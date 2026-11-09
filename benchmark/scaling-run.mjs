import { performance } from 'node:perf_hooks';
import { cpus, platform, arch, loadavg } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createModel } from './dependency-index.mjs';
import { shuffle } from './workloads.mjs';

export const configs = [
  { name: 'disjoint_4_sparse', shared: false, width: 4, affected: .01, rounds: 1 },
  { name: 'disjoint_32_sparse', shared: false, width: 32, affected: .01, rounds: 1 },
  { name: 'hub_1pct', shared: true, width: 4, affected: .01, rounds: 1 },
  { name: 'hub_100pct', shared: true, width: 4, affected: 1, rounds: 1 },
  { name: 'hub_16_rounds', shared: true, width: 4, affected: 1, rounds: 16 },
];
export const methods = ['cwm', 'dependency-witness', 'dependency'];
const hash = x => createHash('sha256').update(x).digest('hex');
const q = (a,p) => a[Math.max(0,Math.ceil(a.length*p)-1)];

export function workload(config, count, seed) {
  const sources = new Set(), affected = Math.round(count*config.affected);
  const decisions = shuffle(Array.from({length:count}, (_,i) => {
    const prefix = config.shared && i<affected ? 'hub' : `d${i}`;
    const ids = Array.from({length:config.width},(_,j)=>`${prefix}-s${j}`);
    ids.forEach(s=>sources.add(s));
    return {id:`d${i}`, sources:ids, threshold:3, action:{type:'outbox',claimId:`claim-${i}`}, affected:i<affected};
  }),seed);
  const rounds=[];
  for(let r=0;r<config.rounds;r++) {
    const merges = r===0 ? (config.shared ? [['hub-s0','hub-s1']] : decisions.filter(d=>d.affected).map(d=>[d.sources[0],d.sources[1]])) : [['hub-s0',`external-${r}`]];
    merges.flat().forEach(s=>sources.add(s));
    rounds.push({merges, decisions:decisions.slice(Math.floor(r*count/config.rounds),Math.floor((r+1)*count/config.rounds))});
  }
  return {config,count,seed,sources:[...sources],decisions,rounds};
}

export function trial(w, method, measure=true) {
  if(measure && !global.gc) throw new Error('Use --expose-gc for retained-heap measurements');
  const checkpoints=[];
  const checkpoint = phase => {
    if(!measure)return {heapUsed:0};
    global.gc();global.gc();
    const m=process.memoryUsage();checkpoints.push({phase,...m});return m;
  };
  const baseline=checkpoint('baseline');
  let start=performance.now();const model=createModel(w.sources,method);
  const constructMs=performance.now()-start;
  start=performance.now();
  for(const d of w.decisions)model.register(d.id,d.sources,d.threshold,d.action);
  const registrationMs=performance.now()-start;
  const registered=checkpoint('registered');
  const tokens=new Map();start=performance.now();
  for(const d of w.decisions) {const t=model.issue(d.id);assert.ok(t);tokens.set(d.id,t);}
  const issuanceMs=performance.now()-start;
  const pending=checkpoint('pending');const initialIndexEdges=model.edges??0;
  model.resetMetrics();
  const updateLatencies=[], actionLatencies=[];let updateMs=0,actionMs=0,executed=0,replacements=0,checks=0;
  for(let r=0;r<w.rounds.length;r++) {
    const round=w.rounds[r];
    for(const pair of round.merges) {start=performance.now();const changed=model.merge(...pair);const elapsed=performance.now()-start;updateMs+=elapsed;updateLatencies.push(elapsed*1000);assert.ok(changed);}
    checkpoint(`round_${r}_updated`);
    for(const d of round.decisions) {
      start=performance.now();const result=model.attempt(tokens.get(d.id),d.action);const elapsed=performance.now()-start;
      actionMs+=elapsed;actionLatencies.push(elapsed*1000);
      // Analytic oracle: each affected support loses exactly one origin in round 0;
      // subsequent merges add an external origin without further reducing support.
      assert.equal(result.final,'executed');
      assert.equal(result.initial,method!=='dependency'&&d.affected?'stale':'executed');
      assert.equal(!!result.replacement,method!=='dependency'&&d.affected);
      executed++;replacements+=Number(!!result.replacement);checks++;
    }
    checkpoint(`round_${r}_executed`);
  }
  assert.equal(model.outbox.length,w.count);assert.equal(model.metrics.signatures,replacements);
  assert.equal(model.metrics.reattestations,replacements);assert.equal(model.edges??0,0);
  const final=checkpoint('final');
  actionLatencies.sort((a,b)=>a-b);updateLatencies.sort((a,b)=>a-b);
  // Keep all measured state live through the final checkpoint.
  assert.equal(tokens.size,w.count);assert.equal(model.decisions.size,w.count);
  return {method,count:w.count,seed:w.seed,workload:w.config.name,width:w.config.width,rounds:w.config.rounds,
    constructMs,registrationMs,issuanceMs,setupMs:constructMs+registrationMs+issuanceMs,
    updateMs,actionMs,maintenanceMs:updateMs+actionMs,lifecycleMs:constructMs+registrationMs+issuanceMs+updateMs+actionMs,
    p50ActionUs:q(actionLatencies,.5),p95ActionUs:q(actionLatencies,.95),p99ActionUs:q(actionLatencies,.99),
    p95UpdateUs:q(updateLatencies,.95),updateCount:updateLatencies.length,
    registeredHeapBytes:registered.heapUsed-baseline.heapUsed,pendingHeapBytes:pending.heapUsed-baseline.heapUsed,
    finalHeapBytes:final.heapUsed-baseline.heapUsed,peakRssKiB:measure?process.resourceUsage().maxRSS:0,
    pendingRssBytes:pending.rss??0,baselineRssBytes:baseline.rss??0,initialIndexEdges,
    dependencyVisits:model.metrics.dependencyVisits??0,executed,replacements,oracleChecks:checks,
    checkpoints,metrics:{...model.metrics}};
}

