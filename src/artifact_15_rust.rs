// Recommended Compute Budget Directives for Client Invocation
ComputeBudgetProgram::set_compute_unit_limit(SetComputeUnitLimitArgs {
    units: 35_000,
});
ComputeBudgetProgram::set_compute_unit_price(SetComputeUnitPriceArgs {
    micro_lamports: 50_000, // Dynamic priority micro-lamports
});