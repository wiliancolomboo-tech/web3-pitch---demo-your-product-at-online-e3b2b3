# Generate program deploy key
solana-keygen new -o target/deploy/sol_sentinel-keypair.json --no-bip39-passphrase --force

# Sync program ID in lib.rs & Anchor.toml with keypair address
anchor keys sync

# Build optimized binary
anchor build

# Deploy to Devnet
solana airdrop 2 -u devnet
anchor deploy --provider.cluster devnet