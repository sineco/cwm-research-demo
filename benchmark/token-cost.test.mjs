import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { makeTokenCase, measureTokenCase, summarizeBatches } from './token-cost.mjs';

test('token-cost fixture varies source count independently of witness origin count', () => {
  const small = makeTokenCase(8, 1);
  const repeated = makeTokenCase(8, 4);
  assert.equal(small.sourceCount, 8);
  assert.equal(repeated.sourceCount, 32);
  assert.equal(repeated.token.payload.roots.length, 8);
  assert.equal(repeated.model.inspect(repeated.token, repeated.action).status, 'current');
  assert.ok(verify(null, Buffer.from(JSON.stringify(repeated.token.payload)), repeated.model.publicKey, Buffer.from(repeated.token.signature, 'base64')));
  const changed = structuredClone(repeated.token.payload);
  changed.threshold = 1;
  assert.equal(verify(null, Buffer.from(JSON.stringify(changed)), repeated.model.publicKey, Buffer.from(repeated.token.signature, 'base64')), false);
});

test('token-cost samples label batch means and retain raw observations', () => {
  const result = measureTokenCase(3, 4, { batches: 2, iterations: 2, warmup: 1 });
  assert.equal(result.sourceCount, 12);
  assert.equal(result.signatureBytes, 64);
  assert.equal(result.signatureBase64Bytes, 88);
  assert.equal(result.tokenBytes, result.recountTokenBytes);
  for (const stats of Object.values(result.measurements)) {
    assert.equal(stats.batchMeanUs.length, 2);
    assert.ok(stats.batchMeanUs.every(value => Number.isFinite(value) && value >= 0));
    assert.ok(stats.minBatchMeanUs <= stats.medianBatchMeanUs && stats.medianBatchMeanUs <= stats.maxBatchMeanUs);
  }
  assert.equal(summarizeBatches([9, 1, 5, 3]).medianBatchMeanUs, 4);
});
