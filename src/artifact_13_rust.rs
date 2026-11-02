use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("NexEscrow11111111111111111111111111111111111");

#[program]
pub mod nexus_escrow {
    use super::*;

    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        seed_id: u64,
        amount: u64,
        deadline: i64,
    ) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, seed_id, amount, deadline)
    }

    pub fn submit_milestone_delivery(
        ctx: Context<SubmitDelivery>,
        delivery_hash: [u8; 32],
    ) -> Result<()> {
        instructions::submit_delivery::handle_submit_delivery(ctx, delivery_hash)
    }

    pub fn verify_and_release(ctx: Context<VerifyAndRelease>) -> Result<()> {
        instructions::verify_and_release::handle_verify_and_release(ctx)
    }

    pub fn raise_dispute(ctx: Context<RaiseDispute>) -> Result<()> {
        instructions::resolve_dispute::handle_raise_dispute(ctx)
    }

    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        payer_refund: u64,
        contractor_payout: u64,
    ) -> Result<()> {
        instructions::resolve_dispute::handle_resolve_dispute(ctx, payer_refund, contractor_payout)
    }

    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        instructions::cancel_escrow::handle_cancel_escrow(ctx)
    }
}