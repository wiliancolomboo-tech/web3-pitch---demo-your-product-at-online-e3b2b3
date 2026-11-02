import { Command } from "commander";
import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { EnterpriseNotifier } from "./notifier";
import * as dotenv from "dotenv";

dotenv.config();

const programId = new PublicKey(
  process.env.PROGRAM_ID || "NexEscrow11111111111111111111111111111111111"
);
const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const program = new Command();
program.name("nexus-agent").description("Enterprise CLI & Event Relayer for NexusEscrow").version("1.0.0");

program
  .command("listen")
  .description("Launch real-time RPC log parser and push alerts to Slack & Resend")
  .action(async () => {
    console.log(`[INIT] Connecting to Solana RPC at ${rpcUrl}...`);
    const connection = new Connection(rpcUrl, { commitment: "confirmed", wsEndpoint: rpcUrl.replace("https", "wss").replace("http", "ws") });
    const notifier = new EnterpriseNotifier();

    console.log(`[SUBSCRIBED] Listening for Program Logs: ${programId.toBase58()}`);

    connection.onLogs(
      programId,
      async ({ logs, err, signature }) => {
        if (err) {
          console.error(`[TX ERROR] Signature ${signature} failed execution:`, err);
          return;
        }

        console.log(`[LOG MATCH] Raw transaction detected: ${signature}`);
        for (const log of logs) {
          if (log.includes("MilestoneSubmitted")) {
            await notifier.dispatch({
              eventType: "MilestoneSubmitted",
              escrowPubkey: signature,
              details: { signature, rawLog: log },
              timestamp: Math.floor(Date.now() / 1000),
            });
          } else if (log.includes("MilestoneReleased")) {
            await notifier.dispatch({
              eventType: "MilestoneReleased",
              escrowPubkey: signature,
              details: { signature, rawLog: log },
              timestamp: Math.floor(Date.now() / 1000),
            });
          } else if (log.includes("EscrowDisputed")) {
            await notifier.dispatch({
              eventType: "EscrowDisputed",
              escrowPubkey: signature,
              details: { signature, alertLevel: "CRITICAL", rawLog: log },
              timestamp: Math.floor(Date.now() / 1000),
            });
          }
        }
      },
      "confirmed"
    );

    // Keep process alive
    process.stdin.resume();
  });

program.parse(process.argv);