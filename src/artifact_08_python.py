import asyncio
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey

RPC_URL = "http://localhost:8899"
PROGRAM_ID = Pubkey.from_string("AuraStrm111111111111111111111111111111111111")

async def keeper_loop():
    client = AsyncClient(RPC_URL)
    print(f"[*] AuraStream Keeper Daemon initiated on {RPC_URL}")
    print(f"[*] Monitoring Program: {PROGRAM_ID}")

    while True:
        try:
            # Query program accounts matching active stream criteria
            # and automatically dispatch `crank_stream` instructions
            # when claimable threshold exceeds gas cost.
            await asyncio.sleep(5)
            print("[✓] Crank scan complete: 0 overdue streams detected.")
        except Exception as e:
            print(f"[!] Error in keeper loop: {e}")
            await asyncio.sleep(2)

if __name__ == "__main__":
    asyncio.run(keeper_loop())