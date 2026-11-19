import assert from 'node:assert/strict';
import { CWM } from './cwm.mjs';
import { createModel } from '../benchmark/dependency-index.mjs';
import { EarlyExitRecount } from '../benchmark/compact-permit.mjs';
import { ReviewBundleConsumer } from './witness-consumer.mjs';

export const methods=['cwm','dependency-witness','early-permit-only','early-plus-manifest'];
export const schedules=['unchanged','unrelated','eligible_merge','insufficient','merge_after_prepare'];
export function downstreamTrial(method,schedule) {
  assert.ok(methods.includes(method)&&schedules.includes(schedule));
  const model=method.startsWith('early') ? new EarlyExitRecount(['A','B','C','D','X','Y']) : createModel(['A','B','C','D','X','Y'],method);
  const action={type:'export_review_bundle',claimId:'constructed-claim'};
  model.register('review-1',['A','B','C','D'],3,action);
  const original=model.issue('review-1');
  if(['eligible_merge','insufficient'].includes(schedule))model.merge('A','B');
  if(schedule==='insufficient')model.merge('C','D');
  if(schedule==='unrelated')model.merge('X','Y');
  const consumer=new ReviewBundleConsumer({publicKey:model.publicKey,decisionId:'review-1',action,threshold:3,
    readCurrentView:ids=>({index:model.index,roots:ids.map(id=>({id,root:model.find(id),epoch:model.epoch.get(id)}))})});
  const initialEligibility=model.inspect(original,action);
  let prepared=original,producerStatus=initialEligibility.status;
  if(method==='early-plus-manifest' && initialEligibility.status==='current') {
    // Fair adapter: recount can supply the same manifest by counting exact roots
    // and signing them at export time. This is additional work, not a CWM monopoly.
    prepared=CWM.prototype.issue.call(model,'review-1',original.payload.tokenId);
    producerStatus='manifest_issued';
  } else if(initialEligibility.status==='stale') {
    const result=model.reattest(original);prepared=result.token;producerStatus=result.status;
  } else if(initialEligibility.status!=='current')prepared=null;
  const preparedCheck=prepared ? consumer.inspectSignedManifest(prepared) : null;
  if(schedule==='merge_after_prepare')model.merge('A','B');
  const committed=prepared ? consumer.commit(prepared) : {status:'producer_blocked'};
  const expected=schedule==='insufficient'?'producer_blocked':method==='early-permit-only'?'manifest_required':schedule==='merge_after_prepare'?'stale_manifest':'exported';
  assert.equal(committed.status,expected);
  assert.equal(consumer.exports.length,expected==='exported'?1:0);
  if(expected==='exported')assert.equal(consumer.commit(prepared).status,'already_exported');
  // Signature verification offline cannot certify current lineage, even after a
  // later merge. It describes the signing authority's historical attestation.
  const offline=consumer.inspectSignedManifest(prepared??original);
  return {method,schedule,pass:true,expected,initialEligibility,producerStatus,preparedCheck,committed,offline,
    exports:consumer.exports,original,prepared,ledger:model.ledger,metrics:model.metrics,
    publicKey:model.publicKey.export({type:'spki',format:'pem'}),
    limitations:['Synthetic four-origin claim, not a verified independent-source case.','Logical consumer separation in one event loop; no remote or durable export.','Current accepted lineage does not certify true source independence.','Freshness is at local commit only; offline signatures do not establish current freshness.']};
}
