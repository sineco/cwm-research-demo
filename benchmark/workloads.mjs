// Controlled disjoint decision supports make the fraction affected by updates exact.
export const configurations = [
  { name: 'no_updates', sourcesPerDecision: 4, affected: 0 },
  { name: 'unrelated_merge', sourcesPerDecision: 4, affected: 0, unrelated: true },
  { name: 'sparse_updates', sourcesPerDecision: 4, affected: 0.01 },
  { name: 'half_affected', sourcesPerDecision: 4, affected: 0.5 },
  { name: 'all_affected', sourcesPerDecision: 4, affected: 1 },
  { name: 'threshold_loss', sourcesPerDecision: 3, affected: 0.5 },
  { name: 'many_sources_sparse', sourcesPerDecision: 32, affected: 0.01 },
  { name: 'many_sources_all', sourcesPerDecision: 32, affected: 1 },
];

export function shuffle(values, seed) {
  const result = [...values];
  let state = seed >>> 0;
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function makeWorkload(config, count, seed = 42) {
  const sources = ['external-A', 'external-B'];
  const setupMerges = [];
  const decisions = Array.from({ length: count }, (_, d) => {
    const ids = Array.from({ length: config.sourcesPerDecision }, (_, s) => `d${d}-s${String(s).padStart(2, '0')}`);
    sources.push(...ids);
    // 32 documents collapse to four known origins before initial issuance.
    if (ids.length > 4) for (let s = 4; s < ids.length; s++) setupMerges.push([ids[s % 4], ids[s]]);
    return { id: `d${d}`, sources: ids, threshold: 3, action: { type: 'outbox', claimId: `claim-${d}` } };
  });
  const order = shuffle(decisions, seed);
  const updates = order.slice(0, Math.round(count * config.affected)).map(d => [d.sources[0], d.sources[1]]);
  if (config.unrelated) updates.push(['external-A', 'external-B']);
  return { name: config.name, count, seed, sources, setupMerges, decisions: order, updates };
}

// Independent oracle: explicit group labels, no CWM find(), epochs, or token code.
export function oracle(workload) {
  const labels = new Map(workload.sources.map(s => [s, s]));
  const members = new Map(workload.sources.map(s => [s, new Set([s])]));
  for (const [a, b] of [...workload.setupMerges, ...workload.updates]) {
    const from = labels.get(b);
    const to = labels.get(a);
    if (from !== to) {
      for (const id of members.get(from)) { labels.set(id, to); members.get(to).add(id); }
      members.delete(from);
    }
  }
  return new Map(workload.decisions.map(d => [d.id,
    new Set(d.sources.map(s => labels.get(s))).size >= d.threshold]));
}
