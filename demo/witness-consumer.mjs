import { verify } from 'node:crypto';

// A review-bundle exporter: its local contract requires a signed current-origin
// manifest, not merely current action eligibility. No private signing key or
// source registry is held by this component. The trusted view is synchronous
// and shares the authority's event loop; this is NOT a remote atomic commit.
export class ReviewBundleConsumer {
  constructor({ publicKey, decisionId, action, threshold, readCurrentView }) {
    Object.assign(this, { publicKey, decisionId, action, threshold, readCurrentView });
    this.exports = [];
  }
  inspectSignedManifest(token) {
    try {
      if (!verify(null, Buffer.from(JSON.stringify(token.payload)), this.publicKey, Buffer.from(token.signature,'base64'))) return {status:'invalid_signature'};
    } catch { return {status:'invalid_signature'}; }
    const p=token.payload;
    if(p.decisionId!==this.decisionId || p.threshold!==this.threshold || JSON.stringify(p.action)!==JSON.stringify(this.action)) return {status:'binding_mismatch'};
    if(!Array.isArray(p.roots))return {status:'manifest_required'};
    if(!p.roots.every(r=>typeof r.id==='string'&&Number.isSafeInteger(r.epoch)&&r.epoch>=0) || new Set(p.roots.map(r=>r.id)).size!==p.roots.length)return {status:'invalid_manifest'};
    if(p.roots.length<this.threshold)return {status:'insufficient_manifest_support'};
    return {status:'historical_attestation_only',count:p.roots.length};
  }
  commit(token) {
    const signed=this.inspectSignedManifest(token);
    if(signed.status!=='historical_attestation_only')return signed;
    if(this.exports.length)return {status:'already_exported'};
    let view;
    try { view=this.readCurrentView?.(token.payload.roots.map(r=>r.id)); } catch { return {status:'freshness_unavailable'}; }
    if(!view || !Number.isSafeInteger(view.index) || !Array.isArray(view.roots) || view.roots.length!==token.payload.roots.length)return {status:'freshness_unavailable'};
    const current=new Map(view.roots.map(r=>[r.id,r]));
    if(token.payload.roots.some(r=>{const now=current.get(r.id);return !now || now.root!==r.id || now.epoch!==r.epoch;}))return {status:'stale_manifest'};
    // There is no await between the trusted view and this simulated export.
    this.exports.push(structuredClone({ decisionId:this.decisionId,action:this.action,
      acceptedAtIndex:view.index,token,scope:'accepted lineage at local export; not true independence or future freshness' }));
    return {status:'exported',count:token.payload.roots.length,acceptedAtIndex:view.index};
  }
}
