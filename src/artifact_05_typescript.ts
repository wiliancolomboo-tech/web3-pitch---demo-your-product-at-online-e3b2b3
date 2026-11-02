import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolSentinel } from "../target/types/sol_sentinel";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("SolSentinel Protocol - Verification Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolSentinel as Program<SolSentinel>;

  let mint: PublicKey;
  let senderTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;

  const sender = (provider.wallet as anchor.Wallet).payer;
  const recipient = Keypair.generate();
  const oracle = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  const streamId = new anchor.BN(42);
  const totalDeposit = new anchor.BN(1_000_000_000); // 1,000 tokens
  const milestoneCount = 4;

  let escrowPda: PublicKey;
  let vaultPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test participants
    const txAirdrop = await provider.connection.requestAirdrop(recipient.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(txAirdrop);

    // Initialize Mint
    mint = await createMint(
      provider.connection,
      sender,
      sender.publicKey,
      null,
      6
    );

    // Token Accounts
    senderTokenAccount = await createAccount(
      provider.connection,
      sender,
      mint,
      sender.publicKey
    );

    recipientTokenAccount = await createAccount(
      provider.connection,
      sender,
      mint,
      recipient.publicKey
    );

    // Mint funds to sender
    await mintTo(
      provider.connection,
      sender,
      mint,
      senderTokenAccount,
      sender,
      5_000_000_000
    );

    // Derive PDAs
    [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("sentinel_escrow"),
        sender.publicKey.toBuffer(),
        recipient.publicKey.toBuffer(),
        streamId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("sentinel_vault"),
        sender.publicKey.toBuffer(),
        recipient.publicKey.toBuffer(),
        streamId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
  });

  it("1. Successfully creates milestone stream and locks funds in Vault PDA", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now);
    const endTime = new anchor.BN(now + 3600); // 1 hour duration

    await program.methods
      .createStream(
        streamId,
        totalDeposit,
        startTime,
        endTime,
        milestoneCount,
        oracle.publicKey
      )
      .accounts({
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        tokenMint: mint,
        senderToken: senderTokenAccount,
        escrowAccount: escrowPda,
        vaultAccount: vaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const escrow = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrow.streamId.toString()).to.equal(streamId.toString());
    expect(escrow.totalDeposit.toString()).to.equal(totalDeposit.toString());
    expect(escrow.claimedAmount.toNumber()).to.equal(0);
    expect(escrow.milestonesCompleted).to.equal(0);

    const vaultInfo = await getAccount(provider.connection, vaultPda);
    expect(vaultInfo.amount.toString()).to.equal(totalDeposit.toString());
  });

  it("2. Rejects unauthorized attempts to attest milestone", async () => {
    try {
      await program.methods
        .attestMilestone(1)
        .accounts({
          signer: unauthorizedUser.publicKey,
          escrowAccount: escrowPda,
        })
        .signers([unauthorizedUser])
        .rpc();
      expect.fail("Should have thrown UnauthorizedOracle");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedOracle");
    }
  });

  it("3. Rejects out-of-order milestone attestation", async () => {
    try {
      await program.methods
        .attestMilestone(2) // Attempting milestone 2 before 1
        .accounts({
          signer: oracle.publicKey,
          escrowAccount: escrowPda,
        })
        .signers([oracle])
        .rpc();
      expect.fail("Should have thrown NonSequentialMilestone");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("NonSequentialMilestone");
    }
  });

  it("4. Oracle successfully attests Milestone 1", async () => {
    await program.methods
      .attestMilestone(1)
      .accounts({
        signer: oracle.publicKey,
        escrowAccount: escrowPda,
      })
      .signers([oracle])
      .rpc();

    const escrow = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrow.milestonesCompleted).to.equal(1);
  });

  it("5. Allows beneficiary to claim partial vested tokens within milestone gate", async () => {
    // Milestone 1 allows unlocking up to 25% (250,000,000)
    const claimAmount = new anchor.BN(100_000_000);

    await program.methods
      .claim(claimAmount)
      .accounts({
        recipient: recipient.publicKey,
        recipientToken: recipientTokenAccount,
        escrowAccount: escrowPda,
        vaultAccount: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([recipient])
      .rpc();

    const escrow = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrow.claimedAmount.toString()).to.equal(claimAmount.toString());

    const recipientBalance = await getAccount(provider.connection, recipientTokenAccount);
    expect(recipientBalance.amount.toString()).to.equal(claimAmount.toString());
  });

  it("6. Rejects claims exceeding current unlocked cap", async () => {
    // Current cap is 250,000,000, already claimed 100,000,000. Maximum claimable is 150,000,000.
    const excessiveClaim = new anchor.BN(500_000_000);

    try {
      await program.methods
        .claim(excessiveClaim)
        .accounts({
          recipient: recipient.publicKey,
          recipientToken: recipientTokenAccount,
          escrowAccount: escrowPda,
          vaultAccount: vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([recipient])
        .rpc();
      expect.fail("Should have rejected claim exceeding cap");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ExceedsClaimable");
    }
  });

  it("7. Executes safe cancellation with proportional clawback & payout", async () => {
    const preSenderBalance = (await getAccount(provider.connection, senderTokenAccount)).amount;
    const preRecipientBalance = (await getAccount(provider.connection, recipientTokenAccount)).amount;

    await program.methods
      .cancelStream()
      .accounts({
        sender: sender.publicKey,
        senderToken: senderTokenAccount,
        recipientToken: recipientTokenAccount,
        escrowAccount: escrowPda,
        vaultAccount: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const postSenderBalance = (await getAccount(provider.connection, senderTokenAccount)).amount;
    const postRecipientBalance = (await getAccount(provider.connection, recipientTokenAccount)).amount;
    const escrow = await program.account.escrowAccount.fetch(escrowPda);

    expect(escrow.isCancelled).to.be.true;
    // Sender gets the unvested tokens back
    expect(postSenderBalance > preSenderBalance).to.be.true;
    // Recipient receives remaining unlocked balance
    expect(postRecipientBalance >= preRecipientBalance).to.be.true;

    // Vault should now be completely drained
    const vault = await getAccount(provider.connection, vaultPda);
    expect(vault.amount.toString()).to.equal("0");
  });
});