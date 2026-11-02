# 1. Build and verify Anchor binary
anchor build

# 2. Get Program Keypair Address
solana-keygen pubkey target/deploy/sol_sentinel-keypair.json

# 3. Synchronize program ID in lib.rs & Anchor.toml, then rebuild
anchor build

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Initialize Sentinel Daemon Environment
cp .env.example .env
npm install
npm run start:daemon