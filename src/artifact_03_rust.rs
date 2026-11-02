use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Sent1neL11111111111111111111111111111111111");

pub const ESCROW_SEED: &[u8] = b"sentinel_escrow";
pub const VAULT_SEED: &[u8] = b"sentinel_vault";

#[program]
pub mod sol_sentinel {
    use super::*;

    /// Initialize a new milestone-based streaming escrow with custom parameters.
    pub fn create_stream(
        ctx: Context<CreateStream>,
        stream_id: u64,
        total_deposit: u64,
        start_time: i64,
        end_time: i64,
        milestone_count: u8,
        attestation_oracle: Pubkey,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;

        require!(total_deposit > 0, SentinelError::InvalidDepositAmount);
        require!(end_time > start_time, SentinelError::InvalidTimeRange);
        require!(start_time >= current_time - 300, SentinelError::StartTimeTooFarInPast);
        require!(milestone_count > 0, SentinelError::ZeroMilestones);

        let escrow = &mut ctx.accounts.escrow_account;
        escrow.sender = ctx.accounts.sender.key();
        escrow.recipient = ctx.accounts.recipient.key();
        escrow.mint = ctx.accounts.token_mint.key();
        escrow.vault = ctx.accounts.vault_account.key();
        escrow.stream_id = stream_id;
        escrow.total_deposit = total_deposit;
        escrow.claimed_amount = 0;
        escrow.start_time = start_time;
        escrow.end_time = end_time;
        escrow.milestone_count = milestone_count;
        escrow.milestones_completed = 0;
        escrow.attestation_oracle = attestation_oracle;
        escrow.is_cancelled = false;
        escrow.bump = ctx.bumps.escrow_account;
        escrow.vault_bump = ctx.bumps.vault_account;

        // Transfer funds from sender to the escrow vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.sender_token.to_account_info(),
            to: ctx.accounts.vault_account.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, total_deposit)?;

        emit!(StreamCreatedEvent {
            stream_id,
            sender: escrow.sender,
            recipient: escrow.recipient,
            deposit_amount: total_deposit,
            start_time,
            end_time,
            milestones: milestone_count,
            timestamp: current_time,
        });

