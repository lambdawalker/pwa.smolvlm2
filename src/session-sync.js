import {authorizedFetch} from './account.js';
const sessionVersions=new Map();
export async function sessionAPI(path='',method='GET',body,{conditional=false}={}){
 const headers={'Content-Type':'application/json'},version=sessionVersions.get(path);
 if(conditional&&version&&Date.now()-version.time<600000)headers['If-None-Match']=version.etag;
 const response=await authorizedFetch('/api/sessions'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
 if(response.status===304)return {unchanged:true};
 let data;try{data=await response.json();}catch{throw Error('Session service returned an invalid response.');}
 if(!response.ok){const error=new Error(data.error||'Could not sync session.');error.status=response.status;throw error;}
 const etag=response.headers?.get('etag');if(method==='GET'&&etag)sessionVersions.set(path,{etag,time:Date.now()});
 return data;
}
export async function imageData(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error('Could not load a session photo. Refresh and retry.');const blob=await r.blob();return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('Could not read photo.'));reader.readAsDataURL(blob);});}
export async function uploadPhoto(session,file,photo){const start=await sessionAPI(`/${session}/photos`,'POST',{mime:file.type||'image/jpeg',bytes:file.size});try{const prepared=await (await fetch(photo.url)).blob();for(const [url,body,type] of [[start.originalUploadUrl,file,file.type||'image/jpeg'],[start.preparedUploadUrl,prepared,'image/jpeg']]){const response=await fetch(url,{method:'PUT',headers:{'Content-Type':type},body});if(!response.ok)throw Error('Photo upload failed. Retry on a stable connection.');}return await sessionAPI(`/${session}/photos/${start.photo.id}`,'PATCH',{revision:start.photo.revision,state:'pending'});}catch(error){try{await sessionAPI(`/${session}/photos/${start.photo.id}`,'DELETE',{permanent:true});}catch{}throw error;}}
export async function savePhoto(session,item,changes){
 if(!item.remoteId||item.shredded)return;
 item.dirty=true;
 const payload={revision:item.revision,state:item.state,category:item.category||'',description:item.description||'',rawOutput:item.rawOutput||'',...changes};
 try{for(let attempt=0;attempt<2;attempt++){
  try{const saved=await sessionAPI(`/${session}/photos/${item.remoteId}`,'PATCH',payload);
   Object.assign(item,{revision:saved.revision,state:saved.state,category:saved.category,description:saved.description,rawOutput:saved.rawOutput,conflict:!!saved.conflict,expiresAt:saved.expiresAt});
   item.error=saved.conflict?'Conflicting changes from another device. Choose a category to keep this photo.':'';return saved;
  }catch(error){
   if(error.status===404){item.shredded=true;return;}
   if(error.status===409){const latest=await sessionAPI('/'+session);if(!latest.photos.some(photo=>photo.id===item.remoteId&&photo.state!=='shredded')){item.shredded=true;return;}if(attempt===0)continue;item.state='review';item.error='This photo changed on another device. Review its category.';}
   throw error;
  }
 }}finally{item.dirty=false;}
}
export async function mergePhotos(existing,photos,{knownAtStart}={}){
 const byId=new Map(existing.map(item=>[item.remoteId,item])),seen=new Set(),result=[];
 for(const photo of photos){if(photo.state==='shredded'){const removed=byId.get(photo.id);if(removed)removed.shredded=true;continue;}seen.add(photo.id);let item=byId.get(photo.id);
 if(photo.state==='uploading'){if(item)result.push(item);continue;}
 if(!item)item={remoteId:photo.id,file:{name:photo.id,type:photo.mime,size:photo.bytes}};
 if(item.reprocess&&(photo.state==='trash'||photo.conflict)&&photo.revision>=item.revision)delete item.reprocess;
 if(!item.dirty&&!item.reprocess&&item.state!=='processing'&&(!item.revision||photo.revision>=item.revision))Object.assign(item,{revision:photo.revision,state:photo.state,category:photo.category,description:photo.description,rawOutput:photo.rawOutput,conflict:!!photo.conflict,expiresAt:photo.expiresAt,error:photo.conflict?'Conflicting changes from another device. Choose a category to keep this photo.':''});
 item.preparedUrl=photo.preparedUrl;item.thumbnail=item.exportImage||photo.preparedUrl;item.originalUrl=photo.originalUrl;result.push(item);
 }
 for(const item of existing){if(!item.remoteId){result.push(item);continue;}if(!seen.has(item.remoteId)){if(!item.shredded&&knownAtStart&&!knownAtStart.has(item.remoteId))result.push(item);else item.shredded=true;}}
 return result;
}

export async function deleteSharedSession(id,api=sessionAPI){
 for(;;){try{const result=await api('/'+id,'DELETE');if(result.deleted===true)return;if(result.deleting!==true)throw Error('Session service returned an invalid response.');}catch(error){if(error.status===404)return;throw error;}}
}
