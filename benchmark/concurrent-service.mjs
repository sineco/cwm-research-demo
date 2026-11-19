import assert from 'node:assert/strict';
import { launchService } from '../demo/agent-client.mjs';
import { loadReportCase } from '../demo/report-fixtures.mjs';

// No model calls: independent HTTP requests compete with trusted-parent IPC.
// The authority still serializes state changes in a single process.
export async function concurrentTrial({ strategy, caseId, schedule, clients = 16 }) {
  assert.ok(['before', 'racing', 'after'].includes(schedule));
  const service = await launchService(strategy, { caseId, scenario: 'disclosure' });
  const { fixture } = loadReportCase(caseId);
  try {
    const permission = await service.call('request_permission', { source_ids: fixture.sources.map(source=>source.id) });
    assert.equal(permission.status,'issued');
    const attempt = () => service.call('attempt_action',{ token_id:permission.token_id });
    let disclosure, responses;
    if (schedule === 'before') {
      disclosure = await service.disclose();
      responses = await Promise.all(Array.from({length:clients},attempt));
    } else if (schedule === 'after') {
      responses = await Promise.all(Array.from({length:clients},attempt));
      disclosure = await service.disclose();
    } else {
      const requests = Array.from({length:Math.floor(clients/2)},attempt);
      const pendingDisclosure = service.disclose();
      requests.push(...Array.from({length:clients-requests.length},attempt));
      [responses, disclosure] = await Promise.all([Promise.all(requests),pendingDisclosure]);
    }
    const state = await service.snapshot();
    const merge = state.ledger.find(event=>event.type==='merge');
    const executions = state.ledger.filter(event=>event.type==='executed');
    const responseExecutions = responses.filter(result=>result.final==='executed').length;
    const checks = {
      merged: disclosure.merged === true && Boolean(merge),
      allRequestsReachedGateway: responses.length===clients && responses.every(result=>['executed','already_executed','blocked','insufficient_support'].includes(result.final)),
      atMostOneEffect: executions.length<=1 && state.outbox.length===executions.length,
      responseMatchesLedger: responseExecutions===executions.length,
      noExecutionAfterSupportLoss: executions.every(event=>event.eventNumber<merge?.eventNumber),
      controlOutcome: schedule==='racing' || executions.length===(schedule==='before'?0:1),
      partition: new Set(state.partition.map(item=>item.root)).size===1,
      separateProcess: service.pid!==process.pid,
    };
    return { strategy,caseId,schedule,clients,checks,pass:Object.values(checks).every(Boolean),
      observedOrder:executions.length?'execution_before_merge':'merge_without_execution',
      responses,disclosure,state };
  } finally { await service.close(); }
}
