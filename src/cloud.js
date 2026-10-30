import {authorizedFetch} from './account.js';
export const CLOUD_MODEL='gemma-cloud';
export const CLOUD_INFO={label:'Gemma 4 E2B · Amazon Bedrock',download:'No model download',hint:'Requires internet. Prepared photos and your prompt are processed by Amazon Bedrock.'};
export const CLOUD_PRECISION='Precision: AWS-managed (not disclosed)';
export async function cloudAvailable(){
 try{const response=await fetch('/api/cloud',{cache:'no-store',signal:AbortSignal.timeout(5000)});return response.ok&&(await response.json()).enabled===true;}catch{return false;}
}
export async function classifyCloud(image,prompt,signal){
 const response=await authorizedFetch('/api/classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,prompt,consent:true}),signal});
 let result;try{result=await response.json();}catch{const error=new Error('Cloud service returned an invalid response. Reload or retry later.');error.status=response.status;error.code='INVALID_API_RESPONSE';throw error;}
 if(!response.ok){const error=new Error(result.error||'Cloud classification failed. Retry later.');error.status=response.status;error.code=result.code;error.providerStatus=result.providerStatus;error.finishReason=result.finishReason;throw error;}
 if(typeof result.text!=='string'||!result.text.trim())throw new Error('Cloud model returned an empty answer.');
 return result.text;
}

// Remove retired browser model weights; app shells are managed by Workbox.
if(globalThis.caches?.keys)globalThis.caches.keys().then(names=>Promise.all(names.filter(name=>name==='transformers-cache').map(name=>globalThis.caches.delete(name)))).catch(()=>{});
