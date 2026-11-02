use anchor_lang::prelude::*;
use anchor_lang::solana_program::clock::Clock;

declare_id!("KroN8sP2K6E8oE2yUqXyZ8aK9r4xN2cW1vM4bY3zT9P");

#[program]
pub mod kronos_sentinel {
    use super::*;

    /// Initializes a new Kronos Sentinel Treasury Vault with policy limits
    pub fn initialize_sentinel(
        ctx: Context<InitializeSentinel>,
        risk_threshold_bps: u16,
        cooldown_seconds: i64,
        max_drawdown_limit: u64,
    ) -> Result<()> {
        require!(risk_threshold_bps <= 10_000, KronosError::InvalidBps);
        require!(cooldown_seconds >= 0, KronosError::InvalidCooldown);

        let sentinel = &mut ctx.accounts.sentinel;
        sentinel.authority = ctx.accounts.authority.key();
        sentinel.vault = ctx.accounts.vault.key();
        sentinel.risk_threshold_bps = risk_threshold_bps;
        sentinel.cooldown_seconds = cooldown_seconds;
        sentinel.max_drawdown_limit = max_drawdown_limit;
        sentinel.last_rebalance_ts = Clock::get()?.unix_timestamp;
        sentinel.total_drawdown_accumulated = 0;
        sentinel.is_paused = false;
        sentinel.bump = ctx.bumps.sentinel;

        emit!(SentinelInitializedEvent {
            sentinel: sentinel.key(),
            authority: sentinel.authority,
            risk_threshold_bps,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Deposits funds into the Sentinel Vault
    pub fn deposit_funds(ctx: Context<DepositFunds>, amount: u64) -> Result<()> {
        require!(amount > 0, KronosError::ZeroAmount);

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, amount)?;

        emit!(FundsDepositedEvent {
            sentinel: ctx.accounts.sentinel.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
            new_balance: ctx.accounts.vault.to_account_info().lamports(),
        });

        Ok(())
    }

    /// Triggers an autonomous circuit-breaker rebalance when risk thresholds are breached
    pub fn trigger_rebalance(
        ctx: Context<TriggerRebalance>,
        simulated_loss_bps: u16,
        rebalance_amount: u64,
    ) -> Result<()> {
        let sentinel = &mut ctx.accounts.sentinel;
        let clock = Clock::get()?;

        require!(!sentinel.is_paused, KronosError::ProtocolPaused);
        require!(
            clock.unix_timestamp >= sentinel.last_rebalance_ts + sentinel.cooldown_seconds,
            KronosError::CooldownActive
        );
        require!(
            simulated_loss_bps >= sentinel.risk_threshold_bps,
            KronosError::ThresholdNotMet
        );

        let vault_balance = ctx.accounts.vault.to_account_info().lamports();
        require!(rebalance_amount <= vault_balance, KronosError::InsufficientVaultBalance);

        // Track cumulative loss impact
        sentinel.total_drawdown_accumulated = sentinel
            .total_drawdown_accumulated
            .checked_add(rebalance_amount)
            .ok_or(KronosError::MathOverflow)?;

        // Trip emergency circuit breaker if max allowed cumulative drawdown exceeded
        if sentinel.total_drawdown_accumulated >= sentinel.max_drawdown_limit {
            sentinel.is_paused = true;
            emit!(CircuitBreakerTrippedEvent {
                sentinel: sentinel.key(),
                total_drawdown: sentinel.total_drawdown_accumulated,
                limit: sentinel.max_drawdown_limit,
                timestamp: clock.unix_timestamp,
            });
        }

        sentinel.last_rebalance_ts = clock.unix_timestamp;

        // Perform safe internal rebalance transfer to the authorized reserve destination
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .vault
            .to_account_info()
            .lamports()
            .checked_sub(rebalance_amount)
            .ok_or(KronosError::MathOverflow)?;

        **ctx.accounts.reserve_destination.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .reserve_destination
            .to_account_info()
            .lamports()
            .checked_add(rebalance_amount)
            .ok_or(KronosError::MathOverflow)?;

        emit!(RebalanceExecutedEvent {
            sentinel: sentinel.key(),
            rebalanced_amount: rebalance_amount,
            remaining_balance: ctx.accounts.vault.to_account_info().lamports(),
            executed_by: ctx.accounts.keeper.key(),
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Emergency override for governance authority to unpause or recalibrate limits
    pub fn emergency_override(
        ctx: Context<EmergencyOverride>,
        resume: bool,
        new_risk_threshold_bps: Option<u16>,
        reset_drawdown: bool,
    ) -> Result<()> {
        let sentinel = &mut ctx.accounts.sentinel;

        if let Some(new_threshold) = new_risk_threshold_bps {
            require!(new_threshold <= 10_000, KronosError::InvalidBps);
            sentinel.risk_threshold_bps = new_threshold;
        }

        if reset_drawdown {
            sentinel.total_drawdown_accumulated = 0;
        }

        sentinel.is_paused = !resume;

        emit!(EmergencyActionExecutedEvent {
            sentinel: sentinel.key(),
            is_paused: sentinel.is_paused,
            new_risk_threshold: sentinel.risk_threshold_bps,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Account Contexts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeSentinel<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + SentinelState::INIT_SPACE,
        seeds = [b"sentinel_state", authority.key().as_ref()],
        bump
    )]
    pub sentinel: Account<'info, SentinelState>,

    /// CHECK: Vault PDA derived deterministically from sentinel seed
    #[account(
        mut,
        seeds = [b"sentinel_vault", sentinel.key().as_ref()],
        bump
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositFunds<'info> {
    #[account(
        mut,
        has_one = vault,
    )]
    pub sentinel: Account<'info, SentinelState>,

    /// CHECK: Target vault verified by has_one constraint
    #[account(mut)]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TriggerRebalance<'info> {
    #[account(
        mut,
        has_one = vault,
    )]
    pub sentinel: Account<'info, SentinelState>,

    /// CHECK: Validated by sentinel account constraint
    #[account(
        mut,
        seeds = [b"sentinel_vault", sentinel.key().as_ref()],
        bump
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: Safe storage account designated to hold protected capital
    #[account(mut)]
    pub reserve_destination: AccountInfo<'info>,

    #[account(mut)]
    pub keeper: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EmergencyOverride<'info> {
    #[account(
        mut,
        has_one = authority @ KronosError::Unauthorized
    )]
    pub sentinel: Account<'info, SentinelState>,