        Ok(())
    }

    /// Attests the completion of a milestone. Only the designated oracle or the sender can call this.
    pub fn attest_milestone(
        ctx: Context<AttestMilestone>,
        milestone_index: u8,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_account;
        let signer = ctx.accounts.signer.key();

        require!(!escrow.is_cancelled, SentinelError::StreamCancelled);
        require!(
            signer == escrow.attestation_oracle || signer == escrow.sender,
            SentinelError::UnauthorizedOracle
        );
        require!(
            milestone_index == escrow.milestones_completed + 1,
            SentinelError::NonSequentialMilestone
        );
        require!(
            milestone_index <= escrow.milestone_count,
            SentinelError::MilestoneLimitExceeded
        );

        escrow.milestones_completed = milestone_index;

        let clock = Clock::get()?;
        emit!(MilestoneAttestedEvent {
            stream_id: escrow.stream_id,
            milestone_index,
            attester: signer,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Claim unlocked funds based on elapsed stream time and completed milestones.
    pub fn claim(ctx: Context<ClaimFunds>, amount_to_claim: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_account;
        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;

        require!(!escrow.is_cancelled, SentinelError::StreamCancelled);
        require!(ctx.accounts.recipient.key() == escrow.recipient, SentinelError::UnauthorizedClaimer);

        let vested_amount = compute_vested_amount(escrow, current_time)?;
        let claimable_now = vested_amount
            .checked_sub(escrow.claimed_amount)
            .ok_or(SentinelError::MathUnderflow)?;

        require!(claimable_now > 0, SentinelError::NothingToClaim);
        require!(amount_to_claim <= claimable_now, SentinelError::ExceedsClaimable);

        escrow.claimed_amount = escrow
            .claimed_amount
            .checked_add(amount_to_claim)
            .ok_or(SentinelError::MathOverflow)?;

        let stream_id_bytes = escrow.stream_id.to_le_bytes();
        let sender_key = escrow.sender;
        let recipient_key = escrow.recipient;
        let vault_bump = escrow.vault_bump;

        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            sender_key.as_ref(),
            recipient_key.as_ref(),
            &stream_id_bytes,
            &[vault_bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_account.to_account_info(),
            to: ctx.accounts.recipient_token.to_account_info(),
            authority: ctx.accounts.vault_account.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount_to_claim)?;

        emit!(FundsClaimedEvent {
            stream_id: escrow.stream_id,
            recipient: escrow.recipient,
            amount: amount_to_claim,
            total_claimed: escrow.claimed_amount,
            timestamp: current_time,
        });

        Ok(())
    }

    /// Cancels the stream, releases owed vested tokens to recipient, and returns remaining to sender.
    pub fn cancel_stream(ctx: Context<CancelStream>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_account;
        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;

        require!(!escrow.is_cancelled, SentinelError::StreamAlreadyCancelled);
        require!(
            ctx.accounts.sender.key() == escrow.sender,
            SentinelError::UnauthorizedSender
        );

        let vested_amount = compute_vested_amount(escrow, current_time)?;
        let pending_to_recipient = vested_amount
            .checked_sub(escrow.claimed_amount)
            .ok_or(SentinelError::MathUnderflow)?;

        let unvested_amount = escrow
            .total_deposit
            .checked_sub(vested_amount)
            .ok_or(SentinelError::MathUnderflow)?;

        let stream_id_bytes = escrow.stream_id.to_le_bytes();
        let sender_key = escrow.sender;
        let recipient_key = escrow.recipient;
        let vault_bump = escrow.vault_bump;

        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            sender_key.as_ref(),
            recipient_key.as_ref(),
            &stream_id_bytes,
            &[vault_bump],
        ]];

        // 1. Transfer any unlocked-but-unclaimed funds to the recipient
        if pending_to_recipient > 0 {
            let cpi_accounts_recipient = Transfer {
                from: ctx.accounts.vault_account.to_account_info(),
                to: ctx.accounts.recipient_token.to_account_info(),
                authority: ctx.accounts.vault_account.to_account_info(),
            };
            let cpi_ctx_recipient = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts_recipient,
                signer_seeds,
            );
            token::transfer(cpi_ctx_recipient, pending_to_recipient)?;
        }

        // 2. Return remaining unvested funds to the sender
        if unvested_amount > 0 {
            let cpi_accounts_sender = Transfer {
                from: ctx.accounts.vault_account.to_account_info(),
                to: ctx.accounts.sender_token.to_account_info(),
                authority: ctx.accounts.vault_account.to_account_info(),
            };
            let cpi_ctx_sender = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts_sender,
                signer_seeds,
            );
            token::transfer(cpi_ctx_sender, unvested_amount)?;
        }

        escrow.is_cancelled = true;
        escrow.claimed_amount = escrow
            .claimed_amount
            .checked_add(pending_to_recipient)
            .ok_or(SentinelError::MathOverflow)?;

        emit!(StreamCancelledEvent {
            stream_id: escrow.stream_id,
            clawback_to_sender: unvested_amount,
            final_payout_to_recipient: pending_to_recipient,
            timestamp: current_time,
        });

        Ok(())
    }
}

/// Pure mathematical calculation of vested allocation
fn compute_vested_amount(escrow: &EscrowAccount, current_time: i64) -> Result<u64> {
    if current_time <= escrow.start_time {
        return Ok(0);
    }

    // Time-based ceiling
    let effective_time = if current_time >= escrow.end_time {
        escrow.end_time
    } else {
        current_time
    };

    let total_duration = escrow
        .end_time
        .checked_sub(escrow.start_time)
        .ok_or(SentinelError::MathUnderflow)?;
    let elapsed_duration = effective_time
        .checked_sub(escrow.start_time)
        .ok_or(SentinelError::MathUnderflow)?;

    // Linear stream factor: total_deposit * (elapsed / total_duration)
    let time_vested = (escrow.total_deposit as u128)
        .checked_mul(elapsed_duration as u128)
        .ok_or(SentinelError::MathOverflow)?
        .checked_div(total_duration as u128)
        .ok_or(SentinelError::MathUnderflow)? as u64;

    // Milestone gate calculation: each milestone unlocks equal tranche: 1 / milestone_count
    let milestone_cap = if escrow.milestone_count == 0 {
        escrow.total_deposit
    } else {
        let per_milestone = (escrow.total_deposit as u128)
            .checked_div(escrow.milestone_count as u128)
            .ok_or(SentinelError::MathUnderflow)?;
        let unlocked = per_milestone
            .checked_mul(escrow.milestones_completed as u128)
            .ok_or(SentinelError::MathOverflow)?;
        unlocked as u64
    };

    // The vested amount is the minimum of time-streamed amount and milestone unlocked cap
    let effective_vested = std::cmp::min(time_vested, milestone_cap);
    Ok(effective_vested)
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(stream_id: u64)]
pub struct CreateStream<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Recipient pubkey verified during creation
    pub recipient: AccountInfo<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = sender_token.mint == token_mint.key(),
        constraint = sender_token.owner == sender.key()
    )]
    pub sender_token: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = sender,
        space = EscrowAccount::LEN,
        seeds = [ESCROW_SEED, sender.key().as_ref(), recipient.key().as_ref(), &stream_id.to_le_bytes()],
        bump
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    #[account(
        init,
        payer = sender,
        token::mint = token_mint,
        token::authority = vault_account,
        seeds = [VAULT_SEED, sender.key().as_ref(), recipient.key().as_ref(), &stream_id.to_le_bytes()],
        bump
    )]
    pub vault_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AttestMilestone<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow_account.sender.as_ref(), escrow_account.recipient.as_ref(), &escrow_account.stream_id.to_le_bytes()],
        bump = escrow_account.bump
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
}

