import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const caseIds = ['P01', 'P02', 'P03', 'P04', 'P05'];
export const scenarios = ['control', 'disclosure', 'recovery'];
export function loadReportCase(caseId = 'P01', scenario = 'disclosure') {
  if (!caseIds.includes(caseId) || !scenarios.includes(scenario)) throw new Error('Unknown case or scenario');
  const bytes = readFileSync(new URL(`./fixtures/${caseId.toLowerCase()}.json`, import.meta.url));
  const fixture = JSON.parse(bytes);
  if (scenario === 'recovery') {
    fixture.sources.push({ id: `${caseId.toLowerCase()}-synthetic-extra`, publisher: 'CONSTRUCTED TEST SOURCE',
      synthetic: true, evidenceSummary: 'Assumed additional independent support for this claim solely to exercise renewal. No real report or independent investigation has been verified.' });
    fixture.limitations.push('Recovery is a hybrid control: two public-report items plus one explicitly synthetic independent source; three initial origins become two at threshold two.');
  }
  return { fixture, fixtureSha256: createHash('sha256').update(bytes).digest('hex'),
    effectiveFixtureSha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex') };
}
