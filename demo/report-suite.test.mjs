import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReportCase, caseIds, scenarios } from './report-fixtures.mjs';
import { runAgentExperiment } from './agent-experiment.mjs';
import { scriptedCompletion } from './agent-loop.mjs';
import { summarizeUsage } from './report-suite.mjs';

test('fixture selection preserves review caveats and separates constructed recovery support', () => {
  for (const id of caseIds) {
    const base = loadReportCase(id);
    const recovery = loadReportCase(id, 'recovery');
    assert.equal(base.fixture.sources.length, 2);
    assert.equal(recovery.fixture.sources.length, 3);
    assert.equal(recovery.fixture.sources[2].synthetic, true);
    assert.equal(base.fixtureSha256, recovery.fixtureSha256);
    assert.notEqual(base.effectiveFixtureSha256, recovery.effectiveFixtureSha256);
    assert.equal(base.fixture.review.reviewer, id === 'P01' ? 'author' : 'Codex (AI-assisted review)');
  }
  assert.throws(() => loadReportCase('../secret'));
  assert.throws(() => loadReportCase('P01', 'unknown'));
  assert.match(loadReportCase('P04').fixture.limitations.join(' '), /12 extension IDs/);
});

test('all five cases block, execute controls and recover through a separate HTTP service', async () => {
  for (const caseId of caseIds) for (const scenario of scenarios) for (const strategy of ['cwm', 'recount']) {
    const run = await runAgentExperiment({ caseId, scenario, strategy, complete: scriptedCompletion(), mode: 'scripted-test-NOT-LLM' });
    assert.equal(run.outcome, 'pass', `${caseId}/${scenario}/${strategy}: ${JSON.stringify(run.checks)}`);
    assert.notEqual(run.servicePid, run.parentPid);
    assert.equal(run.service.outbox.length, scenario === 'disclosure' ? 0 : 1);
    assert.equal(run.agent.toolCalls, 3);
    if (scenario === 'recovery' && strategy === 'cwm') {
      const replacement = run.service.ledger.find(event => event.type === 'renewed');
      assert.ok(replacement, JSON.stringify(run.service.ledger));
    }
  }
});

test('usage accounting preserves missing values and includes repeated input and cached tokens', () => {
  assert.equal(summarizeUsage(null).total_tokens, null);
  assert.equal(summarizeUsage({ usage: [{ usage: null }] }).total_tokens, null);
  const usage = summarizeUsage({ usage: Array(4).fill({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 50 } } }) });
  assert.equal(usage.total_tokens, 480);
  assert.equal(usage.prompt_tokens, 400);
  assert.equal(usage.cachedPromptTokens, 200);
});
