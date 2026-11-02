import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolflowGuardian } from "../target/types/solflow_guardian";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("solflow-guardian test matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolflowGuardian as Program<SolflowGuardian>;

  const admin = Keypair.generate();
  const guardian = Keypair.generate();
  const maliciousActor = Keypair.generate();
  const depositor = Keypair.generate();

  let tokenAMint: PublicKey;
  let tokenBMint: PublicKey;
  let depositorTokenA: PublicKey;
  let vaultAccountPda: PublicKey;
  let vaultBump: number;
  let vaultTokenA: Keypair;
  let vaultTokenB: Keypair;

  const MAX_HOURLY_DRAWDOWN_BPS = 500; // 5.00%
  const COOLDOWN_SECONDS = new anchor.BN(60); // 60 seconds

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [admin, guardian, maliciousActor, depositor]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      });
    }

    // Create Mints
    tokenAMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    tokenBMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    // Compute Vault PDA
    [vaultAccountPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("solflow_vault"), admin.publicKey.toBuffer()],
      program.programId
    );

    vaultTokenA = Keypair.generate();
    vaultTokenB = Keypair.generate();

    // Create depositor ATA & mint funds
    depositorTokenA = await createAccount(
      provider.connection,
      depositor,
      tokenAMint,
      depositor.publicKey
    );
    await mintTo(provider.connection, admin, tokenAMint, depositorTokenA, admin, 1_000_000_000);
  });

  it("1. Successfully initializes the vault with deterministic state", async () => {
    await program.methods
      .initializeVault(MAX_HOURLY_DRAWDOWN_BPS, COOLDOWN_SECONDS)
      .accounts({
        admin: admin.publicKey,
        guardian: guardian.publicKey,
        tokenAMint,
        tokenBMint,
        vaultAccount: vaultAccountPda,
        vaultTokenA: vaultTokenA.publicKey,
        vaultTokenB: vaultTokenB.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin, vaultTokenA, vaultTokenB])
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultAccountPda);
    assert.equal(vault.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(vault.guardian.toBase58(), guardian.publicKey.toBase58());
    assert.equal(vault.maxHourlyDrawdownBps, MAX_HOURLY_DRAWDOWN_BPS);
    assert.equal(vault.isFrozen, false);
    assert.equal(vault.bump, vaultBump);
  });

  it("2. Rejects initialization with invalid drawdown thresholds (> 50%)", async () => {
    const invalidAdmin = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(invalidAdmin.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      signature: sig,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    const [invalidVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("solflow_vault"), invalidAdmin.publicKey.toBuffer()],
      program.programId
    );
    const tempA = Keypair.generate();
    const tempB = Keypair.generate();

    try {
      await program.methods
        .initializeVault(5001, COOLDOWN_SECONDS) // 50.01% exceeds MAX_DRAWDOWN_LIMIT_BPS
        .accounts({
          admin: invalidAdmin.publicKey,
          guardian: guardian.publicKey,
          tokenAMint,
          tokenBMint,
          vaultAccount: invalidVaultPda,
          vaultTokenA: tempA.publicKey,
          vaultTokenB: tempB.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([invalidAdmin, tempA, tempB])
        .rpc();
      assert.fail("Should have failed with InvalidDrawdownLimit");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidDrawdownLimit");
    }
  });

  it("3. Accepts deposits from legitimate depositors", async () => {
    const depositAmount = new anchor.BN(50_000_000); // 50 Tokens

    await program.methods
      .depositFunds(depositAmount)
      .accounts({
        depositor: depositor.publicKey,
        vaultAccount: vaultAccountPda,
        depositorToken: depositorTokenA,
        vaultToken: vaultTokenA.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();

    const vaultBalance = await getAccount(provider.connection, vaultTokenA.publicKey);
    assert.equal(vaultBalance.amount.toString(), depositAmount.toString());
  });

  it("4. Prevents unauthorized actors from triggering the circuit breaker", async () => {
    try {
      await program.methods
        .triggerCircuitBreaker(600, 1)
        .accounts({
          guardian: maliciousActor.publicKey,
          vaultAccount: vaultAccountPda,
        })
        .signers([maliciousActor])
        .rpc();
      assert.fail("Malicious caller should have been rejected");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedGuardian");
    }
  });

  it("5. Allows designated Guardian to trip circuit breaker when threshold exceeded", async () => {
    const breachBps = 750; // 7.5% > 5.0%

    await program.methods
      .triggerCircuitBreaker(breachBps, 1)
      .accounts({
        guardian: guardian.publicKey,
        vaultAccount: vaultAccountPda,
      })
      .signers([guardian])
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultAccountPda);
    assert.equal(vault.isFrozen, true);
    assert.equal(vault.hourlyCumulativeDrawdownBps, breachBps);
  });

  it("6. Rejects further deposits while vault is frozen", async () => {
    try {
      await program.methods
        .depositFunds(new anchor.BN(1_000_000))
        .accounts({
          depositor: depositor.publicKey,
          vaultAccount: vaultAccountPda,
          depositorToken: depositorTokenA,
          vaultToken: vaultTokenA.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc();
      assert.fail("Deposits must fail during frozen state");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("VaultIsFrozen");
    }
  });

  it("7. Allows Admin to safely unfreeze vault after review", async () => {
    await program.methods
      .unfreezeVault()
      .accounts({
        admin: admin.publicKey,
        vaultAccount: vaultAccountPda,
      })
      .signers([admin])
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultAccountPda);
    assert.equal(vault.isFrozen, false);
    assert.equal(vault.hourlyCumulativeDrawdownBps, 0);
  });
});