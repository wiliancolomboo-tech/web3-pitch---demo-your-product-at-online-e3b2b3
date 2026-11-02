#!/usr/bin/env python3
"""
SolVanguard Autonomous Keeper Rebalancer Bot
Sub-second event parsing and atomic execution bot.
"""

import asyncio
import os
import sys
import time
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.transaction import VersionedTransaction
from solders.message import MessageV0
import struct

RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.devnet.solana.com")
PROGRAM_ID = Pubkey.from_string("VngrdX1111111111111111111111111111111111111")
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

class SolVanguardKeeper:
    def __init__(self, keypair_path: str):
        with open(keypair_path, "r") as f:
            secret = list(map(int, f.read().strip("[]\n ").split(",")))
        self.wallet = Keypair.from_bytes(bytes(secret[:64]))
        self.client = AsyncClient(RPC_URL)
        print(f"[*] Keeper initialized with Pubkey: {self.wallet.pubkey()}")

    def derive_pdas(self, vault_owner: Pubkey, token_mint: Pubkey):
        vault_pda, _ = Pubkey.find_program_address(
            [b"vault", bytes(vault_owner), bytes(token_mint)],
            PROGRAM_ID
        )
        token_escrow_pda, _ = Pubkey.find_program_address(
            [b"token_escrow", bytes(vault_pda)],
            PROGRAM_ID
        )
        keeper_registry_pda, _ = Pubkey.find_program_address(
            [b"keeper", bytes(self.wallet.pubkey())],
            PROGRAM_ID
        )
        return vault_pda, token_escrow_pda, keeper_registry_pda

    async def monitor_and_execute(self, vault_owner: Pubkey, token_mint: Pubkey, keeper_token_acc: Pubkey):
        vault_pda, token_escrow, keeper_registry = self.derive_pdas(vault_owner, token_mint)
        print(f"[*] Monitoring Vault PDA: {vault_pda}")

        while True:
            try:
                acc_info = await self.client.get_account_info(vault_pda)
                if not acc_info.value:
                    await asyncio.sleep(1.0)
                    continue

                raw_data = acc_info.value.data
                # HedgedVault layout: 8 (discrim) + 32 (owner) + 32 (mint) + 32 (escrow) + 8 (collateral) + 8 (debt) + 8 (health) + 1 (is_locked)
                if len(raw_data) >= 8 + 32 + 32 + 32 + 8 + 8 + 8 + 1:
                    collateral_amt = struct.unpack_from("<Q", raw_data, 8 + 32 + 32 + 32)[0]
                    is_locked = struct.unpack_from("<?", raw_data, 8 + 32 + 32 + 32 + 8 + 8 + 8)[0]
                    
                    if collateral_amt > 1_000 and not is_locked:
                        print(f"[!] Actionable collateral detected: {collateral_amt}. Triggering rebalance...")
                        await self.send_rebalance_ix(vault_pda, token_escrow, keeper_registry, keeper_token_acc)

                await asyncio.sleep(0.4) # Polling at slot time
            except Exception as e:
                print(f"[ERR] Keeper loop exception: {e}")
                await asyncio.sleep(2.0)

    async def send_rebalance_ix(self, vault: Pubkey, escrow: Pubkey, registry: Pubkey, keeper_token_acc: Pubkey):
        # execute_rebalance sighash = 8 bytes
        # args: simulated_oracle_price (u64), price_timestamp (i64)
        current_ts = int(time.time())
        simulated_price = 150_000_000 # $1.50
        
        # Sighash: anchor execute_rebalance discriminator
        ix_discriminator = bytes([107, 151, 169, 131, 235, 12, 196, 241]) # precomputed Anchor sighash
        ix_data = ix_discriminator + struct.pack("<Qq", simulated_price, current_ts)

        accounts = [
            AccountMeta(pubkey=vault, is_signer=False, is_writable=True),
            AccountMeta(pubkey=escrow, is_signer=False, is_writable=True),
            AccountMeta(pubkey=registry, is_signer=False, is_writable=True),
            AccountMeta(pubkey=keeper_token_acc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=self.wallet.pubkey(), is_signer=True, is_writable=False),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        ix = Instruction(PROGRAM_ID, ix_data, accounts)
        blockhash_resp = await self.client.get_latest_blockhash()
        recent_blockhash = blockhash_resp.value.blockhash

        msg = MessageV0.try_compile(
            payer=self.wallet.pubkey(),
            instructions=[ix],
            address_lookup_table_accounts=[],
            recent_blockhash=recent_blockhash,
        )
        tx = VersionedTransaction(msg, [self.wallet])
        sig = await self.client.send_transaction(tx)
        print(f"[SUCCESS] Rebalance broadcasted! Tx Signature: {sig.value}")

if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python keeper_bot.py <keypair_json> <owner_pubkey> <token_mint> <keeper_token_account>")
        sys.exit(1)

    bot = SolVanguardKeeper(sys.argv[1])
    asyncio.run(
        bot.monitor_and_execute(
            Pubkey.from_string(sys.argv[2]),
            Pubkey.from_string(sys.argv[3]),
            Pubkey.from_string(sys.argv[4]),
        )
    )