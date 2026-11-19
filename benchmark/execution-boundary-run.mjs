import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runBoundarySuite } from './execution-boundary.mjs';

const output = new URL(`../results/execution-boundary/${new Date().toISOString().replaceAll(':', '-')}/`, import.meta.url);
mkdirSync(output, { recursive: true });
const trials = [];
for (let repetition = 0; repetition < 10; repetition++) trials.push({ repetition, cases: await runBoundarySuite() });
const pass = trials.every(trial => trial.cases.every(item => item.pass));
const sourcePaths = ['demo/cwm.mjs', 'demo/agent-service.mjs', 'demo/public-report.mjs', 'demo/fixtures/p01.json', 'benchmark/execution-boundary.mjs', 'benchmark/execution-boundary-run.mjs'];
const sources = sourcePaths.map(path => {
  const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
  const target = new URL(`source/${path}`, output); mkdirSync(new URL('.', target), { recursive: true }); writeFileSync(target, bytes);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
});
writeFileSync(new URL('results.json', output), JSON.stringify({ nodeVersion: process.version, pass, sources, trials }, null, 2) + '\n');
const rows = trials[0].cases.map(item => `| ${item.strategy} | ${item.name} | ${item.kind} | ${trials.filter(trial => trial.cases.find(c => c.name === item.name && c.strategy === item.strategy)?.pass).length}/10 |`).join('\n');
writeFileSync(new URL('REPORT.md', output), `# Controlled execution-boundary experiment\n\n${pass ? 'PASS' : 'FAIL'}: 13 method/schedule combinations, repeated 10 times (130 checks of complete scenarios). Repetition verifies deterministic scheduling, not a statistical failure-rate estimate.\n\n| Method | Schedule | Environment | Expected outcome reproduced |\n| --- | --- | --- | --- |\n${rows}\n\nEight combinations use actual loopback HTTP with the P01 fixture and an in-memory effect. A trusted test-only barrier pauses an in-flight request before authoritative validation. Normal service execution has no await between validation and its simulated effect. Five combinations use synthetic in-process barriers: these are not additional real-report cases.\n\nThe unsafe cached-preflight comparators deliberately execute after support falls below threshold. Their PASS means the expected bug was reproduced, not safe behavior. Both revalidating methods block at that boundary. CWM also rejects a replacement token invalidated by a second merge (synthetic four-to-three-to-two case).\n\nMerges processed after the effect do not retroactively revoke it. No test inserts a merge inside the synchronous commit operation; that operation is indivisible under this single-process event-loop model. These results do not establish distributed linearizability, Raft behavior, real firewall atomicity, or an advantage over correct recount.\n\nSource snapshots and hashes accompany the trace. No LLM calls, arbitrary sleeps, or external firewall actions occur.\n`);
console.log(`${pass ? 'PASS' : 'FAIL'}: 130 scheduled scenarios; intentionally unsafe controls included.`);
console.log(`Report: ${new URL('REPORT.md', output).pathname}`);
if (!pass) process.exitCode = 1;
