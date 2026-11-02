import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import axios from "axios";
import { Resend } from "resend";
import * as dotenv from "dotenv";

dotenv.config();

// Types
export interface SentinelConfig {
  rpcUrl: string;
  programId: string;
  oraclePrivateKey: string;
  resendApiKey: string;
  opsEmail: string;
  slackWebhookUrl?: string;
  discordWebhookUrl?: string;
}

export class SolSentinelClient {
  private connection: Connection;
  private oracleKeypair: Keypair;
  private resend: Resend;
  private config: SentinelConfig;

  constructor(config: SentinelConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.oracleKeypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(config.oraclePrivateKey))
    );
    this.resend = new Resend(config.resendApiKey);
  }

  /**
   * Dispatches enterprise alert across channels (Email + Webhook)
   */
  public async dispatchNotification(
    subject: string,
    message: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    console.log(`[ALERT] ${subject} -> Processing enterprise delivery...`);

    // 1. Transactional Email via Resend
    try {
      if (this.config.resendApiKey && this.config.opsEmail) {
        await this.resend.emails.send({
          from: "alerts@solsentinel.io",
          to: this.config.opsEmail,
          subject: `[SolSentinel] ${subject}`,
          html: `
            <h2>SolSentinel Protocol Alert: ${subject}</h2>
            <p><strong>Details:</strong> ${message}</p>
            <pre style="background: #111; color: #00ff66; padding: 10px; border-radius: 5px;">
              ${JSON.stringify(metadata, null, 2)}
            </pre>
            <hr />
            <p>SolSentinel Automated Sentinel Service v1.0.0</p>
          `,
        });
        console.log(`[Resend] Successfully delivered email to ${this.config.opsEmail}`);
      }
    } catch (err) {
      console.error("[Resend] Error sending transactional email:", err);
    }

    // 2. Discord Webhook Broadcast
    try {
      if (this.config.discordWebhookUrl) {
        await axios.post(this.config.discordWebhookUrl, {
          embeds: [
            {
              title: `⚡ SolSentinel: ${subject}`,
              description: message,
              color: 0x00f58c,
              fields: Object.entries(metadata).map(([k, v]) => ({
                name: k,
                value: String(v),
                inline: true,
              })),
              timestamp: new Date().toISOString(),
            },
          ],
        });
        console.log("[Discord] Webhook notification dispatched.");
      }
    } catch (err) {
      console.error("[Discord] Webhook dispatch failure:", err);
    }

    // 3. Slack Webhook Broadcast
    try {
      if (this.config.slackWebhookUrl) {
        await axios.post(this.config.slackWebhookUrl, {
          text: `*SolSentinel Protocol Event*: ${subject}\n>${message}`,
        });
        console.log("[Slack] Notification delivered.");
      }
    } catch (err) {
      console.error("[Slack] Webhook dispatch failure:", err);
    }
  }

  /**
   * Start the real-time event listener to bridge on-chain state with Enterprise APIs
   */
  public async startSentinelDaemon(program: Program): Promise<void> {
    console.log("Starting SolSentinel real-time daemon listener...");

    program.addEventListener("StreamCreatedEvent", async (event, slot) => {
      await this.dispatchNotification(
        "New Stream Created",
        `Stream ID #${event.streamId.toString()} initialized with ${event.depositAmount.toString()} base units.`,
        {
          streamId: event.streamId.toString(),
          sender: event.sender.toBase58(),
          recipient: event.recipient.toBase58(),
          milestones: event.milestones,
          slot,
        }
      );
    });

    program.addEventListener("MilestoneAttestedEvent", async (event, slot) => {
      await this.dispatchNotification(
        "Milestone Verified & Attested",
        `Milestone ${event.milestoneIndex} completed for Stream #${event.streamId.toString()}`,
        {
          streamId: event.streamId.toString(),
          milestoneIndex: event.milestoneIndex,
          attester: event.attester.toBase58(),
          slot,
        }
      );
    });

    program.addEventListener("StreamCancelledEvent", async (event, slot) => {
      await this.dispatchNotification(
        "CRITICAL: Stream Clawback / Cancelled",
        `Stream #${event.streamId.toString()} has been terminated by treasury.`,
        {
          streamId: event.streamId.toString(),
          clawbackToSender: event.clawbackToSender.toString(),
          finalPayoutToRecipient: event.finalPayoutToRecipient.toString(),
          slot,
        }
      );
    });

    console.log("SolSentinel Daemon listening on Solana WebSocket cluster.");
  }
}

// Runnable Entrypoint
if (require.main === module) {
  const config: SentinelConfig = {
    rpcUrl: process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899",
    programId: process.env.PROGRAM_ID || "Sent1neL11111111111111111111111111111111111",
    oraclePrivateKey: process.env.ORACLE_PRIVATE_KEY || "[1,2,3...]",
    resendApiKey: process.env.RESEND_API_KEY || "",
    opsEmail: process.env.OPS_EMAIL || "treasury@enterprise.io",
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  };

  const client = new SolSentinelClient(config);
  console.log("SolSentinel Enterprise Client initialized successfully.");
}