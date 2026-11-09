# CWM research code

Reference implementation of corroboration witness maintenance (CWM) and its re-attestation extension. Signed tokens record the origin groups supporting a decision and their epochs. Before a simulated action executes, the gateway checks freshness; changed support is recounted, then permission is renewed or execution stays blocked.

This code-only release contains implementation, tests, synthetic workload generators, and benchmark runners. It excludes the manuscript, invention disclosures, co-author correspondence, recorded measurements, and private repository history. Running these commands generates new measurements, not the paper's recorded results.

## Quick start

Requires Node.js 20+ and Git. No third-party Node packages or API keys are required.

```sh
npm test
npm run demo
npm run benchmark:quick
npm run benchmark:spectrum:quick
```

Open the generated `demo/output/report.html` in a browser. Run commands from a Git clone: spectrum and scaling runners record the current commit for reproducibility.

## Code map

| File | Purpose |
| --- | --- |
| `demo/cwm.mjs` | Origin groups, epochs, signed tokens, gateway, re-attestation |
| `demo/run.mjs` | Four-case demonstration and generated report |
| `demo/cwm.test.mjs` | Token lifecycle and validation tests |
| `benchmark/dependency-index.mjs` | Incremental eligibility and dependency-indexed witnesses |
| `benchmark/workloads.mjs` | Initial workloads and independent group-label oracle |
| `benchmark/spectrum-workloads.mjs` | Shared, streaming, and lineage-error workloads |
| `benchmark/run.mjs` | Initial three-method comparison |
| `benchmark/spectrum-run.mjs` | Five-method spectrum comparison |
| `benchmark/scaling-run.mjs` | Fresh-process memory and timing experiments |
| `benchmark/*.test.mjs` | Baseline, dependency-index, and scaling checks |

## Full experiments

```sh
npm run benchmark
npm run benchmark:spectrum
npm run benchmark:scaling -- --smoke
npm run benchmark:scaling
```

Full experiments can take substantially longer and use more memory than quick runs. Outputs appear under `results/`, excluded from Git. Spectrum/scaling outputs include source snapshots, hashes, and protocol metadata. Inspect the runners for workload definitions and measurement boundaries.

The five methods are CWM, recounting, global invalidation, incremental eligibility, and dependency-indexed witnesses. Recounting and incremental eligibility enforce current eligibility without requiring a replacement signed account of supporting origins. This distinction matters when comparing costs.

## Assumptions and limitations

Sources, claims, thresholds, and lineage updates are trusted inputs. Source sets are fixed and provenance can only merge. All evidence and actions are synthetic. The action writes to an in-memory outbox.

There is no Raft implementation, LLM, copying detector, real dataset, firewall integration, or distributed execution guarantee. Audit and replay state are in memory and signing keys are ephemeral. Lookup-cost interventions add synchronous CPU work, not real network latency. All methods depend on accepted lineage; missed merges can permit unsafe actions relative to true lineage, while false merges can incorrectly block actions.

This is research code, not production authorization software.

## Licensing

No open-source license has been assigned. Public visibility alone does not grant an open-source license. Licensing is pending agreement by the rights holders.
