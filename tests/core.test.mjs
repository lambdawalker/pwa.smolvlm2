import test from 'node:test';
import assert from 'node:assert/strict';
import { fitDimensions, validatePhoto, friendlyError } from '../src/core.js';
test('large landscape and portrait photos stay inside memory budget',()=>{assert.deepEqual(fitDimensions(6000,4000),{width:768,height:512});assert.deepEqual(fitDimensions(3000,6000),{width:384,height:768});});
test('small photos are not upscaled and invalid dimensions are rejected',()=>{assert.deepEqual(fitDimensions(200,100),{width:200,height:100});assert.throws(()=>fitDimensions(0,100));assert.throws(()=>fitDimensions(NaN,100));});
test('reject oversized and non-image files but allow unknown MIME from mobile pickers',()=>{assert.throws(()=>validatePhoto({size:31*1024*1024,type:'image/jpeg'}));assert.throws(()=>validatePhoto({size:2,type:'text/plain'}));assert.doesNotThrow(()=>validatePhoto({size:10,type:''}));});
test('memory and network failures explain recovery',()=>{assert.match(friendlyError('buffer size allocation failed'),/Close other tabs/);assert.match(friendlyError('Failed to fetch'),/Connect to the internet/);});

// Custom prompts are trimmed and bounded before starting the worker.
 test('custom prompts reject empty and oversized input',async()=>{
 const {resolvePrompt,PROMPTS}=await import('../src/core.js');
 assert.equal(resolvePrompt('brief'),PROMPTS.brief);
 assert.equal(resolvePrompt('custom','  Describe the sky.  '),'Describe the sky.');
 assert.throws(()=>resolvePrompt('custom','   '));
 assert.throws(()=>resolvePrompt('custom','x'.repeat(1001)));
 });
