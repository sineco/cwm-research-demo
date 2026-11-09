import { performance } from 'node:perf_hooks';
import { cpus, platform, arch, loadavg } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createModel } from './dependency-index.mjs';
import { spectrumConfigs, makeSpectrum, expectedEvents } from './spectrum-workloads.mjs';

export const strategies = ['cwm', 'recount', 'global', 'dependency', 'dependency-witness'];
const digest = x => createHash('sha256').update(x).digest('hex');
const quantile = (xs, p) => [...xs].sort((a,b) => a-b)[Math.max(0, Math.ceil(xs.length*p)-1)];

export function runTrial(w, strategy, expected = expectedEvents(w)) {
  const startSetup = performance.now();
  const model = createModel(w.sources, strategy);
  w.setupMerges.forEach(pair => model.merge(...pair));
  const tokens = new Map(), byId = new Map(w.decisions.map(d => [d.id, d]));
  for (const d of w.decisions) {
    model.register(d.id, d.sources, d.threshold, d.action);
    const token = model.issue(d.id);
    if (!token) throw new Error('Insufficient initial support');
    tokens.set(d.id, token);
  }
  const setupMs = performance.now() - startSetup;
  const initialIndexEdges = model.edges ?? 0;
  const setupMetrics = { ...model.metrics };
  // Deliberately synthetic synchronous per-source resolution cost, not network latency.
  let injectedMs = 0;
  if (w.delayUs) {
    const roots = model.roots.bind(model);
    model.roots = ids => {
      const start = performance.now(), target = ids.length * w.delayUs / 1000;
      while (performance.now() - start < target) { /* controlled CPU delay */ }
      injectedMs += performance.now() - start;
      return roots(ids);
    };
  }
  model.resetMetrics();
  const pending = new Set(tokens.keys());
  const observations = [], latencies = [];
  let updateMs = 0, refreshMs = 0, actionMs = 0;
  for (let i = 0; i < w.events.length; i++) {
    const event = w.events[i], start = performance.now();
    if (event.type === 'merge') {
      if (event.accepted) model.merge(...event.pair);
      updateMs += performance.now() - start;
    } else if (event.type === 'refresh') {
      const checks = [];
      for (const id of pending) {
        const token = tokens.get(id), d = byId.get(id);
        const check = model.inspect(token, d.action);
        if (check.status === 'stale') {
          const renewal = model.reattest(token);
          if (renewal.token) tokens.set(id, renewal.token);
          checks.push([id, renewal.status === 'renewed', check.status, !!renewal.token]);
        } else checks.push([id, check.status === 'current', check.status, false]);
      }
      refreshMs += performance.now() - start;
      observations.push({ i, checks });
    } else {
      const d = byId.get(event.id);
      const result = model.attempt(tokens.get(d.id), d.action);
      // Retirement is inside both action totals and action percentiles.
      if (model.retire && result.final !== 'executed') {
        model.retire(d.id);
      }
      const elapsed = performance.now() - start;
      latencies.push(elapsed * 1000);
      actionMs += elapsed;
      pending.delete(d.id);
      observations.push({ i, allowed: result.final === 'executed', status: result.final,
        initial: result.initial, replaced: !!result.replacement });
    }
  }
  let executed = 0, unsafe = 0, falseBlocks = 0, truthUnsafe = 0, truthFalseBlocks = 0, refreshMismatches = 0;
  let freshnessMismatches = 0, expectedSignatures = 0, expectedRenewals = 0;
  const issued = new Map(w.decisions.map(d => [d.id, expected.initialIndex]));
  function checkFreshness(id, exp, initial, replaced) {
    const expectedStatus = ['recount', 'dependency'].includes(strategy)
      ? (exp.accepted ? 'current' : 'insufficient_support')
      : issued.get(id) < (strategy === 'global' ? exp.index : exp.changedAt) ? 'stale' : 'current';
    const replace = expectedStatus === 'stale' && exp.accepted;
    freshnessMismatches += Number(initial !== expectedStatus || replaced !== replace);
    expectedRenewals += Number(expectedStatus === 'stale');
    expectedSignatures += Number(replace);
    if (replace) issued.set(id, exp.index);
  }
  for (const observation of observations) {
    const exp = expected[observation.i];
    if (observation.checks) {
      for (const [id, allowed, initial, replaced] of observation.checks) {
        refreshMismatches += Number(allowed !== exp.get(id).accepted);
        checkFreshness(id, exp.get(id), initial, replaced);
      }
    } else {
      const allowed = observation.allowed;
      checkFreshness(w.events[observation.i].id, exp,
        observation.initial === 'executed' ? 'current' : observation.initial, observation.replaced);
      executed += Number(allowed);
      unsafe += Number(allowed && !exp.accepted);
      falseBlocks += Number(!allowed && exp.accepted);
      truthUnsafe += Number(allowed && !exp.truth);
      truthFalseBlocks += Number(!allowed && exp.truth);
      if (!['executed', 'blocked', 'insufficient_support'].includes(observation.status)) throw new Error(`Unexpected status ${observation.status}`);
    }
  }
  if (unsafe || falseBlocks || refreshMismatches || freshnessMismatches || model.outbox.length !== executed ||
      model.metrics.signatures !== expectedSignatures || model.metrics.reattestations !== expectedRenewals) throw new Error('Oracle mismatch');
  const totalMs = updateMs + refreshMs + actionMs;
  return { strategy, setupMs, updateMs, refreshMs, actionMs, totalMs, lifecycleMs: setupMs + totalMs,
    p50ActionUs: quantile(latencies, .5), p95ActionUs: quantile(latencies, .95),
    executed, blocked: w.count - executed, unsafe, falseBlocks, truthUnsafe, truthFalseBlocks, refreshMismatches, freshnessMismatches,
    initialIndexEdges, finalIndexEdges: model.edges ?? 0, injectedMs,
    ...model.metrics, setupSourceLookups: setupMetrics.sourceLookups };
}

