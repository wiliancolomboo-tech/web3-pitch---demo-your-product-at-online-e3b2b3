# 1. Build and Test Solana Anchor Program
anchor build
anchor test

# 2. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
anchor deploy --program-name nexus_escrow

# 3. Spin up Autonomous Enterprise Telemetry Daemon via Docker
cp .env.example .env
# Edit .env with your actual RESEND_API_KEY and SLACK_WEBHOOK_URL
docker compose up -d --build

# 4. View Real-Time Multi-Channel Logs
docker compose logs -f nexus-telemetry-agent