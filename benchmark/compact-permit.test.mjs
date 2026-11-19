import test from 'node:test';
import assert from 'node:assert/strict';
import { compactMethods, createCompactModel } from './compact-permit.mjs';
import { createModel } from './dependency-index.mjs';
import { configs, quietConfig, makeWorkload, trial } from './tradeoff.mjs';

const action = { type: 'simulated_outbox', claimId: 'claim' };
function setup(method, threshold=3) {
  const model=createCompactModel(['A','B','C','D','X','Y'],method);
  model.register('d',['A','B','C','D'],threshold,action);
  return {model,token:model.issue('d')};
}
for(const method of compactMethods) {
  test(`${method}: compact format preserves signature, binding and replay checks`,()=>{
    const {model,token}=setup(method);
    assert.deepEqual(Object.keys(token.payload).sort(),['kind','tokenId','decisionId','action','threshold'].sort());
    assert.equal(Buffer.from(token.signature,'base64').length,64);
    for(const mutate of [t=>t.payload.threshold=1,t=>t.payload.decisionId='other',t=>t.payload.action.claimId='other',t=>t.signature='bad']) {
      const changed=structuredClone(token);mutate(changed);
      assert.equal(model.inspect(changed,action).status,'invalid_signature');
    }
    assert.equal(model.inspect(token,{...action,claimId:'other'}).status,'binding_mismatch');
    const other=setup(method).model;
    assert.equal(other.inspect(token,action).status,'invalid_signature');
    assert.equal(model.inspect(null,action).status,'invalid_permit_format');
    model.decisions.get('d').threshold=2;
    assert.equal(model.inspect(token,action).status,'binding_mismatch');
    model.decisions.get('d').threshold=3;
    assert.equal(model.attempt(token,action).final,'executed');
    assert.equal(model.attempt(token,action).final,'already_executed');
    assert.equal(model.outbox.length,1);
  });
  test(`${method}: surviving support executes without renewal; insufficient support blocks`,()=>{
    for(const blocked of [false,true]) {
      const {model,token}=setup(method);
      model.merge('A','B');
      if(blocked)model.merge('A','C');
      const result=model.attempt(token,action);
      assert.equal(result.final,blocked?'insufficient_support':'executed');
      assert.equal(result.replacement,null);
      assert.equal(model.metrics.signatures,1);
      assert.equal(model.metrics.reattestations,0);
      assert.equal(model.outbox.length,blocked?0:1);
    }
    const {model}=setup(method,5);
    assert.equal(model.issue('d'),null);
  });
  test(`${method}: matches full-witness eligibility baseline across merge sequences`,()=>{
    for(const merges of [[],[['X','Y']],[['A','B']],[['A','B'],['C','D']],[['B','C'],['A','D'],['B','A']]]) {
      const {model:compact,token:small}=setup(method);
      const full=createModel(['A','B','C','D','X','Y'],method.replace('-compact',''));
      full.register('d',['A','B','C','D'],3,action);const big=full.issue('d');
      for(const pair of merges){compact.merge(...pair);full.merge(...pair);}
      assert.equal(compact.inspect(small,action).status,full.inspect(big,action).status);
      assert.equal(compact.attempt(small,action).final,full.attempt(big,action).final);
      assert.deepEqual(compact.outbox,full.outbox);
      assert.ok(Buffer.byteLength(JSON.stringify(small))<Buffer.byteLength(JSON.stringify(big)));
    }
  });
}
test('compact baselines satisfy the matched workload oracle in all nine shapes',()=>{
  for(const config of [...configs,quietConfig])for(const method of compactMethods){
    const result=trial(makeWorkload(config,20,11),method,false);
    assert.equal(result.renewals,0);assert.equal(result.executed,20);
  }
});