    pub authority: Signer<'info>,
}

// -----------------------------------------------------------------------------
// State Structs
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct SentinelState {
    pub authority: Pubkey,                // 32
    pub vault: Pubkey,                    // 32
    pub risk_threshold_bps: u16,          // 2
    pub cooldown_seconds: i64,            // 8
    pub max_drawdown_limit: u64,          // 8
    pub last_rebalance_ts: i64,           // 8
    pub total_drawdown_accumulated: u64,  // 8
    pub is_paused: bool,                  // 1
    pub bump: u8,                         // 1
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

#[event]
pub struct SentinelInitializedEvent {
    pub sentinel: Pubkey,
    pub authority: Pubkey,
    pub risk_threshold_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct FundsDepositedEvent {
    pub sentinel: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct RebalanceExecutedEvent {
    pub sentinel: Pubkey,
    pub rebalanced_amount: u64,
    pub remaining_balance: u64,
    pub executed_by: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct CircuitBreakerTrippedEvent {
    pub sentinel: Pubkey,
    pub total_drawdown: u64,
    pub limit: u64,
    pub timestamp: i64,
}

#[event]
pub struct EmergencyActionExecutedEvent {
    pub sentinel: Pubkey,
    pub is_paused: bool,
    pub new_risk_threshold: u16,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

#[error_code]
pub enum KronosError {
    #[msg("Basis points must be between 0 and 10,000")]
    InvalidBps,
    #[msg("Cooldown time must be non-negative")]
    InvalidCooldown,
    #[msg("Deposit amount must be strictly positive")]
    ZeroAmount,
    #[msg("The sentinel protocol is currently paused")]
    ProtocolPaused,
    #[msg("Execution cooldown window is currently active")]
    CooldownActive,
    #[msg("Simulated market loss does not breach risk threshold")]
    ThresholdNotMet,
    #[msg("Requested rebalance amount exceeds vault balance")]
    InsufficientVaultBalance,
    #[msg("Arithmetic calculation overflowed")]
    MathOverflow,
    #[msg("Unauthorized signer for governance operation")]
    Unauthorized,
}