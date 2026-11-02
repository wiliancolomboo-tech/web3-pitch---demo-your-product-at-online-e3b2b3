const program = anchor.workspace.NexusClearinghouse;
const [clearinghouse] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("clearinghouse")],
  program.programId
);
const state = await program.account.clearinghouseState.fetch(clearinghouse);
console.log("NexusFi Admin:", state.admin.toBase58());