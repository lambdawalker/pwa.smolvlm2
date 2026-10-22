// Limit transfers until their response bodies finish, not just until headers arrive.
export function createDownloadFetch(fetchImpl,{sizes=new Map(),progress=()=>{},limit=3}={}){
 let active=0,timer;const queue=[];
 function schedule(){if(!timer)timer=setTimeout(()=>{timer=null;pump();},0);}
 function pump(){
  queue.sort((a,b)=>(sizes.get(a.url)??Infinity)-(sizes.get(b.url)??Infinity));
  while(active<limit&&queue.length){const job=queue.shift();active++;transfer(job);}
 }
 async function transfer({url,args,resolve,reject}){
  let released=false;const release=()=>{if(!released){released=true;active--;schedule();}};
  const emit=(status,loaded=0,total=sizes.get(url))=>progress({file:url,status,loaded,total,progress:total?loaded/total*100:undefined});
  try{
   emit('download');const response=await fetchImpl(...args);
   if(!response.ok||!response.body){await response.body?.cancel();emit(response.status===404?'unavailable':response.ok?'done':'error');release();resolve(new Response(null,{status:response.status,statusText:response.statusText,headers:response.headers}));return;}
   const reader=response.body.getReader();const total=sizes.get(url)||Number(response.headers.get('content-length'))||undefined;let loaded=0,last=0;
   const body=new ReadableStream({
    async pull(controller){try{const {done,value}=await reader.read();if(done){emit('done',loaded,total);release();controller.close();return;}loaded+=value.byteLength;const now=Date.now();if(now-last>100){emit('progress',loaded,total);last=now;}controller.enqueue(value);}catch(error){emit('error',loaded,total);release();controller.error(error);}},
    async cancel(reason){try{await reader.cancel(reason);}finally{release();}},
   });
   resolve(new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers}));
  }catch(error){emit('error');release();reject(error);}
 }
 return (...args)=>{const input=args[0];const url=typeof input==='string'?input:input.url||String(input);progress({file:url,status:'queued',loaded:0,total:sizes.get(url)});return new Promise((resolve,reject)=>{queue.push({url,args,resolve,reject});schedule();});};
}

export async function installModelDownloads(selected,progress){
 const original=globalThis.fetch.bind(globalThis);const prefix=`https://huggingface.co/${selected.id}/resolve/${selected.revision}/`;const sizes=new Map();
 // Metadata is optional: cached/offline use and loading must work without the Hub API.
 try{
  const url=`https://huggingface.co/api/models/${selected.id}/revision/${selected.revision}?blobs=true`;
  const response=await original(url,{signal:AbortSignal.timeout(8000)});
  if(response.ok){const metadata=await response.json();for(const file of metadata.siblings||[])if(Number.isFinite(file.size))sizes.set(prefix+file.rfilename,file.size);}
 }catch{}
 const queued=createDownloadFetch(original,{sizes,progress,limit:3});
 globalThis.fetch=(input,...rest)=>{const url=typeof input==='string'?input:input.url||String(input);return url.startsWith(prefix)?queued(input,...rest):original(input,...rest);};
}
