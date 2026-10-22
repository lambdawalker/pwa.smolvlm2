import { MODELS } from './models.js';
const CACHE='transformers-cache';
function receiptURL(key,fp16){return `https://little-lens.invalid/models/${key}/${MODELS[key].revision}/${fp16?'fp16':'fp32'}`;}
export async function recordModel(key,fp16,files){
 const cache=await caches.open(CACHE);
 const prefix=`https://huggingface.co/${MODELS[key].id}/resolve/${MODELS[key].revision}/`;
 const urls=[...new Set(files)].map(file=>prefix+file);
 if(!urls.some(url=>url.endsWith('.onnx')))throw Error('Model files could not be verified.');
 for(const url of urls)if(!await cache.match(url))throw Error('Some model files were not saved. Free browser storage and retry the download.');
 await cache.put(receiptURL(key,fp16),new Response(JSON.stringify(urls),{headers:{'Content-Type':'application/json'}}));
}
export async function availableModels(fp16){
 const result=[];
 try{const cache=await caches.open(CACHE);
 for(const key of Object.keys(MODELS)){
  const receipt=await cache.match(receiptURL(key,fp16));if(!receipt)continue;
  const urls=await receipt.json();if(!Array.isArray(urls)||!urls.length)continue;
  let complete=true;for(const url of urls)if(!await cache.match(url)){complete=false;break;}
  if(complete)result.push(key);
 }
 }catch{}
 return result;
}
export async function removeModel(key){
 const cache=await caches.open(CACHE);const prefix=`https://huggingface.co/${MODELS[key].id}/resolve/${MODELS[key].revision}/`;
 for(const request of await cache.keys())if(request.url.startsWith(prefix))await cache.delete(request);
 for(const fp16 of [true,false])await cache.delete(receiptURL(key,fp16));
}
