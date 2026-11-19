import test from 'node:test';
import assert from 'node:assert/strict';
import { configs, quietConfig, methods, makeWorkload, trial } from './tradeoff.mjs';

test('matched workloads preserve root multiplicity and analytical renewal counts across five strategies', () => {
  for (const config of configs) {
    const w = makeWorkload(config, 100, 11);
    assert.equal(w.decisions.length, 100);
    assert.ok(w.decisions.every(d=>d.sources.length===config.roots*config.sourcesPerRoot));
    for (const method of methods) {
      const row = trial(w,method,false);
      const affected = Math.round(100*config.fanout);
      const expected = method === 'global' ? 100*config.rounds : ['cwm','dependency-witness'].includes(method) ? affected*config.rounds : 0;
      assert.equal(row.renewals,expected);
      assert.equal(row.executed,100);
      assert.equal(row.inspections,100*config.checks*config.rounds);
      assert.equal(row.initialIndexEdges,method.startsWith('dependency') ? 100*config.roots : 0);
    }
  }
});

test('no-change control keeps every original witness current without renewal',()=>{
  for(const method of methods){
    const row=trial(makeWorkload(quietConfig,20,11),method,false);
    assert.equal(row.renewals,0);assert.equal(row.updateMs,0);assert.equal(row.executed,20);
  }
});
