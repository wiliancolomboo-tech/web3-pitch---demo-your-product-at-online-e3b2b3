import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

interface MilestoneClaimedPayload {
  escrowId: string;
  milestoneIndex: number;
  netAmountLamports: number;
  feeAmountLamports: number;
  recipient: string;
  timestamp: number;
  signature: string;
}

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "Sent1neL11111111111111111111111111111111111"
);
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const WSS_ENDPOINT = process.env.SOLANA_WSS_URL || "wss://api.devnet.solana.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const ENTERPRISE_NOTIFICATION_EMAIL = process.env.ACCOUNTING_EMAIL || "treasury@enterprise.com";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

export class SentinelDispatcher {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(RPC_ENDPOINT, {
      wsEndpoint: WSS_ENDPOINT,
      commitment: "confirmed",
    });
  }

  public async startListener(): Promise<void> {
    console.log(`[Sentinel Agent] Subscribing to program logs: ${PROGRAM_ID.toBase58()}`);

    this.connection.onLogs(
      PROGRAM_ID,
      async ({ logs, err, signature }) => {
        if (err) return;

        for (const line of logs) {
          if (line.includes("MilestoneClaimedEvent")) {
            console.log(`[Event Detected] Milestone claimed in tx: ${signature}`);
            await this.handleMilestoneClaimLog(line, signature);
          } else if (line.includes("EscrowDisputedEvent")) {
            console.warn(`[Alert] Escrow disputed in tx: ${signature}`);
            await this.handleDisputeAlert(line, signature);
          }
        }
      },
      "confirmed"
    );
  }

  public async handleMilestoneClaimLog(rawLog: string, signature: string): Promise<void> {
    try {
      // Mock deterministic parser matching IDL serialization
      const payload: MilestoneClaimedPayload = {
        escrowId: "1001",
        milestoneIndex: 0,
        netAmountLamports: 1_980_000_000, // 1.98 SOL
        feeAmountLamports: 20_000_000,    // 0.02 SOL
        recipient: "B4x...PayoutAddress",
        timestamp: Math.floor(Date.now() / 1000),
        signature,
      };

      await Promise.all([
        this.dispatchResendReceipt(payload),
        this.dispatchSlackNotification(payload),
      ]);
    } catch (e: any) {
      console.error(`[Dispatch Error] Failed to process claim log: ${e.message}`);
    }
  }

  private async dispatchResendReceipt(payload: MilestoneClaimedPayload): Promise<void> {
    if (!RESEND_API_KEY) {
      console.warn("[Resend] Skipped: RESEND_API_KEY is not defined in environment.");
      return;
    }

    const solAmount = (payload.netAmountLamports / 1e9).toFixed(4);
    const feeSol = (payload.feeAmountLamports / 1e9).toFixed(4);

    const emailBody = `
      <h2>SolPulse Sentinel: Capital Disbursement Notice</h2>
      <p>An on-chain milestone settlement has finalized on Solana.</p>
      <table style="border: 1px solid #ccc; border-collapse: collapse; width: 100%;">
        <tr><td style="padding: 8px;"><b>Escrow ID</b></td><td style="padding: 8px;">${payload.escrowId}</td></tr>
        <tr><td style="padding: 8px;"><b>Milestone Index</b></td><td style="padding: 8px;">#${payload.milestoneIndex}</td></tr>
        <tr><td style="padding: 8px;"><b>Net Transferred</b></td><td style="padding: 8px;"><b>${solAmount} SOL</b></td></tr>
        <tr><td style="padding: 8px;"><b>Protocol Fee (Treasury)</b></td><td style="padding: 8px;">${feeSol} SOL</td></tr>
        <tr><td style="padding: 8px;"><b>Recipient Key</b></td><td style="padding: 8px;"><code>${payload.recipient}</code></td></tr>
        <tr><td style="padding: 8px;"><b>Solana Explorer Link</b></td><td style="padding: 8px;"><a href="https://explorer.solana.com/tx/${payload.signature}?cluster=devnet">View Transaction</a></td></tr>
      </table>
      <p><small>Generated autonomously by SolPulse Sentinel Enterprise Daemon</small></p>
    `;

    try {
      await axios.post(
        "https://api.resend.com/emails",
        {
          from: "Sentinel Settlements <onboarding@resend.dev>",
          to: [ENTERPRISE_NOTIFICATION_EMAIL],
          subject: `[Settlement Finalized] Escrow #${payload.escrowId} Milestone #${payload.milestoneIndex}`,
          html: emailBody,
        },
        {
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log(`[Resend] Successfully dispatched audit email for Escrow #${payload.escrowId}`);
    } catch (err: any) {
      console.error(`[Resend API Error] ${err.response?.data?.message || err.message}`);
    }
  }

  private async dispatchSlackNotification(payload: MilestoneClaimedPayload): Promise<void> {
    if (!SLACK_WEBHOOK_URL) {
      console.warn("[Slack] Skipped: SLACK_WEBHOOK_URL is not configured.");
      return;
    }

    const netSol = (payload.netAmountLamports / 1e9).toFixed(4);
    const slackMessage = {
      text: `🚀 *Milestone Released & Claimed | Escrow #${payload.escrowId}*`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "✅ Milestone Payout Settled",
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Escrow ID:*\n${payload.escrowId}` },
            { type: "mrkdwn", text: `*Milestone:*\nIndex #${payload.milestoneIndex}` },
            { type: "mrkdwn", text: `*Disbursed:*\n${netSol} SOL` },
            { type: "mrkdwn", text: `*Explorer:*\n<https://explorer.solana.com/tx/${payload.signature}?cluster=devnet|View Tx>` },
          ],
        },
      ],
    };

    try {
      await axios.post(SLACK_WEBHOOK_URL, slackMessage);
      console.log(`[Slack] Successfully delivered webhook notification.`);
    } catch (err: any) {
      console.error(`[Slack Webhook Error] ${err.response?.data || err.message}`);
    }
  }

  private async handleDisputeAlert(rawLog: string, signature: string): Promise<void> {
    if (!SLACK_WEBHOOK_URL) return;

    await axios.post(SLACK_WEBHOOK_URL, {
      text: `🚨 *URGENT: Escrow Disputed on Solana* \nTx: https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    });
  }
}

// Daemon entrypoint
if (require.main === module) {
  const daemon = new SentinelDispatcher();
  daemon.startListener().catch((err) => {
    console.error("[Fatal Error in Sentinel Daemon]", err);
    process.exit(1);
  });
}