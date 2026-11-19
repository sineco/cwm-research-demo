import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, platform, arch, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configs, quietConfig, earlyConfigs, methods, makeWorkload, trial } from './tradeoff.mjs';
import { compactMethods, earlyMethod } from './compact-permit.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
if (process.argv[2] === '--worker') {
  const { config, count, seed, method } = JSON.parse(process.argv[3]);
  trial(makeWorkload(config, 20, 101), method, false);
  const w = makeWorkload(config, count, seed);
  const workloadSha256 = hash(JSON.stringify(w));
  console.log(JSON.stringify({ ...trial(w, method), workloadSha256 }));
} else {
  const smoke = process.argv.includes('--smoke');
  const quiet = process.argv.includes('--quiet');
  const early = process.argv.includes('--early');
  const compact = early || process.argv.includes('--compact');
  const activeMethods = early ? [...methods,...compactMethods,earlyMethod] : compact ? [...methods,...compactMethods] : methods;
  const activeConfigs = early ? earlyConfigs : quiet ? [quietConfig] : compact ? [...configs,quietConfig] : configs;
  const output = new URL(`../results/tradeoff/${new Date().toISOString().replaceAll(':','-')}${smoke ? '-smoke' : early ? '-early' : compact ? '-compact' : quiet ? '-quiet' : ''}/`, import.meta.url);
  mkdirSync(output, { recursive: true });
  const metadata = { startedAt: new Date().toISOString(), node: process.version, cpu: cpus()[0].model, platform: platform(), arch: arch(), startLoad: loadavg(), count: smoke ? 20 : 500, seeds: smoke ? [11] : [11,29,47], methods: activeMethods, configs: activeConfigs, smoke };
  const manifest = [];
  function save(path, bytes) {
    mkdirSync(new URL('.', new URL(path, output)), { recursive: true });
    writeFileSync(new URL(path, output), bytes); manifest.push({ path, sha256: hash(bytes) });
  }
  const paths = ['benchmark/early-exit.test.mjs','benchmark/compact-permit.mjs','benchmark/compact-permit.test.mjs','benchmark/tradeoff.mjs','benchmark/tradeoff-run.mjs','benchmark/tradeoff.test.mjs','benchmark/dependency-index.mjs','benchmark/workloads.mjs','demo/cwm.mjs','package.json'];
  const source = paths.map(path => ({ path, bytes: readFileSync(new URL(`../${path}`, import.meta.url)) }));
  for (const { path, bytes } of source) save(`source/${path}`, bytes);
  save('protocol.json', JSON.stringify(metadata,null,2)+'\n');
  const rows = []; let block = 0;
  for (const config of activeConfigs) for (const seed of metadata.seeds) {
    for (let offset=0; offset<activeMethods.length; offset++) {
      const method = activeMethods[(block+offset)%activeMethods.length];
      const result = spawnSync(process.execPath, ['--expose-gc',fileURLToPath(import.meta.url),'--worker',JSON.stringify({ config, count: metadata.count, seed, method })], { encoding:'utf8', maxBuffer: 8*1024*1024 });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      rows.push({ ...JSON.parse(result.stdout), order: offset });
      save('results.json', JSON.stringify({ metadata, rows },null,2)+'\n');
      console.log(`${rows.length}/${activeConfigs.length*metadata.seeds.length*activeMethods.length} ${config.name} ${seed} ${method}`);
    }
    block++;
  }
  for (const { path, bytes } of source) if (hash(bytes)!==hash(readFileSync(new URL(`../${path}`,import.meta.url)))) throw new Error(`Source changed during run: ${path}`);
  metadata.finishedAt = new Date().toISOString(); metadata.endLoad = loadavg();
  save('results.json',JSON.stringify({metadata,rows},null,2)+'\n');
  const fields = Object.keys(rows[0]).filter(key => !['checkpoints','metrics'].includes(key));
  save('SUMMARY.csv',fields.join(',')+'\n'+rows.map(row=>fields.map(key=>row[key]).join(',')).join('\n')+'\n');
  const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const table = [];
  for (const config of activeConfigs) for (const method of activeMethods) {
    const group=rows.filter(row=>row.workload===config.name&&row.method===method);
    const time=group.map(row=>row.maintenanceMs);
    table.push(`| ${config.name} | ${method} | ${(median(group.map(row=>row.pendingHeapBytes))/2**20).toFixed(2)} | ${median(time).toFixed(1)} [${Math.min(...time).toFixed(1)}, ${Math.max(...time).toFixed(1)}] | ${median(group.map(row=>row.lifecycleMs)).toFixed(1)} | ${group[0].renewals} |`);
  }
  save('REPORT.md',`# Matched memory–time trade-off experiment\n\n${rows.length} fresh-process trials; ${metadata.count} decisions per trial; seeds ${metadata.seeds.join(', ')}; ${metadata.node}, ${metadata.cpu}. All analytical outcome assertions passed.\n\n| Workload | Method | Pending heap MiB (median) | Maintenance ms median [min, max] | Lifecycle ms median | Renewals |\n|---|---|---:|---:|---:|---:|\n${table.join('\n')}\n\n## Protocol and limitations\n\n- recount-early uses a compact permit and stops resolving sources once the threshold is met, both at issuance and inspection. Audit records a lower bound when counting stops early. Additional workloads vary source order, threshold and support loss.\n- Compact variants omit witness roots/epochs/index/linkage from signed permits while retaining the same current-eligibility algorithms. This is a token-format ablation, not a claim to optimize every baseline. Raw rows include total and mean serialized initial token bytes.\n- Each method receives identical source IDs, premerges, decisions and update/check schedules within each workload/seed. Fresh processes, 20-decision warmup, rotating method order. Three seeds/orderings are not statistical confidence bounds.\n- Pending heap is post-GC increase above the workload-only baseline, including authority, registry, signed tokens and issuance audit. Explicit GC checkpoints are outside measured intervals; automatic GC is included. Process peak RSS includes input and warmup, so it is not incremental method memory.\n- Maintenance includes merges, repeated permission inspections with lazy renewal and one final execution per decision. Inspections are preflight/status checks, not repeated uses of a one-shot action. Setup and complete lifecycle timings are separately retained.\n- Sources per origin are premerged before issuance. Preprocessing audit is cleared for every method; subsequent audit is retained. After-check/final heap, audit events, source lookups, dependency visits and signatures are in raw results.\n- Threshold is three except the high-threshold supplement (32). Relevant first merge reduces origins by one; later churn merges absorb an external origin and change epochs without further reducing support. The support_loss supplement starts eligible then blocks all decisions after a merge; it measures one final attempt and no preflight checks. Other decisions remain eligible. Blocking correctness is covered by other tests, not this performance workload.\n- Recount and dependency maintain current eligibility; CWM and dependency-witness require fresh affected witnesses, while global refreshes after any merge. These are different contracts. Compare both resource costs and guarantees; do not call the cheapest eligibility checker a drop-in fresh-witness substitute.\n- Synthetic local in-memory workloads, single host, no HTTP, durable audit, consensus or LLM. Shared fanout uses identical source sets, which also changes registry size across workloads; compare methods within a workload. No claim of universal optimality or production latency.\n`);
  writeFileSync(new URL('manifest.json',output),JSON.stringify([...new Map(manifest.map(item=>[item.path,item])).values()],null,2)+'\n');
  console.log(`Results: ${fileURLToPath(output)}`);
}
