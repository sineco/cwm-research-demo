import test from 'node:test';
import assert from 'node:assert/strict';
import { CWM } from './cwm.mjs';
import { p01, replayP01 } from './public-report.mjs';

for (const strategy of ['cwm', 'recount']) {
  test(`P01 ${strategy}: disclosure prevents the effect, while no-disclosure control executes`, () => {
    const blocked = replayP01(strategy);
    const control = replayP01(strategy, { disclose: false });
    assert.equal(blocked.pass, true);
    assert.equal(control.pass, true);
    assert.equal(blocked.outbox.length, 0);
    assert.deepEqual(control.outbox, [p01.action]);
    assert.equal(blocked.ledger.some(event => event.type === 'executed'), false);
    assert.equal(blocked.metrics.reattestations, strategy === 'cwm' ? 1 : 0);
  });
}

test('P01 verdict catches a broken merge instead of passing an always-allow replay', () => {
  const original = CWM.prototype.merge;
  try {
    CWM.prototype.merge = () => true;
    for (const strategy of ['cwm', 'recount']) {
      const result = replayP01(strategy);
      assert.equal(result.pass, false);
      assert.equal(result.checks.partitionMatchesAnnotation, false);
      assert.equal(result.checks.expectedEffectCount, false);
    }
  } finally {
    CWM.prototype.merge = original;
  }
});
