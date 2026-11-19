import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { concurrentTrial } from './concurrent-service.mjs';
import { caseIds } from '../demo/report-fixtures.mjs';

const output=new URL(`../results/concurrent-service/${new Date().toISOString().replaceAll(':','-')}/`,import.meta.url);
mkdirSync(output,{recursive:true});
const manifest=[];
function save(path,bytes) {
  mkdirSync(new URL('.',new URL(path,output)),{recursive:true});
  writeFileSync(new URL(path,output),bytes);
  manifest.push({path,sha256:createHash('sha256').update(bytes).digest('hex')});
}
for(const path of ['benchmark/concurrent-service.mjs','benchmark/concurrent-service-run.mjs','benchmark/concurrent-service.test.mjs','demo/agent-service.mjs','demo/agent-client.mjs','demo/report-fixtures.mjs','demo/cwm.mjs',...caseIds.map(id=>`demo/fixtures/${id.toLowerCase()}.json`)])save(`source/${path}`,readFileSync(new URL(`../${path}`,import.meta.url)));
const rows=[];
for(const caseId of caseIds)for(const strategy of ['cwm','recount'])for(const schedule of ['before','racing','after'])for(let repeat=0;repeat<3;repeat++) {
  const run=await concurrentTrial({caseId,strategy,schedule});
  save(`traces/${caseId}-${strategy}-${schedule}-${repeat}.json`,JSON.stringify(run,null,2)+'\n');
  rows.push({caseId,strategy,schedule,repeat,pass:run.pass,observedOrder:run.observedOrder,requests:run.clients,effects:run.state.outbox.length});
  if(!run.pass) throw new Error(JSON.stringify(run.checks));
}
save('results.json',JSON.stringify({node:process.version,rows},null,2)+'\n');
const racing=rows.filter(row=>row.schedule==='racing');
save('REPORT.md',`# Concurrent service requests and provenance disclosures\n\n${rows.length} trials passed, each with 16 competing HTTP action attempts: ${rows.length*16} requests. Five report-pair fixtures, two methods, three schedules, three repetitions. No LLM calls.\n\n- Before control: merge acknowledgement precedes the request burst; zero effects.\n- After control: all action responses precede the merge; exactly one effect, retained after disclosure.\n- Racing: the parent dispatches half the HTTP requests, sends the trusted IPC disclosure without awaiting it, then dispatches the rest. No sleeps or barriers prescribe which request commits first. Observed ${racing.filter(row=>row.effects===1).length} execution-before-merge and ${racing.filter(row=>row.effects===0).length} merge-without-execution trials.\n\nAll trials had at most one effect; every recorded execution preceded the support-reducing merge in the authority's ledger. HTTP responses agreed with the ledger. A no-effect racing trial alone is not evidence of handling both possible orders; the before/after controls explicitly exercise each. These repetitions are scheduling observations, not a production failure-rate estimate.\n\nThe actual HTTP and IPC channels are concurrent, but the authority serializes validation and the in-memory effect synchronously in one Node process. This does not demonstrate distributed atomicity, Raft behavior, crash recovery, durable deduplication or atomicity with an external firewall. It tests gateway concurrency, not agent reasoning or provenance inference. Raw traces contain the authoritative event order.\n`);
writeFileSync(new URL('manifest.json',output),JSON.stringify(manifest,null,2)+'\n');
console.log(`PASS ${rows.length} trials, ${rows.length*16} action requests. Results: ${fileURLToPath(output)}`);
