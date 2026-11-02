# 1. Clone repository and install dependencies
git clone https://github.com/kronos-solana/sentinel-vault.git
cd sentinel-vault
npm install

# 2. Build Anchor smart contract
anchor build

# 3. Synchronize program keys
solana address -k target/deploy/kronos_sentinel-keypair.json
# Confirm ID matches lib.rs 'declare_id!'

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 5. Run full integration QA Matrix (100% assertions)
anchor test