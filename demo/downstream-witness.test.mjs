import test from 'node:test';
import assert from 'node:assert/strict';
import { CWM } from './cwm.mjs';
import { ReviewBundleConsumer } from './witness-consumer.mjs';
import { methods,schedules,downstreamTrial } from './downstream-witness.mjs';

test('all downstream contract cases hold, including the fair recount adapter',()=>{
 for(const method of methods)for(const schedule of schedules)assert.ok(downstreamTrial(method,schedule).pass);
 const stale=downstreamTrial('cwm','merge_after_prepare');
 assert.equal(stale.offline.status,'historical_attestation_only');assert.equal(stale.committed.status,'stale_manifest');
});
test('consumer fails closed for unavailable freshness and rejects tampering and misbinding',()=>{
 const model=new CWM(['A','B','C']);const action={type:'export'};model.register('d',['A','B','C'],3,action);const token=model.issue('d');
 const consumer=new ReviewBundleConsumer({publicKey:model.publicKey,decisionId:'d',action,threshold:3});
 assert.equal(consumer.commit(token).status,'freshness_unavailable');
 const bad=structuredClone(token);bad.payload.roots[0].epoch++;assert.equal(consumer.commit(bad).status,'invalid_signature');
 consumer.action={type:'different'};assert.equal(consumer.commit(token).status,'binding_mismatch');assert.equal(consumer.exports.length,0);
});
