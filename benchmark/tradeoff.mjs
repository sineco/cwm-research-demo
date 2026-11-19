import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createModel } from './dependency-index.mjs';
import { compactMethods, earlyMethod, createCompactModel } from './compact-permit.mjs';
import { shuffle } from './workloads.mjs';

export const methods = ['cwm', 'recount', 'global', 'dependency-witness', 'dependency'];
const base = { roots: 4, sourcesPerRoot: 1, checks: 1, rounds: 1, fanout: 0, shared: false };
export const quietConfig = { ...base, name: 'quiet_compact', updates: false };
export const configs = [
  { ...base, name: 'compact_once' },
  { ...base, name: 'compact_repeated', checks: 8 },
  { ...base, name: 'broad_repeated', roots: 32, sourcesPerRoot: 8, checks: 8 },
  { ...base, name: 'broad_sparse_changes', roots: 32, sourcesPerRoot: 8, checks: 8, fanout: .01, shared: true },
  { ...base, name: 'broad_full_changes', roots: 32, sourcesPerRoot: 8, checks: 8, fanout: 1, shared: true },
  { ...base, name: 'compact_full_changes', fanout: 1, shared: true },
  { ...base, name: 'compact_churn', rounds: 8, fanout: 1, shared: true },
  { ...base, name: 'unrelated_churn', rounds: 8 },
];

export const earlyConfigs = [
  ...configs, quietConfig,
  { ...base, name: 'broad_interleaved', roots: 32, sourcesPerRoot: 8, checks: 8, interleave: true },
  { ...base, name: 'broad_high_threshold', roots: 32, sourcesPerRoot: 8, checks: 8, threshold: 32 },
  { ...base, name: 'support_loss', roots: 3, sourcesPerRoot: 86, checks: 0, fanout: 1, shared: true, blocked: true },
];

export function makeWorkload(config, count, seed) {
  const sources = new Set(), premerges = [], seen = new Set();
  const affectedCount = Math.round(count * config.fanout);
  const decisions = shuffle(Array.from({ length: count }, (_, i) => {
    const prefix = config.shared && i < affectedCount ? 'hub' : `d${i}`;
    const groups = Array.from({ length: config.roots }, (_, r) => Array.from({ length: config.sourcesPerRoot }, (_, s) => `${prefix}-r${r}-s${s}`));
    if (!seen.has(prefix)) {
      seen.add(prefix);
      for (const group of groups) for (const id of group.slice(1)) premerges.push([group[0], id]);
    }
    groups.flat().forEach(id => sources.add(id));
    return { id: `d${i}`, sources: config.interleave ? groups[0].flatMap((_,s)=>groups.map(group=>group[s])) : groups.flat(), threshold: config.threshold ?? 3, action: { type: 'simulated_outbox', claimId: `claim-${i}` }, affected: i < affectedCount };
  }), seed);
  const merges = Array.from({ length: config.rounds }, (_, i) => {
    if (config.updates === false) return null;
    // First relevant merge reduces support by one. Subsequent ones change its
    // epoch by absorbing an external origin, preserving the remaining count.
    const pair = affectedCount ? (i === 0 ? ['hub-r0-s0', 'hub-r1-s0'] : ['hub-r0-s0', `external-${i}`])
      : [`unrelated-${i}-a`, `unrelated-${i}-b`];
    pair.forEach(id => sources.add(id));
    return pair;
  });
  return { config, count, seed, sources: [...sources], premerges, decisions, merges };
}

