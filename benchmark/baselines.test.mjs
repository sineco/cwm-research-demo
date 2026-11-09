import test from 'node:test';
import assert from 'node:assert/strict';
import { CWM } from '../demo/cwm.mjs';
import { configurations, makeWorkload, oracle } from './workloads.mjs';

for (const config of configurations) for (const strategy of ['cwm', 'recount', 'global']) {
  test(`${strategy} matches independent oracle for ${config.name}`, () => {
    const workload = makeWorkload(config, 20);
    const expected = oracle(workload);
    const model = new CWM(workload.sources, { strategy });
    workload.setupMerges.forEach(pair => model.merge(...pair));
    const tokens = workload.decisions.map(d => {
      model.register(d.id, d.sources, d.threshold, d.action);
      return model.issue(d.id);
    });
    model.resetMetrics();
    workload.updates.forEach(pair => model.merge(...pair));
    workload.decisions.forEach((d, i) => {
      const result = model.attempt(tokens[i], d.action);
      assert.equal(result.final === 'executed', expected.get(d.id));
    });
    if (strategy === 'recount') assert.equal(model.metrics.sourceLookups, 20*config.sourcesPerDecision);
    if (strategy === 'cwm') assert.equal(model.metrics.reattestations, Math.round(20*config.affected));
    if (strategy === 'global') assert.equal(model.metrics.reattestations, workload.updates.length ? 20 : 0);
  });
}

for (const strategy of ['cwm', 'recount', 'global']) {
  test(`${strategy}: interleaved decisions, renewal, absorbed roots, and replay`, () => {
    const model = new CWM(['A','B','C','D','X','Y'], { strategy });
    const action = { type: 'outbox' };
    model.register('one', ['A','B','C','D'], 3, action);
    model.register('two', ['B','C','D'], 3, action);
    const one = model.issue('one');
    const two = model.issue('two');
    model.merge('A','B');
    assert.equal(model.attempt(two, action).final, 'executed');
    const renewed = strategy === 'recount' ? one : model.reattest(one).token;
    model.merge('C','D');
    assert.notEqual(model.attempt(renewed, action).final, 'executed');
    assert.equal(model.execute(two, action).status, 'already_executed');
    assert.equal(model.outbox.length, 1);
  });
  test(`${strategy}: common action and signature protections`, () => {
    const model = new CWM(['A','B','C'], { strategy });
    model.register('d', ['A','B','C'], 3, { claim: 'one' });
    const token = model.issue('d');
    assert.equal(model.execute(token, { claim: 'two' }).status, 'binding_mismatch');
    token.payload.threshold = 1;
    assert.equal(model.execute(token, { claim: 'one' }).status, 'invalid_signature');
  });
}
