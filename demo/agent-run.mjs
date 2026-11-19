import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCompletion, endpointConfig, scriptedCompletion } from './agent-loop.mjs';
import { runAgentExperiment } from './agent-experiment.mjs';

const args = process.argv.slice(2);
const allowed = ['--smoke', '--recount', '--no-disclosure'];
if (args.some(arg => !allowed.includes(arg))) throw new Error('Usage: node demo/agent-run.mjs [--smoke] [--recount] [--no-disclosure]');
const smoke = args.includes('--smoke');
const config = smoke ? null : endpointConfig();
const scenarios = smoke ? [
  { strategy: 'cwm', disclose: true }, { strategy: 'recount', disclose: true },
  { strategy: 'cwm', disclose: false }, { strategy: 'recount', disclose: false },
] : [{ strategy: args.includes('--recount') ? 'recount' : 'cwm', disclose: !args.includes('--no-disclosure') }];
const output = new URL('./output/agent/', import.meta.url);
mkdirSync(output, { recursive: true });
console.log(smoke ? 'SCRIPTED HTTP SMOKE TEST — no LLM calls.' : `LIVE MODEL: ${config.model}. Calling the configured endpoint with public P01 metadata.`);
for (const scenario of scenarios) {
  const mode = smoke ? 'scripted-smoke-NOT-LLM' : 'live-model';
  const run = await runAgentExperiment({ ...scenario, mode,
    complete: smoke ? scriptedCompletion() : createCompletion(config) });
  const filename = `${smoke ? 'smoke' : 'live'}-${scenario.strategy}-${scenario.disclose ? 'merge' : 'control'}.json`;
  writeFileSync(new URL(filename, output), JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
  console.log(`\n${run.outcome.toUpperCase()} ${scenario.strategy} / ${scenario.disclose ? 'shared-origin disclosure' : 'no-disclosure control'}`);
  for (const exchange of run.exchanges) console.log(`  ${exchange.sequence}. ${exchange.name}: ${exchange.result.final ?? exchange.result.status ?? exchange.result.error ?? 'evidence returned'}`);
  console.log(`  Simulated effects: ${run.service.outbox.length}; service process differs from agent host: ${run.servicePid !== run.parentPid}`);
  if (run.failure) console.log(`  Error: ${run.failure}`);
  console.log(`  Trace: ${fileURLToPath(new URL(filename, output))}`);
  if (run.outcome !== 'pass') process.exitCode = 1;
}