export function trial(w, method, measureMemory = true) {
  if (measureMemory && !global.gc) throw new Error('Memory measurements require --expose-gc');
  const checkpoints = [];
  const checkpoint = phase => {
    if (!measureMemory) return { heapUsed: 0 };
    global.gc(); global.gc();
    const memory = process.memoryUsage(); checkpoints.push({ phase, ...memory }); return memory;
  };
  const baseline = checkpoint('workload_only');
  let start = performance.now();
  const model = [...compactMethods,earlyMethod].includes(method) ? createCompactModel(w.sources, method) : createModel(w.sources, method);
  for (const pair of w.premerges) model.merge(...pair);
  // Common input preprocessing is timed but its construction audit is not part
  // of the pending-decision retention policy. All methods receive the same rule.
  model.ledger.length = 0;
  for (const d of w.decisions) model.register(d.id, d.sources, d.threshold, d.action);
  const tokens = new Map(w.decisions.map(d => [d.id, model.issue(d.id)]));
  const setupMs = performance.now() - start;
  for (const token of tokens.values()) {
    assert.ok(token);
    if ([...compactMethods,earlyMethod].includes(method)) assert.equal(token.payload.roots, undefined);
    else assert.equal(token.payload.roots.length, w.config.roots);
  }
  const initialTokenBytes = [...tokens.values()].reduce((sum,token)=>sum+Buffer.byteLength(JSON.stringify(token)),0);
  const pending = checkpoint('pending');
  const initialIndexEdges = model.edges ?? 0;
  model.resetMetrics();
  let updateMs = 0, checkMs = 0, actionMs = 0, renewals = 0, inspections = 0;
  const latencies = [];
  for (const [round, pair] of w.merges.entries()) {
    if (pair) {
      start = performance.now(); const changed = model.merge(...pair); updateMs += performance.now() - start;
      assert.equal(changed, true);
    }
    for (let repeat = 0; repeat < w.config.checks; repeat++) for (const d of w.decisions) {
      start = performance.now();
      let token = tokens.get(d.id);
      const initial = model.inspect(token, d.action);
      let final = initial;
      if (initial.status === 'stale') {
        const result = model.reattest(token);
        token = result.token;
        if (token) { tokens.set(d.id, token); final = model.inspect(token, d.action); }
      }
      const elapsed = performance.now() - start; checkMs += elapsed; latencies.push(elapsed * 1000);
      const expectedStale = Boolean(pair) && repeat === 0 && (method === 'global' || (d.affected && ['cwm', 'dependency-witness'].includes(method)));
      assert.equal(initial.status, expectedStale ? 'stale' : 'current', `${round}/${d.id}/${method}`);
      assert.equal(final.status, 'current');
      renewals += Number(expectedStale); inspections++;
    }
  }
  const afterChecks = checkpoint('after_checks');
  for (const d of w.decisions) {
    start = performance.now(); const result = model.attempt(tokens.get(d.id), d.action); actionMs += performance.now() - start;
    assert.equal(result.final, w.config.blocked ? (['cwm','global','dependency-witness'].includes(method) ? 'blocked' : 'insufficient_support') : 'executed'); assert.equal(result.replacement, null);
  }
  const final = checkpoint('after_execution');
  assert.equal(model.outbox.length, w.config.blocked ? 0 : w.count);
  assert.equal(model.metrics.reattestations, renewals + (w.config.blocked && ['cwm','global','dependency-witness'].includes(method) ? w.count : 0));
  assert.equal(model.metrics.signatures, renewals);
  assert.equal(tokens.size, w.count); assert.equal(model.decisions.size, w.count);
  latencies.sort((a,b) => a-b);
  return { method, workload: w.config.name, count: w.count, seed: w.seed,
    setupMs, updateMs, checkMs, actionMs, maintenanceMs: updateMs + checkMs + actionMs,
    lifecycleMs: setupMs + updateMs + checkMs + actionMs,
    pendingHeapBytes: pending.heapUsed - baseline.heapUsed,
    afterChecksHeapBytes: afterChecks.heapUsed - baseline.heapUsed,
    finalHeapBytes: final.heapUsed - baseline.heapUsed,
    processPeakRssKiB: measureMemory ? process.resourceUsage().maxRSS : 0,
    p50CheckUs: latencies[Math.ceil(latencies.length*.5)-1] ?? null, p95CheckUs: latencies[Math.ceil(latencies.length*.95)-1] ?? null,
    initialIndexEdges, initialTokenBytes, meanInitialTokenBytes: initialTokenBytes / w.count, inspections, renewals, executed: model.outbox.length,
    auditEvents: model.ledger.length, checkpoints, metrics: { ...model.metrics } };
}
