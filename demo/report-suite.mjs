// Provider-reported billed-context counts, not signed witness bytes or estimates.
export function summarizeUsage(agent) {
  const entries = agent?.usage ?? [];
  const fields = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  const complete = entries.length > 0 && entries.every(entry => fields.every(field => Number.isFinite(entry.usage?.[field])));
  return { modelRequests: entries.length, available: complete,
    ...Object.fromEntries(fields.map(field => [field, complete ? entries.reduce((sum, entry) => sum + entry.usage[field], 0) : null])),
    cachedPromptTokens: entries.length && entries.every(entry => Number.isFinite(entry.usage?.prompt_tokens_details?.cached_tokens))
      ? entries.reduce((sum, entry) => sum + entry.usage.prompt_tokens_details.cached_tokens, 0) : null };
}
