import { CWM } from '../demo/cwm.mjs';

// Server-side reverse dependencies, maintained for pending decisions only.
export class DependencyIndex extends CWM {
  constructor(sources, { strategy = 'dependency' } = {}) {
    super(sources, { strategy });
    this.dependents = new Map();
    this.decisionRoots = new Map();
    this.changedAt = new Map();
    this.eligibility = new Map();
    this.dirty = new Set();
    this.edges = 0;
  }

  resetMetrics() {
    super.resetMetrics();
    Object.assign(this.metrics, { dependencyVisits: 0, dependencyChecks: 0,
      indexLinksAdded: 0, indexLinksRemoved: 0, peakIndexEdges: this.edges ?? 0 });
  }

  register(id, sourceIds, threshold, action) {
    super.register(id, sourceIds, threshold, action);
    const roots = new Set(this.roots(sourceIds));
    this.decisionRoots.set(id, roots);
    for (const root of roots) {
      if (!this.dependents.has(root)) this.dependents.set(root, new Set());
      this.dependents.get(root).add(id);
      this.edges++;
      this.metrics.indexLinksAdded++;
    }
    this.metrics.peakIndexEdges = Math.max(this.metrics.peakIndexEdges, this.edges);
    this.changedAt.set(id, this.index);
    this.dirty.add(id);
  }

  issue(id, previousTokenId = null) {
    const token = super.issue(id, previousTokenId);
    this.eligibility.set(id, token !== null);
    this.dirty.delete(id);
    return token;
  }

  merge(a, b) {
    const [left, right] = [this.find(a), this.find(b)].sort();
    if (!super.merge(a, b)) return false;
    const surviving = this.dependents.get(left) ?? new Set();
    const absorbed = this.dependents.get(right) ?? new Set();
    for (const id of new Set([...surviving, ...absorbed])) {
      this.metrics.dependencyVisits++;
      this.changedAt.set(id, this.index);
      this.dirty.add(id);
    }
    for (const id of absorbed) {
      const roots = this.decisionRoots.get(id);
      roots.delete(right);
      roots.add(left);
      this.edges--;
      this.metrics.indexLinksRemoved++;
      if (!surviving.has(id)) {
        surviving.add(id);
        this.edges++;
        this.metrics.indexLinksAdded++;
      }
    }
    if (surviving.size) this.dependents.set(left, surviving);
    this.dependents.delete(right);
    return true;
  }

  inspectDependency(payload, decision) {
    this.metrics.dependencyChecks++;
    if (!this.decisionRoots.has(decision.id) || !this.changedAt.has(decision.id)) {
      return { status: 'missing_dependency_state' };
    }
    if (this.strategy === 'dependency-witness') {
      return payload.issuedAtIndex < this.changedAt.get(decision.id)
        ? { status: 'stale', staleRoots: [], reason: 'dependency_changed' }
        : { status: 'current' };
    }
    if (this.dirty.has(decision.id)) {
      this.eligibility.set(decision.id, this.decisionRoots.get(decision.id).size >= decision.threshold);
      this.dirty.delete(decision.id);
    }
    return { status: this.eligibility.get(decision.id) ? 'current' : 'insufficient_support' };
  }

  execute(token, action) {
    const result = super.execute(token, action);
    if (result.status === 'executed') this.retire(token.payload.decisionId);
    return result;
  }

  retire(id) {
    const decision = this.decisions.get(id);
    if (decision) decision.retired = true;
    for (const root of this.decisionRoots.get(id) ?? []) {
      const ids = this.dependents.get(root);
      ids.delete(id);
      if (!ids.size) this.dependents.delete(root);
      this.edges--;
      this.metrics.indexLinksRemoved++;
    }
    this.decisionRoots.delete(id);
    this.changedAt.delete(id);
    this.eligibility.delete(id);
    this.dirty.delete(id);
  }
}

export function createModel(sources, strategy) {
  return strategy.startsWith('dependency') ? new DependencyIndex(sources, { strategy }) : new CWM(sources, { strategy });
}
