import { sign } from 'node:crypto';
import { CWM } from '../demo/cwm.mjs';
import { DependencyIndex } from './dependency-index.mjs';

// Format-only ablation: preserve the existing eligibility algorithms and audit
// policy, removing witness roots, epochs, partition index and renewal linkage.
const compactPermit = Base => class extends Base {
  permitSupport(decision) {
    return { count: this.roots(decision.sourceIds).length, exact: true };
  }

  issue(id, previousTokenId = null) {
    if (previousTokenId !== null) throw new Error('Eligibility permits do not attest freshness or support renewal linkage');
    const decision = this.decisions.get(id);
    if (!decision || decision.executed || decision.retired) throw new Error('Decision missing, executed or retired');
    const support = this.permitSupport(decision);
    const count = support.count;
    const eligible = count >= decision.threshold;
    if (this.strategy === 'dependency') {
      this.eligibility.set(id, eligible);
      this.dirty.delete(id);
    }
    if (!eligible) return null;
    const payload = {
      kind: 'eligibility-permit-v1', tokenId: `token-${++this.sequence}`, decisionId: id,
      action: structuredClone(decision.action), threshold: decision.threshold,
    };
    this.metrics.signatures++;
    const token = { payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), this.privateKey).toString('base64') };
    this.record({ type: 'issued', tokenId: payload.tokenId, previousTokenId: null, ...(support.exact ? { count } : { countLowerBound: count }) });
    return token;
  }

  inspect(token, action) {
    if (token?.payload?.kind !== 'eligibility-permit-v1') return { status: 'invalid_permit_format' };
    // Inherited verification, registry/action/policy binding, replay protection,
    // and current eligibility evaluation are identical to the original baseline.
    return super.inspect(token, action);
  }
};

const CompactRecount = compactPermit(CWM);
const CompactDependency = compactPermit(DependencyIndex);
export class EarlyExitRecount extends CompactRecount {
  constructor(sources) { super(sources, { strategy: 'recount' }); }
  permitSupport(decision) {
    const roots = new Set();
    let visited = 0;
    for (const id of decision.sourceIds) {
      this.metrics.sourceLookups++; visited++;
      roots.add(this.find(id));
      if (roots.size >= decision.threshold) break;
    }
    return { count: roots.size, exact: visited === decision.sourceIds.length };
  }
  hasSupport(decision) { return this.permitSupport(decision).count >= decision.threshold; }
}
export const earlyMethod = 'recount-early';
export const compactMethods = ['recount-compact', 'dependency-compact'];
export function createCompactModel(sources, method) {
  if (method === earlyMethod) return new EarlyExitRecount(sources);
  if (method === 'recount-compact') return new CompactRecount(sources, { strategy: 'recount' });
  if (method === 'dependency-compact') return new CompactDependency(sources, { strategy: 'dependency' });
  throw new Error('Unknown compact-permit method');
}
