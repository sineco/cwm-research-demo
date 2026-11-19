import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

if(process.argv.length<3)throw new Error('Pass one or more tradeoff or concurrent-service result directories');
for(const dir of process.argv.slice(2)) {
  const read=path=>JSON.parse(readFileSync(join(dir,path),'utf8'));
  const manifest=read('manifest.json');
  for(const item of manifest)assert.equal(createHash('sha256').update(readFileSync(join(dir,item.path))).digest('hex'),item.sha256,item.path);
  const data=read('results.json');
  if(data.metadata) {
    const {metadata,rows}=data;
    assert.equal(rows.length,metadata.configs.length*metadata.seeds.length*metadata.methods.length);
    for(const config of metadata.configs)for(const seed of metadata.seeds) {
      const group=rows.filter(row=>row.workload===config.name&&row.seed===seed);
      assert.equal(group.length,metadata.methods.length);
      assert.equal(new Set(group.map(row=>row.method)).size,metadata.methods.length);
      assert.equal(new Set(group.map(row=>row.workloadSha256)).size,1);
      for(const compact of group.filter(row=>row.method.endsWith('-compact'))) {
        const full=group.find(row=>row.method===compact.method.replace('-compact',''));
        assert.ok(full);
        assert.ok(compact.initialTokenBytes<full.initialTokenBytes);
        assert.equal(compact.metrics.sourceLookups,full.metrics.sourceLookups);
        assert.equal(compact.metrics.verifications,full.metrics.verifications);
        assert.equal(compact.metrics.signatures,full.metrics.signatures);
        assert.equal(compact.initialIndexEdges,full.initialIndexEdges);
      }
      const early=group.find(row=>row.method==='recount-early');
      if(early) {
        const full=group.find(row=>row.method==='recount-compact');
        assert.equal(early.initialTokenBytes,full.initialTokenBytes);
        assert.ok(early.metrics.sourceLookups<=full.metrics.sourceLookups);
        assert.equal(early.metrics.verifications,full.metrics.verifications);
        if(config.blocked)assert.equal(early.metrics.sourceLookups,full.metrics.sourceLookups);
      }
      for(const row of group) {
        const relevant=Math.round(metadata.count*config.fanout);
        const renewals=config.blocked || config.updates===false ? 0 : row.method==='global' ? metadata.count*config.rounds : ['cwm','dependency-witness'].includes(row.method) ? relevant*config.rounds : 0;
        assert.equal(row.renewals,renewals);
        assert.equal(row.metrics.signatures,renewals);
        assert.equal(row.executed,config.blocked ? 0 : metadata.count);
        assert.equal(row.inspections,metadata.count*config.rounds*config.checks);
        assert.ok(Math.abs(row.maintenanceMs-row.updateMs-row.checkMs-row.actionMs)<1e-7);
        assert.ok(row.pendingHeapBytes>0);
      }
    }
  } else {
    assert.equal(data.rows.length,90);
    for(const row of data.rows) {
      const trace=read(`traces/${row.caseId}-${row.strategy}-${row.schedule}-${row.repeat}.json`);
      assert.equal(trace.responses.length,16);
      assert.ok(trace.pass);
      assert.equal(trace.state.outbox.length,row.effects);
      const merge=trace.state.ledger.find(event=>event.type==='merge');
      const executions=trace.state.ledger.filter(event=>event.type==='executed');
      assert.ok(merge);
      assert.ok(executions.length<=1);
      assert.ok(executions.every(event=>event.eventNumber<merge.eventNumber));
      assert.equal(executions.length,trace.responses.filter(response=>response.final==='executed').length);
    }
  }
  console.log(`Verified ${dir}: ${manifest.length} file hashes, ${data.rows.length} result rows and consistency/oracle checks.`);
}
