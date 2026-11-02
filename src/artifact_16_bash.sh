# Create local keypair for Sentinel Daemon
mkdir -p secrets
solana-keygen new -o secrets/sentinel-keypair.json --no-bip39-passphrase --force

# Fund Sentinel on Devnet (for transaction execution fees)
solana airdrop 1 $(solana-keygen pubkey secrets/sentinel-keypair.json) -u devnet

# Launch via Docker Compose
docker compose up -d --build
docker compose logs -f solsentinel-watcher