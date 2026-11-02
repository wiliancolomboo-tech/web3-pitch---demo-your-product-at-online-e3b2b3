"""
Kronos Real-Time MEV-Guarded Keeper Daemon
Monitors open streams, verifies profitability bounds, and dispatches high-priority cranks.
"""

import asyncio
import logging
import os
import struct
import time
from typing import List, Optional
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.transaction import VersionedTransaction
from solders.message import MessageV0

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

PROGRAM_ID = Pubkey.from_string("KroN9sH8pZ2K7W6C5fX3qY1VzE8uG4rL0mD1jT9bVxP")
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
RPC_ENDPOINT = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")

class KronosKeeperBot:
    def __init__(self, keypair_path: str):
        self.client = AsyncClient(RPC_ENDPOINT, commitment=Confirmed)
        with open(keypair_path, "r") as f:
            secret = eval(f.read().strip())
            self.wallet = Keypair.from_bytes(bytes(secret))
        logging.info(f"Keeper initialized with address: {self.wallet.pubkey()}")

    async def scan_active_streams(self) -> List[Pubkey]:
        # Filter Program Accounts for StreamAccount discriminator
        # Discriminator for "account:StreamAccount"
        filters = [{"dataSize": 8 + 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 16 + 8 + 1 + 1 + 1 + 1}]
        resp = await self.client.get_program_accounts(
            PROGRAM_ID,
            commitment=Confirmed,
            encoding="base64",
            filters=filters,
        )
        return [acc.pubkey for acc in resp.value]

    async def evaluate_and_crank(self, stream_pda: Pubkey):
        account_info = await self.client.get_account_info(stream_pda)
        if not account_info.value or not account_info.value.data:
            return

        data = account_info.value.data
        # Decode StreamAccount struct
        # Offset 8 (discriminator)
        offset = 8
        stream_id, = struct.unpack_from("<Q", data, offset); offset += 8
        sender = Pubkey(data[offset:offset+32]); offset += 32
        beneficiary = Pubkey(data[offset:offset+32]); offset += 32
        mint = Pubkey(data[offset:offset+32]); offset += 32
        escrow_vault = Pubkey(data[offset:offset+32]); offset += 32
        total_deposit, claimed_amount, start_time, end_time, cliff_time = struct.unpack_from("<QQqqq", data, offset)
        offset += 40
        rate_q64, = struct.unpack_from("<QQ", data, offset) # u128
        offset += 16
        last_settled, is_cancelable, is_completed = struct.unpack_from("<q??", data, offset)

        now = int(time.time())
        if is_completed or now < cliff_time:
            return

        effective_time = min(now, end_time)
        vested = int(((effective_time - start_time) * rate_q64) / 1_000_000_000_000)
        claimable = min(total_deposit, vested) - claimed_amount

        # Profitability check: minimum claimable incentive to offset CU priority fees
        crank_incentive = int((claimable * 25) / 10000)
        if crank_incentive < 500:  # e.g., minimum unit threshold
            return

        logging.info(f"Profitable stream found! Stream ID {stream_id} | Incentive: {crank_incentive}")

        # Derive ATA accounts and build transaction
        beneficiary_ata = self.get_associated_token_address(beneficiary, mint)
        caller_ata = self.get_associated_token_address(self.wallet.pubkey(), mint)

        ix = self.build_crank_instruction(
            stream_pda,
            escrow_vault,
            beneficiary_ata,
            caller_ata
        )

        await self.send_priority_transaction([ix])

    def get_associated_token_address(self, owner: Pubkey, mint: Pubkey) -> Pubkey:
        ata, _ = Pubkey.find_program_address(
            [bytes(owner), bytes(TOKEN_PROGRAM_ID), bytes(mint)],
            Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
        )
        return ata

    def build_crank_instruction(
        self,
        stream_pda: Pubkey,
        escrow_vault: Pubkey,
        beneficiary_ata: Pubkey,
        caller_ata: Pubkey,
    ) -> Instruction:
        # Instruction discriminator for crank_settle
        # sighash("global", "crank_settle")
        disc = bytes([128, 143, 203, 114, 184, 11, 237, 241]) 
        data = disc + bytes([0]) # None for amount_to_claim

        accounts = [
            AccountMeta(pubkey=stream_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=escrow_vault, is_signer=False, is_writable=True),
            AccountMeta(pubkey=beneficiary_ata, is_signer=False, is_writable=True),
            AccountMeta(pubkey=self.wallet.pubkey(), is_signer=True, is_writable=False),
            AccountMeta(pubkey=caller_ata, is_signer=False, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        ]
        return Instruction(PROGRAM_ID, data, accounts)

    async def send_priority_transaction(self, instructions: List[Instruction]):
        recent_blockhash = (await self.client.get_latest_blockhash()).value.blockhash
        msg = MessageV0.try_compile(
            payer=self.wallet.pubkey(),
            instructions=instructions,
            address_lookup_table_accounts=[],
            recent_blockhash=recent_blockhash,
        )
        tx = VersionedTransaction(msg, [self.wallet])
        sig = await self.client.send_raw_transaction(bytes(tx))
        logging.info(f"Crank submitted: https://solscan.io/tx/{sig}")

    async def run(self):
        logging.info("Starting Kronos Crank Keeper worker loop...")
        while True:
            try:
                active_streams = await self.scan_active_streams()
                for stream in active_streams:
                    await self.evaluate_and_crank(stream)
            except Exception as e:
                logging.error(f"Keeper tick error: {e}")
            await asyncio.sleep(1.0)

if __name__ == "__main__":
    bot = KronosKeeperBot("/root/.config/solana/id.json")
    asyncio.run(bot.run())