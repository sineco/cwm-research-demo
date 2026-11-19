import assert from 'node:assert/strict';
import { CWM } from '../demo/cwm.mjs';
import { p01 } from '../demo/public-report.mjs';
import { startActionService } from '../demo/agent-service.mjs';

function barrier() {
  let signal, resume;
  const entered = new Promise(resolve => { signal = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  return { entered, resume, wait: async () => { signal(); await released; } };
}

async function httpCase(strategy, schedule) {
  const gate = barrier();
  const service = await startActionService({ strategy, beforeAttempt: schedule === 'request_in_flight' ? gate.wait : null });
  const events = [];
  const call = async (name, args) => {
    const response = await fetch(`${service.url}/tools`, { method: 'POST',
      headers: { Authorization: `Bearer ${service.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const result = await response.json(); events.push({ event: name, result }); return result;
  };
  const merge = () => events.push({ event: 'merge_acknowledged', ...service.disclose() });
  try {
    if (schedule === 'before_issuance') merge();
    const permission = await call('request_permission', { source_ids: p01.sources.map(source => source.id) });
    let result = null;
    if (permission.token_id) {
      if (schedule === 'after_issuance') merge();
      if (schedule === 'request_in_flight') {
        const pending = call('attempt_action', { token_id: permission.token_id });
        // The HTTP body has reached the service. Pause at an explicit barrier,
        // rather than relying on a sleep to guess which request ran first.
        await Promise.race([gate.entered, pending.then(() => { throw new Error('Request bypassed test barrier'); })]);
        events.push({ event: 'attempt_paused_before_authoritative_validation' });
        merge(); gate.resume(); result = await pending;
      } else result = await call('attempt_action', { token_id: permission.token_id });
      if (schedule === 'after_commit') merge();
    }
    const snapshot = service.snapshot();
    const expectedEffects = schedule === 'after_commit' ? 1 : 0;
    const expectedFinal = schedule === 'before_issuance' ? 'insufficient_support'
      : schedule === 'after_commit' ? 'executed' : strategy === 'cwm' ? 'blocked' : 'insufficient_support';
    const actualFinal = result?.final ?? permission.status;
    const checks = { expectedFinal: actualFinal === expectedFinal,
      effectCount: snapshot.outbox.length === expectedEffects,
      singleCurrentOrigin: new Set(snapshot.partition.map(item => item.root)).size === 1,
      noPrematureEffect: schedule === 'after_commit' || !snapshot.ledger.some(item => item.type === 'executed') };
    return { name: `http_${schedule}`, strategy, kind: 'real_loopback_http_simulated_effect', checks,
      pass: Object.values(checks).every(Boolean), events, snapshot };
  } finally { gate.resume(); await service.close(); }
}

async function preflightCase(strategy, unsafe) {
  const model = new CWM(['A', 'B', 'C'], { strategy });
  const action = { type: 'synthetic_effect', claimId: 'race-control' };
  model.register('d', ['A', 'B', 'C'], 3, action);
  const token = model.issue('d');
  const gate = barrier();
  let cached;
  const pending = (async () => {
    cached = model.inspect(token, action);
    await gate.wait();
    if (unsafe) {
      // Deliberately broken comparator, confined to this experimental harness.
      // A caller trusts a cached approval across an asynchronous boundary.
      if (cached.status === 'current') model.outbox.push(action);
      return { final: model.outbox.length ? 'executed_from_cached_approval' : 'blocked' };
    }
    return model.attempt(token, action);
  })();
  await gate.entered;
  model.merge('A', 'B'); gate.resume();
  const result = await pending;
  const expectedEffects = unsafe ? 1 : 0;
  const checks = { preflightInitiallyAllowed: cached.status === 'current',
    originsBelowThreshold: new Set(model.snapshot().map(item => item.root)).size === 2,
    expectedEffects: model.outbox.length === expectedEffects,
    expectedOutcome: result.final === (unsafe ? 'executed_from_cached_approval' : strategy === 'cwm' ? 'blocked' : 'insufficient_support') };
  return { name: unsafe ? 'unsafe_cached_preflight_control' : 'revalidate_after_preflight', strategy,
    kind: 'synthetic_in_process_barrier', unsafeControl: unsafe, expectedUnsafeEffect: unsafe,
    pass: Object.values(checks).every(Boolean), checks, result, ledger: model.ledger, outbox: model.outbox };
}

async function renewalCase() {
  const model = new CWM(['A', 'B', 'C', 'D']);
  const action = { type: 'synthetic_effect', claimId: 'renewal-race-control' };
  model.register('d', ['A', 'B', 'C', 'D'], 3, action);
  const old = model.issue('d'); model.merge('A', 'B');
  const renewed = model.reattest(old);
  assert.equal(renewed.status, 'renewed');
  const gate = barrier();
  const pending = (async () => { await gate.wait(); return model.attempt(renewed.token, action); })();
  await gate.entered; model.merge('C', 'D'); gate.resume();
  const result = await pending;
  const checks = { renewalHadEnoughSupport: renewed.after === 3,
    renewedTokenBecomesStale: result.initial === 'stale',
    blockedAfterSecondMerge: result.final === 'blocked' && model.outbox.length === 0,
    currentCountTwo: new Set(model.snapshot().map(item => item.root)).size === 2 };
  return { name: 'merge_after_renewal_before_commit', strategy: 'cwm', kind: 'synthetic_in_process_barrier',
    pass: Object.values(checks).every(Boolean), checks, result, ledger: model.ledger, outbox: model.outbox };
}

export async function runBoundarySuite() {
  const cases = [];
  for (const strategy of ['cwm', 'recount']) {
    for (const schedule of ['before_issuance', 'after_issuance', 'request_in_flight', 'after_commit']) cases.push(await httpCase(strategy, schedule));
    cases.push(await preflightCase(strategy, false));
    cases.push(await preflightCase(strategy, true));
  }
  cases.push(await renewalCase());
  return cases;
}
