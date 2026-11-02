use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("Aura1111111111111111111111111111111111111111");

#[program]
pub mod aurastream {
    use super::*;

    /// Initializes a streaming payment escrow between sender and recipient.
    pub fn initialize_stream(
        ctx: Context<InitializeStream>,
        stream_id: u64,
        deposit_amount: u64,
        start_time: i64,
        end_time: i64,
        cancelable_by_sender: bool,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;

        // Strict input validations
        require!(deposit_amount > 0, StreamError::ZeroDeposit);
        require!(end_time > start_time, StreamError::InvalidTimeRange);
        require!(
            start_time >= current_time - 300,
            StreamError::StartTimeTooFarInPast
        );

        let stream = &mut ctx.accounts.stream_account;
        stream.sender = ctx.accounts.sender.key();
        stream.recipient = ctx.accounts.recipient.key();
        stream.mint = ctx.accounts.mint.key();
        stream.escrow_vault = ctx.accounts.escrow_vault.key();
        stream.stream_id = stream_id;
        stream.deposit_amount = deposit_amount;
        stream.withdrawn_amount = 0;
        stream.start_time = start_time;
        stream.end_time = end_time;
        stream.cancelable_by_sender = cancelable_by_sender;
        stream.bump = ctx.bumps.stream_account;
        stream.vault_bump = ctx.bumps.escrow_vault;
        stream.created_at = current_time;

        // Fund the Escrow Vault from Sender
        let cpi_accounts = Transfer {
            from: ctx.accounts.sender_token_account.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, deposit_amount)?;

        emit!(StreamCreatedEvent {
            stream_id,
            sender: stream.sender,
            recipient: stream.recipient,
            mint: stream.mint,
            deposit_amount,
            start_time,
            end_time,
            cancelable_by_sender,
            timestamp: current_time,
        });

        Ok(())
    }

    /// Withdraws all currently vested funds to the recipient.
    pub fn withdraw_stream(ctx: Context<WithdrawStream>, stream_id: u64) -> Result<()> {
        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;
        let stream = &mut ctx.accounts.stream_account;

        require!(
            current_time >= stream.start_time,
            StreamError::StreamNotStarted
        );

        let total_vested = calculate_vested_amount(
            stream.deposit_amount,
            stream.start_time,
            stream.end_time,
            current_time,
        )?;

        let claimable = total_vested
            .checked_sub(stream.withdrawn_amount)
            .ok_or(StreamError::MathUnderflow)?;

        require!(claimable > 0, StreamError::NoFundsAvailable);

        stream.withdrawn_amount = stream
            .withdrawn_amount
            .checked_add(claimable)
            .ok_or(StreamError::MathOverflow)?;

        // Execute CPI transfer from Vault PDA to Recipient Token Account
        let sender_key = stream.sender;
        let recipient_key = stream.recipient;
        let stream_id_bytes = stream_id.to_le_bytes();
        let bump_ref = &[stream.vault_bump];

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow_vault",
            sender_key.as_ref(),
            recipient_key.as_ref(),
            stream_id_bytes.as_ref(),
            bump_ref,
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, claimable)?;

        emit!(StreamWithdrawnEvent {
            stream_id,
            recipient: stream.recipient,
            amount: claimable,
            total_withdrawn: stream.withdrawn_amount,
            timestamp: current_time,
        });

        // Automatically close the stream account and vault if 100% of funds have been withdrawn
        if stream.withdrawn_amount == stream.deposit_amount {
            let close_vault_accounts = CloseAccount {
                account: ctx.accounts.escrow_vault.to_account_info(),
                destination: ctx.accounts.recipient.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            };
            let close_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                close_vault_accounts,
                signer_seeds,
            );
            token::close_account(close_ctx)?;

