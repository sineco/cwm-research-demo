import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { measureTokenCase } from './token-cost.mjs';

const protocol = { roots: [3, 8, 32, 128, 512], sourcesPerOrigin: [1, 4], batches: 20, iterations: 50, warmup: 100 };
const output = new URL(`../results/token-cost/${new Date().toISOString().replaceAll(':', '-')}/`, import.meta.url);
mkdirSync(output, { recursive: true });
const sources = ['demo/cwm.mjs', 'benchmark/token-cost.mjs', 'benchmark/token-cost-run.mjs'].map(path => {
  const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
  const target = new URL(`source/${path}`, output); mkdirSync(new URL('.', target), { recursive: true }); writeFileSync(target, bytes);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const results = [];
for (const rootCount of protocol.roots) for (const multiplier of protocol.sourcesPerOrigin) {
  results.push(measureTokenCase(rootCount, multiplier, protocol));
  console.log(`Measured ${rootCount} origins / ${rootCount * multiplier} sources.`);
}
const metadata = { node: process.version, platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem() };
writeFileSync(new URL('results.json', output), JSON.stringify({ metadata, protocol, sources, results }, null, 2) + '\n');
const csv = ['origins,sources,token_bytes,operation,median_batch_mean_us,min_batch_mean_us,max_batch_mean_us'];
for (const row of results) for (const [name, stats] of Object.entries(row.measurements)) csv.push([row.originCount, row.sourceCount, row.tokenBytes, name, stats.medianBatchMeanUs, stats.minBatchMeanUs, stats.maxBatchMeanUs].join(','));
writeFileSync(new URL('SUMMARY.csv', output), csv.join('\n') + '\n');
const table = results.map(row => `| ${row.originCount} | ${row.sourceCount} | ${row.tokenBytes} | ${row.measurements.sign_preencoded_payload.medianBatchMeanUs.toFixed(2)} | ${row.measurements.verify_preencoded_payload.medianBatchMeanUs.toFixed(2)} | ${row.measurements.cwm_inspect_current.medianBatchMeanUs.toFixed(2)} | ${row.measurements.recount_inspect_current.medianBatchMeanUs.toFixed(2)} |`).join('\n');
writeFileSync(new URL('REPORT.md', output), `# Signed-witness cost microbenchmark\n\nSynthetic fixed-length source IDs, 3–512 current roots, and one or four source IDs per root. Every decision meets a threshold of three; no merges occur in measured inspection paths. Each operation has 100 warmups and 20 batches of 50 operations. Columns report median batch-mean microseconds per operation, **not individual-request percentiles**. All raw batch means are retained in results.json.\n\n| Origins | Sources | Token bytes | Sign preencoded (µs) | Verify preencoded (µs) | CWM full inspect (µs) | Recount full inspect (µs) |\n| --- | --- | --- | --- | --- | --- | --- |\n${table}\n\n## Measurement scope\n\n- Token size is compact UTF-8 JSON for the initial token, including payload and base64 signature. Ed25519 signatures are 64 raw bytes (88 base64 bytes). Root IDs and epochs dominate growth. Premerging extra sources changes epoch/index values, so equally sized root sets need not have exactly identical byte counts.\n- Serialization measures JSON conversion plus Buffer allocation. Signing and verification components use preencoded payloads; they exclude encoding. Full inspect includes real signature verification, binding comparisons and current-state checks. Recount uses the same signed-token contract. Issuance includes root resolution, payload construction, encoding, signing, base64 conversion and in-memory audit append.\n- Key generation, fixture construction, premerges and between-batch ledger cleanup are excluded. Automatic garbage collection during timed loops is included. JIT, CPU scheduling and thermal effects remain uncontrolled. Operation order rotates by batch; configuration order is fixed. The empty-loop control is reported without subtracting it.\n- Components overlap with composite operations and must not be added to estimate total latency. All operations are in one local process; no network, disk durability, LLM, Raft, queueing, concurrent load, or external action is measured.\n- Repeated measurements of a fixed synthetic token are not a general deployment ranking. This is a descriptive pilot from one process on one machine, not replicated independent benchmark trials. Microsecond differences should not be promoted into a universal fastest claim.\n\n## Reproducibility\n\nNode ${metadata.node}; ${metadata.platform}/${metadata.arch}; CPU ${metadata.cpu}. Source snapshots, SHA-256 hashes, settings and raw batches accompany this report. The source snapshots contain no private keys; keys are ephemeral and generated in memory. Reruns use a new timestamped directory.\n`);
console.log(`Report: ${new URL('REPORT.md', output).pathname}`);
