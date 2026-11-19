import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startActionService } from './agent-service.mjs';
import { createCompletion, endpointConfig, scriptedCompletion } from './agent-loop.mjs';
import { runAgentExperiment } from './agent-experiment.mjs';
import { p01 } from './public-report.mjs';

const ids = p01.sources.map(source => source.id);
const call = (service, name, args, headers = {}) => fetch(`${service.url}/tools`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${service.credential}`, ...headers },
  body: JSON.stringify({ name, arguments: args }),
});

test('HTTP boundary rejects unauthorized requests, browser origins, policy changes and fabricated evidence', async t => {
  const service = await startActionService();
  t.after(() => service.close());
  assert.equal((await call(service, 'read_evidence', {}, { Authorization: '' })).status, 401);
  assert.equal((await call(service, 'read_evidence', {}, { Origin: 'https://example.com' })).status, 403);
  for (const [name, args] of [
    ['merge', { sources: ids }], ['request_permission', { source_ids: ids, threshold: 1 }],
    ['request_permission', { source_ids: [ids[0], ids[0]] }], ['request_permission', { source_ids: [ids[0], 'invented'] }],
    ['attempt_action', { token_id: 'token-1', action: 'arbitrary-command' }],
  ]) assert.equal((await call(service, name, args)).status, 400);
  assert.equal((await (await call(service, 'attempt_action', { token_id: 'invented' })).json()).status, 'unknown_token');
  assert.equal(service.snapshot().outbox.length, 0);
});

test('HTTP concurrent replay creates at most one simulated effect', async t => {
  const service = await startActionService();
  t.after(() => service.close());
  const permission = await (await call(service, 'request_permission', { source_ids: ids })).json();
  const results = await Promise.all(Array.from({ length: 8 }, async () =>
    (await call(service, 'attempt_action', { token_id: permission.token_id })).json()));
  assert.equal(results.filter(result => result.final === 'executed').length, 1);
  assert.equal(results.filter(result => result.final === 'already_executed').length, 7);
  assert.equal(service.snapshot().outbox.length, 1);
});

test('merge acknowledged before HTTP attempt blocks the effect; post-effect merge cannot undo it', async t => {
  for (const before of [true, false]) {
    const service = await startActionService();
    t.after(() => service.close());
    const permission = await (await call(service, 'request_permission', { source_ids: ids })).json();
    if (before) service.disclose();
    const result = await (await call(service, 'attempt_action', { token_id: permission.token_id })).json();
    if (!before) service.disclose();
    assert.equal(result.final, before ? 'blocked' : 'executed');
    assert.equal(service.snapshot().outbox.length, before ? 0 : 1);
  }
});

test('scripted tool driver reaches separate service process for both methods and controls', async () => {
  for (const strategy of ['cwm', 'recount']) {
    for (const disclose of [true, false]) {
      const result = await runAgentExperiment({ strategy, disclose, complete: scriptedCompletion(), mode: 'scripted-test-NOT-LLM' });
      assert.equal(result.outcome, 'pass', JSON.stringify(result.checks));
      assert.notEqual(result.servicePid, result.parentPid);
      assert.equal(result.agent.toolCalls, 3);
    }
  }
});

test('a model that only narrates is incomplete, not a successful safety experiment', async () => {
  const result = await runAgentExperiment({ complete: async () => ({ message: { role: 'assistant', content: 'I blocked it.' } }) });
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.checks.toolWorkflowReachedGateway, false);
  assert.equal(result.service.outbox.length, 0);
});

test('Chat Completions wire adapter delivers real tool results and usage through a local fake-model endpoint', async t => {
  const script = scriptedCompletion();
  const received = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    received.push({ url: req.url, auth: req.headers.authorization, data });
    const next = await script(data.messages);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'fake-model-not-live', choices: [{ message: next.message }], usage: { total_tokens: 12 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const complete = createCompletion(endpointConfig({ CWM_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, CWM_LLM_MODEL: 'test-model', CWM_LLM_API_KEY: 'test-only-not-secret' }));
  const result = await runAgentExperiment({ complete, mode: 'fake-model-wire-test-NOT-LLM' });
  assert.equal(result.outcome, 'pass');
  assert.equal(received.length, 4);
  assert.ok(received.every(request => request.url === '/v1/chat/completions' && request.data.model === 'test-model' && request.auth === 'Bearer test-only-not-secret'));
  const lastTools = received.at(-1).data.messages.filter(message => message.role === 'tool');
  assert.deepEqual(lastTools.map(message => message.tool_call_id), ['call-1', 'call-2', 'call-3']);
  assert.equal(JSON.parse(lastTools.at(-1).content).final, 'blocked');
  assert.equal(result.agent.usage.reduce((sum, item) => sum + item.usage.total_tokens, 0), 48);
  assert.equal(JSON.stringify(result).includes('test-only-not-secret'), false);
});

test('configuration rejects remote plaintext and embedded credentials', () => {
  const base = { CWM_LLM_MODEL: 'gpt-4o-mini', CWM_LLM_API_KEY: 'test' };
  assert.throws(() => endpointConfig({ ...base, CWM_LLM_BASE_URL: 'http://example.com/v1' }), /HTTPS/);
  assert.throws(() => endpointConfig({ ...base, CWM_LLM_BASE_URL: 'https://user:secret@example.com/v1' }), /credentials/);
  assert.equal(endpointConfig({ ...base, CWM_LLM_BASE_URL: 'https://api.openai.com/v1' }).url, 'https://api.openai.com/v1/chat/completions');
});
