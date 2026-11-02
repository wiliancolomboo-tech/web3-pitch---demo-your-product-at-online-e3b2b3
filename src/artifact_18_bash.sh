# 1. Build Solana Anchor Program
anchor build

# 2. Deploy to Solana Devnet
solana program deploy \
  --program-id target/deploy/solpulse_sentinel-keypair.json \
  target/deploy/solpulse_sentinel.so \
  --url devnet

# 3. Configure Local Environment
cat <<EOF > .env
PROGRAM_ID=$(solana address -k target/deploy/solpulse_sentinel-keypair.json)
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_WSS_URL=wss://api.devnet.solana.com
RESEND_API_KEY=re_enterprise_test_token_123456
ACCOUNTING_EMAIL=treasury@company.com
SLACK_WEBHOOK_URL=https://api.example.com/webhooks/alerts/placeholder
EOF

# 4. Run Automated QA Suite
anchor test

# 5. Launch Sentinel Daemon in Isolated Container
docker compose up -d --build
docker compose logs -f sentinel-agent