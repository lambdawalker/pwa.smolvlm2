import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCategory, parseResult, runBatch } from '../src/batch-core.js';
test('only an unambiguous category is accepted',()=>{
 assert.equal(parseCategory('  "Computer screens". '),'Computer screens');
 assert.equal(parseCategory('INDOORS'),'Indoors');
 for(const answer of ['Indoors or Outdoors','This is outdoors','', 'Documents\nIndoors'])assert.equal(parseCategory(answer),null);
});
test('batch is sequential, preserves completed items, and continues after a bad file',async()=>{
 const items=[{state:'done'},{state:'pending',id:1},{state:'pending',id:2}];let active=0,max=0;
 await runBatch(items,async item=>{active++;max=Math.max(max,active);await Promise.resolve();active--;if(item.id===1)throw Error('Bad photo');return JSON.stringify({category:'Outdoors',description:'A yard.'});},()=>{},()=>false);
 assert.equal(max,1);assert.equal(items[0].state,'done');assert.equal(items[1].state,'error');assert.equal(items[2].category,'Outdoors');
});
test('cancellation ignores late results and leaves unfinished photos pending',async()=>{
 const items=[{state:'pending'},{state:'pending'}];let cancelled=false;
 await runBatch(items,async()=>{cancelled=true;return 'Documents';},()=>{},()=>cancelled);
 assert.equal(items[0].state,'pending');assert.equal(items[1].state,'pending');assert.equal(items[0].category,undefined);
});

test('structured classification validates both fields and caps description',()=>{
 assert.deepEqual(parseResult('{"category":"Indoors","description":"A room."}'),{category:'Indoors',description:'A room.'});
 for(const value of ['Indoors','{}','{"category":"Other","description":"x"}','{"category":"Indoors"}'])assert.equal(parseResult(value),null);
 assert.equal(parseResult(JSON.stringify({category:'Documents',description:'x'.repeat(300)})).description.length,180);
});
test('batch respects concurrency and pauses scheduling after a provider failure',async()=>{
 const items=Array.from({length:6},()=>({state:'pending'}));let active=0,max=0,calls=0;const releases=[];
 const run=runBatch(items,async()=>{calls++;active++;max=Math.max(max,active);await new Promise(resolve=>releases.push(resolve));active--;return '{"category":"Indoors","description":"Room"}';},()=>{},()=>false,3);
 assert.equal(calls,3);releases.splice(0).forEach(resolve=>resolve());await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,6);releases.splice(0).forEach(resolve=>resolve());await run;assert.equal(max,3);assert.equal(items.filter(i=>i.state==='done').length,6);
 const paused=Array.from({length:5},()=>({state:'pending'}));calls=0;
 await runBatch(paused,async()=>{calls++;const error=new Error('quota');error.pauseBatch=true;throw error;},()=>{},()=>false,2);
 assert.equal(calls,2);assert.equal(paused.filter(i=>i.state==='pending').length,3);
});
