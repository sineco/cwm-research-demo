import { generateKeyPairSync, sign, verify } from 'node:crypto';

const encode = value => Buffer.from(JSON.stringify(value));

// A single synchronous state machine: methods contain no await points.
// This is a local atomicity model, not distributed consensus.
export class CWM {
  constructor(sources, { strategy = 'cwm' } = {}) {
    if (!['cwm', 'recount', 'global', 'dependency', 'dependency-witness'].includes(strategy)) throw new Error('Unknown strategy');
    this.strategy = strategy;
    this.resetMetrics();
    this.parent = new Map(sources.map(id => [id, id]));
    this.epoch = new Map(sources.map(id => [id, 0]));
    this.decisions = new Map();
    this.ledger = [];
    this.outbox = [];
    this.index = 0;
    this.sequence = 0;
    const keys = generateKeyPairSync('ed25519');
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
  }

  resetMetrics() {
    this.metrics = { sourceLookups: 0, witnessChecks: 0, signatures: 0, verifications: 0, reattestations: 0 };
  }

  find(id) {
    if (!this.parent.has(id)) throw new Error(`Unknown source: ${id}`);
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // Path compression; lookups do not walk the evidence graph.
    while (id !== root) {
      const next = this.parent.get(id);
      this.parent.set(id, root);
      id = next;
    }
    return root;
  }

  roots(sourceIds) {
    this.metrics.sourceLookups += sourceIds.length;
    return [...new Set(sourceIds.map(id => this.find(id)))].sort();
  }

  record(event) {
    this.ledger.push({ eventNumber: this.ledger.length + 1, stateIndex: this.index, ...event });
  }

  merge(a, b) {
    const [left, right] = [this.find(a), this.find(b)].sort();
    if (left === right) return false;
    this.parent.set(right, left);
    this.epoch.set(left, Math.max(this.epoch.get(left), this.epoch.get(right)) + 1);
    this.index++;
    this.record({ type: 'merge', survivingRoot: left, absorbedRoot: right, epoch: this.epoch.get(left) });
    return true;
  }

  register(id, sourceIds, threshold, action) {
    if (this.decisions.has(id)) throw new Error('Decision already exists');
    if (!Number.isInteger(threshold) || threshold < 1) throw new Error('Invalid threshold');
    sourceIds.forEach(source => this.find(source));
    this.decisions.set(id, {
      id, sourceIds: [...new Set(sourceIds)], threshold,
      action: structuredClone(action), executed: false,
    });
  }

  issue(id, previousTokenId = null) {
    const decision = this.decisions.get(id);
    if (!decision || decision.executed || decision.retired) throw new Error('Decision missing, executed or retired');
    const roots = this.roots(decision.sourceIds);
    if (roots.length < decision.threshold) return null;
    const payload = {
      tokenId: `token-${++this.sequence}`, decisionId: id,
      action: structuredClone(decision.action), threshold: decision.threshold,
      roots: roots.map(root => ({ id: root, epoch: this.epoch.get(root) })),
      issuedAtIndex: this.index, previousTokenId,
    };
    this.metrics.signatures++;
    const token = { payload, signature: sign(null, encode(payload), this.privateKey).toString('base64') };
    this.record({ type: 'issued', tokenId: payload.tokenId, previousTokenId, count: roots.length });
    return token;
  }

  inspect(token, requestedAction) {
    try {
      this.metrics.verifications++;
      if (!verify(null, encode(token.payload), this.publicKey, Buffer.from(token.signature, 'base64'))) {
        return { status: 'invalid_signature' };
      }
    } catch {
      return { status: 'invalid_signature' };
    }
    const payload = token.payload;
    const decision = this.decisions.get(payload.decisionId);
    if (!decision) return { status: 'unknown_decision' };
    if (decision.executed) return { status: 'already_executed' };
    if (decision.retired) return { status: 'retired_decision' };
    if (JSON.stringify(requestedAction) !== JSON.stringify(payload.action) ||
        JSON.stringify(payload.action) !== JSON.stringify(decision.action) ||
        payload.threshold !== decision.threshold) return { status: 'binding_mismatch' };
    if (this.strategy === 'recount') {
      return { status: this.roots(decision.sourceIds).length >= decision.threshold ? 'current' : 'insufficient_support' };
    }
    if (this.strategy === 'global') {
      return payload.issuedAtIndex === this.index ? { status: 'current' } :
        { status: 'stale', staleRoots: [], reason: 'global_version_changed' };
    }
    if (this.strategy.startsWith('dependency')) return this.inspectDependency(payload, decision);
    const staleRoots = payload.roots.filter(root => {
      this.metrics.witnessChecks++;
      return this.find(root.id) !== root.id || this.epoch.get(root.id) !== root.epoch;
    }).map(root => root.id);
    return staleRoots.length ? { status: 'stale', staleRoots } : { status: 'current' };
  }

