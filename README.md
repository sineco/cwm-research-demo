# CWM research code

Reference implementation of corroboration witness maintenance (CWM). Signed tokens record the origin groups supporting a decision and their epochs. Before a simulated action executes, the gateway checks freshness; changed support is recounted, then permission is renewed or execution stays blocked.

This code-only release contains implementation, tests, workload generators, public-report metadata fixtures and experiment runners. It excludes the manuscript, recorded measurements, private review documents and private repository history. Running a benchmark generates new measurements, not the paper's archived results.

## Quick start

Requires Node.js 20+ and Git. No third-party Node packages are needed. These commands use no paid APIs:

```sh
npm test
npm run demo
npm run demo:agent:smoke
npm run experiment:five-cases:smoke
npm run demo:downstream
npm run benchmark:tradeoff:smoke
```

Tests and agent demos need permission to bind local loopback ports and launch child processes. The smoke agent follows a script; it is not an LLM. The action service records simulated effects in memory and never changes a firewall. Open `demo/output/report.html` after the basic demo. Generated files under `results/` and `demo/output/` are ignored by Git.

## Optional live agent

Copy `.env.agent.example` to `.env.agent`, then set your own OpenAI-compatible endpoint, model and API key locally. Never commit the key. Live runs send fixture metadata to your configured provider and can incur API charges.

```sh
cp .env.agent.example .env.agent
# Edit .env.agent locally before running either command below.
npm run demo:agent
npm run experiment:five-cases
```

The example configuration uses `https://api.openai.com/v1` and `gpt-4o-mini`. This is a configuration example, not a claim that this model reproduces historical measurements. The single-case runner supports `--recount` and `--no-disclosure` after `--`.

## Code map

| Files | Purpose |
| --- | --- |
| `demo/cwm.mjs` | Origin groups, epochs, signed tokens, gateway and renewal |
| `demo/agent-{loop,service,client,experiment}.mjs` | Model tool loop and separate local action service |
| `demo/report-suite-run.mjs`, `demo/fixtures/` | Five public-report cases: disclosure, control and recovery |
| `demo/witness-consumer.mjs`, `demo/downstream-witness.mjs` | Consumer requiring a current signed manifest |
| `benchmark/dependency-index.mjs` | Dependency witnesses and incremental eligibility |
| `benchmark/compact-permit.mjs`, `benchmark/tradeoff.mjs` | Compact permits and early-exit recount comparisons |
| `benchmark/execution-boundary.mjs`, `benchmark/concurrent-service.mjs` | Ordered and concurrent local execution checks |
| `benchmark/token-cost.mjs` | Signing, verification and token-size measurements |
| `benchmark/{run,spectrum-run,scaling-run}.mjs` | Original comparison and scaling experiments |
| `demo/*.test.mjs`, `benchmark/*.test.mjs` | Regression and outcome tests |

## Experiments

Run from a Git clone; spectrum and scaling record the current commit. Full runs may take longer and consume more memory than smoke runs.

```sh
npm run benchmark:quick
npm run benchmark:spectrum:quick
npm run benchmark:scaling -- --smoke
npm run experiment:boundary
npm run experiment:concurrent-service
npm run benchmark:token-cost
npm run benchmark:tradeoff -- --early
```

The full original runs are `npm run benchmark:spectrum` and `npm run benchmark:scaling`. Some runners refuse to overwrite existing output directories. Code snapshots, hashes and metadata accompany generated results. The public five-case runner snapshots its code and fixtures without requiring private annotation documents. Recorded-result verifier scripts are included for checking locally generated archives; no archived measurements are shipped.

## Evidence and interpretation

Fixtures contain public report URLs and short paraphrased claims, not full articles. Their initial partitions, disclosure timing and thresholds are controlled experimental assumptions. AI-assisted annotations were checked by the authors; fixture review fields retain historical collection-time status. The recovery scenario adds an explicitly synthetic third source. These five selected pairs are not representative sampling or formal independent adjudication. Defanged historical indicators are evidence strings, not instructions to visit domains or block real traffic.

CWM and dependency-indexed witnesses maintain signed support records. Eligibility indexes and early-exit recount can enforce a current allow/block decision without renewing such a record. The downstream adapter shows that recount can also produce a full manifest. Timings must be interpreted with these different contracts in mind; CWM is not universally faster or smaller.

## Assumptions and limitations

Source registration and lineage updates are trusted. Source sets are fixed and provenance only merges. Cryptographic validity does not prove that sources are truthful or independent. Missed merges can permit unsafe actions relative to true lineage; false merges can incorrectly block actions.

There is no Raft implementation, provenance-discovery engine, production firewall integration, or distributed atomicity guarantee. Validation and simulated effects use a local synchronous boundary. Keys, replay state and audit state are ephemeral. CPU-delay interventions do not measure network latency. The live agent pilot uses curated metadata and simulated actions; it does not establish resistance to adaptive attacks.

## Licensing

No open-source license has been assigned. Public visibility alone does not grant an open-source license. Licensing is pending agreement by the rights holders. Third-party report copyrights remain with their publishers.
