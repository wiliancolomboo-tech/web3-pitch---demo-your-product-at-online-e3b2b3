use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::{VaultConfig, UserRecord, VAULT_CONFIG_SEED, VAULT_TOKEN_SEED, USER_RECORD_SEED};
use crate::errors::AegisError;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_CONFIG_SEED, token_mint.key().as_ref()],
        bump = vault_config.bump,
        has_one = token_vault,
        has_one = token_mint
    )]
    pub vault_config: Account<'info, VaultConfig>,

    pub token_mint: Account<'info, Mint>,

    #[account(mut)]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == token_mint.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [USER_RECORD_SEED, vault_config.key().as_ref(), user.key().as_ref()],
        bump = user_record.bump,
        has_one = user @ AegisError::UnauthorizedCaller
    )]
    pub user_record: Account<'info, UserRecord>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, AegisError::ZeroAmountProhibited);

    let vault_config = &mut ctx.accounts.vault_config;
    let user_record = &mut ctx.accounts.user_record;
    let clock = Clock::get()?;

    // 1. Vault Freeze Enforcement
    require!(vault_config.is_active, AegisError::VaultFrozen);

    // 2. User Balance Verification
    let user_available = user_record
        .deposited_amount
        .checked_sub(user_record.withdrawn_amount)
        .ok_or(AegisError::MathOverflow)?;
    require!(amount <= user_available, AegisError::MathOverflow);

    // 3. Single-Tx Bound Verification
    if amount > vault_config.single_tx_limit {
        vault_config.is_active = false;
        emit!(CircuitBreakerTrippedEvent {
            vault: vault_config.key(),
            trigger_reason: 1, // Single-tx limit breached
            violator: ctx.accounts.user.key(),
            attempted_amount: amount,
            slot: clock.slot,
        });
        return err!(AegisError::SingleTransactionLimitExceeded);
    }

    // 4. Rolling-Epoch Window Velocity Verification
    let slots_elapsed = clock.slot.saturating_sub(vault_config.current_epoch_start_slot);
    if slots_elapsed >= vault_config.epoch_window_slots {
        // Reset window
        vault_config.current_epoch_start_slot = clock.slot;
        vault_config.current_epoch_withdrawn_volume = 0;
    }

    let projected_volume = vault_config
        .current_epoch_withdrawn_volume
        .checked_add(amount)
        .ok_or(AegisError::MathOverflow)?;

    if projected_volume > vault_config.epoch_velocity_limit {
        // Automatically trip the circuit breaker and freeze further movements
        vault_config.is_active = false;
        emit!(CircuitBreakerTrippedEvent {
            vault: vault_config.key(),
            trigger_reason: 2, // Velocity limit breached
            violator: ctx.accounts.user.key(),
            attempted_amount: amount,
            slot: clock.slot,
        });
        return err!(AegisError::EpochVelocityExceeded);
    }

    // 5. Invariant Checks Passed: Mutate State
    vault_config.current_epoch_withdrawn_volume = projected_volume;
    vault_config.total_withdrawals = vault_config
        .total_withdrawals
        .checked_add(amount)
        .ok_or(AegisError::MathOverflow)?;

    user_record.withdrawn_amount = user_record
        .withdrawn_amount
        .checked_add(amount)
        .ok_or(AegisError::MathOverflow)?;
    user_record.last_interaction_slot = clock.slot;

    // 6. CPI Transfer with Vault Config Signer Seeds
    let vault_key = vault_config.key();
    let seeds = &[
        VAULT_TOKEN_SEED,
        vault_key.as_ref(),
        &[vault_config.vault_bump],
    ];
    let signer = &[&seeds[..]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.token_vault.to_account_info(),
        to: ctx.accounts.user_token_account.to_account_info(),
        authority: vault_config.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
    token::transfer(cpi_ctx, amount)?;

    emit!(WithdrawalSettledEvent {
        vault: vault_config.key(),
        user: ctx.accounts.user.key(),
        amount,
        slot: clock.slot,
    });

    Ok(())
}

#[event]
pub struct CircuitBreakerTrippedEvent {
    pub vault: Pubkey,
    pub trigger_reason: u8,
    pub violator: Pubkey,
    pub attempted_amount: u64,
    pub slot: u64,
}

#[event]
pub struct WithdrawalSettledEvent {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub slot: u64,
}