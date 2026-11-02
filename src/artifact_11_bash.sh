# 1. Clone & install dependencies
git clone https://github.com/solflow-guardian/core.git
cd core
npm install

# 2. Build on-chain Anchor program
anchor build

# 3. Synchronize program keys
solana address -k target/deploy/solflow_guardian-keypair.json
# Update declare_id!("...") in programs/solflow-guardian/src/lib.rs if regenerating key

# 4. Deploy to Solana Devnet
anchor deploy --provider.cluster devnet

# 5. Run end-to-end integration test suite
anchor test