anchor console --provider.cluster devnet

const program = anchor.workspace.KinetixCore;
const [marketPda] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("market"), collateralMint.toBuffer(), borrowMint.toBuffer()],
  program.programId
);
const marketState = await program.account.marketConfig.fetch(marketPda);
console.log("Current Market Utilization BPS:", marketState.optimalUtilizationBps);