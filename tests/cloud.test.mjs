import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCloud } from '../src/cloud.js';
test('cloud errors preserve diagnostic codes and upstream finish reason',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'Output was truncated',code:'OUTPUT_TRUNCATED',providerStatus:200,finishReason:'MAX_TOKENS'}),{status:502});
  await assert.rejects(classifyCloud('image','prompt'),error=>error.status===502&&error.providerStatus===200&&error.code==='OUTPUT_TRUNCATED'&&error.finishReason==='MAX_TOKENS');
  globalThis.fetch=async()=>new Response('Bad Gateway',{status:502});
  await assert.rejects(classifyCloud('image','prompt'),error=>error.status===502&&error.code==='INVALID_API_RESPONSE');
 }finally{globalThis.fetch=original;}
});
