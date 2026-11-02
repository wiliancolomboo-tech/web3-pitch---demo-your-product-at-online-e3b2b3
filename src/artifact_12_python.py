import asyncio
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.keypair import Keypair

RPC_URL = "http://127.0.0.1:8899"
PROGRAM_ID = Pubkey.from_string("Chrno68xK7yWc8sDqHZwB6G5yP3uE4F7gQ8L9u1v2Ab3")

async def monitor_and_crank():
    client = AsyncClient(RPC_URL)
    print(f"[*] ChronoStream Keeper Daemon active on: {RPC_URL}")
    print(f"[*] Monitoring Program ID: {PROGRAM_ID}")

    while True:
        try:
            # Query program accounts matching StreamState discriminator
            accounts = await client.get_program_accounts(PROGRAM_ID)
            print(f"[+] Heartbeat: Active streams detected: {len(accounts.value)}")
            
            # Logic: Iterate streams, check current time vs last_settled_time, execute crank
            await asyncio.sleep(2)
        except Exception as e:
            print(f"[!] Error in keeper loop: {e}")
            await asyncio.sleep(5)

if __name__ == "__main__":
    asyncio.run(monitor_and_crank())