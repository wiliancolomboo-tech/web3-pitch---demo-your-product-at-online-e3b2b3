import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  solanaWsUrl: process.env.SOLANA_WS_URL || "wss://api.devnet.solana.com",
  programId: process.env.PROGRAM_ID || "SFG1111111111111111111111111111111111111111",
  guardianPrivateKey: process.env.GUARDIAN_PRIVATE_KEY || "",
  vaultAdminPublicKey: process.env.VAULT_ADMIN_PUBLIC_KEY || "",
  
  // Enterprise Out-of-Band Integration Endpoints
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
  resendApiKey: process.env.RESEND_API_KEY || "",
  resendAlertEmailTo: process.env.RESEND_ALERT_EMAIL_TO || "cfo-ops@enterprise-corp.com",
  resendFromEmail: process.env.RESEND_FROM_EMAIL || "alerts@solflowguardian.io",

  // Risk Engine Parameters
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
  volatilityTriggerBps: parseInt(process.env.VOLATILITY_TRIGGER_BPS || "850", 10), // 8.5%
};