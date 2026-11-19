import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { caseIds, scenarios } from './report-fixtures.mjs';
import { summarizeUsage } from './report-suite.mjs';

const dir = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node demo/verify-five-case.mjs results/five-case/<run>');
const read = file => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const manifest = read('manifest.json');
for (const entry of manifest) {
  assert.equal(createHash('sha256').update(readFileSync(join(dir, entry.path))).digest('hex'), entry.sha256, entry.path);
}
const rows = read('results.json');
assert.equal(rows.length, 30);
assert.equal(new Set(rows.map(row => `${row.caseId}/${row.scenario}/${row.strategy}`)).size, 30);
for (const caseId of caseIds) for (const scenario of scenarios) for (const strategy of ['cwm', 'recount']) {
  const trace = read(`traces/${caseId}-${scenario}-${strategy}.json`);
  assert.equal(trace.outcome, 'pass');
  assert.notEqual(trace.servicePid, trace.parentPid);
  assert.equal(trace.fixture.caseId, caseId);
  assert.equal(trace.fixture.sources.length, scenario === 'recovery' ? 3 : 2);
  assert.equal(trace.service.outbox.length, scenario === 'disclosure' ? 0 : 1);
  assert.equal(trace.fixture.sources.filter(source => source.synthetic).length, scenario === 'recovery' ? 1 : 0);
  assert.equal(trace.fixture.threshold, 2);
  assert.equal(new Set(trace.service.partition.map(item => item.root)).size, scenario === 'disclosure' ? 1 : 2);
  const events = trace.service.ledger;
  assert.equal(events.filter(event => event.type === 'merge').length, scenario === 'control' ? 0 : 1);
  assert.equal(events.filter(event => event.type === 'renewed').length, scenario === 'recovery' && strategy === 'cwm' ? 1 : 0);
  const fixtureBytes = readFileSync(join(dir, `source/demo/fixtures/${caseId.toLowerCase()}.json`));
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), trace.fixtureSha256);
  assert.equal(createHash('sha256').update(JSON.stringify(trace.fixture)).digest('hex'), trace.effectiveFixtureSha256);
  assert.deepEqual(summarizeUsage(trace.agent), trace.usageSummary);
  const row = rows.find(row => row.caseId === caseId && row.scenario === scenario && row.strategy === strategy);
  assert.equal(row.total_tokens, trace.usageSummary.total_tokens);
  assert.equal(row.effects, trace.service.outbox.length);
}
console.log(`Verified ${manifest.length} file hashes and all 30 trace/fixture/partition/effect/renewal/usage outcomes. This checks archived consistency, not provenance truth or independent signature validity.`);
for (const strategy of ['cwm', 'recount']) {
  const subset = rows.filter(row => row.strategy === strategy);
  const sums = Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens','modelRequests','toolCalls'].map(key => [key, subset.every(row => Number.isFinite(row[key])) ? subset.reduce((sum,row) => sum + row[key], 0) : null]));
  console.log(strategy, JSON.stringify(sums));
}
