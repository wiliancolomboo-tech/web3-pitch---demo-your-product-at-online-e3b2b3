use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::{VaultConfig, VAULT_CONFIG_SEED, VAULT_TOKEN_SEED};
use crate::errors::AegisError;

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Guardian key can be an off-chain automated keypair or multisig PDA.
    pub guardian: UncheckedAccount<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = VaultConfig::LEN,
        seeds = [VAULT_CONFIG_SEED, token_mint.key().as_ref()],
        bump
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        init,
        payer = admin,
        seeds = [VAULT_TOKEN_SEED, vault_config.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = vault_config
    )]
    pub token_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_initialize_vault(
    ctx: Context<InitializeVault>,
    single_tx_limit: u64,
    epoch_velocity_limit: u64,
    epoch_window_slots: u64,
) -> Result<()> {
    require!(single_tx_limit > 0, AegisError::ZeroAmountProhibited);
    require!(epoch_velocity_limit >= single_tx_limit, AegisError::EpochVelocityExceeded);
    require!(epoch_window_slots > 0, AegisError::ZeroAmountProhibited);

    let vault_config = &mut ctx.accounts.vault_config;
    let clock = Clock::get()?;

    vault_config.admin = ctx.accounts.admin.key();
    vault_config.guardian = ctx.accounts.guardian.key();
    vault_config.token_mint = ctx.accounts.token_mint.key();
    vault_config.token_vault = ctx.accounts.token_vault.key();
    vault_config.is_active = true;
    vault_config.single_tx_limit = single_tx_limit;
    vault_config.epoch_velocity_limit = epoch_velocity_limit;
    vault_config.epoch_window_slots = epoch_window_slots;
    vault_config.current_epoch_start_slot = clock.slot;
    vault_config.current_epoch_withdrawn_volume = 0;
    vault_config.total_deposits = 0;
    vault_config.total_withdrawals = 0;
    vault_config.bump = ctx.bumps.vault_config;
    vault_config.vault_bump = ctx.bumps.token_vault;

    msg!("AegisVault initialized successfully: {}", vault_config.key());
    Ok(())
}