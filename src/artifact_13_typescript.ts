import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Resend } from "resend";
import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

// Configuration Schema
interface SentinelConfig {
  rpcUrl: string;
  wsUrl: string;
  programId: string;
  guardianKeypairPath: string;
  resendApiKey: string;
  resendAlertTo: string;
  resendFromEmail: string;
  slackWebhookUrl: string;
  monitoredVaultMint: string;
}

const CONFIG: SentinelConfig = {
  rpcUrl: process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899",
  wsUrl: process.env.SOLANA_WS_URL || "ws://127.0.0.1:8900",
  programId: process.env.PROGRAM_ID || "Aegis11111111111111111111111111111111111111",
  guardianKeypairPath: process.env.GUARDIAN_KEYPAIR_PATH || "./guardian-keypair.json",
  resendApiKey: process.env.RESEND_API_KEY || "re_test_000000000000000000000000",
  resendAlertTo: process.env.ALERT_EMAIL || "security@enterprise-treasury.io",
  resendFromEmail: process.env.FROM_EMAIL || "alerts@aegisvault.fi",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
  monitoredVaultMint: process.env.MINT_ADDRESS || "So11111111111111111111111111111111111111112",
};

export class AegisSentinelDaemon {
  private connection: Connection;
  private guardianKeypair: Keypair;
  private resendClient: Resend;
  private programPubkey: PublicKey;

  constructor() {
    this.connection = new Connection(CONFIG.rpcUrl, {
      wsEndpoint: CONFIG.wsUrl,
      commitment: "confirmed",
    });

    if (fs.existsSync(CONFIG.guardianKeypairPath)) {
      const secret = Uint8Array.from(JSON.parse(fs.readFileSync(CONFIG.guardianKeypairPath, "utf-8")));
      this.guardianKeypair = Keypair.fromSecretKey(secret);
    } else {
      this.guardianKeypair = Keypair.generate();
      console.warn(`[WARN] No keypair found at ${CONFIG.guardianKeypairPath}. Using transient key: ${this.guardianKeypair.publicKey.toBase58()}`);
    }

    this.resendClient = new Resend(CONFIG.resendApiKey);
    this.programPubkey = new PublicKey(CONFIG.programId);
  }

  public async start(): Promise<void> {
    console.log("=====================================================");
    console.log("       AEGISVAULT SENTINEL AUTONOMOUS MONITOR        ");
    console.log("=====================================================");
    console.log(`Program ID:        ${this.programPubkey.toBase58()}`);
    console.log(`Guardian Sentinel: ${this.guardianKeypair.publicKey.toBase58()}`);
    console.log(`RPC Node:          ${CONFIG.rpcUrl}`);
    console.log("-----------------------------------------------------");

    this.listenToOnChainEvents();
  }

  private listenToOnChainEvents(): void {
    console.log("[STATUS] Subscribing to Program Transaction Logs...");

    this.connection.onLogs(
      this.programPubkey,
      async (logs, ctx) => {
        if (logs.err) return;

        for (const line of logs.logs) {
          // Detect CircuitBreakerTripped event
          if (line.includes("CircuitBreakerTrippedEvent") || line.includes("BreakerManualTripEvent")) {
            console.error(`[CRITICAL ALERT] Circuit Breaker anomaly detected at Slot ${ctx.slot}!`);
            await this.handleSecurityIncident({
              slot: ctx.slot,
              signature: logs.signature,
              logContent: line,
            });
          }

          if (line.includes("WithdrawalSettledEvent")) {
            console.log(`[INFO] Nominal Outflow Settled: Tx ${logs.signature.slice(0, 16)}...`);
          }
        }
      },
      "confirmed"
    );
  }

