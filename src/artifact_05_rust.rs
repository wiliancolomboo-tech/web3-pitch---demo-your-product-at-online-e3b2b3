use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("SFG1111111111111111111111111111111111111111");

pub const VAULT_SEED: &[u8] = b"solflow_vault";
pub const MAX_BPS: u16 = 10_000;
pub const MAX_DRAWDOWN_LIMIT_BPS: u16 = 5_000; // 50% max allowed by protocol

#[program]
pub mod solflow_guardian {
    use super::*;

    /// Initialize an Enterprise Treasury Vault protected by SolFlow Guardian
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        max_hourly_drawdown_bps: u16,
        cooldown_period_seconds: i64,
    ) -> Result<()> {
        require!(
            max_hourly_drawdown_bps > 0 && max_hourly_drawdown_bps <= MAX_DRAWDOWN_LIMIT_BPS,
            ErrorCode::InvalidDrawdownLimit
        );
        require!(
            cooldown_period_seconds >= 60,
            ErrorCode::InvalidCooldownPeriod
        );

        let vault = &mut ctx.accounts.vault_account;
        vault.admin = ctx.accounts.admin.key();
        vault.guardian = ctx.accounts.guardian.key();
        vault.token_a_mint = ctx.accounts.token_a_mint.key();
        vault.token_b_mint = ctx.accounts.token_b_mint.key();
        vault.vault_token_a = ctx.accounts.vault_token_a.key();
        vault.vault_token_b = ctx.accounts.vault_token_b.key();
        vault.max_hourly_drawdown_bps = max_hourly_drawdown_bps;
        vault.cooldown_period_seconds = cooldown_period_seconds;
        vault.is_frozen = false;
        vault.last_rebalance_timestamp = Clock::get()?.unix_timestamp;
        vault.hourly_cumulative_drawdown_bps = 0;
        vault.bump = ctx.bumps.vault_account;

        emit!(VaultInitializedEvent {
            vault: vault.key(),
            admin: vault.admin,
            guardian: vault.guardian,
            max_hourly_drawdown_bps,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Deposits funds into the managed treasury vault
    pub fn deposit_funds(ctx: Context<DepositFunds>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroDepositAmount);
        require!(!ctx.accounts.vault_account.is_frozen, ErrorCode::VaultIsFrozen);

        let cpi_accounts = Transfer {
            from: ctx.accounts.depositor_token.to_account_info(),
            to: ctx.accounts.vault_token.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(DepositEvent {
            vault: ctx.accounts.vault_account.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Triggers an immediate emergency freeze when adverse market drift is detected
    pub fn trigger_circuit_breaker(
        ctx: Context<TriggerCircuitBreaker>,
        observed_drawdown_bps: u16,
        reason_code: u8,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault_account;
        let current_time = Clock::get()?.unix_timestamp;

        require!(!vault.is_frozen, ErrorCode::AlreadyFrozen);
        require!(
            observed_drawdown_bps >= vault.max_hourly_drawdown_bps,
            ErrorCode::ThresholdNotExceeded
        );

        vault.is_frozen = true;
        vault.hourly_cumulative_drawdown_bps = observed_drawdown_bps;

        emit!(CircuitBreakerTrippedEvent {
            vault: vault.key(),
            triggered_by: ctx.accounts.guardian.key(),
            observed_drawdown_bps,
            reason_code,
            timestamp: current_time,
        });

        Ok(())
    }

    /// Rebalances treasury balances between Token A (Risk Asset) and Token B (Safe Asset)
    pub fn execute_rebalance(
        ctx: Context<ExecuteRebalance>,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault_account;
        let current_time = Clock::get()?.unix_timestamp;

        require!(!vault.is_frozen, ErrorCode::VaultIsFrozen);
        require!(amount_in > 0, ErrorCode::InvalidRebalanceAmount);
        require!(
            current_time - vault.last_rebalance_timestamp >= vault.cooldown_period_seconds,
            ErrorCode::CooldownActive
        );

        // Vault PDA seeds for signing the transfer
        let admin_key = vault.admin;
        let bump = vault.bump;
        let seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            admin_key.as_ref(),
            &[bump],
        ]];

        // Transfer funds from Vault Token A to external executor/destination
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_a.to_account_info(),
            to: ctx.accounts.destination_token_a.to_account_info(),
            authority: vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            seeds,
        );
        token::transfer(cpi_ctx, amount_in)?;

        vault.last_rebalance_timestamp = current_time;

        emit!(RebalanceExecutedEvent {
            vault: vault.key(),
            executor: ctx.accounts.guardian.key(),
            amount_in,
            min_amount_out,
            timestamp: current_time,
        });

        Ok(())
    }

    /// Unfreezes the vault after risk review by Governance Admin
    pub fn unfreeze_vault(ctx: Context<AdminUnfreeze>) -> Result<()> {
        let vault = &mut ctx.accounts.vault_account;
        require!(vault.is_frozen, ErrorCode::NotFrozen);

        vault.is_frozen = false;
        vault.hourly_cumulative_drawdown_bps = 0;
        vault.last_rebalance_timestamp = Clock::get()?.unix_timestamp;

        emit!(VaultUnfrozenEvent {
            vault: vault.key(),
            admin: ctx.accounts.admin.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Safe delegated off-chain automated sentinel key
    pub guardian: AccountInfo<'info>,

    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [VAULT_SEED, admin.key().as_ref()],
        bump
    )]
    pub vault_account: Account<'info, VaultState>,

    #[account(
        init,
        payer = admin,
        token::mint = token_a_mint,
        token::authority = vault_account
    )]
    pub vault_token_a: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        token::mint = token_b_mint,
        token::authority = vault_account
    )]
    pub vault_token_b: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositFunds<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault_account.admin.as_ref()],
        bump = vault_account.bump
    )]
    pub vault_account: Account<'info, VaultState>,

    #[account(mut)]
    pub depositor_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_token.key() == vault_account.vault_token_a 
                  || vault_token.key() == vault_account.vault_token_b @ ErrorCode::InvalidTokenAccount
    )]
    pub vault_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TriggerCircuitBreaker<'info> {
    #[account(
        constraint = guardian.key() == vault_account.guardian || guardian.key() == vault_account.admin @ ErrorCode::UnauthorizedGuardian
    )]
    pub guardian: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault_account.admin.as_ref()],
        bump = vault_account.bump
    )]
    pub vault_account: Account<'info, VaultState>,
}

