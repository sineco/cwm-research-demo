import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixtureSha256, p01, replayP01 } from './public-report.mjs';

const runs = ['cwm', 'recount'].map(strategy => replayP01(strategy));
const controls = ['cwm', 'recount'].map(strategy => replayP01(strategy, { disclose: false }));
const pass = [...runs, ...controls].every(run => run.pass);
const output = new URL('./output/public-report/', import.meta.url);
mkdirSync(output, { recursive: true });
const trace = { caseId: p01.caseId, generatedAt: new Date().toISOString(), nodeVersion: process.version,
  fixtureSha256, hashScope: 'Exact local fixture bytes, not source webpages.', fixture: p01,
  pass, runs, controls };
writeFileSync(new URL('p01-results.json', output), JSON.stringify(trace, null, 2) + '\n');

const lines = [
  'P01: public-report annotation replay',
  `Claim: ${p01.claim}`,
  `Review: ${p01.review.reviewer}, ${p01.review.decision}; second review pending.`,
  'Scope: curated public-source metadata + controlled merge timing + simulated action.',
  'No LLM, live firewall, automatic lineage detection, or distributed execution.',
  '',
];
for (const run of runs) {
  lines.push(`${run.strategy.toUpperCase()}: ${run.pass ? 'PASS' : 'FAIL'}`);
  for (const event of run.events) lines.push(`  ${event.step}. ${event.type}: ${JSON.stringify(event)}`);
  lines.push('  Audit:');
  for (const event of run.ledger) lines.push(`    ${JSON.stringify(event)}`);
  lines.push('');
}
lines.push('Controls (no disclosure; same incomplete accepted partition):');
for (const control of controls) lines.push(`  ${control.strategy}: ${control.pass ? 'PASS' : 'FAIL'} — ${control.result.final}, outbox=${control.outbox.length}`);
lines.push('', `${pass ? 'PASS' : 'FAIL'}: both methods block after disclosure; both controls execute.`,
  'The recount baseline blocks directly; CWM rejects stale permission and then re-attests.',
  'This is a behavior check, not evidence that CWM is faster or uniquely correct.');
if (!pass) lines.push('Failed checks: ' + JSON.stringify([...runs, ...controls].filter(run => !run.pass).map(run => ({strategy: run.strategy, disclose: run.disclose, checks: run.checks}))));
writeFileSync(new URL('p01-report.txt', output), lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`\nFull trace: ${fileURLToPath(new URL('p01-results.json', output))}`);
console.log(`Readable log: ${fileURLToPath(new URL('p01-report.txt', output))}`);
if (!pass) process.exitCode = 1;
