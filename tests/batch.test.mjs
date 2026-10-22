import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCategory, runBatch } from '../src/batch-core.js';
test('only an unambiguous category is accepted',()=>{
 assert.equal(parseCategory('  "Computer screens". '),'Computer screens');
 assert.equal(parseCategory('INDOORS'),'Indoors');
 for(const answer of ['Indoors or Outdoors','This is outdoors','', 'Documents\nIndoors'])assert.equal(parseCategory(answer),null);
});
test('batch is sequential, preserves completed items, and continues after a bad file',async()=>{
 const items=[{state:'done'},{state:'pending',id:1},{state:'pending',id:2}];let active=0,max=0;
 await runBatch(items,async item=>{active++;max=Math.max(max,active);await Promise.resolve();active--;if(item.id===1)throw Error('Bad photo');return 'Outdoors';},()=>{},()=>false);
 assert.equal(max,1);assert.equal(items[0].state,'done');assert.equal(items[1].state,'error');assert.equal(items[2].category,'Outdoors');
});
test('cancellation ignores late results and leaves unfinished photos pending',async()=>{
 const items=[{state:'pending'},{state:'pending'}];let cancelled=false;
 await runBatch(items,async()=>{cancelled=true;return 'Documents';},()=>{},()=>cancelled);
 assert.equal(items[0].state,'pending');assert.equal(items[1].state,'pending');assert.equal(items[0].category,undefined);
});