#[derive(Accounts)]
pub struct ExecuteRebalance<'info> {
    #[account(
        constraint = guardian.key() == vault_account.guardian || guardian.key() == vault_account.admin @ ErrorCode::UnauthorizedGuardian
    )]
    pub guardian: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault_account.admin.as_ref()],
        bump = vault_account.bump
    )]
    pub vault_account: Account<'info, VaultState>,

    #[account(
        mut,
        constraint = vault_token_a.key() == vault_account.vault_token_a @ ErrorCode::InvalidTokenAccount
    )]
    pub vault_token_a: Account<'info, TokenAccount>,

    #[account(mut)]
    pub destination_token_a: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminUnfreeze<'info> {
    #[account(
        constraint = admin.key() == vault_account.admin @ ErrorCode::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault_account.admin.as_ref()],
        bump = vault_account.bump
    )]
    pub vault_account: Account<'info, VaultState>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub admin: Pubkey,                         // 32
    pub guardian: Pubkey,                      // 32
    pub token_a_mint: Pubkey,                  // 32
    pub token_b_mint: Pubkey,                  // 32
    pub vault_token_a: Pubkey,                 // 32
    pub vault_token_b: Pubkey,                 // 32
    pub max_hourly_drawdown_bps: u16,          // 2
    pub hourly_cumulative_drawdown_bps: u16,   // 2
    pub cooldown_period_seconds: i64,          // 8
    pub last_rebalance_timestamp: i64,         // 8
    pub is_frozen: bool,                       // 1
    pub bump: u8,                              // 1
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct VaultInitializedEvent {
    pub vault: Pubkey,
    pub admin: Pubkey,
    pub guardian: Pubkey,
    pub max_hourly_drawdown_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct DepositEvent {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct CircuitBreakerTrippedEvent {
    pub vault: Pubkey,
    pub triggered_by: Pubkey,
    pub observed_drawdown_bps: u16,
    pub reason_code: u8,
    pub timestamp: i64,
}

#[event]
pub struct RebalanceExecutedEvent {
    pub vault: Pubkey,
    pub executor: Pubkey,
    pub amount_in: u64,
    pub min_amount_out: u64,
    pub timestamp: i64,
}

#[event]
pub struct VaultUnfrozenEvent {
    pub vault: Pubkey,
    pub admin: Pubkey,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum ErrorCode {
    #[msg("Drawdown basis points must be between 1 and 5000 (0.01% - 50.00%)")]
    InvalidDrawdownLimit,
    #[msg("Cooldown period must be at least 60 seconds")]
    InvalidCooldownPeriod,
    #[msg("Deposit amount must be strictly greater than zero")]
    ZeroDepositAmount,
    #[msg("Treasury Vault is currently frozen by Circuit Breaker")]
    VaultIsFrozen,
    #[msg("Vault is already in a frozen state")]
    AlreadyFrozen,
    #[msg("Vault is not currently frozen")]
    NotFrozen,
    #[msg("Observed drawdown does not meet or exceed the trigger threshold")]
    ThresholdNotExceeded,
    #[msg("Rebalance cooldown timer has not yet elapsed")]
    CooldownActive,
    #[msg("Rebalance amount must be greater than zero")]
    InvalidRebalanceAmount,
    #[msg("Invalid token account passed for this vault")]
    InvalidTokenAccount,
    #[msg("Unauthorized: Caller is neither the designated Guardian nor Admin")]
    UnauthorizedGuardian,
    #[msg("Unauthorized: Caller is not the designated Vault Admin")]
    UnauthorizedAdmin,
}