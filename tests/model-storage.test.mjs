import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS } from '../src/models.js';
import { recordModel,availableModels,removeModel } from '../src/model-storage.js';
test('availability requires a successful receipt and every cached file for the matching device variant',async()=>{
 const entries=new Map();const keyOf=x=>typeof x==='string'?x:x.url;
 const cache={match:async key=>entries.get(keyOf(key))?.clone(),put:async(key,response)=>entries.set(keyOf(key),response.clone()),delete:async key=>entries.delete(keyOf(key)),keys:async()=>[...entries.keys()].map(url=>({url}))};
 const previous=globalThis.caches;globalThis.caches={open:async()=>cache};
 try{
 const model=MODELS['256m'];const prefix=`https://huggingface.co/${model.id}/resolve/${model.revision}/`;
 await cache.put(prefix+'config.json',new Response('{}'));await assert.rejects(recordModel('256m',true,['config.json','onnx/model.onnx']));assert.deepEqual(await availableModels(true),[]);
 await cache.put(prefix+'onnx/model.onnx',new Response('weights'));await recordModel('256m',true,['config.json','onnx/model.onnx']);assert.deepEqual(await availableModels(true),['256m']);assert.deepEqual(await availableModels(false),[]);
 await cache.delete(prefix+'config.json');assert.deepEqual(await availableModels(true),[]);
 await removeModel('256m');assert.equal(entries.size,0);
 }finally{globalThis.caches=previous;}
});
