#!/usr/bin/env python3
"""
AegisFlow Autonomous Keeper Daemon
Monitors all on-chain StreamEscrow PDAs and executes atomic liquidations.
"""

import time
import asyncio
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey

RPC_URL = "https://api.devnet.solana.com"
PROGRAM_ID = Pubkey.from_string("Aeg1sF1ow11111111111111111111111111111111111")
LIQUIDATION_THRESHOLD_BPS = 8500

async def monitor_streams():
    client = AsyncClient(RPC_URL)
    print(f"[*] AegisFlow Keeper Engine Online. Scanning Program: {PROGRAM_ID}")

    while True:
        try:
            # Query all program accounts matching StreamEscrow layout
            accounts = await client.get_program_accounts(PROGRAM_ID)
            current_time = int(time.time())
            
            for acc in accounts.value:
                data = acc.account.data
                if len(data) < 180: # Skip non-stream accounts
                    continue

                # Unpack StreamEscrow fields (Offsets based on InitSpace alignment)
                # Stream ID: offset 8..16
                # Total Deposited: offset 112..120
                # Principal Debt: offset 128..136
                # Start Time: offset 136..144
                # End Time: offset 144..152
                total_deposited = int.from_bytes(data[112:120], byteorder="little")
                debt = int.from_bytes(data[128:136], byteorder="little")
                start_time = int.from_bytes(data[136:144], byteorder="little", signed=True)
                end_time = int.from_bytes(data[144:152], byteorder="little", signed=True)

                if debt == 0 or current_time >= end_time:
                    continue

                # Calculate remaining unvested collateral
                elapsed = max(0, current_time - start_time)
                duration = end_time - start_time
                vested = (total_deposited * elapsed) // duration if duration > 0 else total_deposited
                unvested = max(0, total_deposited - vested)

                if unvested == 0:
                    health_bps = 10_000
                else:
                    health_bps = (debt * 10_000) // unvested

                if health_bps >= LIQUIDATION_THRESHOLD_BPS:
                    print(f"[!] LIQUIDATABLE STREAM DETECTED: {acc.pubkey}")
                    print(f"    Current Debt: {debt} | Unvested Collateral: {unvested} | Health: {health_bps / 100}%")
                    # Trigger liquidation instruction CPI here via local signer
                    
        except Exception as e:
            print(f"[!] Polling error encountered: {str(e)}")

        await asyncio.sleep(1.0) # Scan every 1 second (approx 2 Solana slots)

if __name__ == "__main__":
    asyncio.run(monitor_streams())