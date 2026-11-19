import { sign, verify } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CWM } from '../demo/cwm.mjs';

export function makeTokenCase(originCount, sourcesPerOrigin = 1, strategy = 'cwm') {
  const groups = Array.from({ length: originCount }, (_, group) =>
    Array.from({ length: sourcesPerOrigin }, (_, member) => `origin-${String(group).padStart(4, '0')}-source-${String(member).padStart(4, '0')}`));
  const ids = groups.flat();
  const model = new CWM(ids, { strategy });
  for (const group of groups) for (const id of group.slice(1)) model.merge(group[0], id);
  const action = { type: 'synthetic_outbox_request', claimId: 'token-cost', target: '192.0.2.10' };
  model.register('token-cost-decision', ids, 3, action);
  const token = model.issue('token-cost-decision');
  if (!token || token.payload.roots.length !== originCount) throw new Error('Invalid token-cost fixture');
  model.ledger.length = 0;
  model.resetMetrics();
  return { model, action, token, sourceCount: ids.length };
}

export function summarizeBatches(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { minBatchMeanUs: sorted[0], medianBatchMeanUs: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    maxBatchMeanUs: sorted.at(-1), batchMeanUs: values };
}

export function measureTokenCase(originCount, sourcesPerOrigin, { batches = 20, iterations = 50, warmup = 100 } = {}) {
  const cwm = makeTokenCase(originCount, sourcesPerOrigin);
  const recount = makeTokenCase(originCount, sourcesPerOrigin, 'recount');
  const payloadBytes = Buffer.from(JSON.stringify(cwm.token.payload));
  const signatureBytes = Buffer.from(cwm.token.signature, 'base64');
  const tokenBytes = Buffer.from(JSON.stringify(cwm.token));
  let sink;
  const operations = {
    empty_loop_control: () => 1,
    serialize_payload: () => Buffer.from(JSON.stringify(cwm.token.payload)),
    serialize_token: () => Buffer.from(JSON.stringify(cwm.token)),
    sign_preencoded_payload: () => sign(null, payloadBytes, cwm.model.privateKey),
    verify_preencoded_payload: () => verify(null, payloadBytes, cwm.model.publicKey, signatureBytes),
    cwm_inspect_current: () => cwm.model.inspect(cwm.token, cwm.action),
    recount_inspect_current: () => recount.model.inspect(recount.token, recount.action),
    issue_witness: () => cwm.model.issue('token-cost-decision'),
  };
  const names = Object.keys(operations);
  // Warm all paths first. The loop below rotates operation order each batch.
  for (const name of names) for (let i = 0; i < warmup; i++) sink = operations[name]();
  const samples = Object.fromEntries(names.map(name => [name, []]));
  for (let batch = 0; batch < batches; batch++) {
    for (let offset = 0; offset < names.length; offset++) {
      const name = names[(batch + offset) % names.length];
      // Avoid unbounded audit retention; cleanup is outside the timed interval.
      cwm.model.ledger.length = 0;
      recount.model.ledger.length = 0;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) sink = operations[name]();
      samples[name].push((performance.now() - start) * 1000 / iterations);
    }
  }
  if (sink === undefined || !verify(null, payloadBytes, cwm.model.publicKey, signatureBytes)) throw new Error('Crypto validation failed');
  if (cwm.model.inspect(cwm.token, cwm.action).status !== 'current' || recount.model.inspect(recount.token, recount.action).status !== 'current') throw new Error('Unexpected gateway state');
  return { originCount, sourcesPerOrigin, sourceCount: cwm.sourceCount,
    payloadBytes: payloadBytes.length, signatureBytes: signatureBytes.length,
    signatureBase64Bytes: Buffer.byteLength(cwm.token.signature), tokenBytes: tokenBytes.length,
    recountTokenBytes: Buffer.byteLength(JSON.stringify(recount.token)),
    measurements: Object.fromEntries(names.map(name => [name, summarizeBatches(samples[name])])) };
}
