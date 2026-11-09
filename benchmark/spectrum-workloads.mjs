import { shuffle, makeWorkload } from './workloads.mjs';

export const spectrumConfigs = [
  { name: 'disjoint_sparse', topology: 'disjoint', affected: .01 },
  { name: 'disjoint_dense', topology: 'disjoint', affected: 1 },
  { name: 'unrelated', topology: 'disjoint', affected: 0, unrelated: true },
  ...[.01, .1, 1].map(affected => ({ name: `hub_${affected}`, topology: 'hub', affected })),
  { name: 'heterogeneous', topology: 'heterogeneous', affected: 1 },
  { name: 'hub_threshold_loss', topology: 'hub', affected: 1, loss: true },
  ...[4, 16].flatMap(rounds => ['execution', 'pending'].map(policy => ({
    name: `stream_${rounds}_${policy}`, topology: 'hub', affected: 1, rounds, policy,
  }))),
  { name: 'many_sources_sparse', topology: 'disjoint', affected: .01, sourcesPerDecision: 32 },
  ...[10, 100].map(delayUs => ({ name: `resolution_${delayUs}us`, topology: 'hub', affected: .01, delayUs })),
  { name: 'missed_merge', topology: 'hub', affected: 1, loss: true, error: 'missed' },
  { name: 'false_merge', topology: 'hub', affected: 1, loss: true, error: 'false' },
];

export function makeSpectrum(config, count, seed) {
  const rounds = config.rounds ?? 1;
  let sources, decisions, setupMerges = [], initialUpdates;
  if (config.topology === 'disjoint') {
    const base = makeWorkload({ ...config, sourcesPerDecision: config.sourcesPerDecision ?? 4 }, count, seed);
    ({ sources, decisions, setupMerges } = base);
    initialUpdates = base.updates;
  } else {
    const all = new Set(['external-A', 'external-B', 'hub0-s0', 'hub0-s1', 'hub0-s2', 'hub0-s3']);
    decisions = Array.from({ length: count }, (_, i) => {
      // Seeded heterogeneous membership: independently sampled skewed hubs.
      const draw = shuffle(Array.from({ length: 16 }, (_, x) => x), seed + i * 7919)[0];
      const group = config.topology === 'heterogeneous' ? (draw < 8 ? 0 : draw < 12 ? 1 : draw - 10) : 0;
      const shared = config.topology === 'heterogeneous' || i < Math.round(count * config.affected);
      const ids = Array.from({ length: 4 }, (_, s) => shared ? `hub${group}-s${s}` : `d${i}-s${s}`);
      ids.forEach(x => all.add(x));
      return { id: `d${i}`, sources: ids, threshold: 3, action: { type: 'outbox', claimId: `claim-${i}` } };
    });
    decisions = shuffle(decisions, seed);
    initialUpdates = [['hub0-s0', 'hub0-s1']];
    if (config.loss) initialUpdates.push(['hub0-s2', 'hub0-s3']);
    sources = [...all];
  }
  const events = [];
  for (let round = 0; round < rounds; round++) {
    let pairs = round === 0 ? initialUpdates : [[`hub0-s0`, `external-round-${round}`]];
    if (round > 0) sources.push(`external-round-${round}`);
    for (const pair of pairs) events.push({ type: 'merge', pair,
      accepted: config.error !== 'missed', truth: config.error !== 'false' });
    if (config.policy === 'pending') events.push({ type: 'refresh' });
    const begin = Math.floor(round * count / rounds), end = Math.floor((round + 1) * count / rounds);
    for (const decision of decisions.slice(begin, end)) events.push({ type: 'execute', id: decision.id });
  }
  return { name: config.name, count, seed, sources, decisions, setupMerges, events,
    policy: config.policy ?? 'execution', delayUs: config.delayUs ?? 0, config };
}

// Explicit group labels independent of the implementation's union-find and epochs.
export class LabelOracle {
  constructor(sources) { this.labels = new Map(sources.map(x => [x, x])); }
  merge(a, b) {
    const left = this.labels.get(a), right = this.labels.get(b);
    if (left === undefined || right === undefined) throw new Error('Unknown oracle source');
    if (left === right) return false;
    for (const [id, label] of this.labels) if (label === right) this.labels.set(id, left);
    return true;
  }
  allowed(d) { return new Set(d.sources.map(x => this.labels.get(x))).size >= d.threshold; }
}

export function expectedEvents(workload) {
  const accepted = new LabelOracle(workload.sources), truth = new LabelOracle(workload.sources);
  let index = 0;
  for (const pair of workload.setupMerges) { index += Number(accepted.merge(...pair)); truth.merge(...pair); }
  const initialIndex = index;
  const byId = new Map(workload.decisions.map(d => [d.id, d]));
  const pending = new Set(byId.keys());
  const changedAt = new Map(workload.decisions.map(d => [d.id, index]));
  const state = id => ({ accepted: accepted.allowed(byId.get(id)), truth: truth.allowed(byId.get(id)), changedAt: changedAt.get(id), index });
  const events = workload.events.map(event => {
    if (event.type === 'merge') {
      if (event.accepted) {
        const [a,b] = event.pair.map(x => accepted.labels.get(x));
        if (a !== b) {
          index++;
          for (const id of pending) {
            if (byId.get(id).sources.some(s => [a,b].includes(accepted.labels.get(s)))) changedAt.set(id,index);
          }
          accepted.merge(...event.pair);
        }
      }
      if (event.truth) truth.merge(...event.pair);
      return null;
    }
    if (event.type === 'refresh') return new Map([...pending].map(id => [id, state(id)]));
    pending.delete(event.id);
    return state(event.id);
  });
  events.initialIndex = initialIndex;
  return events;
}
