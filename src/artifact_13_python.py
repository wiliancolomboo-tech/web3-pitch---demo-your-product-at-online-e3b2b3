import asyncio
import os
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta

RPC_URL = os.getenv("SOLANA_RPC_URL", "http://127.0.0.1:8899")
PROGRAM_ID = Pubkey.from_string("Aegis111111111111111111111111111111111111111")
POOL_ADDRESS = Pubkey.from_string("YOUR_POOL_PDA_ADDRESS_HERE")
KEEPER_KEYPAIR = Keypair.from_base58_string(os.getenv("KEEPER_PRIVATE_KEY", "..."))

async def run_crank_bot():
    client = AsyncClient(RPC_URL)
    print(f"[*] Aegis Crank Keeper running on {RPC_URL}...")
    
    # 8-byte discriminator for 'crank_epoch'
    discriminator = bytes([208, 147, 81, 76, 219, 132, 254, 89])

    sol_vault, _ = Pubkey.find_program_address(
        [b"sol-vault", bytes(POOL_ADDRESS)],
        PROGRAM_ID
    )

    while True:
        try:
            accounts = [
                AccountMeta(pubkey=POOL_ADDRESS, is_signer=False, is_writable=True),
                AccountMeta(pubkey=sol_vault, is_signer=False, is_writable=True),
                AccountMeta(pubkey=KEEPER_KEYPAIR.pubkey(), is_signer=True, is_writable=True),
                AccountMeta(pubkey=Pubkey.from_string("11111111111111111111111111111111"), is_signer=False, is_writable=False),
            ]
            ix = Instruction(PROGRAM_ID, discriminator, accounts)
            
            # Simulated check or broadcast
            slot = (await client.get_slot()).value
            print(f"[Slot: {slot}] Polling epoch threshold for Pool: {POOL_ADDRESS}")
            
            # Sleep until next epoch interval (~30s)
            await asyncio.sleep(30)

        except Exception as e:
            print(f"[!] Error executing crank loop: {e}")
            await asyncio.sleep(5)

if __name__ == "__main__":
    asyncio.run(run_crank_bot())