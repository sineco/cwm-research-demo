import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { CWM } from '../demo/cwm.mjs';
import { createModel, DependencyIndex } from './dependency-index.mjs';
import { spectrumConfigs, makeSpectrum, expectedEvents, LabelOracle } from './spectrum-workloads.mjs';
import { runTrial, strategies } from './spectrum-run.mjs';

for (const config of spectrumConfigs) for (const strategy of strategies) {
  test(`${strategy}: event oracle ${config.name}`, () => {
    const w = makeSpectrum(config, 20, 11);
    const row = runTrial(w, strategy, expectedEvents(w));
    assert.equal(row.unsafe + row.falseBlocks + row.refreshMismatches + row.freshnessMismatches, 0);
    assert.equal(row.finalIndexEdges, 0);
    assert.equal(row.truthUnsafe, config.error === 'missed' ? 20 : 0);
    assert.equal(row.truthFalseBlocks, config.error === 'false' ? 20 : 0);
  });
}

test('dependency eligibility uses maintained support without resolving sources again', () => {
  const m = createModel(['A', 'B', 'C', 'D', 'X'], 'dependency');
  const action = { pay: 1 };
  m.register('one', ['A', 'B', 'C', 'D'], 3, action);
  const token = m.issue('one');
  m.resetMetrics();
  m.roots = () => { throw new Error('Unexpected source resolution'); };
  m.merge('A', 'X');
  assert.equal(m.inspect(token, action).status, 'current');
  m.merge('A', 'B');
  assert.equal(m.inspect(token, action).status, 'current');
  m.merge('C', 'D');
  assert.equal(m.inspect(token, action).status, 'insufficient_support');
  assert.equal(m.metrics.sourceLookups, 0);
});

for (const policy of ['execution', 'pending']) {
  test(`freshness oracle rejects stale-token bypass during ${policy}`, t => {
    const inspect = CWM.prototype.inspect;
    t.mock.method(CWM.prototype, 'inspect', function (...args) {
      const result = inspect.apply(this, args);
      return result.status === 'stale' ? { status: 'current' } : result;
    });
    const w = makeSpectrum({ name: 'freshness-regression', topology: 'hub', affected: 1, policy }, 1, 11);
    assert.throws(() => runTrial(w, 'cwm'), /Oracle mismatch/);
  });
}

test('blocked action percentiles include retirement time', t => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock++);
  const retire = DependencyIndex.prototype.retire;
  t.mock.method(DependencyIndex.prototype, 'retire', function (id) {
    clock += 100;
    return retire.call(this, id);
  });
  const w = makeSpectrum({ name: 'retirement-regression', topology: 'hub', affected: 1, loss: true }, 1, 11);
  const row = runTrial(w, 'dependency');
  assert.equal(row.blocked, 1);
  assert.ok(row.actionMs >= 100);
  assert.equal(row.p50ActionUs, row.actionMs * 1000);
  assert.equal(row.p95ActionUs, row.actionMs * 1000);
});

for (const strategy of ['dependency', 'dependency-witness']) {
  test(`${strategy}: terminal blocked retirement cannot revive old tokens`, () => {
    const m = createModel(['A','B','C','D'], strategy), action = { pay: 1 };
    m.register('one', ['A','B','C'], 3, action);
    const token = m.issue('one');
    m.merge('A','B');
    assert.notEqual(m.attempt(token, action).final, 'executed');
    m.retire('one');
    assert.equal(m.attempt(token, action).final, 'retired_decision');
    m.merge('A','D');
    assert.equal(m.execute(token, action).status, 'retired_decision');
    assert.throws(() => m.issue('one'), /retired/);
    assert.equal(m.outbox.length, 0);
    m.register('two', ['A','C','D'], 1, action);
    const other = m.issue('two');
    m.changedAt.delete('two');
    assert.equal(m.execute(other, action).status, 'missing_dependency_state');
  });
  test(`${strategy}: absorbed-root dependencies survive repeated merges and old tokens`, () => {
    const m = createModel(['A','B','C','D','E','X','Y'], strategy), action = { pay: 1 };
    m.register('one', ['B','C','D','E'], 3, action);
    const old = m.issue('one');
    m.merge('X', 'Y');
    assert.equal(m.inspect(old, action).status, 'current');
    m.merge('A', 'B');
    const fresh = m.issue('one');
    if (strategy === 'dependency-witness') assert.equal(m.inspect(old, action).status, 'stale');
    assert.equal(m.inspect(fresh, action).status, 'current');
    assert.equal(m.merge('A', 'B'), false);
    m.merge('A', 'C');
    const renewed = m.issue('one');
    m.merge('D','E');
    assert.notEqual(m.attempt(renewed, action).final, 'executed');
    assert.equal(m.outbox.length, 0);
  });
  test(`${strategy}: signature, action, replay, retirement`, () => {
    const m = createModel(['A','B','C'], strategy), action = { pay: 1 };
    m.register('one', ['A','B','C'], 3, action);
    const t = m.issue('one');
    assert.equal(m.execute(t, { pay: 2 }).status, 'binding_mismatch');
    const bad = structuredClone(t); bad.payload.threshold = 1;
    assert.equal(m.execute(bad, action).status, 'invalid_signature');
    assert.equal(m.execute(t, action).status, 'executed');
    assert.equal(m.execute(t, action).status, 'already_executed');
    assert.equal(m.edges, 0);
    m.resetMetrics(); m.merge('A', 'B');
    assert.equal(m.metrics.dependencyVisits, 0);
  });
  test(`${strategy}: random merge sequences preserve exact pending reverse index`, () => {
    for (let seed = 1; seed <= 20; seed++) {
      let state = seed;
      const rand = n => { state = (Math.imul(state,1664525)+1013904223) >>> 0; return state % n; };
      const sources = Array.from({ length: 30 }, (_, i) => `s${i}`);
      const m = createModel(sources, strategy), oracle = new LabelOracle(sources), ds = [];
      for (let i = 0; i < 12; i++) {
        const ids = [...new Set(Array.from({ length: 8 }, () => sources[rand(30)]))];
        const d = { id: `d${i}`, sources: ids, threshold: 3, action: { i } };
        m.register(d.id, ids, 3, d.action); d.token = m.issue(d.id); ds.push(d);
      }
      for (let step = 0; step < 20; step++) {
        const a = sources[rand(30)], b = sources[rand(30)]; m.merge(a,b); oracle.merge(a,b);
        for (const d of ds.filter(d => !d.done)) {
          const roots = new Set(d.sources.map(s => m.find(s)));
          assert.deepEqual(m.decisionRoots.get(d.id), roots);
          for (const [root, ids] of m.dependents) assert.equal(ids.has(d.id), roots.has(root));
        }
        const d = ds[step % ds.length];
        if (!d.done) {
          assert.equal(m.attempt(d.token, d.action).final === 'executed', oracle.allowed(d));
          m.retire(d.id); d.done = true;
        }
        assert.equal(m.edges, [...m.dependents.values()].reduce((n, ids) => n + ids.size, 0));
      }
    }
  });
}
