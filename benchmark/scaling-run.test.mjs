import test from 'node:test';
import assert from 'node:assert/strict';
import { configs, workload, methods, trial } from './scaling-run.mjs';
import { expectedEvents } from './spectrum-workloads.mjs';

for(const config of configs) test(`Scaling analytic oracle agrees with explicit labels: ${config.name}`,()=>{
  const w=workload(config,100,29);
  const events=w.rounds.flatMap(r=>[...r.merges.map(pair=>({type:'merge',pair,accepted:true,truth:true})),...r.decisions.map(d=>({type:'execute',id:d.id}))]);
  const expected=expectedEvents({...w,setupMerges:[],events});
  const byId=new Map(w.decisions.map(d=>[d.id,d]));
  for(let i=0;i<events.length;i++)if(events[i].type==='execute') {
    assert.equal(expected[i].accepted,true);
    assert.equal(expected[i].changedAt>0,byId.get(events[i].id).affected);
  }
  for(const method of methods){const r=trial(w,method,false);assert.equal(r.executed,100);assert.equal(r.replacements,method==='dependency'?0:Math.round(100*config.affected));}
});
