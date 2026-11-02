use anchor_lang::prelude::*;
use crate::state::{StreamState, StreamStatus};
use crate::errors::SentinelError;
use crate::events::DisputeResolvedEvent;

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        has_one = arbiter @ SentinelError::Unauthorized,
        constraint = stream_state.status == StreamStatus::Disputed @ SentinelError::StreamNotActive
    )]
    pub stream_state: Account<'info, StreamState>,
    pub arbiter: Signer<'info>,

    /// CHECK: Verified against stream_state.payee
    #[account(mut, address = stream_state.payee)]
    pub payee: AccountInfo<'info>,

    /// CHECK: Verified against stream_state.payer
    #[account(mut, address = stream_state.payer)]
    pub payer: AccountInfo<'info>,

    /// CHECK: Vault holding remaining balance
    #[account(
        mut,
        seeds = [b"stream_vault", stream_state.key().as_ref()],
        bump = stream_state.vault_bump
    )]
    pub stream_vault: AccountInfo<'info>,
}

pub fn handler(
    ctx: Context<ResolveDispute>,
    payee_lamports: u64,
    payer_refund_lamports: u64,
) -> Result<()> {
    let stream = &mut ctx.accounts.stream_state;
    let vault_lamports = ctx.accounts.stream_vault.lamports();

    require!(
        payee_lamports.checked_add(payer_refund_lamports).unwrap() <= vault_lamports,
        SentinelError::DisputeResolutionMismatch
    );

    if payee_lamports > 0 {
        **ctx.accounts.stream_vault.try_borrow_mut_lamports()? -= payee_lamports;
        **ctx.accounts.payee.try_borrow_mut_lamports()? += payee_lamports;
    }

    if payer_refund_lamports > 0 {
        **ctx.accounts.stream_vault.try_borrow_mut_lamports()? -= payer_refund_lamports;
        **ctx.accounts.payer.try_borrow_mut_lamports()? += payer_refund_lamports;
    }

    stream.status = StreamStatus::Resolved;
    stream.released_amount += payee_lamports;

    let clock = Clock::get()?;
    emit!(DisputeResolvedEvent {
        stream_id: stream.stream_id,
        payee_lamports,
        payer_refund_lamports,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}