  private async handleSecurityIncident(incident: { slot: number; signature: string; logContent: string }): Promise<void> {
    const timestamp = new Date().toISOString();
    const payload = {
      title: "🚨 AEGISVAULT DEFENSIVE QUARANTINE ENGAGED",
      timestamp,
      slot: incident.slot,
      txSignature: incident.signature,
      details: incident.logContent,
      network: "Solana Mainnet-Beta / Testnet",
    };

    console.log(`[INCIDENT RESPONSE] Executing Enterprise Telemetry Fanout...`);

    // 1. Dispatch Webhook to Slack / PagerDuty
    await this.notifySlack(payload);

    // 2. Dispatch Enterprise Transactional Email via Resend
    await this.notifyResend(payload);
  }

  private async notifySlack(payload: any): Promise<void> {
    if (!CONFIG.slackWebhookUrl) {
      console.log("[TELEMETRY:SLACK] No webhook configured, skipping Slack push.");
      return;
    }

    try {
      await axios.post(CONFIG.slackWebhookUrl, {
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: payload.title, emoji: true },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Slot:*\n${payload.slot}` },
              { type: "mrkdwn", text: `*Timestamp:*\n${payload.timestamp}` },
              { type: "mrkdwn", text: `*Signature:*\n\`${payload.txSignature}\`` },
              { type: "mrkdwn", text: `*Program Status:*\nQuarantined` },
            ],
          },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `Log context: \`${payload.details}\`` },
            ],
          },
        ],
      });
      console.log("[TELEMETRY:SLACK] Critical incident notification dispatched.");
    } catch (err: any) {
      console.error(`[ERROR:SLACK] Failed to notify Slack: ${err.message}`);
    }
  }

  private async notifyResend(payload: any): Promise<void> {
    if (!CONFIG.resendApiKey || CONFIG.resendApiKey.startsWith("re_test_mock")) {
      console.log("[TELEMETRY:RESEND] Mock API Key detected; logging simulated Resend payload:");
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    try {
      const response = await this.resendClient.emails.send({
        from: CONFIG.resendFromEmail,
        to: [CONFIG.resendAlertTo],
        subject: `[CRITICAL ACTION REQUIRED] AegisVault Incident - Slot ${payload.slot}`,
        html: `
          <div style="font-family: Arial, sans-serif; background-color: #0d1117; color: #ffffff; padding: 24px; border-radius: 8px;">
            <h1 style="color: #ff4757; border-bottom: 2px solid #ff4757; padding-bottom: 8px;">AegisVault Defense Activated</h1>
            <p><strong>A high-velocity transaction triggered an invariant breach. The vault was immediately quarantined.</strong></p>
            <table style="width: 100%; border-collapse: collapse; margin-top: 16px; color: #c9d1d9;">
              <tr><td style="padding: 8px; border: 1px solid #30363d;"><strong>Network Slot:</strong></td><td style="padding: 8px; border: 1px solid #30363d;">${payload.slot}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #30363d;"><strong>Trigger Signature:</strong></td><td style="padding: 8px; border: 1px solid #30363d;"><a href="https://solscan.io/tx/${payload.txSignature}" style="color: #58a6ff;">${payload.txSignature}</a></td></tr>
              <tr><td style="padding: 8px; border: 1px solid #30363d;"><strong>Timestamp:</strong></td><td style="padding: 8px; border: 1px solid #30363d;">${payload.timestamp}</td></tr>
            </table>
            <p style="margin-top: 20px; font-size: 13px; color: #8b949e;">This is an automated cryptographic alert from the Aegis Sentinel Security Stack.</p>
          </div>
        `,
      });
      console.log(`[TELEMETRY:RESEND] Enterprise executive alert dispatched. ID: ${response.data?.id}`);
    } catch (err: any) {
      console.error(`[ERROR:RESEND] Failed to dispatch via Resend: ${err.message}`);
    }
  }
}

// Entrypoint Execution
if (require.main === module) {
  const daemon = new AegisSentinelDaemon();
  daemon.start().catch((err) => {
    console.error("[FATAL] Daemon failure:", err);
    process.exit(1);
  });
}