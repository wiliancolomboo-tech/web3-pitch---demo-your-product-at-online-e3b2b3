import axios from "axios";
import { CONFIG } from "./config";

export interface IncidentTelemetry {
  vaultAddress: string;
  observedDrawdownBps: number;
  thresholdBps: number;
  txSignature: string;
  timestamp: string;
  reason: string;
}

export class EnterpriseTelemetryService {
  /**
   * Dispatches formatted incidents simultaneously to Slack, Discord, and Resend
   */
  public static async broadcastEmergencyAlert(telemetry: IncidentTelemetry): Promise<void> {
    const promises: Promise<any>[] = [];

    if (CONFIG.slackWebhookUrl) {
      promises.push(this.sendSlackNotification(telemetry));
    }
    if (CONFIG.discordWebhookUrl) {
      promises.push(this.sendDiscordNotification(telemetry));
    }
    if (CONFIG.resendApiKey && CONFIG.resendAlertEmailTo) {
      promises.push(this.sendResendEmail(telemetry));
    }

    const results = await Promise.allSettled(promises);
    results.forEach((res, index) => {
      if (res.status === "rejected") {
        console.error(`[Telemetry Error] Notification service ${index} failed:`, res.reason);
      }
    });
  }

  private static async sendSlackNotification(data: IncidentTelemetry): Promise<void> {
    const payload = {
      text: `🚨 *SOLFLOW GUARDIAN: CIRCUIT BREAKER TRIGGERED* 🚨`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🚨 SolFlow Guardian Alert: Treasury Frozen",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Vault PDA:*\n\`${data.vaultAddress}\`` },
            { type: "mrkdwn", text: `*Trigger Reason:*\n${data.reason}` },
            { type: "mrkdwn", text: `*Observed Loss:*\n${(data.observedDrawdownBps / 100).toFixed(2)}%` },
            { type: "mrkdwn", text: `*Allowed Max:*\n${(data.thresholdBps / 100).toFixed(2)}%` },
            { type: "mrkdwn", text: `*Solana TX:*\n<https://explorer.solana.com/tx/${data.txSignature}?cluster=devnet|View on Explorer>` },
            { type: "mrkdwn", text: `*Timestamp:*\n${data.timestamp}` },
          ],
        },
      ],
    };

    await axios.post(CONFIG.slackWebhookUrl, payload, { timeout: 4000 });
    console.log("[Telemetry] Slack incident payload dispatched successfully.");
  }

  private static async sendDiscordNotification(data: IncidentTelemetry): Promise<void> {
    const payload = {
      username: "SolFlow Guardian Sentinel",
      avatar_url: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
      embeds: [
        {
          title: "🚨 CRITICAL: Treasury Circuit-Breaker Activated",
          color: 15158332, // Red
          fields: [
            { name: "Vault", value: `\`${data.vaultAddress}\``, inline: false },
            { name: "Observed Drawdown", value: `${(data.observedDrawdownBps / 100).toFixed(2)}%`, inline: true },
            { name: "Configured Threshold", value: `${(data.thresholdBps / 100).toFixed(2)}%`, inline: true },
            { name: "Incident Reason", value: data.reason, inline: false },
            { name: "Transaction Hash", value: `[Solana Explorer](https://explorer.solana.com/tx/${data.txSignature}?cluster=devnet)`, inline: false },
          ],
          footer: { text: "SolFlow Guardian Enterprise Autonomous Defense" },
          timestamp: new Date().toISOString(),
        },
      ],
    };

    await axios.post(CONFIG.discordWebhookUrl, payload, { timeout: 4000 });
    console.log("[Telemetry] Discord incident webhook delivered successfully.");
  }

  private static async sendResendEmail(data: IncidentTelemetry): Promise<void> {
    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e4e8; border-radius: 8px;">
        <h2 style="color: #d73a49; border-bottom: 2px solid #eaecef; padding-bottom: 10px;">🚨 SolFlow Guardian: Treasury Circuit-Breaker Invocation</h2>
        <p>This is an automated operational security dispatch confirming an emergency freeze on the managed Solana vault.</p>
        
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="background-color: #f6f8fa;">
            <td style="padding: 10px; font-weight: bold;">Vault Address</td>
            <td style="padding: 10px;"><code>${data.vaultAddress}</code></td>
          </tr>
          <tr>
            <td style="padding: 10px; font-weight: bold;">Incident Cause</td>
            <td style="padding: 10px;">${data.reason}</td>
          </tr>
          <tr style="background-color: #f6f8fa;">
            <td style="padding: 10px; font-weight: bold;">Observed Loss Metric</td>
            <td style="padding: 10px; color: #d73a49; font-weight: bold;">${(data.observedDrawdownBps / 100).toFixed(2)}%</td>
          </tr>
          <tr>
            <td style="padding: 10px; font-weight: bold;">Execution Signature</td>
            <td style="padding: 10px;"><a href="https://explorer.solana.com/tx/${data.txSignature}?cluster=devnet">Inspect Solana Transaction</a></td>
          </tr>
        </table>
        
        <p style="font-size: 13px; color: #586069;">Action Required: Convene treasury committee multisig to review risk vectors before invoking <code>unfreeze_vault</code>.</p>
      </div>
    `;

    await axios.post(
      "https://api.resend.com/emails",
      {
        from: CONFIG.resendFromEmail,
        to: [CONFIG.resendAlertEmailTo],
        subject: `[CRITICAL ALERT] SolFlow Guardian Treasury Frozen (${data.vaultAddress.slice(0, 8)}...)`,
        html: htmlBody,
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.resendApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 5000,
      }
    );
    console.log("[Telemetry] Resend audit email dispatched successfully.");
  }
}