use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("AegisPay11111111111111111111111111111111111");

#[program]
pub mod aegis_escrow {
    use super::*;

    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        escrow_id: u64,
        total_milestones: u8,
        amount_per_milestone: u64,
        milestone_timeout_seconds: i64,
    ) -> Result<()> {
        require!(total_milestones > 0, AegisError::InvalidMilestoneCount);
        require!(amount_per_milestone > 0, AegisError::ZeroAmount);
        require!(milestone_timeout_seconds > 0, AegisError::InvalidTimeout);

        let total_deposit = amount_per_milestone
            .checked_mul(total_milestones as u64)
            .ok_or(AegisError::NumericalOverflow)?;

        // Transfer funds from client to vault PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.client.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        transfer(cpi_context, total_deposit)?;

        let escrow = &mut ctx.accounts.escrow_state;
        escrow.client = ctx.accounts.client.key();
        escrow.beneficiary = ctx.accounts.beneficiary.key();
        escrow.arbiter = ctx.accounts.arbiter.key();
        escrow.escrow_id = escrow_id;
        escrow.total_milestones = total_milestones;
        escrow.completed_milestones = 0;
        escrow.amount_per_milestone = amount_per_milestone;
        escrow.remaining_balance = total_deposit;
        escrow.milestone_timeout_seconds = milestone_timeout_seconds;
        escrow.last_activity_timestamp = Clock::get()?.unix_timestamp;
        escrow.state = EscrowStatus::Active;
        escrow.bump = ctx.bumps.escrow_state;
        escrow.vault_bump = ctx.bumps.vault;

        emit!(EscrowInitializedEvent {
            escrow_id,
            client: escrow.client,
            beneficiary: escrow.beneficiary,
            total_deposit,
            timestamp: escrow.last_activity_timestamp,
        });

        Ok(())
    }

    pub fn submit_milestone(
        ctx: Context<SubmitMilestone>,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(escrow.state == EscrowStatus::Active, AegisError::InvalidEscrowState);
        require!(
            escrow.completed_milestones < escrow.total_milestones,
            AegisError::AllMilestonesCompleted
        );

        escrow.current_proof_hash = proof_hash;
        escrow.last_activity_timestamp = Clock::get()?.unix_timestamp;
        escrow.state = EscrowStatus::MilestoneSubmitted;

        emit!(MilestoneSubmittedEvent {
            escrow_id: escrow.escrow_id,
            milestone_index: escrow.completed_milestones + 1,
            proof_hash,
            timestamp: escrow.last_activity_timestamp,
        });

        Ok(())
    }

    pub fn approve_milestone(ctx: Context<ApproveMilestone>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStatus::MilestoneSubmitted,
            AegisError::NoMilestoneSubmitted
        );

        let payout_amount = escrow.amount_per_milestone;
        require!(
            escrow.remaining_balance >= payout_amount,
            AegisError::InsufficientVaultBalance
        );

        // Vault PDA transfers funds to beneficiary
        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            b"aegis_vault",
            escrow.client.as_ref(),
            escrow_id_bytes.as_ref(),
            &[escrow.vault_bump],
        ]];

        let transfer_instruction = anchor_lang::solana_program::system_instruction::transfer(
            ctx.accounts.vault.key,
            ctx.accounts.beneficiary.key,
            payout_amount,
        );

        anchor_lang::solana_program::program::invoke_signed(
            &transfer_instruction,
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.beneficiary.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        escrow.completed_milestones = escrow
            .completed_milestones
            .checked_add(1)
            .ok_or(AegisError::NumericalOverflow)?;
        escrow.remaining_balance = escrow
            .remaining_balance
            .checked_sub(payout_amount)
            .ok_or(AegisError::NumericalOverflow)?;
        escrow.last_activity_timestamp = Clock::get()?.unix_timestamp;

        if escrow.completed_milestones == escrow.total_milestones {
            escrow.state = EscrowStatus::Completed;
        } else {
            escrow.state = EscrowStatus::Active;
        }

        emit!(MilestoneApprovedEvent {
            escrow_id: escrow.escrow_id,
            milestone_index: escrow.completed_milestones,
            payout_amount,
            is_final: escrow.state == EscrowStatus::Completed,
            timestamp: escrow.last_activity_timestamp,
        });

        Ok(())
    }

    pub fn dispute_escrow(ctx: Context<DisputeEscrow>, reason_hash: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStatus::Active || escrow.state == EscrowStatus::MilestoneSubmitted,
            AegisError::InvalidEscrowState
        );

        escrow.state = EscrowStatus::Disputed;
        escrow.last_activity_timestamp = Clock::get()?.unix_timestamp;

        emit!(EscrowDisputedEvent {
            escrow_id: escrow.escrow_id,
            disputer: ctx.accounts.caller.key(),
            reason_hash,
            timestamp: escrow.last_activity_timestamp,
        });

        Ok(())
    }

    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        beneficiary_split_bps: u16,
    ) -> Result<()> {
        require!(beneficiary_split_bps <= 10000, AegisError::InvalidSplit);
        let escrow = &mut ctx.accounts.escrow_state;
        require!(escrow.state == EscrowStatus::Disputed, AegisError::NotInDispute);

        let total_remaining = escrow.remaining_balance;
        let beneficiary_amount = (total_remaining as u128)
            .checked_mul(beneficiary_split_bps as u128)
            .ok_or(AegisError::NumericalOverflow)?
            .checked_div(10000)
            .ok_or(AegisError::NumericalOverflow)? as u64;

        let client_refund_amount = total_remaining
            .checked_sub(beneficiary_amount)
            .ok_or(AegisError::NumericalOverflow)?;

        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            b"aegis_vault",
            escrow.client.as_ref(),
            escrow_id_bytes.as_ref(),
            &[escrow.vault_bump],
        ]];

        if beneficiary_amount > 0 {
            let tx_ben = anchor_lang::solana_program::system_instruction::transfer(
                ctx.accounts.vault.key,
                ctx.accounts.beneficiary.key,
                beneficiary_amount,
            );
            anchor_lang::solana_program::program::invoke_signed(
                &tx_ben,
                &[
                    ctx.accounts.vault.to_account_info(),
                    ctx.accounts.beneficiary.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                seeds,
            )?;
        }

        if client_refund_amount > 0 {
            let tx_client = anchor_lang::solana_program::system_instruction::transfer(
                ctx.accounts.vault.key,
                ctx.accounts.client.key,
                client_refund_amount,
            );
            anchor_lang::solana_program::program::invoke_signed(
                &tx_client,
                &[
                    ctx.accounts.vault.to_account_info(),
                    ctx.accounts.client.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                seeds,
            )?;
        }

        escrow.remaining_balance = 0;
        escrow.state = EscrowStatus::Settled;
        escrow.last_activity_timestamp = Clock::get()?.unix_timestamp;

        emit!(DisputeResolvedEvent {
            escrow_id: escrow.escrow_id,
            beneficiary_amount,
            client_refund_amount,
            timestamp: escrow.last_activity_timestamp,
        });

        Ok(())
    }

    pub fn claim_timeout_refund(ctx: Context<ClaimTimeoutRefund>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(escrow.state == EscrowStatus::Active, AegisError::InvalidEscrowState);

        let current_time = Clock::get()?.unix_timestamp;
        let elapsed = current_time
            .checked_sub(escrow.last_activity_timestamp)
            .ok_or(AegisError::NumericalOverflow)?;

        require!(elapsed >= escrow.milestone_timeout_seconds, AegisError::TimeoutNotReached);

        let refund_amount = escrow.remaining_balance;
        require!(refund_amount > 0, AegisError::ZeroAmount);

        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            b"aegis_vault",
            escrow.client.as_ref(),
            escrow_id_bytes.as_ref(),
            &[escrow.vault_bump],
        ]];

        let tx_refund = anchor_lang::solana_program::system_instruction::transfer(
            ctx.accounts.vault.key,
            ctx.accounts.client.key,
            refund_amount,
        );
        anchor_lang::solana_program::program::invoke_signed(
            &tx_refund,
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.client.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        escrow.remaining_balance = 0;
        escrow.state = EscrowStatus::Defaulted;
        escrow.last_activity_timestamp = current_time;

        emit!(TimeoutRefundClaimedEvent {
            escrow_id: escrow.escrow_id,
            refund_amount,
            timestamp: current_time,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    /// CHECK: Beneficiary public key validated during agreement parameters
    pub beneficiary: AccountInfo<'info>,

    /// CHECK: Arbiter designated as impartial third party
    pub arbiter: AccountInfo<'info>,

    #[account(
        init,
        payer = client,
        space = 8 + EscrowState::INIT_SPACE,
        seeds = [b"aegis_escrow", client.key().as_ref(), escrow_id.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        seeds = [b"aegis_vault", client.key().as_ref(), escrow_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitMilestone<'info> {
    pub beneficiary: Signer<'info>,

    #[account(
        mut,
        has_one = beneficiary @ AegisError::UnauthorizedSigner,
        seeds = [b"aegis_escrow", escrow_state.client.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.bump
    )]
    pub escrow_state: Account<'info, EscrowState>,
}

#[derive(Accounts)]
pub struct ApproveMilestone<'info> {
    pub approver: Signer<'info>,

    /// CHECK: Must match escrow_state.beneficiary
    #[account(
        mut,
        address = escrow_state.beneficiary @ AegisError::UnauthorizedSigner
    )]
    pub beneficiary: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"aegis_escrow", escrow_state.client.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.bump,
        constraint = (approver.key() == escrow_state.client || approver.key() == escrow_state.arbiter) @ AegisError::UnauthorizedSigner
    )]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        seeds = [b"aegis_vault", escrow_state.client.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DisputeEscrow<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"aegis_escrow", escrow_state.client.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.bump,
        constraint = (caller.key() == escrow_state.client || caller.key() == escrow_state.beneficiary) @ AegisError::UnauthorizedSigner
    )]
    pub escrow_state: Account<'info, EscrowState>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    pub arbiter: Signer<'info>,

    /// CHECK: Client recipient
    #[account(mut, address = escrow_state.client)]
    pub client: AccountInfo<'info>,

    /// CHECK: Beneficiary recipient
    #[account(mut, address = escrow_state.beneficiary)]
    pub beneficiary: AccountInfo<'info>,

    #[account(
        mut,
        has_one = arbiter @ AegisError::UnauthorizedSigner,
        seeds = [b"aegis_escrow", escrow_state.client.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        seeds = [b"aegis_vault", escrow_state.client.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimTimeoutRefund<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        mut,
        has_one = client @ AegisError::UnauthorizedSigner,
        seeds = [b"aegis_escrow", client.key().as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        seeds = [b"aegis_vault", client.key().as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// STATE SCHEMAS & EVENTS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct EscrowState {
    pub client: Pubkey,
    pub beneficiary: Pubkey,
    pub arbiter: Pubkey,
    pub escrow_id: u64,
    pub total_milestones: u8,
    pub completed_milestones: u8,
    pub amount_per_milestone: u64,
    pub remaining_balance: u64,
    pub milestone_timeout_seconds: i64,
    pub last_activity_timestamp: i64,
    pub current_proof_hash: [u8; 32],
    pub state: EscrowStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    Active,
    MilestoneSubmitted,
    Disputed,
    Completed,
    Settled,
    Defaulted,
}

#[event]
pub struct EscrowInitializedEvent {
    pub escrow_id: u64,
    pub client: Pubkey,
    pub beneficiary: Pubkey,
    pub total_deposit: u64,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneSubmittedEvent {
    pub escrow_id: u64,
    pub milestone_index: u8,
    pub proof_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct MilestoneApprovedEvent {
    pub escrow_id: u64,
    pub milestone_index: u8,
    pub payout_amount: u64,
    pub is_final: bool,
    pub timestamp: i64,
}

#[event]
pub struct EscrowDisputedEvent {
    pub escrow_id: u64,
    pub disputer: Pubkey,
    pub reason_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct DisputeResolvedEvent {
    pub escrow_id: u64,
    pub beneficiary_amount: u64,
    pub client_refund_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct TimeoutRefundClaimedEvent {
    pub escrow_id: u64,
    pub refund_amount: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum AegisError {
    #[msg("Milestone count must be greater than zero")]
    InvalidMilestoneCount,
    #[msg("Deposit amount must be greater than zero")]
    ZeroAmount,
    #[msg("Timeout duration must be positive")]
    InvalidTimeout,
    #[msg("Numerical overflow occurred")]
    NumericalOverflow,
    #[msg("Escrow is not in the required state for this operation")]
    InvalidEscrowState,
    #[msg("All milestones have already been fulfilled")]
    AllMilestonesCompleted,
    #[msg("No milestone submission is currently pending review")]
    NoMilestoneSubmitted,
    #[msg("Vault does not hold sufficient balance to fulfill payout")]
    InsufficientVaultBalance,
    #[msg("Signer does not possess required authorization")]
    UnauthorizedSigner,
    #[msg("Escrow is not under active dispute")]
    NotInDispute,
    #[msg("Dispute split basis points cannot exceed 10000 (100%)")]
    InvalidSplit,
    #[msg("Timeout period has not yet elapsed")]
    TimeoutNotReached,
}