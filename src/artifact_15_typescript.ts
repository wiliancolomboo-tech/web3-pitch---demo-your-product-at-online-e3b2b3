import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AegisVault } from "../target/types/aegis_vault";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("AegisVault Protocol Hardened Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AegisVault as Program<AegisVault>;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const guardian = Keypair.generate();
  const attacker = Keypair.generate();
  const legitimateUser = Keypair.generate();

  let tokenMint: PublicKey;
  let vaultConfigPda: PublicKey;
  let vaultConfigBump: number;
  let tokenVaultPda: PublicKey;
  let tokenVaultBump: number;

  const SINGLE_TX_LIMIT = new anchor.BN(50_000_000); // 50 tokens
  const EPOCH_VELOCITY_LIMIT = new anchor.BN(100_000_000); // 100 tokens
  const EPOCH_WINDOW_SLOTS = new anchor.BN(500);

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [guardian, attacker, legitimateUser]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Create Test Mint
    tokenMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Derive PDAs
    [vaultConfigPda, vaultConfigBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis-vault-config"), tokenMint.toBuffer()],
      program.programId
    );

    [tokenVaultPda, tokenVaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis-token-escrow"), vaultConfigPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes the AegisVault with deterministic safety parameters", async () => {
    await program.methods
      .initializeVault(SINGLE_TX_LIMIT, EPOCH_VELOCITY_LIMIT, EPOCH_WINDOW_SLOTS)
      .accountsPartial({
        admin: admin.publicKey,
        guardian: guardian.publicKey,
        tokenMint: tokenMint,
        vaultConfig: vaultConfigPda,
        tokenVault: tokenVaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.vaultConfig.fetch(vaultConfigPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.guardian.toBase58()).to.equal(guardian.publicKey.toBase58());
    expect(configAccount.isActive).to.be.true;
    expect(configAccount.singleTxLimit.toString()).to.equal(SINGLE_TX_LIMIT.toString());
  });

  it("2. Accepts legitimate deposits and tracks per-user ledger records", async () => {
    const userAta = await createAccount(
      provider.connection,
      legitimateUser,
      tokenMint,
      legitimateUser.publicKey
    );

    const depositAmount = new anchor.BN(200_000_000); // 200 tokens
    await mintTo(
      provider.connection,
      admin,
      tokenMint,
      userAta,
      admin,
      depositAmount.toNumber()
    );

    const [userRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis-user-record"), vaultConfigPda.toBuffer(), legitimateUser.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .deposit(depositAmount)
      .accountsPartial({
        user: legitimateUser.publicKey,
        vaultConfig: vaultConfigPda,
        tokenMint: tokenMint,
        userTokenAccount: userAta,
        tokenVault: tokenVaultPda,
        userRecord: userRecordPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([legitimateUser])
      .rpc();

    const record = await program.account.userRecord.fetch(userRecordPda);
    expect(record.depositedAmount.toString()).to.equal(depositAmount.toString());

    const vaultTokenAccount = await getAccount(provider.connection, tokenVaultPda);
    expect(vaultTokenAccount.amount.toString()).to.equal(depositAmount.toString());
  });

  it("3. Executes nominal withdrawals beneath the single-tx limit", async () => {
    const [userRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis-user-record"), vaultConfigPda.toBuffer(), legitimateUser.publicKey.toBuffer()],
      program.programId
    );

    const userAta = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: legitimateUser.publicKey,
    });

    const withdrawAmount = new anchor.BN(40_000_000); // 40 tokens (< 50 limit)

    await program.methods
      .withdraw(withdrawAmount)
      .accountsPartial({
        user: legitimateUser.publicKey,
        vaultConfig: vaultConfigPda,
        tokenMint: tokenMint,
        tokenVault: tokenVaultPda,
        userTokenAccount: userAta,
        userRecord: userRecordPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([legitimateUser])
      .rpc();

    const record = await program.account.userRecord.fetch(userRecordPda);
    expect(record.withdrawnAmount.toString()).to.equal(withdrawAmount.toString());
  });

  it("4. Automatically trips circuit-breaker when single-tx threshold is breached", async () => {
    const [userRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis-user-record"), vaultConfigPda.toBuffer(), legitimateUser.publicKey.toBuffer()],
      program.programId
    );

    const userAta = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: legitimateUser.publicKey,
    });

    const maliciousAmount = new anchor.BN(55_000_000); // 55 tokens (> 50 limit)

    try {
      await program.methods
        .withdraw(maliciousAmount)
        .accountsPartial({
          user: legitimateUser.publicKey,
          vaultConfig: vaultConfigPda,
          tokenMint: tokenMint,
          tokenVault: tokenVaultPda,
          userTokenAccount: userAta,
          userRecord: userRecordPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([legitimateUser])
        .rpc();

      expect.fail("Transaction should have failed with SingleTransactionLimitExceeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SingleTransactionLimitExceeded");
    }

    // Verify vault is now quarantined
    const config = await program.account.vaultConfig.fetch(vaultConfigPda);
    expect(config.isActive).to.be.false;
  });

  it("5. Rejects any operation while the vault is in Quarantined state", async () => {
    const [userRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis-user-record"), vaultConfigPda.toBuffer(), legitimateUser.publicKey.toBuffer()],
      program.programId
    );

    const userAta = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: legitimateUser.publicKey,
    });

    try {
      await program.methods
        .withdraw(new anchor.BN(1_000_000))
        .accountsPartial({
          user: legitimateUser.publicKey,
          vaultConfig: vaultConfigPda,
          tokenMint: tokenMint,
          tokenVault: tokenVaultPda,
          userTokenAccount: userAta,
          userRecord: userRecordPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([legitimateUser])
        .rpc();

      expect.fail("Operation should be blocked by circuit breaker");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("VaultFrozen");
    }
  });

  it("6. Prevents unauthorized actors from resolving the circuit breaker", async () => {
    try {
      await program.methods
        .resolveBreaker()
        .accountsPartial({
          admin: attacker.publicKey,
          vaultConfig: vaultConfigPda,
        })
        .signers([attacker])
        .rpc();

      expect.fail("Attacker should not be able to resolve breaker");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedCaller");
    }
  });

  it("7. Allows SuperAdmin to resolve breaker and restore operational balance", async () => {
    await program.methods
      .resolveBreaker()
      .accountsPartial({
        admin: admin.publicKey,
        vaultConfig: vaultConfigPda,
      })
      .signers([admin])
      .rpc();

    const config = await program.account.vaultConfig.fetch(vaultConfigPda);
    expect(config.isActive).to.be.true;
    expect(config.currentEpochWithdrawnVolume.toNumber()).to.equal(0);
  });
});