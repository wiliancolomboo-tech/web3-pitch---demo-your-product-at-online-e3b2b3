# 1. Install dependencies
yarn install

# 2. Build Anchor smart contract
anchor build

# 3. Synchronize generated Program ID with Anchor.toml and lib.rs
solana address -k target/deploy/streamguard-keypair.json
# (Replace declare_id! with generated key)

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Run end-to-end integration tests
anchor test --skip-local-validator