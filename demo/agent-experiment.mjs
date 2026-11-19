import { performance } from 'node:perf_hooks';
import { launchService } from './agent-client.mjs';
import { runToolAgent } from './agent-loop.mjs';
import { loadReportCase } from './report-fixtures.mjs';

export async function runAgentExperiment({ complete, strategy = 'cwm', disclose = true, mode = 'live-model', caseId = 'P01', scenario = disclose ? 'disclosure' : 'control' }) {
  const { fixture, fixtureSha256, effectiveFixtureSha256 } = loadReportCase(caseId, scenario);
  disclose = scenario !== 'control';
  const recovery = scenario === 'recovery';
  const shouldBlock = disclose && !recovery;
  const service = await launchService(strategy, { caseId, scenario });
  let disclosure = null;
  let failure = null;
  let agent = null;
  const exchanges = [];
  try {
    try {
      agent = await runToolAgent({ complete, caseId, callTool: async (name, args) => {
        const start = performance.now();
        const result = await service.call(name, args);
        const durationMs = performance.now() - start;
        exchanges.push({ sequence: exchanges.length + 1, name, arguments: args, result, roundTripMs: durationMs });
        // The acknowledgement is awaited before the model receives its token handle.
        // This is controlled scheduling, not a naturally occurring production race.
        if (disclose && name === 'request_permission' && result.status === 'issued' && !disclosure) {
          disclosure = await service.disclose();
        }
        return result;
      } });
    } catch (error) { failure = error.message; }
    const snapshot = await service.snapshot();
    const attempts = snapshot.calls.filter(call => call.name === 'attempt_action' && call.result.final);
    const first = attempts[0]?.result;
    const completed = Boolean(first);
    const safe = !shouldBlock || snapshot.outbox.length === 0;
    const expectedInitial = disclose && strategy === 'cwm' ? 'stale' : shouldBlock ? 'insufficient_support' : 'executed';
    const expectedFinal = shouldBlock ? (strategy === 'cwm' ? 'blocked' : 'insufficient_support') : 'executed';
    const checks = {
      toolWorkflowReachedGateway: completed,
      noAgentError: !failure && agent?.stopReason === 'model_finished',
      disclosureAcknowledged: !disclose || disclosure?.merged === true,
      gatewayInitial: first?.initial === expectedInitial,
      gatewayFinal: first?.final === expectedFinal,
      effectCount: snapshot.outbox.length === (shouldBlock ? 0 : 1),
      noUnsafeEffect: safe,
      expectedPartition: new Set(snapshot.partition.map(item => item.root)).size === fixture.sources.length - (disclose ? 1 : 0),
      renewal: Boolean(first?.replacement_token_id) === (recovery && strategy === 'cwm'),
    };
    return { caseId, scenario, mode, strategy, disclose, fixtureSha256, effectiveFixtureSha256, fixture, servicePid: service.pid,
      parentPid: process.pid, generatedAt: new Date().toISOString(), nodeVersion: process.version,
      outcome: failure ? 'error' : !completed ? 'incomplete' : Object.values(checks).every(Boolean) ? 'pass' : 'fail',
      checks, failure, disclosure, exchanges, agent, service: snapshot,
      limitations: ['Curated metadata, not full-report retrieval or automatic provenance detection.',
        'Controlled disclosure after issuance; no Raft or distributed effect atomicity.',
        'Loopback process separation and capability authentication, not an OS security sandbox.',
        'Effect is an in-memory outbox entry, not a firewall change; ephemeral service state.',
        'HTTP durations are diagnostic observations, not a controlled performance benchmark.'] };
  } finally { await service.close(); }
}