export function main() {
  const quick = process.argv.includes('--quick'), profile = process.argv.includes('--profile');
  const count = quick || profile ? 50 : 500;
  const seeds = quick || profile ? [11] : [11, 29, 47], repeats = quick || profile ? 1 : 5;
  const output = `results/spectrum${quick ? '-quick' : profile ? '-profile' : ''}`;
  mkdirSync(output, { recursive: true });
  const startedAt = new Date().toISOString(), startLoad = loadavg();
  const sourcePaths = ['demo/cwm.mjs', 'benchmark/dependency-index.mjs', 'benchmark/spectrum-workloads.mjs', 'benchmark/spectrum-run.mjs', 'benchmark/workloads.mjs'];
  const sourceBuffers = Object.fromEntries(sourcePaths.map(p => [p, readFileSync(p)]));
  const sourceHashes = Object.fromEntries(sourcePaths.map(p => [p, digest(sourceBuffers[p])]));
  for (const config of spectrumConfigs) {
    const w = makeSpectrum(config, 20, 1), expected = expectedEvents(w);
    for (const strategy of strategies) runTrial(w, strategy, expected);
  }
  const rows = [], traces = [];
  for (const config of spectrumConfigs) for (const seed of seeds) {
    const w = makeSpectrum(config, count, seed), expected = expectedEvents(w);
    const traceHash = digest(JSON.stringify(w));
    traces.push({ traceHash, workload: w });
    for (let repeat = 0; repeat < repeats; repeat++) {
      // Balanced rotation across five repeats; no parallel benchmark processes.
      for (let position = 0; position < strategies.length; position++) {
        const strategy = strategies[(position + repeat + seeds.indexOf(seed)) % strategies.length];
        rows.push({ workload: w.name, count, seed, repeat, position, traceHash, ...runTrial(w, strategy, expected) });
      }
    }
    console.log(`Verified ${config.name}, seed=${seed}, ${repeats} repeats × ${strategies.length} methods`);
  }
  for (const p of sourcePaths) if (digest(readFileSync(p)) !== sourceHashes[p]) throw new Error(`Source changed during run: ${p}`);
  const metadata = { startedAt, finishedAt: new Date().toISOString(), node: process.version,
    cpu: cpus()[0]?.model, logicalCores: cpus().length, platform: platform(), arch: arch(),
    startLoad, endLoad: loadavg(), count, seeds, repeats, strategies, sourceHashes,
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    timing: 'Setup separate; update, refresh and action include crypto/logging/index maintenance; oracle evaluated outside timed intervals; delayUs is synthetic CPU delay per source lookup, not RPC.' };
  writeFileSync(`${output}/benchmark.json`, JSON.stringify({ metadata, rows }, null, 2) + '\n');
  const keys = [...new Set(rows.flatMap(Object.keys))];
  writeFileSync(`${output}/benchmark.csv`, keys.join(',') + '\n' + rows.map(r => keys.map(k => r[k] ?? 0).join(',')).join('\n') + '\n');
  writeFileSync(`${output}/traces.json`, JSON.stringify(traces) + '\n');
  for (const path of sourcePaths) {
    mkdirSync(`${output}/source/${path.slice(0, path.lastIndexOf('/'))}`, { recursive: true });
    writeFileSync(`${output}/source/${path}`, sourceBuffers[path]);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
