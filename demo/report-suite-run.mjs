import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { caseIds, scenarios } from './report-fixtures.mjs';
import { createCompletion, endpointConfig, scriptedCompletion } from './agent-loop.mjs';
import { runAgentExperiment } from './agent-experiment.mjs';
import { summarizeUsage } from './report-suite.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--smoke', '--live'].includes(arg)) || args.length !== 1) throw new Error('Choose exactly one: --smoke or --live');
const smoke = args[0] === '--smoke';
const config = smoke ? null : endpointConfig();
const stamp = new Date().toISOString().replaceAll(':', '-');
const output = new URL(`../results/five-case/${stamp}-${smoke ? 'smoke' : 'live'}/`, import.meta.url);
mkdirSync(new URL('traces/', output), { recursive: true });
const manifest = [];
function save(relative, bytes) {
  mkdirSync(new URL('.', new URL(relative, output)), { recursive: true });
  writeFileSync(new URL(relative, output), bytes);
  manifest.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex') });
}
for (const file of ['package.json', 'demo/cwm.mjs', 'demo/public-report.mjs', 'demo/agent-service.mjs', 'demo/agent-client.mjs', 'demo/agent-loop.mjs', 'demo/agent-experiment.mjs', 'demo/report-fixtures.mjs', 'demo/report-suite.mjs', 'demo/report-suite-run.mjs', 'demo/report-suite.test.mjs', ...caseIds.map(id => `demo/fixtures/${id.toLowerCase()}.json`)]) {
  save(`source/${file}`, readFileSync(new URL(`../${file}`, import.meta.url)));
}
console.log(smoke ? 'SCRIPTED five-case suite — no LLM calls or LLM token estimates.' : `LIVE five-case suite: ${config.model}; 30 conditions, at most 8 model requests each.`);
const rows = [];
for (const [i, caseId] of caseIds.entries()) {
  for (const [j, scenario] of scenarios.entries()) {
    // Alternate which method runs first; these observations are still unreplicated.
    for (const strategy of (i + j) % 2 ? ['recount', 'cwm'] : ['cwm', 'recount']) {
      const run = await runAgentExperiment({ caseId, scenario, strategy,
        mode: smoke ? 'scripted-smoke-NOT-LLM' : 'live-model',
        complete: smoke ? scriptedCompletion() : createCompletion(config) });
      const usage = summarizeUsage(run.agent);
      save(`traces/${caseId}-${scenario}-${strategy}.json`, JSON.stringify({ ...run, usageSummary: usage }, null, 2) + '\n');
      rows.push({ caseId, scenario, strategy, outcome: run.outcome,
        initial: run.exchanges.find(exchange => exchange.name === 'attempt_action')?.result.initial ?? null,
        final: run.exchanges.find(exchange => exchange.name === 'attempt_action')?.result.final ?? null,
        effects: run.service.outbox.length, witnessBytes: run.exchanges.find(exchange => exchange.name === 'request_permission')?.result.witness_bytes ?? null,
        ...usage, toolCalls: run.agent?.toolCalls ?? null,
        models: [...new Set(run.agent?.usage.map(entry => entry.model) ?? [])].join(';') });
      save('results.json', JSON.stringify(rows, null, 2) + '\n');
      console.log(`${run.outcome.toUpperCase()} ${caseId} ${scenario} ${strategy}: ${rows.at(-1).final}; LLM tokens=${usage.total_tokens ?? 'unavailable'}`);
      if (run.outcome !== 'pass') process.exitCode = 1;
      if (run.outcome === 'error') break;
    }
    if (process.exitCode) break;
  }
  if (process.exitCode) break;
}
const header = Object.keys(rows[0]);
save('SUMMARY.csv', [header.join(','), ...rows.map(row => header.map(key => row[key] ?? '').join(','))].join('\n') + '\n');
const body = rows.map(row => `| ${row.caseId} | ${row.scenario} | ${row.strategy} | ${row.outcome} | ${row.final} | ${row.effects} | ${row.total_tokens ?? 'N/A'} |`).join('\n');
save('REPORT.md', `# Five-case ${smoke ? 'scripted smoke' : 'live-agent'} suite\n\nGenerated ${stamp}. Node ${process.version}. ${rows.filter(row => row.outcome === 'pass').length}/${rows.length} observed runs passed; planned 30.\n\n| Case | Scenario | Method | Outcome | Gateway final | Effects | LLM tokens |\n|---|---|---|---|---|---:|---:|\n${body}\n\n## Interpretation boundaries\n\n- Five selected report pairs, not representative sampling or independent human adjudication. AI-assisted annotations were checked by the authors; fixture review fields preserve their collection-time status.\n- Control and disclosure use two public-report metadata items at threshold two. Initial separation and merge timing are controlled assumptions.\n- Recovery adds ONE EXPLICITLY SYNTHETIC source for the same claim: three origins become two. It tests renewal, not a verified third investigation.\n- Separate loopback service; effects are in-memory outbox entries. No actual firewall, Raft, full-report retrieval or learned provenance detection.\n- One run per condition; the 30 runs are not 30 independent real-world cases.\n- LLM counts come from provider usage, summed across requests; missing usage is N/A, never zero. Cached input, where supplied, is recorded separately in CSV/JSON. Witness bytes are a different measure.\n- Both methods keep witnesses and provenance computation server-side. Differences in model wording, result payloads and request counts confound a causal token-saving claim. There is no LLM-reassessment comparator.\n- Source snapshots and fixture hashes describe this run; they are not frozen copies of the original articles.\n`);
// Overwritten incremental files should have only their final hash listed.
const unique = [...new Map(manifest.map(item => [item.path, item])).values()];
writeFileSync(new URL('manifest.json', output), JSON.stringify(unique, null, 2) + '\n');
console.log(`Results: ${fileURLToPath(output)}`);