#[derive(Accounts)]
pub struct ClaimFunds<'info> {
    #[account(mut)]
    pub recipient: Signer<'info>,

    #[account(
        mut,
        constraint = recipient_token.mint == escrow_account.mint,
        constraint = recipient_token.owner == recipient.key()
    )]
    pub recipient_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow_account.sender.as_ref(), escrow_account.recipient.as_ref(), &escrow_account.stream_id.to_le_bytes()],
        bump = escrow_account.bump
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    #[account(
        mut,
        seeds = [VAULT_SEED, escrow_account.sender.as_ref(), escrow_account.recipient.as_ref(), &escrow_account.stream_id.to_le_bytes()],
        bump = escrow_account.vault_bump
    )]
    pub vault_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelStream<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(
        mut,
        constraint = sender_token.mint == escrow_account.mint,
        constraint = sender_token.owner == sender.key()
    )]
    pub sender_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = recipient_token.mint == escrow_account.mint,
        constraint = recipient_token.owner == escrow_account.recipient
    )]
    pub recipient_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow_account.sender.as_ref(), escrow_account.recipient.as_ref(), &escrow_account.stream_id.to_le_bytes()],
        bump = escrow_account.bump
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    #[account(
        mut,
        seeds = [VAULT_SEED, escrow_account.sender.as_ref(), escrow_account.recipient.as_ref(), &escrow_account.stream_id.to_le_bytes()],
        bump = escrow_account.vault_bump
    )]
    pub vault_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
pub struct EscrowAccount {
    pub sender: Pubkey,            // 32
    pub recipient: Pubkey,         // 32
    pub mint: Pubkey,              // 32
    pub vault: Pubkey,             // 32
    pub stream_id: u64,            // 8
    pub total_deposit: u64,        // 8
    pub claimed_amount: u64,       // 8
    pub start_time: i64,           // 8
    pub end_time: i64,             // 8
    pub milestone_count: u8,       // 1
    pub milestones_completed: u8,   // 1
    pub attestation_oracle: Pubkey,// 32
    pub is_cancelled: bool,        // 1
    pub bump: u8,                  // 1
    pub vault_bump: u8,            // 1
}

impl EscrowAccount {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 32 + 1 + 1 + 1 + 64;
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct StreamCreatedEvent {
    pub stream_id: u64,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub deposit_amount: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub milestones: u8,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneAttestedEvent {
    pub stream_id: u64,
    pub milestone_index: u8,
    pub attester: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FundsClaimedEvent {
    pub stream_id: u64,
    pub recipient: Pubkey,
    pub amount: u64,
    pub total_claimed: u64,
    pub timestamp: i64,
}

#[event]
pub struct StreamCancelledEvent {
    pub stream_id: u64,
    pub clawback_to_sender: u64,
    pub final_payout_to_recipient: u64,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum SentinelError {
    #[msg("Deposit amount must be greater than zero.")]
    InvalidDepositAmount,
    #[msg("Stream end time must be strictly greater than start time.")]
    InvalidTimeRange,
    #[msg("Start time cannot be set more than 5 minutes in the past.")]
    StartTimeTooFarInPast,
    #[msg("Stream must have at least one defined milestone.")]
    ZeroMilestones,
    #[msg("Escrow stream is currently cancelled.")]
    StreamCancelled,
    #[msg("Escrow stream has already been cancelled.")]
    StreamAlreadyCancelled,
    #[msg("Caller is not authorized to attest milestones.")]
    UnauthorizedOracle,
    #[msg("Milestones must be attested sequentially.")]
    NonSequentialMilestone,
    #[msg("Milestone index exceeds the total milestone limit.")]
    MilestoneLimitExceeded,
    #[msg("Signer is not authorized to claim from this stream.")]
    UnauthorizedClaimer,
    #[msg("No funds available to claim at this time.")]
    NothingToClaim,
    #[msg("Requested claim amount exceeds currently vested amount.")]
    ExceedsClaimable,
    #[msg("Signer is not authorized to cancel this stream.")]
    UnauthorizedSender,
    #[msg("Arithmetic overflow detected.")]
    MathOverflow,
    #[msg("Arithmetic underflow detected.")]
    MathUnderflow,
}