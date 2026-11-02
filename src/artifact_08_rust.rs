use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::{VaultConfig, UserRecord, VAULT_CONFIG_SEED, USER_RECORD_SEED};
use crate::errors::AegisError;

#[derive(Accounts)]
pub struct Deposit<'info> {
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

    #[account(
        mut,
        constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == token_mint.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = UserRecord::LEN,
        seeds = [USER_RECORD_SEED, vault_config.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_record: Account<'info, UserRecord>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, AegisError::ZeroAmountProhibited);
    require!(ctx.accounts.vault_config.is_active, AegisError::VaultFrozen);

    // Transfer token from user to program-controlled escrow
    let cpi_accounts = Transfer {
        from: ctx.accounts.user_token_account.to_account_info(),
        to: ctx.accounts.token_vault.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    token::transfer(cpi_ctx, amount)?;

    let clock = Clock::get()?;
    let vault_config = &mut ctx.accounts.vault_config;
    let user_record = &mut ctx.accounts.user_record;

    vault_config.total_deposits = vault_config
        .total_deposits
        .checked_add(amount)
        .ok_or(AegisError::MathOverflow)?;

    if user_record.owner == Pubkey::default() {
        user_record.owner = ctx.accounts.user.key();
        user_record.vault = vault_config.key();
        user_record.bump = ctx.bumps.user_record;
    }

    user_record.deposited_amount = user_record
        .deposited_amount
        .checked_add(amount)
        .ok_or(AegisError::MathOverflow)?;
    user_record.last_interaction_slot = clock.slot;

    emit!(DepositEvent {
        vault: vault_config.key(),
        user: ctx.accounts.user.key(),
        amount,
        slot: clock.slot,
    });

    Ok(())
}

#[event]
pub struct DepositEvent {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub slot: u64,
}