function main() {
  if(process.argv[2]==='--worker') {
    const {config,count,seed,method}=JSON.parse(process.argv[3]);
    trial(workload(config,200,101),method,false);
    const w=workload(config,count,seed);const traceHash=hash(JSON.stringify(w));
    console.log(JSON.stringify({...trial(w,method),traceHash}));return;
  }
  const smoke=process.argv.includes('--smoke');const output=smoke?'results/scaling-smoke':'results/scaling';
  if(existsSync(`${output}/benchmark.json`))throw new Error(`Refusing to overwrite ${output}`);
  mkdirSync(output,{recursive:true});
  const counts=smoke?[100]:[1000,5000,20000],seeds=smoke?[11]:[11,29,47];
  const paths=['benchmark/scaling-run.mjs','benchmark/scaling-run.test.mjs','benchmark/dependency-index.mjs','benchmark/workloads.mjs','demo/cwm.mjs'];
  const buffers=Object.fromEntries(paths.map(p=>[p,readFileSync(p)]));const sourceHashes=Object.fromEntries(paths.map(p=>[p,hash(buffers[p])]));
  const metadata={startedAt:new Date().toISOString(),node:process.version,cpu:cpus()[0].model,cores:cpus().length,platform:platform(),arch:arch(),startLoad:loadavg(),counts,seeds,methods,configs,sourceHashes,gitHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),smoke};
  writeFileSync(`${output}/protocol.json`,JSON.stringify(metadata,null,2));
  const rows=[];let block=0;
  for(const count of counts)for(const config of configs)for(const seed of seeds) {
    for(let position=0;position<methods.length;position++) {
      const method=methods[(position+block)%methods.length];
      const run=spawnSync(process.execPath,['--expose-gc',new URL(import.meta.url).pathname,'--worker',JSON.stringify({config,count,seed,method})],{encoding:'utf8',maxBuffer:8*1024*1024});
      if(run.status!==0)throw new Error(run.stderr||run.stdout);
      rows.push({...JSON.parse(run.stdout),position});
      writeFileSync(`${output}/progress.json`,JSON.stringify({metadata,rows},null,2));
      console.log(`${rows.length}/${counts.length*configs.length*seeds.length*methods.length} ${config.name} N=${count} seed=${seed} ${method}`);
    }block++;
  }
  for(const p of paths)assert.equal(hash(readFileSync(p)),sourceHashes[p],'Source changed during measurement');
  metadata.finishedAt=new Date().toISOString();metadata.endLoad=loadavg();
  writeFileSync(`${output}/benchmark.json`,JSON.stringify({metadata,rows},null,2)+'\n');
  const fields=Object.keys(rows[0]).filter(k=>!['checkpoints','metrics'].includes(k));
  writeFileSync(`${output}/benchmark.csv`,fields.join(',')+'\n'+rows.map(r=>fields.map(k=>r[k]).join(',')).join('\n')+'\n');
  for(const p of paths){mkdirSync(`${output}/source/${p.slice(0,p.lastIndexOf('/'))}`,{recursive:true});writeFileSync(`${output}/source/${p}`,buffers[p]);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
