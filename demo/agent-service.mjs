import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CWM } from './cwm.mjs';
import { loadReportCase } from './report-fixtures.mjs';

export const toolDefinitions = [
  { type: 'function', function: { name: 'read_evidence', description: 'Read the curated case evidence metadata and fixed experimental action. This is not live retrieval.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } },
  { type: 'function', function: { name: 'request_permission', description: 'Request a signed permission for the fixed sandbox action using all returned evidence IDs. The manager owns the threshold and partition.', parameters: { type: 'object', properties: { source_ids: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 } }, required: ['source_ids'], additionalProperties: false } } },
  { type: 'function', function: { name: 'attempt_action', description: 'Submit the returned token ID to the gateway. It revalidates current provenance and may reject or re-attest. The effect is only an in-memory sandbox outbox entry.', parameters: { type: 'object', properties: { token_id: { type: 'string' } }, required: ['token_id'], additionalProperties: false } } },
];

const objectWithKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export async function startActionService({ strategy = 'cwm', credential = randomBytes(32).toString('hex'), beforeAttempt = null, caseId = 'P01', scenario = 'disclosure' } = {}) {
  if (!['cwm', 'recount'].includes(strategy)) throw new Error('Unsupported strategy');
  const { fixture } = loadReportCase(caseId, scenario);
  const decisionId = `${caseId.toLowerCase()}-agent-decision`;
  const ids = fixture.sources.map(source => source.id);
  const model = new CWM(ids, { strategy });
  model.register(decisionId, ids, fixture.threshold, fixture.action);
  let issuedToken = null;
  const calls = [];
  const send = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    // No browser-origin access, CORS, public listener, filesystem or shell tool.
    if (req.headers.origin) return send(res, 403, { error: 'browser_origin_denied' });
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${credential}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST' || req.url !== '/tools') return send(res, 404, { error: 'not_found' });
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 415, { error: 'json_required' });
    let body;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) { send(res, 413, { error: 'body_too_large' }); req.resume(); return; }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return send(res, 400, { error: 'invalid_json' }); }
    if (!objectWithKeys(body, ['name', 'arguments'])) return send(res, 400, { error: 'invalid_tool_request' });
    const args = body.arguments;
    let result;
    // All authority checks and the simulated effect below are synchronous.
    // A merge can occur before or after this handler, not inside model.attempt().
    if (body.name === 'read_evidence' && objectWithKeys(args, [])) {
      result = { caseId: fixture.caseId, claim: fixture.claim, sources: fixture.sources,
        threshold: fixture.threshold, action: fixture.action, review: fixture.review, limitations: fixture.limitations, scope: 'curated metadata; experimental partition; simulated effect' };
    } else if (body.name === 'request_permission' && objectWithKeys(args, ['source_ids'])
      && Array.isArray(args.source_ids) && args.source_ids.length === ids.length
      && new Set(args.source_ids).size === ids.length && ids.every(id => args.source_ids.includes(id))) {
      if (model.decisions.get(decisionId).executed) result = { status: 'already_executed' };
      else {
        issuedToken ??= model.issue(decisionId);
        result = issuedToken ? { status: 'issued', token_id: issuedToken.payload.tokenId,
          witness_bytes: Buffer.byteLength(JSON.stringify(issuedToken)), threshold: fixture.threshold,
          notice: 'Issuance is not execution permission forever. The gateway rechecks on every attempt.' }
          : { status: 'insufficient_support' };
      }
    } else if (body.name === 'attempt_action' && objectWithKeys(args, ['token_id']) && typeof args.token_id === 'string') {
      if (!issuedToken || args.token_id !== issuedToken.payload.tokenId) result = { status: 'unknown_token' };
      else {
        // Optional trusted test barrier BEFORE authoritative validation. No HTTP
        // route or model tool can install this hook; normal service has no await here.
        if (beforeAttempt) await beforeAttempt();
        const attempt = model.attempt(issuedToken, fixture.action);
        result = { initial: attempt.initial, final: attempt.final,
          replacement_token_id: attempt.replacement?.payload.tokenId ?? null,
          effect: attempt.final === 'executed' ? 'simulated_outbox_entry' : 'none',
          outbox_count: model.outbox.length };
      }
    } else return send(res, 400, { error: 'unknown_tool_or_invalid_arguments' });
    calls.push({ sequence: calls.length + 1, name: body.name, arguments: args, result });
    send(res, 200, result);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    credential,
    disclose: () => ({ merged: model.merge(...fixture.disclosure.merge), stateIndex: model.index }),
    snapshot: () => structuredClone({ strategy, partition: model.snapshot(), calls, ledger: model.ledger,
      outbox: model.outbox, metrics: model.metrics, originalToken: issuedToken }),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

// Only the trusted parent harness can inject the annotation or inspect state.
// These administrative commands have no HTTP routes or model tools.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const service = await startActionService({ strategy: process.env.CWM_SERVICE_STRATEGY, caseId: process.env.CWM_SERVICE_CASE, scenario: process.env.CWM_SERVICE_SCENARIO });
  process.on('message', message => {
    if (message?.command === 'disclose') process.send?.({ id: message.id, data: service.disclose() });
    else if (message?.command === 'snapshot') process.send?.({ id: message.id, data: service.snapshot() });
  });
  process.once('disconnect', async () => { await service.close(); process.exit(0); });
  process.send?.({ ready: true, url: service.url, credential: service.credential, pid: process.pid });
}
