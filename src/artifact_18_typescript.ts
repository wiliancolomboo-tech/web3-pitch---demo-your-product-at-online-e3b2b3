import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { AegisStream } from "../target/types/aegis_stream";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("aegis_stream enterprise test matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AegisStream as Program<AegisStream>;

  const sender = (provider.wallet as anchor.Wallet).payer;
  const recipient = Keypair.generate();
  const arbiter = Keypair.generate();

  let mint: PublicKey;
  let senderTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;

  const depositAmount = new BN(1_000_000_000); // 1,000 Tokens (6 decimals)
  const streamDuration = 10; // 10 seconds

  before(async () => {
    // Airdrop SOL to test actors
    const sig1 = await provider.connection.requestAirdrop(recipient.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    const sig2 = await provider.connection.requestAirdrop(arbiter.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);

    // Initialize Mint
    mint = await createMint(
      provider.connection,
      sender,
      sender.publicKey,
      null,
      6
    );

    // Setup Token Accounts
    senderTokenAccount = await createAccount(provider.connection, sender, mint, sender.publicKey);
    recipientTokenAccount = await createAccount(provider.connection, sender, mint, recipient.publicKey);

    // Mint tokens to sender
    await mintTo(provider.connection, sender, mint, senderTokenAccount, sender, 10_000_000_000);
  });

  it("1. Successfully initializes a milestone-locked stream", async () => {
    const streamSeed = new BN(1001);
    const now = Math.floor(Date.now() / 1000);
    const startTime = new BN(now);
    const endTime = new BN(now + streamDuration);
    const cliffTime = new BN(now);

    const [streamPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("stream"), sender.publicKey.toBuffer(), streamSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), streamPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeStream(
        streamSeed,
        depositAmount,
        startTime,
        endTime,
        cliffTime,
        true // requires_milestone = true
      )
      .accounts({
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        arbiter: arbiter.publicKey,
        mint: mint,
        senderTokenAccount: senderTokenAccount,
        streamState: streamPda,
        streamVault: vaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const streamAccount = await program.account.streamState.fetch(streamPda);
    expect(streamAccount.depositAmount.eq(depositAmount)).to.be.true;
    expect(streamAccount.amountWithdrawn.toNumber()).to.equal(0);
    expect(streamAccount.requiresMilestone).to.be.true;
    expect(streamAccount.milestoneApproved).to.be.false;

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(depositAmount.toNumber());
  });

  it("2. Fails withdrawal when milestone is unapproved", async () => {
    const streamSeed = new BN(1001);
    const [streamPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("stream"), sender.publicKey.toBuffer(), streamSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), streamPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .withdraw()
        .accounts({
          recipient: recipient.publicKey,
          streamState: streamPda,
          mint: mint,
          streamVault: vaultPda,
          recipientTokenAccount: recipientTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([recipient])
        .rpc();
      expect.fail("Expected transaction to fail due to unapproved milestone");
    } catch (err: any) {
      expect(err.toString()).to.include("MilestoneNotApproved");
    }
  });

  it("3. Arbiter approves milestone, permitting partial linear withdrawal", async () => {
    const streamSeed = new BN(1001);
    const [streamPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("stream"), sender.publicKey.toBuffer(), streamSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), streamPda.toBuffer()],
      program.programId
    );

    // Arbiter completes the milestone
    await program.methods
      .completeMilestone()
      .accounts({
        arbiter: arbiter.publicKey,
        streamState: streamPda,
      })
      .signers([arbiter])
      .rpc();

    const streamAccount = await program.account.streamState.fetch(streamPda);
    expect(streamAccount.milestoneApproved).to.be.true;

    // Wait 3 seconds to accumulate linear vesting
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Recipient claims vested tokens
    await program.methods
      .withdraw()
      .accounts({
        recipient: recipient.publicKey,
        streamState: streamPda,
        mint: mint,
        streamVault: vaultPda,
        recipientTokenAccount: recipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([recipient])
      .rpc();

    const recipientAccount = await getAccount(provider.connection, recipientTokenAccount);
    expect(Number(recipientAccount.amount)).to.be.greaterThan(0);
  });

  it("4. Deterministic Clawback splits unvested capital to sender and vested to recipient", async () => {
    // Setup a new fresh stream for deterministic clawback evaluation
    const streamSeed = new BN(2002);
    const now = Math.floor(Date.now() / 1000);
    const startTime = new BN(now);
    const endTime = new BN(now + 20); // 20s stream
    const cliffTime = new BN(now);

    const [streamPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("stream"), sender.publicKey.toBuffer(), streamSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), streamPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeStream(
        streamSeed,
        depositAmount,
        startTime,
        endTime,
        cliffTime,
        false // No milestone needed
      )
      .accounts({
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        arbiter: arbiter.publicKey,
        mint: mint,
        senderTokenAccount: senderTokenAccount,
        streamState: streamPda,
        streamVault: vaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Wait 2 seconds
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const senderBalBefore = Number((await getAccount(provider.connection, senderTokenAccount)).amount);

    // Sender executes clawback
    await program.methods
      .clawbackStream()
      .accounts({
        sender: sender.publicKey,
        recipientWallet: recipient.publicKey,
        streamState: streamPda,
        mint: mint,
        streamVault: vaultPda,
        senderTokenAccount: senderTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const senderBalAfter = Number((await getAccount(provider.connection, senderTokenAccount)).amount);
    const streamAccount = await program.account.streamState.fetch(streamPda);

    expect(streamAccount.isClosed).to.be.true;
    expect(senderBalAfter).to.be.greaterThan(senderBalBefore);
  });
});