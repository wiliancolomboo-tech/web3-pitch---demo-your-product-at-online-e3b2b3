import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { CONFIG } from "./config";
import { EnterpriseTelemetryService } from "./telemetry";

const VAULT_SEED = Buffer.from("solflow_vault");

export class SolFlowGuardianAgent {
  private connection: Connection;
  private guardianKeypair: Keypair;
  private programId: PublicKey;
  private vaultAdminPubkey: PublicKey;
  private vaultPda: PublicKey;
  private isProcessing: boolean = false;

  constructor() {
    this.connection = new Connection(CONFIG.solanaRpcUrl, {
      commitment: "confirmed",
      wsEndpoint: CONFIG.solanaWsUrl,
    });

    if (!CONFIG.guardianPrivateKey) {
      console.warn("[Sentinel Warning] GUARDIAN_PRIVATE_KEY missing. Generating ephemeral key for testing...");
      this.guardianKeypair = Keypair.generate();
    } else {
      this.guardianKeypair = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(CONFIG.guardianPrivateKey))
      );
    }

    this.programId = new PublicKey(CONFIG.programId);
    this.vaultAdminPubkey = CONFIG.vaultAdminPublicKey
      ? new PublicKey(CONFIG.vaultAdminPublicKey)
      : this.guardianKeypair.publicKey;

    const [vaultAddress] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, this.vaultAdminPubkey.toBuffer()],
      this.programId
    );
    this.vaultPda = vaultAddress;

    console.log("==========================================================");
    console.log("🛡️  SOLFLOW GUARDIAN: AUTONOMOUS SENTINEL INITIALIZED");
    console.log(`Program ID:       ${this.programId.toBase58()}`);
    console.log(`Vault PDA:        ${this.vaultPda.toBase58()}`);
    console.log(`Guardian Signer:  ${this.guardianKeypair.publicKey.toBase58()}`);
    console.log("==========================================================");
  }

  /**
   * Evaluates volatility and on-chain drawdown metrics
   */
  public async monitorCycle(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // 1. Fetch on-chain vault state
      const accountInfo = await this.connection.getAccountInfo(this.vaultPda);
      if (!accountInfo) {
        console.log(`[Sentinel] Vault account ${this.vaultPda.toBase58()} not yet initialized on-chain. Waiting...`);
        this.isProcessing = false;
        return;
      }

      // Check is_frozen byte (offset 178 in VaultState)
      // Discriminator(8) + Admin(32) + Guardian(32) + MintA(32) + MintB(32) + VaultA(32) + VaultB(32) + Drawdown(2) + CumDrawdown(2) + Cooldown(8) + Timestamp(8) = 230 bytes
      const isFrozen = accountInfo.data[230] === 1;
      if (isFrozen) {
        console.log("[Sentinel] Vault is currently FROZEN. Sentinel in observation mode.");
        this.isProcessing = false;
        return;
      }

      // 2. Compute Synthetic Market Volatility & Pool Drift
      // Simulating dynamic price deviation check against Pyth/Switchboard feeds
      const simulatedDrawdownBps = Math.floor(Math.random() * 1200); // 0.00% to 12.00%
      console.log(`[Sentinel Tick] Current Deviation: ${(simulatedDrawdownBps / 100).toFixed(2)}% | Trigger Bound: ${(CONFIG.volatilityTriggerBps / 100).toFixed(2)}%`);

      if (simulatedDrawdownBps >= CONFIG.volatilityTriggerBps) {
        console.warn(`[BREACH DETECTED] Volatility breach ${simulatedDrawdownBps} bps >= ${CONFIG.volatilityTriggerBps} bps!`);
        await this.triggerCircuitBreaker(simulatedDrawdownBps);
      }
    } catch (err: any) {
      console.error("[Sentinel Monitor Loop Error]:", err.message);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Builds and submits on-chain freeze instruction & calls enterprise telemetry
   */
  public async triggerCircuitBreaker(drawdownBps: number): Promise<void> {
    console.log("[Guardian Action] Submitting on-chain trigger_circuit_breaker transaction...");

    // Discriminator for trigger_circuit_breaker: sha256("global:trigger_circuit_breaker")[0..8]
    // Hex: [129, 219, 142, 12, 114, 185, 237, 240]
    const sighash = Buffer.from([129, 219, 142, 12, 114, 185, 237, 240]);
    const drawdownBuffer = Buffer.alloc(2);
    drawdownBuffer.writeUInt16LE(drawdownBps, 0);
    const reasonCodeBuffer = Buffer.from([1]); // 1 = Rapid Price Drop

    const instructionData = Buffer.concat([sighash, drawdownBuffer, reasonCodeBuffer]);

    const instruction = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.guardianKeypair.publicKey, isSigner: true, isWritable: false },
        { pubkey: this.vaultPda, isSigner: false, isWritable: true },
      ],
      data: instructionData,
    });

    const tx = new Transaction().add(instruction);
    tx.feePayer = this.guardianKeypair.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    try {
      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [this.guardianKeypair],
        { skipPreflight: false, commitment: "confirmed" }
      );
      console.log(`✅ [CIRCUIT BREAKER FIRED] Signature: ${signature}`);

      // Dispatch Telemetry to Enterprise Channels
      await EnterpriseTelemetryService.broadcastEmergencyAlert({
        vaultAddress: this.vaultPda.toBase58(),
        observedDrawdownBps: drawdownBps,
        thresholdBps: CONFIG.volatilityTriggerBps,
        txSignature: signature,
        timestamp: new Date().toISOString(),
        reason: "Simulated Extreme Volatility Oracle Divergence (>8.5%)",
      });
    } catch (err: any) {
      console.error("[Transaction Failed]:", err.message);
    }
  }

  public run(): void {
    console.log(`[Sentinel Active] Polling interval every ${CONFIG.pollIntervalMs}ms`);
    setInterval(() => this.monitorCycle(), CONFIG.pollIntervalMs);
  }
}

// Direct Execution Entrypoint
if (require.main === module) {
  const agent = new SolFlowGuardianAgent();
  agent.run();
}