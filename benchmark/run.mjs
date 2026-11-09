import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CWM } from '../demo/cwm.mjs';
import { configurations, makeWorkload, oracle } from './workloads.mjs';

const quick = process.argv.includes('--quick');
const sizes = quick ? [100] : [500, 2000];
const repeats = quick ? 1 : 3;
const strategies = ['cwm', 'recount', 'global'];
const quantile = (values, p) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function trial(workload, expected, strategy) {
  const startSetup = performance.now();
  const model = new CWM(workload.sources, { strategy });
  workload.setupMerges.forEach(pair => model.merge(...pair));
  const tokens = new Map();
  for (const d of workload.decisions) {
    model.register(d.id, d.sources, d.threshold, d.action);
    const token = model.issue(d.id);
    if (!token) throw new Error('Workload starts with insufficient support');
    tokens.set(d.id, token);
  }
  const setupMs = performance.now()-startSetup;
  model.resetMetrics();
  const startMerge = performance.now();
  workload.updates.forEach(pair => model.merge(...pair));
  const updateMs = performance.now()-startMerge;
  let executed = 0, unsafe = 0, falseBlocks = 0, recoveries = 0;
  const latencies = [];
  const startActions = performance.now();
  for (const d of workload.decisions) {
    const start = performance.now();
    const result = model.attempt(tokens.get(d.id), d.action);
    latencies.push((performance.now()-start)*1000);
    const allowed = result.final === 'executed';
    executed += Number(allowed);
    unsafe += Number(allowed && !expected.get(d.id));
    falseBlocks += Number(!allowed && expected.get(d.id));
    recoveries += Number(allowed && !!result.replacement);
  }
  const actionMs = performance.now()-startActions;
  return { strategy, setupMs, updateMs, actionMs, totalMs: updateMs+actionMs,
    p50ActionUs: quantile(latencies, .5), p95ActionUs: quantile(latencies, .95),
    executed, blocked: workload.count-executed, unsafe, falseBlocks, recoveries, ...model.metrics };
}

// Untimed warmup of all execution paths, excluded from outputs.
for (const config of configurations) {
  const workload = makeWorkload(config, 20, 1);
  const expected = oracle(workload);
  for (const strategy of strategies) trial(workload, expected, strategy);
}
const rows = [];
for (const count of sizes) for (const config of configurations) {
  const workload = makeWorkload(config, count, 42);
  const expected = oracle(workload);
  const traceHash = digest(workload);
  for (let repeat = 0; repeat < repeats; repeat++) {
    const order = strategies.map((_, i) => strategies[(i+repeat)%strategies.length]);
    for (const strategy of order) {
      const result = trial(workload, expected, strategy);
      rows.push({ workload: config.name, count, repeat, traceHash, ...result });
      if (result.unsafe || result.falseBlocks) throw new Error(`Correctness mismatch: ${JSON.stringify(result)}`);
    }
  }
  console.log(`Verified ${config.name}, ${count} decisions, ${repeats} repeat(s)`);
}
const metadata = { generatedAt: new Date().toISOString(), mode: quick ? 'quick' : 'full',
  node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
  sizes, repeats, seed: 42, timing: 'Real Ed25519; setup separate; updates + gateway/re-attestation/action timed; oracle excluded' };
const output = new URL(quick ? '../results/quick/' : '../results/', import.meta.url);
mkdirSync(output, { recursive: true });
writeFileSync(new URL('benchmark.json', output), JSON.stringify({ metadata, rows }, null, 2)+'\n');
const keys = Object.keys(rows[0]);
writeFileSync(new URL('benchmark.csv', output), keys.join(',')+'\n'+rows.map(row => keys.map(k => row[k]).join(',')).join('\n')+'\n');
const summaries = [];
for (const count of sizes) for (const config of configurations) for (const strategy of strategies) {
  const subset = rows.filter(r => r.count === count && r.workload === config.name && r.strategy === strategy);
  const sample = subset[0];
  summaries.push({ workload: config.name, count, strategy,
    medianMs: quantile(subset.map(r => r.totalMs), .5),
    minMs: Math.min(...subset.map(r => r.totalMs)), maxMs: Math.max(...subset.map(r => r.totalMs)),
    p95Us: quantile(subset.map(r => r.p95ActionUs), .5),
    sourceLookups: sample.sourceLookups, witnessChecks: sample.witnessChecks,
    reattestations: sample.reattestations, signatures: sample.signatures,
    executed: sample.executed, blocked: sample.blocked, unsafe: sample.unsafe, falseBlocks: sample.falseBlocks });
}
const lines = ['# Measured baseline comparison', '',
  `Generated ${metadata.generatedAt}. Node ${metadata.node}; ${metadata.cpu}; ${metadata.platform}/${metadata.arch}.`, '',
  `${rows.length} measured runs, ${repeats} repeat(s) per strategy/workload/size. Every run matched an independent group-label oracle: zero unsafe executions and zero false blocks.`, '',
  'These are synthetic local measurements, not paper-ready evidence of real-world accuracy or distributed scalability. Repeats share seed 42 and identical traces; their variation measures runtime noise, not statistical variation across datasets.', '',
  'Total time is merge updates plus gateway/action processing, including cryptography and in-memory logging. Initial partition setup, registration, token issuance, warmup, and oracle evaluation are excluded; setup time is available in the raw CSV. No performance threshold is asserted.', '',
  '| Workload | Decisions | Method | Median total ms (min–max) | Median trial p95 action µs | Re-attestations | Source lookups | Witness checks | Renewed signatures | Executed / blocked |',
  '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
for (const r of summaries) lines.push(`| ${r.workload} | ${r.count} | ${r.strategy} | ${r.medianMs.toFixed(2)} (${r.minMs.toFixed(2)}–${r.maxMs.toFixed(2)}) | ${r.p95Us.toFixed(2)} | ${r.reattestations} | ${r.sourceLookups} | ${r.witnessChecks} | ${r.signatures} | ${r.executed} / ${r.blocked} |`);
lines.push('', '## Interpretation', '',
  'Compare CWM with global versioning to assess selective invalidation. Compare CWM with recount to assess whether avoiding source resolution repays the cost of witness validation and renewal. Lower re-attestation counts alone do not establish faster execution.', '',
  'In the many_sources workloads, each decision has 32 source IDs but only four initial origin groups. This deliberately tests where a compact witness could help. In the other workloads, there are only three or four source IDs per decision, so recounting may be cheaper. All-affected workloads deliberately remove the selectivity advantage.', '',
  'Source lookups count input IDs passed to roots(); witness checks count root/epoch checks, including repeated checks during renewal. Neither counts internal union-find pointer hops. Both are reported so reduced source lookups cannot be mistaken for reduced total work.', '',
  'Global versioning retains the common signed-token payload for a controlled comparison. A specialized global-token format could be smaller/faster. The recount baseline does not sign a replacement after a merge: it authorizes directly from current support within the atomic local operation. CWM/global follow the demo’s extra verification and recount passes; these costs are included.', '',
  'See the repository README for assumptions and usage. Recorded paper results are not bundled with this code-only release.');
writeFileSync(new URL('SUMMARY.md', output), lines.join('\n')+'\n');
console.log(`Saved results to ${fileURLToPath(output)}`);