  reattest(token) {
    const check = this.inspect(token, token?.payload?.action);
    if (check.status !== 'stale') return { status: check.status, token: null };
    this.metrics.reattestations++;
    const decision = this.decisions.get(token.payload.decisionId);
    this.record({ type: 'reattest_requested', decisionId: decision.id,
      oldToken: token.payload.tokenId, staleRoots: check.staleRoots });
    const before = token.payload.roots.length;
    const after = this.roots(decision.sourceIds).length;
    if (after < decision.threshold) {
      this.record({ type: 'blocked', oldToken: token.payload.tokenId, newToken: null,
        before, after, threshold: decision.threshold, reason: 'Additional independent evidence required' });
      return { status: 'blocked', before, after, token: null };
    }
    // Count and signing share one synchronous state; merge cannot interleave.
    const replacement = this.issue(decision.id, token.payload.tokenId);
    this.record({ type: 'renewed', oldToken: token.payload.tokenId,
      newToken: replacement.payload.tokenId, before, after });
    return { status: 'renewed', before, after, token: replacement };
  }

  execute(token, action) {
    const check = this.inspect(token, action);
    if (check.status !== 'current') {
      this.record({ type: 'rejected', tokenId: token?.payload?.tokenId ?? null, ...check });
      return check;
    }
    // The simulated effect is inside the same synchronous operation as validation.
    const decision = this.decisions.get(token.payload.decisionId);
    decision.executed = true;
    this.outbox.push(structuredClone(action));
    this.record({ type: 'executed', decisionId: decision.id, tokenId: token.payload.tokenId });
    return { status: 'executed' };
  }

  attempt(token, action) {
    const initial = this.execute(token, action);
    if (initial.status !== 'stale') return { initial: initial.status, final: initial.status, replacement: null };
    const renewal = this.reattest(token);
    if (!renewal.token) return { initial: 'stale', final: renewal.status, replacement: null };
    // Always revalidate even the newly issued token.
    const result = this.execute(renewal.token, action);
    return { initial: 'stale', final: result.status, replacement: renewal.token };
  }

  snapshot() {
    return [...this.parent.keys()].sort().map(source => {
      const root = this.find(source);
      return { source, root, epoch: this.epoch.get(root) };
    });
  }
}

export const scenarios = [
  { name: 'Three origins, no change', sources: ['A', 'B', 'C'], merges: [], expected: 'executed' },
  { name: 'Four origins become three', sources: ['A', 'B', 'C', 'D'], merges: [['A', 'B']], expected: 'executed' },
  { name: 'Three origins become two', sources: ['A', 'B', 'C'], merges: [['A', 'B']], expected: 'blocked' },
  { name: 'Unrelated origins merge', sources: ['A', 'B', 'C'], merges: [['X', 'Y']], expected: 'executed' },
];

export function runScenario(scenario) {
  const cwm = new CWM([...new Set([...scenario.sources, 'X', 'Y'])]);
  const action = { type: 'release_to_simulated_outbox', claimId: 'synthetic-claim-1' };
  cwm.register('decision-1', scenario.sources, 3, action);
  const before = cwm.snapshot();
  const token = cwm.issue('decision-1');
  scenario.merges.forEach(([a, b]) => cwm.merge(a, b));
  const after = cwm.snapshot();
  const result = cwm.attempt(token, action);
  return {
    name: scenario.name, expected: scenario.expected, threshold: 3, sourceIds: scenario.sources,
    independentBefore: scenario.sources.length, independentAfter: cwm.roots(scenario.sources).length,
    sourceCountingBaseline: new Set(scenario.sources).size >= 3 ? 'executed' : 'blocked',
    before, after, originalToken: token, ...result, ledger: cwm.ledger, outbox: cwm.outbox,
  };
}
