import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { Aurastream } from "../target/types/aurastream";

describe("aurastream protocol automated validation suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Aurastream as Program<Aurastream>;

  let mint: PublicKey;
  let senderTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;

  const sender = (provider.wallet as anchor.Wallet).payer;
  const recipient = Keypair.generate();
  const unauthorizedParty = Keypair.generate();

  const streamId = new anchor.BN(Date.now());
  const depositAmount = new anchor.BN(10_000_000_000); // 10,000 SPL units (decimals = 6)

  let streamPDA: PublicKey;
  let streamBump: number;
  let escrowVaultPDA: PublicKey;
  let escrowBump: number;

  let startTime: anchor.BN;
  let endTime: anchor.BN;

  before(async () => {
    // Airdrop SOL to recipient and unauthorizedParty for testnet gas
    const airdropSig1 = await provider.connection.requestAirdrop(recipient.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(airdropSig1);

    const airdropSig2 = await provider.connection.requestAirdrop(unauthorizedParty.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(airdropSig2);

    // Initialize Mint (USDC simulation)
    mint = await createMint(
      provider.connection,
      sender,
      sender.publicKey,
      null,
      6
    );

    // Create Token Accounts
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

    // Mint test supply to sender
    await mintTo(
      provider.connection,
      sender,
      mint,
      senderTokenAccount,
      sender.publicKey,
      50_000_000_000
    );

    // Calculate PDAs
    const streamIdBuffer = streamId.toArrayLike(Buffer, "le", 8);
    [streamPDA, streamBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("stream"), sender.publicKey.toBuffer(), recipient.publicKey.toBuffer(), streamIdBuffer],
      program.programId
    );

    [escrowVaultPDA, escrowBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault"), sender.publicKey.toBuffer(), recipient.publicKey.toBuffer(), streamIdBuffer],
      program.programId
    );
  });

  it("1. Successfully creates an institutional payment stream", async () => {
    const currentSlotTime = Math.floor(Date.now() / 1000);
    startTime = new anchor.BN(currentSlotTime - 2); // 2 seconds ago
    endTime = new anchor.BN(currentSlotTime + 8);   // 8 seconds total length

    const tx = await program.methods
      .initializeStream(streamId, depositAmount, startTime, endTime, true)
      .accounts({
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        mint: mint,
        senderTokenAccount: senderTokenAccount,
        streamAccount: streamPDA,
        escrowVault: escrowVaultPDA,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    expect(tx).to.be.a("string");

    // Verify stream state
    const streamAccount = await program.account.streamAccount.fetch(streamPDA);
    expect(streamAccount.sender.toBase58()).to.equal(sender.publicKey.toBase58());
    expect(streamAccount.recipient.toBase58()).to.equal(recipient.publicKey.toBase58());
    expect(streamAccount.depositAmount.toNumber()).to.equal(depositAmount.toNumber());
    expect(streamAccount.withdrawnAmount.toNumber()).to.equal(0);
    expect(streamAccount.cancelableBySender).to.be.true;

    // Verify vault balance
    const vaultBalance = await getAccount(provider.connection, escrowVaultPDA);
    expect(Number(vaultBalance.amount)).to.equal(depositAmount.toNumber());
  });

  it("2. Rejects unauthorized recipient withdrawal attempts", async () => {
    try {
      await program.methods
        .withdrawStream(streamId)
        .accounts({
          recipient: unauthorizedParty.publicKey,
          sender: sender.publicKey,
          streamAccount: streamPDA,
          escrowVault: escrowVaultPDA,
          recipientTokenAccount: recipientTokenAccount,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([unauthorizedParty])
        .rpc();
      expect.fail("Should have failed with unauthorized recipient error");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedRecipient");
    }
  });

  it("3. Successfully processes continuous per-second micro-vesting claim", async () => {
    // Wait 3 seconds to accumulate vested tokens
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const initialRecipientToken = await getAccount(provider.connection, recipientTokenAccount);

    const tx = await program.methods
      .withdrawStream(streamId)
      .accounts({
        recipient: recipient.publicKey,
        sender: sender.publicKey,
        streamAccount: streamPDA,
        escrowVault: escrowVaultPDA,
        recipientTokenAccount: recipientTokenAccount,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([recipient])
      .rpc();

    expect(tx).to.be.a("string");

    const updatedStreamAccount = await program.account.streamAccount.fetch(streamPDA);
    const postRecipientToken = await getAccount(provider.connection, recipientTokenAccount);

    const delta = Number(postRecipientToken.amount) - Number(initialRecipientToken.amount);
    expect(delta).to.be.greaterThan(0);
    expect(updatedStreamAccount.withdrawnAmount.toNumber()).to.equal(delta);
  });

  it("4. Enforces emergency clawback, refunds unvested float to treasury, and closes PDAs", async () => {
    const senderBeforeBalance = await getAccount(provider.connection, senderTokenAccount);

    const cancelTx = await program.methods
      .cancelStream(streamId)
      .accounts({
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        streamAccount: streamPDA,
        escrowVault: escrowVaultPDA,
        senderTokenAccount: senderTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();

    expect(cancelTx).to.be.a("string");

    const senderAfterBalance = await getAccount(provider.connection, senderTokenAccount);
    expect(Number(senderAfterBalance.amount)).to.be.greaterThan(Number(senderBeforeBalance.amount));

    // Verify Stream Account PDA has been closed and rent refunded to sender
    const closedAccountInfo = await provider.connection.getAccountInfo(streamPDA);
    expect(closedAccountInfo).to.be.null;

    // Verify Escrow Vault PDA is closed
    const closedVaultInfo = await provider.connection.getAccountInfo(escrowVaultPDA);
    expect(closedVaultInfo).to.be.null;
  });

  it("5. Boundary Test: Rejects stream creation with invalid time horizons", async () => {
    const badStreamId = new anchor.BN(99999);
    const now = Math.floor(Date.now() / 1000);
    const badStartTime = new anchor.BN(now + 1000);
    const badEndTime = new anchor.BN(now + 100); // End before start

    const [badStreamPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("stream"), sender.publicKey.toBuffer(), recipient.publicKey.toBuffer(), badStreamId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [badEscrowVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault"), sender.publicKey.toBuffer(), recipient.publicKey.toBuffer(), badStreamId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    try {
      await program.methods
        .initializeStream(badStreamId, depositAmount, badStartTime, badEndTime, true)
        .accounts({
          sender: sender.publicKey,
          recipient: recipient.publicKey,
          mint: mint,
          senderTokenAccount: senderTokenAccount,
          streamAccount: badStreamPDA,
          escrowVault: badEscrowVault,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("Should have thrown InvalidTimeRange");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidTimeRange");
    }
  });
});