import test from 'node:test';
import assert from 'node:assert/strict';
import { EarlyExitRecount, createCompactModel } from './compact-permit.mjs';
import { earlyConfigs, makeWorkload, trial } from './tradeoff.mjs';
const action={type:'outbox',claimId:'test'};

test('early exit stops only after distinct roots meet threshold and reports a lower bound',()=>{
 const model=new EarlyExitRecount(['A','A2','B','C','D']);
 model.merge('A','A2');model.register('d',['A','A2','B','C','D'],3,action);
 model.resetMetrics();const token=model.issue('d');assert.equal(model.metrics.sourceLookups,4);
 assert.equal(model.ledger.at(-1).count,undefined);assert.equal(model.ledger.at(-1).countLowerBound,3);
 model.resetMetrics();assert.equal(model.inspect(token,action).status,'current');assert.equal(model.metrics.sourceLookups,4);
 model.merge('B','C');model.merge('A','B');model.resetMetrics();
 assert.equal(model.attempt(token,action).final,'insufficient_support');assert.equal(model.metrics.sourceLookups,5);assert.equal(model.outbox.length,0);
});
test('early exit preserves authentication, action/policy binding and replay guards',()=>{
 const m=new EarlyExitRecount(['A','B','C','D']);m.register('d',['A','B','C','D'],3,action);const t=m.issue('d');
 const bad=structuredClone(t);bad.payload.threshold=1;assert.equal(m.inspect(bad,action).status,'invalid_signature');
 assert.equal(m.inspect(t,{type:'other'}).status,'binding_mismatch');m.decisions.get('d').threshold=2;assert.equal(m.inspect(t,action).status,'binding_mismatch');m.decisions.get('d').threshold=3;
 m.merge('A','B');assert.equal(m.attempt(t,action).final,'executed');assert.equal(m.attempt(t,action).final,'already_executed');assert.equal(m.outbox.length,1);
});
test('early exit agrees with exhaustive recount under source permutations and every pair merge sequence',()=>{
 for(const ids of [['A','B','C','D'],['D','C','B','A'],['B','D','A','C']])for(const threshold of [1,2,3,4,5]){
  const a=new EarlyExitRecount(ids),b=createCompactModel(ids,'recount-compact');
  for(const m of [a,b])m.register('d',ids,threshold,action);
  const ta=a.issue('d'),tb=b.issue('d');assert.equal(Boolean(ta),Boolean(tb));
  if(!ta)continue;
  for(const pair of [['A','B'],['C','D'],['B','D']]){a.merge(...pair);b.merge(...pair);assert.equal(a.inspect(ta,action).status,b.inspect(tb,action).status);}
  assert.equal(a.attempt(ta,action).final,b.attempt(tb,action).final);assert.deepEqual(a.outbox,b.outbox);
 }
});
test('eligible, ordered, high-threshold and blocked workload oracles hold for early recount and witnesses',()=>{
 for(const config of earlyConfigs)for(const method of ['cwm','recount-compact','recount-early','dependency-compact','dependency-witness','global']){
  const result=trial(makeWorkload(config,10,11),method,false);assert.equal(result.executed,config.blocked?0:10);
 }
});
