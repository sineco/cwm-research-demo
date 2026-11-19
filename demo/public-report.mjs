import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CWM } from './cwm.mjs';

const fixtureBytes = readFileSync(new URL('./fixtures/p01.json', import.meta.url));
export const p01 = JSON.parse(fixtureBytes);
export const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');

// Replay the reviewed annotation, not an automated provenance detector.
export function replayP01(strategy, { disclose = true } = {}) {
  assert.ok(['cwm', 'recount'].includes(strategy));
  const ids = p01.sources.map(source => source.id);
  const model = new CWM(ids, { strategy });
  model.register('p01-decision', ids, p01.threshold, p01.action);
  const before = model.snapshot();
  const token = model.issue('p01-decision');
  assert.ok(token, 'Initial experimental partition must permit issuance');
  const events = [
    { step: 1, type: 'loaded', caseId: p01.caseId, sourceIds: ids, threshold: p01.threshold },
    { step: 2, type: 'issued', tokenId: token.payload.tokenId, acceptedOrigins: token.payload.roots.length },
  ];
  if (disclose) {
    assert.equal(model.merge(...p01.disclosure.merge), true);
    events.push({ step: 3, type: 'shared_origin_disclosed', sourceIds: p01.disclosure.merge });
  } else {
    events.push({ step: 3, type: 'control_no_disclosure', explanation: 'Controlled incomplete knowledge, not evidence of true independence.' });
  }
  const after = model.snapshot();
  const attempt = model.attempt(token, p01.action);
  events.push({ step: 4, type: 'gateway_result', initial: attempt.initial, final: attempt.final,
    replacementTokenId: attempt.replacement?.payload.tokenId ?? null, outboxActions: model.outbox.length });
  // Fixed expectations are derived from the reviewed two-to-one annotation,
  // independently of the implementation's root-count result.
  const expected = disclose
    ? { initial: strategy === 'cwm' ? 'stale' : 'insufficient_support', final: strategy === 'cwm' ? 'blocked' : 'insufficient_support', outbox: 0 }
    : { initial: 'executed', final: 'executed', outbox: 1 };
  const actualOrigins = new Set(after.map(item => item.root)).size;
  const checks = {
    issuedWithTwoOrigins: token.payload.roots.length === 2,
    partitionMatchesAnnotation: actualOrigins === (disclose ? 1 : 2),
    expectedInitialStatus: attempt.initial === expected.initial,
    expectedFinalStatus: attempt.final === expected.final,
    expectedEffectCount: model.outbox.length === expected.outbox,
    noReplacementIssued: attempt.replacement === null && model.metrics.signatures === 1,
    expectedRenewalCount: model.metrics.reattestations === (disclose && strategy === 'cwm' ? 1 : 0),
    blockedAudit: !disclose || strategy !== 'cwm' || model.ledger.some(event =>
      event.type === 'blocked' && event.oldToken === token.payload.tokenId && event.before === 2 && event.after === 1 && event.threshold === 2),
  };
  return { strategy, disclose, pass: Object.values(checks).every(Boolean), checks,
    expected, before, after, events, originalToken: token, result: attempt,
    ledger: model.ledger, outbox: model.outbox, metrics: { ...model.metrics } };
}