            emit!(StreamCompletedEvent {
                stream_id,
                timestamp: current_time,
            });
        }

        Ok(())
    }

    /// Cancels the stream: vests claimable funds to recipient, returns remaining unvested to sender.
    pub fn cancel_stream(ctx: Context<CancelStream>, stream_id: u64) -> Result<()> {
        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;
        let stream = &mut ctx.accounts.stream_account;

        require!(
            stream.cancelable_by_sender,
            StreamError::StreamNotCancelable
        );

        let total_vested = calculate_vested_amount(
            stream.deposit_amount,
            stream.start_time,
            stream.end_time,
            current_time,
        )?;

        let claimable_by_recipient = total_vested
            .checked_sub(stream.withdrawn_amount)
            .ok_or(StreamError::MathUnderflow)?;

        let remaining_unvested = stream
            .deposit_amount
            .checked_sub(total_vested)
            .ok_or(StreamError::MathUnderflow)?;

        let sender_key = stream.sender;
        let recipient_key = stream.recipient;
        let stream_id_bytes = stream_id.to_le_bytes();
        let bump_ref = &[stream.vault_bump];

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow_vault",
            sender_key.as_ref(),
            recipient_key.as_ref(),
            stream_id_bytes.as_ref(),
            bump_ref,
        ]];

        let cpi_program = ctx.accounts.token_program.to_account_info();

        // 1. Pay out claimable vested funds to recipient if available
        if claimable_by_recipient > 0 {
            let cpi_recipient = Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            };
            let cpi_recipient_ctx =
                CpiContext::new_with_signer(cpi_program.clone(), cpi_recipient, signer_seeds);
            token::transfer(cpi_recipient_ctx, claimable_by_recipient)?;
        }

        // 2. Refund remaining unvested balance to sender
        if remaining_unvested > 0 {
            let cpi_sender = Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.sender_token_account.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            };
            let cpi_sender_ctx =
                CpiContext::new_with_signer(cpi_program.clone(), cpi_sender, signer_seeds);
            token::transfer(cpi_sender_ctx, remaining_unvested)?;
        }

        // 3. Close the escrow vault token account and return rent to sender
        let close_vault_accounts = CloseAccount {
            account: ctx.accounts.escrow_vault.to_account_info(),
            destination: ctx.accounts.sender.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        let close_vault_ctx =
            CpiContext::new_with_signer(cpi_program, close_vault_accounts, signer_seeds);
        token::close_account(close_vault_ctx)?;

        emit!(StreamCanceledEvent {
            stream_id,
            recipient_vested_amount: claimable_by_recipient,
            sender_refunded_amount: remaining_unvested,
            timestamp: current_time,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// HELPER MATH FUNCTIONS
// -----------------------------------------------------------------------------

#[inline(always)]
pub fn calculate_vested_amount(
    total_amount: u64,
    start_time: i64,
    end_time: i64,
    current_time: i64,
) -> Result<u64> {
    if current_time <= start_time {
        return Ok(0);
    }
    if current_time >= end_time {
        return Ok(total_amount);
    }

    let elapsed = (current_time - start_time) as u128;
    let duration = (end_time - start_time) as u128;
    let total = total_amount as u128;

    let vested = total
        .checked_mul(elapsed)
        .ok_or(StreamError::MathOverflow)?
        .checked_div(duration)
        .ok_or(StreamError::MathUnderflow)?;

    Ok(vested as u64)
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(stream_id: u64)]
pub struct InitializeStream<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Recipient pubkey is validated as non-system program address
    pub recipient: AccountInfo<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = sender_token_account.mint == mint.key() @ StreamError::InvalidMint,
        constraint = sender_token_account.owner == sender.key() @ StreamError::InvalidTokenOwner,
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = sender,
        space = StreamAccount::LEN,
        seeds = [b"stream", sender.key().as_ref(), recipient.key().as_ref(), &stream_id.to_le_bytes()],
        bump
    )]
    pub stream_account: Account<'info, StreamAccount>,

    #[account(
        init,
        payer = sender,
        seeds = [b"escrow_vault", sender.key().as_ref(), recipient.key().as_ref(), &stream_id.to_le_bytes()],
        bump,
        token::mint = mint,
        token::authority = escrow_vault,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(stream_id: u64)]
