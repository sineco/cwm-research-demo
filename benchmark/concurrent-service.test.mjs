import test from 'node:test';
import assert from 'node:assert/strict';
import { concurrentTrial } from './concurrent-service.mjs';

test('concurrent HTTP requests agree with serialized merge/effect order and deduplicate effects',async()=>{
  for(const strategy of ['cwm','recount'])for(const schedule of ['before','racing','after']) {
    const result=await concurrentTrial({strategy,caseId:'P02',schedule,clients:8});
    assert.equal(result.pass,true,JSON.stringify(result.checks));
    if(schedule==='before')assert.equal(result.state.outbox.length,0);
    if(schedule==='after')assert.equal(result.state.outbox.length,1);
  }
});
