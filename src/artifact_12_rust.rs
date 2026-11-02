use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Aegis11111111111111111111111111111111111111");

#[program]
pub mod aegis_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        single_tx_limit: u64,
        epoch_velocity_limit: u64,
        epoch_window_slots: u64,
    ) -> Result<()> {
        instructions::admin::handle_initialize_vault(
            ctx,
            single_tx_limit,
            epoch_velocity_limit,
            epoch_window_slots,
        )
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handle_withdraw(ctx, amount)
    }

    pub fn emergency_trip(ctx: Context<EmergencyTripBreaker>, reason_code: u8) -> Result<()> {
        instructions::breaker::handle_emergency_trip(ctx, reason_code)
    }

    pub fn resolve_breaker(ctx: Context<ResolveBreaker>) -> Result<()> {
        instructions::breaker::handle_resolve_breaker(ctx)
    }
}