pub struct WithdrawStream<'info> {
    #[account(mut)]
    pub recipient: Signer<'info>,

    /// CHECK: Validated against stream_account sender record
    #[account(mut, address = stream_account.sender @ StreamError::InvalidSender)]
    pub sender: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"stream", sender.key().as_ref(), recipient.key().as_ref(), &stream_id.to_le_bytes()],
        bump = stream_account.bump,
        has_one = recipient @ StreamError::UnauthorizedRecipient,
        has_one = escrow_vault @ StreamError::InvalidVault,
    )]
    pub stream_account: Account<'info, StreamAccount>,

    #[account(
        mut,
        seeds = [b"escrow_vault", sender.key().as_ref(), recipient.key().as_ref(), &stream_id.to_le_bytes()],
        bump = stream_account.vault_bump,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = recipient_token_account.mint == stream_account.mint @ StreamError::InvalidMint,
        constraint = recipient_token_account.owner == recipient.key() @ StreamError::InvalidTokenOwner,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(stream_id: u64)]
pub struct CancelStream<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Validated against stream_account recipient record
    #[account(mut, address = stream_account.recipient @ StreamError::UnauthorizedRecipient)]
    pub recipient: AccountInfo<'info>,

    #[account(
        mut,
        close = sender,
        seeds = [b"stream", sender.key().as_ref(), recipient.key().as_ref(), &stream_id.to_le_bytes()],
        bump = stream_account.bump,
        has_one = sender @ StreamError::UnauthorizedSender,
        has_one = escrow_vault @ StreamError::InvalidVault,
    )]
    pub stream_account: Account<'info, StreamAccount>,

    #[account(
        mut,
        seeds = [b"escrow_vault", sender.key().as_ref(), recipient.key().as_ref(), &stream_id.to_le_bytes()],
        bump = stream_account.vault_bump,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = sender_token_account.mint == stream_account.mint @ StreamError::InvalidMint,
        constraint = sender_token_account.owner == sender.key() @ StreamError::InvalidTokenOwner,
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = recipient_token_account.mint == stream_account.mint @ StreamError::InvalidMint,
        constraint = recipient_token_account.owner == recipient.key() @ StreamError::InvalidTokenOwner,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
pub struct StreamAccount {
    pub sender: Pubkey,               // 32
    pub recipient: Pubkey,            // 32
    pub mint: Pubkey,                 // 32
    pub escrow_vault: Pubkey,         // 32
    pub stream_id: u64,               // 8
    pub deposit_amount: u64,          // 8
    pub withdrawn_amount: u64,        // 8
    pub start_time: i64,              // 8
    pub end_time: i64,                // 8
    pub created_at: i64,              // 8
    pub cancelable_by_sender: bool,   // 1
    pub bump: u8,                     // 1
    pub vault_bump: u8,               // 1
}

impl StreamAccount {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 64;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct StreamCreatedEvent {
    pub stream_id: u64,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub deposit_amount: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub cancelable_by_sender: bool,
    pub timestamp: i64,
}

#[event]
pub struct StreamWithdrawnEvent {
    pub stream_id: u64,
    pub recipient: Pubkey,
    pub amount: u64,
    pub total_withdrawn: u64,
    pub timestamp: i64,
}

#[event]
pub struct StreamCanceledEvent {
    pub stream_id: u64,
    pub recipient_vested_amount: u64,
    pub sender_refunded_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct StreamCompletedEvent {
    pub stream_id: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum StreamError {
    #[msg("Deposit amount must be strictly greater than 0.")]
    ZeroDeposit,
    #[msg("Stream end time must be greater than start time.")]
    InvalidTimeRange,
    #[msg("Stream start time cannot be more than 5 minutes in the past.")]
    StartTimeTooFarInPast,
    #[msg("Stream has not reached its scheduled start time.")]
    StreamNotStarted,
    #[msg("No newly vested funds available for withdrawal.")]
    NoFundsAvailable,
    #[msg("Sender is not authorized to cancel this stream.")]
    StreamNotCancelable,
    #[msg("Unauthorized recipient.")]
    UnauthorizedRecipient,
    #[msg("Unauthorized sender.")]
    UnauthorizedSender,
    #[msg("Invalid sender address.")]
    InvalidSender,
    #[msg("Escrow vault address mismatch.")]
    InvalidVault,
    #[msg("Mint address mismatch.")]
    InvalidMint,
    #[msg("Invalid token account owner.")]
    InvalidTokenOwner,
    #[msg("Arithmetic overflow occurred.")]
    MathOverflow,
    #[msg("Arithmetic underflow occurred.")]
    MathUnderflow,
}