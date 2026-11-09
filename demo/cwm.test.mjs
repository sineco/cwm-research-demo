import test from 'node:test';
import assert from 'node:assert/strict';
import { CWM, runScenario, scenarios } from './cwm.mjs';

const action = { type: 'release_to_simulated_outbox', claimId: 'claim-1' };
function setup(sources = ['A', 'B', 'C', 'D']) {
  const model = new CWM(['A', 'B', 'C', 'D', 'X', 'Y']);
  model.register('d1', sources, 3, action);
  return { model, token: model.issue('d1') };
}

for (const scenario of scenarios) {
  test(scenario.name, () => {
    const result = runScenario(scenario);
    assert.equal(result.final, scenario.expected);
    assert.equal(result.outbox.length, scenario.expected === 'executed' ? 1 : 0);
    assert.equal(!!result.replacement, scenario.sources.length === 4);
    if (scenario.name === 'Three origins become two') {
      assert.equal(result.sourceCountingBaseline, 'executed');
      assert.equal(result.initial, 'stale');
      assert.ok(result.ledger.some(e => e.type === 'blocked' && e.before === 3 && e.after === 2));
    }
  });
}

test('tampered token cannot authorize or trigger renewal', () => {
  const { model, token } = setup();
  token.payload.threshold = 1;
  assert.equal(model.attempt(token, action).final, 'invalid_signature');
  assert.equal(model.reattest(token).status, 'invalid_signature');
  assert.equal(model.outbox.length, 0);
});

test('a token cannot authorize a different action', () => {
  const { model, token } = setup();
  assert.equal(model.execute(token, { ...action, claimId: 'another-claim' }).status, 'binding_mismatch');
  assert.equal(model.outbox.length, 0);
});

test('absorbed root is detected even when its stored epoch does not change', () => {
  const { model, token } = setup(['B', 'C', 'D']);
  model.merge('A', 'B');
  assert.equal(model.epoch.get('B'), 0);
  assert.deepEqual(model.inspect(token, action), { status: 'stale', staleRoots: ['B'] });
  const renewed = model.reattest(token);
  assert.equal(renewed.status, 'renewed');
  assert.equal(renewed.after, 3);
  assert.deepEqual(renewed.token.payload.roots.map(r => r.id), ['A', 'C', 'D']);
});

test('a later merge invalidates a replacement before execution', () => {
  const { model, token } = setup();
  model.merge('A', 'B');
  const renewed = model.reattest(token);
  assert.equal(renewed.status, 'renewed');
  assert.equal(renewed.token.payload.previousTokenId, token.payload.tokenId);
  model.merge('C', 'D');
  assert.equal(model.execute(renewed.token, action).status, 'stale');
  assert.equal(model.reattest(renewed.token).status, 'blocked');
  assert.equal(model.outbox.length, 0);
});

test('successful action cannot be replayed', () => {
  const { model, token } = setup();
  assert.equal(model.execute(token, action).status, 'executed');
  assert.equal(model.execute(token, action).status, 'already_executed');
  assert.equal(model.outbox.length, 1);
});

test('duplicate source IDs do not inflate corroboration', () => {
  const { model, token } = setup(['A', 'A', 'B']);
  assert.equal(token, null);
  assert.equal(model.outbox.length, 0);
});

test('tokens signed by a different manager are rejected', () => {
  const first = setup();
  const second = setup();
  assert.equal(second.model.execute(first.token, action).status, 'invalid_signature');
});

test('repeated merge is a no-op and does not invalidate a fresh token', () => {
  const { model, token } = setup();
  model.merge('A', 'B');
  const renewed = model.reattest(token);
  const index = model.index;
  assert.equal(model.merge('B', 'A'), false);
  assert.equal(model.index, index);
  assert.equal(model.execute(renewed.token, action).status, 'executed');
});

test('malformed tokens fail closed', () => {
  const { model } = setup();
  for (const token of [null, {}, { payload: {}, signature: 'bad' }]) {
    assert.equal(model.execute(token, action).status, 'invalid_signature');
  }
});

test('across merge sequences, execution never occurs below the current threshold', () => {
  const sources = ['A', 'B', 'C', 'D', 'X', 'Y'];
  const pairs = sources.flatMap((a, i) => sources.slice(i + 1).map(b => [a, b]));
  for (const first of pairs) for (const second of pairs) {
    const { model, token } = setup();
    model.merge(...first);
    model.merge(...second);
    const count = model.roots(['A', 'B', 'C', 'D']).length;
    const outcome = model.attempt(token, action);
    assert.equal(outcome.final, count >= 3 ? 'executed' : 'blocked');
    assert.equal(model.outbox.length, count >= 3 ? 1 : 0);
  }
});
