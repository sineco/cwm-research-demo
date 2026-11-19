import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundarySuite } from './execution-boundary.mjs';

test('controlled execution boundaries prevent stale effects and expose cached-approval bug', { timeout: 30000 }, async () => {
  const cases = await runBoundarySuite();
  assert.equal(cases.length, 13);
  for (const item of cases) assert.equal(item.pass, true, `${item.strategy}/${item.name}: ${JSON.stringify(item.checks)}`);
  const vulnerable = cases.filter(item => item.unsafeControl);
  assert.equal(vulnerable.length, 2);
  assert.ok(vulnerable.every(item => item.outbox.length === 1));
  assert.ok(cases.filter(item => item.name === 'revalidate_after_preflight').every(item => item.outbox.length === 0));
  for (const item of cases.filter(item => item.name === 'http_request_in_flight')) {
    const order = item.events.map(event => event.event);
    assert.ok(order.indexOf('attempt_paused_before_authoritative_validation') < order.indexOf('merge_acknowledged'));
    assert.ok(order.indexOf('merge_acknowledged') < order.indexOf('attempt_action'));
  }
});
