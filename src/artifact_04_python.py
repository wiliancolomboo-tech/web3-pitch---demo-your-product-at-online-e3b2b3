"""
Aegis Protocol Autonomous Keeper Bot
Monitors active on-chain OrderState PDAs, fetches Pyth real-time feeds,
and triggers `execute_order` atomically when conditions are met.
"""

import asyncio
import struct
import logging
from dataclasses import dataclass
from typing import List, Optional
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.transaction import Transaction
from solders.message import Message

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

AEGIS_PROGRAM_ID = Pubkey.from_string("AegisCore11111111111111111111111111111111111")
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
PYTH_SOL_USD_FEED = Pubkey.from_string("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG")

# Binary discriminators
ORDER_DISCRIMINATOR = bytes([134, 173, 223, 185, 33, 82, 159, 133]) # Anchor sha256("account:OrderState")[..8]

@dataclass
class Order:
    pda: Pubkey
    owner: Pubkey
    order_id: int
    input_mint: Pubkey
    output_mint: Pubkey
    deposit_amount: int
    trigger_price: int
    minimum_out_amount: int
    condition: int # 0: Above, 1: Below
    is_active: bool
    vault_bump: int

class AegisKeeperBot:
    def __init__(self, rpc_endpoint: str, keeper_keypair: Keypair):
        self.client = AsyncClient(rpc_endpoint)
        self.keeper = keeper_keypair
        self.running = False

    async def fetch_active_orders(self) -> List[Order]:
        """Fetch all OrderState accounts by filtering on account size and discriminator."""
        orders = []
        try:
            # 8 bytes disc + OrderState::LEN (124 bytes) = 132 bytes
            resp = await self.client.get_program_accounts(
                AEGIS_PROGRAM_ID,
                encoding="base64",
                data_size=132
            )
            if not resp.value:
                return orders

            for account_info in resp.value:
                pubkey = account_info.pubkey
                data = account_info.account.data

                if data[:8] != ORDER_DISCRIMINATOR:
                    continue

                # Unpack fixed layout:
                # 8: discriminator
                # 32: owner, 8: order_id, 32: input_mint, 32: output_mint,
                # 8: deposit_amount, 8: trigger_price, 8: min_out,
                # 1: condition, 1: is_active, 1: bump, 1: vault_bump
                payload = data[8:]
                owner = Pubkey(payload[0:32])
                order_id = struct.unpack("<Q", payload[32:40])[0]
                input_mint = Pubkey(payload[40:72])
                output_mint = Pubkey(payload[72:104])
                deposit_amount = struct.unpack("<Q", payload[104:112])[0]
                trigger_price = struct.unpack("<Q", payload[112:120])[0]
                minimum_out_amount = struct.unpack("<Q", payload[120:128])[0]
                condition = payload[128]
                is_active = bool(payload[129])
                vault_bump = payload[131]

                if is_active:
                    orders.append(Order(
                        pda=pubkey,
                        owner=owner,
                        order_id=order_id,
                        input_mint=input_mint,
                        output_mint=output_mint,
                        deposit_amount=deposit_amount,
                        trigger_price=trigger_price,
                        minimum_out_amount=minimum_out_amount,
                        condition=condition,
                        is_active=is_active,
                        vault_bump=vault_bump
                    ))
        except Exception as e:
            logging.error(f"Error fetching orders: {e}")

        return orders

    async def get_pyth_price(self, oracle_account: Pubkey) -> Optional[int]:
        """Fetch and parse live normalized price from Pyth account."""
        resp = await self.client.get_account_info(oracle_account)
        if not resp.value:
            return None
        
        # Pyth SDK binary layout:
        # Magic (4) + Version (4) + Type (4) + Size (4) + PriceType (4) + Exponent (4)
        # Offset 208 contains current price (i64)
        data = resp.value.data
        if len(data) < 240:
            return None
        
        price = struct.unpack("<q", data[208:216])[0]
        return price if price > 0 else None

    async def trigger_execution(self, order: Order, pyth_oracle: Pubkey):
        """Build and send the execute_order transaction with PDA signer accounts."""
        logging.info(f"Target condition met for order {order.order_id}! Triggering execution...")

        # Derive PDAs
        config_pda, _ = Pubkey.find_program_address([b"config"], AEGIS_PROGRAM_ID)
        vault_pda, _ = Pubkey.find_program_address([b"vault", bytes(order.pda)], AEGIS_PROGRAM_ID)

        # Derive Keeper Token ATA (assumed existing for simplicity)
        keeper_ata, _ = Pubkey.find_program_address(
            [bytes(self.keeper.pubkey()), bytes(TOKEN_PROGRAM_ID), bytes(order.input_mint)],
            Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
        )

        accounts = [
            AccountMeta(pubkey=config_pda, is_signer=False, is_writable=False),
            AccountMeta(pubkey=order.pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=vault_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=keeper_ata, is_signer=False, is_writable=True),
            AccountMeta(pubkey=keeper_ata, is_signer=False, is_writable=True), # destination/dex target
            AccountMeta(pubkey=pyth_oracle, is_signer=False, is_writable=False),
            AccountMeta(pubkey=order.owner, is_signer=False, is_writable=True),
            AccountMeta(pubkey=self.keeper.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        # Anchor discriminator for `execute_order`
        data = bytes([50, 169, 137, 244, 185, 23, 116, 237])

        ix = Instruction(AEGIS_PROGRAM_ID, data, accounts)
        latest_blockhash = (await self.client.get_latest_blockhash()).value.blockhash

        msg = Message([ix], self.keeper.pubkey())
        tx = Transaction([self.keeper], msg, latest_blockhash)

        try:
            tx_sig = await self.client.send_transaction(tx)
            logging.info(f"Successfully executed order {order.order_id}! Tx Sig: {tx_sig.value}")
        except Exception as e:
            logging.error(f"Failed to execute order {order.order_id}: {e}")

    async def run(self):
        self.running = True
        logging.info("Starting Aegis Autonomous Keeper Bot daemon...")

        while self.running:
            try:
                orders = await self.fetch_active_orders()
                if orders:
                    current_price = await self.get_pyth_price(PYTH_SOL_USD_FEED)
                    if current_price:
                        for order in orders:
                            if order.condition == 0 and current_price >= order.trigger_price:
                                await self.trigger_execution(order, PYTH_SOL_USD_FEED)
                            elif order.condition == 1 and current_price <= order.trigger_price:
                                await self.trigger_execution(order, PYTH_SOL_USD_FEED)

            except Exception as e:
                logging.error(f"Error in keeper event loop: {e}")

            await asyncio.sleep(1.0) # Check every 1000ms

if __name__ == "__main__":
    mock_keeper = Keypair()
    bot = AegisKeeperBot("https://api.devnet.solana.com", mock_keeper)
    asyncio.run(bot.run())