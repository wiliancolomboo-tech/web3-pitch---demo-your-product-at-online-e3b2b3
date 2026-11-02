use anchor_lang::prelude::*;
use crate::state::{VaultConfig, VAULT_CONFIG_SEED};
use crate::errors::AegisError;

#[derive(Accounts)]
pub struct EmergencyTripBreaker<'info> {
    /// Sentinel keeper or Admin signer
    pub guardian_or_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_CONFIG_SEED, vault_config.token_mint.as_ref()],
        bump = vault_config.bump,
        constraint = (
            guardian_or_admin.key() == vault_config.guardian || 
            guardian_or_admin.key() == vault_config.admin
        ) @ AegisError::UnauthorizedCaller
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
pub struct ResolveBreaker<'info> {
    /// SuperAdmin only (multi-sig Cold Storage)
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_CONFIG_SEED, vault_config.token_mint.as_ref()],
        bump = vault_config.bump,
        has_one = admin @ AegisError::UnauthorizedCaller
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

pub fn handle_emergency_trip(ctx: Context<EmergencyTripBreaker>, reason_code: u8) -> Result<()> {
    let vault_config = &mut ctx.accounts.vault_config;
    require!(vault_config.is_active, AegisError::BreakerStateUnchanged);

    vault_config.is_active = false;
    let clock = Clock::get()?;

    emit!(BreakerManualTripEvent {
        vault: vault_config.key(),
        actor: ctx.accounts.guardian_or_admin.key(),
        reason_code,
        slot: clock.slot,
    });

    msg!("CIRCUIT BREAKER ENGAGED. Vault quarantined by: {}", ctx.accounts.guardian_or_admin.key());
    Ok(())
}

pub fn handle_resolve_breaker(ctx: Context<ResolveBreaker>) -> Result<()> {
    let vault_config = &mut ctx.accounts.vault_config;
    require!(!vault_config.is_active, AegisError::BreakerStateUnchanged);

    let clock = Clock::get()?;
    vault_config.is_active = true;
    vault_config.current_epoch_start_slot = clock.slot;
    vault_config.current_epoch_withdrawn_volume = 0;

    emit!(BreakerResolvedEvent {
        vault: vault_config.key(),
        admin: ctx.accounts.admin.key(),
        slot: clock.slot,
    });

    msg!("CIRCUIT BREAKER RESOLVED. Normal vault processing restored by admin: {}", ctx.accounts.admin.key());
    Ok(())
}

#[event]
pub struct BreakerManualTripEvent {
    pub vault: Pubkey,
    pub actor: Pubkey,
    pub reason_code: u8,
    pub slot: u64,
}

#[event]
pub struct BreakerResolvedEvent {
    pub vault: Pubkey,
    pub admin: Pubkey,
    pub slot: u64,
}