import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AegisFlow } from "../target/types/aegis_flow";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("aegis_flow integration test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AegisFlow as Program<AegisFlow>;

  let mintKeypair: Keypair;
  let mint: PublicKey;
  let sender: Keypair;
  let recipient: Keypair;
  let adversary: Keypair;

  let senderTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;

  const depositAmount = new anchor.BN(10_000_000_000); // 10,000 tokens (decimals = 6)
  const nonce = new anchor.BN(Math.floor(Math.random() * 1_000_000));

  before(async () => {
    sender = Keypair.generate();
    recipient = Keypair.generate();
    adversary = Keypair.generate();

    // Fund SOL for rent and gas
    const fundTx1 = await provider.connection.requestAirdrop(sender.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    const fundTx2 = await provider.connection.requestAirdrop(recipient.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    const fundTx3 = await provider.connection.requestAirdrop(adversary.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);

    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: fundTx1,
    });

    mintKeypair = Keypair.generate();
    mint = await createMint(
      provider.connection,
      sender,
      sender.publicKey,
      null,
      6,
      mintKeypair
    );

    senderTokenAccount = await createAccount(provider.connection, sender, mint, sender.publicKey);
    recipientTokenAccount = await createAccount(provider.connection, recipient, mint, recipient.publicKey);

    await mintTo(
      provider.connection,
      sender,
      mint,
      senderTokenAccount,
      sender.publicKey,
      depositAmount.toNumber() * 2
    );
  });

  it("1. Successfully initializes a conditional stream escrow", async () => {
    const [streamPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("stream_escrow"),
        sender.publicKey.toBuffer(),
        recipient.publicKey.toBuffer(),
        nonce.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), streamPda.toBuffer()],
      program.programId
    );

    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now);
    const cliffTime = new anchor.BN(now + 2);
    const endTime = new anchor.BN(now + 10);

    await program.methods
      .initializeStream(nonce, depositAmount, startTime, endTime, cliffTime, true)
      .accounts({
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        mint: mint,
        senderTokenAccount: senderTokenAccount,
        streamEscrow: streamPda,
        tokenVault: vaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([sender])
      .rpc();

    const streamAccount = await program.account.streamEscrow.fetch(streamPda);
    assert.ok(streamAccount.sender.equals(sender.publicKey));
    assert.ok(streamAccount.recipient.equals(recipient.publicKey));
    assert.equal(streamAccount.initialDeposit.toString(), depositAmount.toString());
    assert.equal(streamAccount.totalWithdrawn.toString(), "0");
    assert.equal(streamAccount.isPaused, false);

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    assert.equal(vaultAccount.amount.toString(), depositAmount.toString());
  });

  it("2. Rejects withdrawal attempts prior to reaching the cliff threshold", async () => {
    const [streamPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("stream_escrow"),
        sender.publicKey.toBuffer(),
        recipient.publicKey.toBuffer(),
        nonce.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), streamPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .withdrawVested()
        .accounts({
          recipient: recipient.publicKey,
          streamEscrow: streamPda,
          tokenVault: vaultPda,
          recipientTokenAccount: recipientTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([recipient])
        .rpc();
      assert.fail("Should have thrown NoClaimableFunds error due to active cliff.");
    } catch (err: any) {
      expect(err.toString()).to.contain("NoClaimableFunds");
    }
  });

  it("3. Enforces pause instruction authority checks", async () => {
    const [streamPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("stream_escrow"),
        sender.publicKey.toBuffer(),
        recipient.publicKey.toBuffer(),
        nonce.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    try {
      await program.methods
        .pauseStream()
        .accounts({
          authority: adversary.publicKey,
          streamEscrow: streamPda,
        })
        .signers([adversary])
        .rpc();
      assert.fail("Adversary should not be able to pause someone else's stream.");
    } catch (err: any) {
      expect(err.toString()).to.contain("Unauthorized");
    }
  });

  it("4. Allows authorized sender to pause and resume without mathematical corruption", async () => {
    const [streamPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("stream_escrow"),
        sender.publicKey.toBuffer(),
        recipient.publicKey.toBuffer(),
        nonce.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Pause
    await program.methods
      .pauseStream()
      .accounts({
        authority: sender.publicKey,
        streamEscrow: streamPda,
      })
      .signers([sender])
      .rpc();

    let account = await program.account.streamEscrow.fetch(streamPda);
    assert.equal(account.isPaused, true);

    // Wait 2 seconds
    await new Promise((r) => setTimeout(r, 2000));

    // Resume
    await program.methods
      .resumeStream()
      .accounts({
        authority: sender.publicKey,
        streamEscrow: streamPda,
      })
      .signers([sender])
      .rpc();

    account = await program.account.streamEscrow.fetch(streamPda);
    assert.equal(account.isPaused, false);
    assert.isAbove(account.pausedDuration.toNumber(), 0);
  });

  it("5. Executes deterministic stream cancellation and proportional refund clawback", async () => {
    const [streamPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("stream_escrow"),
        sender.publicKey.toBuffer(),
        recipient.publicKey.toBuffer(),
        nonce.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), streamPda.toBuffer()],
      program.programId
    );

    const senderInitialBalance = (await getAccount(provider.connection, senderTokenAccount)).amount;

    await program.methods
      .cancelStream()
      .accounts({
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        senderTokenAccount: senderTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        tokenVault: vaultPda,
        streamEscrow: streamPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender])
      .rpc();

    const senderFinalBalance = (await getAccount(provider.connection, senderTokenAccount)).amount;
    const recipientFinalBalance = (await getAccount(provider.connection, recipientTokenAccount)).amount;

    // Both recipient received vested accrued and sender clawed back unvested
    assert.isAbove(Number(recipientFinalBalance), 0);
    assert.isAbove(Number(senderFinalBalance), Number(senderInitialBalance));

    // Escrow account state closed
    const accountInfo = await provider.connection.getAccountInfo(streamPda);
    assert.isNull(accountInfo);
  });
});