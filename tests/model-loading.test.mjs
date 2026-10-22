import test from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../node_modules/@huggingface/transformers/src/env.js';
import { getModelFile } from '../node_modules/@huggingface/transformers/src/utils/hub.js';
import { configureModelLoading } from '../src/model-loading.js';
test('real Transformers.js cache-only loading reads cached files and never fetches misses',async()=>{
 const originalFetch=globalThis.fetch;let network=0;
 globalThis.fetch=async()=>{network++;throw Error('Unexpected network request');};
 try{
  env.useCustomCache=true;env.useBrowserCache=false;env.useFSCache=false;
  env.customCache={match:async key=>String(key)==='https://huggingface.co/test/model/resolve/pinned/config.json'?new Response('{"model_type":"smolvlm"}'):undefined,put:async()=>{}};
  configureModelLoading(env,true);
  const data=await getModelFile('test/model','config.json',true,{revision:'pinned',local_files_only:true});
  assert.equal(JSON.parse(new TextDecoder().decode(data)).model_type,'smolvlm');
  assert.equal(await getModelFile('test/model','optional.json',false,{revision:'pinned',local_files_only:true}),null);
  await assert.rejects(getModelFile('test/model','missing.onnx',true,{revision:'pinned',local_files_only:true}),/not found locally/);
  assert.equal(network,0);
  configureModelLoading(env,false);assert.equal(env.allowLocalModels,false);assert.equal(env.allowRemoteModels,true);
 }finally{globalThis.fetch=originalFetch;delete globalThis.__littleLensLocalFetch;}
});
