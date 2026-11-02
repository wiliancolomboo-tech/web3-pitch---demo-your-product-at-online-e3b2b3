import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { NexusEscrow } from "../target/types/nexus_escrow";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("NexusEscrow Comprehensive End-to-End Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.NexusEscrow as Program<NexusEscrow>;

  const payer = (provider.wallet as any).payer as Keypair;
  const contractor = Keypair.generate();
  const arbiter = Keypair.generate();

  const seedId = new anchor.BN(Date.now());
  const escrowAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);

  let escrowPda: PublicKey;
  let escrowBump: number;
  let vaultPda: PublicKey;
  let vaultBump: number;

  before(async () => {
    // Airdrop SOL to test actors
    const sig1 = await provider.connection.requestAirdrop(contractor.publicKey, 2 * LAMPORTS_PER_SOL);
    const sig2 = await provider.connection.requestAirdrop(arbiter.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);

    [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), payer.publicKey.toBuffer(), seedId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );
  });

  it("TC-01: Successfully initializes escrow and locks funds in Vault PDA", async () => {
    const futureDeadline = new anchor.BN(Math.floor(Date.now() / 1000) + 10);

    const initialPayerBalance = await provider.connection.getBalance(payer.publicKey);

    await program.methods
      .initializeEscrow(seedId, escrowAmount, futureDeadline)
      .accounts({
        payer: payer.publicKey,
        contractor: contractor.publicKey,
        arbiter: arbiter.publicKey,
        escrowState: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.payer.toBase58()).to.equal(payer.publicKey.toBase58());
    expect(escrowAccount.contractor.toBase58()).to.equal(contractor.publicKey.toBase58());
    expect(escrowAccount.amount.toNumber()).to.equal(escrowAmount.toNumber());
    expect(escrowAccount.status).to.deep.equal({ funded: {} });

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.equal(escrowAmount.toNumber());
  });

  it("TC-02: Contractor submits work delivery hash", async () => {
    const rawDeliveryContent = "Git commit: a9b3c4f92d47e22138 Nexus Engine v1.0.0";
    const hash = crypto.createHash("sha256").update(rawDeliveryContent).digest();
    const deliveryHashArray = Array.from(new Uint8Array(hash));

    await program.methods
      .submitMilestoneDelivery(deliveryHashArray)
      .accounts({
        escrowState: escrowPda,
        contractor: contractor.publicKey,
      })
      .signers([contractor])
      .rpc();

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.status).to.deep.equal({ delivered: {} });
    expect(Buffer.from(escrowAccount.deliveryHash).toString("hex")).to.equal(hash.toString("hex"));
  });

  it("TC-03: Payer verifies work and releases payout to contractor", async () => {
    const contractorPreBalance = await provider.connection.getBalance(contractor.publicKey);

    await program.methods
      .verifyAndRelease()
      .accounts({
        escrowState: escrowPda,
        payer: payer.publicKey,
        vault: vaultPda,
        contractor: contractor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const contractorPostBalance = await provider.connection.getBalance(contractor.publicKey);
    expect(contractorPostBalance - contractorPreBalance).to.equal(escrowAmount.toNumber());

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.status).to.deep.equal({ completed: {} });

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.equal(0);
  });

  it("TC-04 Security Guard: Fails on double release attempt", async () => {
    try {
      await program.methods
        .verifyAndRelease()
        .accounts({
          escrowState: escrowPda,
          payer: payer.publicKey,
          vault: vaultPda,
          contractor: contractor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();
      expect.fail("Should have thrown InvalidState error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidState");
    }
  });

  it("TC-05: Arbiter can resolve contested milestone through dispute flow", async () => {
    const disputeSeed = new anchor.BN(Date.now() + 100);
    const [disputeEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), payer.publicKey.toBuffer(), disputeSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [disputeVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), disputeEscrowPda.toBuffer()],
      program.programId
    );

    const disputeDeadline = new anchor.BN(Math.floor(Date.now() / 1000) + 100);

    // Initialize
    await program.methods
      .initializeEscrow(disputeSeed, escrowAmount, disputeDeadline)
      .accounts({
        payer: payer.publicKey,
        contractor: contractor.publicKey,
        arbiter: arbiter.publicKey,
        escrowState: disputeEscrowPda,
        vault: disputeVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    // Raise Dispute
    await program.methods
      .raiseDispute()
      .accounts({
        escrowState: disputeEscrowPda,
        signer: payer.publicKey,
      })
      .signers([payer])
      .rpc();

    const disputedState = await program.account.escrowState.fetch(disputeEscrowPda);
    expect(disputedState.status).to.deep.equal({ disputed: {} });

    // Arbiter splits funds: 50% refund to payer, 50% payout to contractor
    const halfAmount = new anchor.BN(escrowAmount.toNumber() / 2);

    await program.methods
      .resolveDispute(halfAmount, halfAmount)
      .accounts({
        escrowState: disputeEscrowPda,
        arbiter: arbiter.publicKey,
        vault: disputeVaultPda,
        payer: payer.publicKey,
        contractor: contractor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([arbiter])
      .rpc();

    const resolvedState = await program.account.escrowState.fetch(disputeEscrowPda);
    expect(resolvedState.status).to.deep.equal({ completed: {} });
  });
});