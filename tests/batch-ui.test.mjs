import { defaults } from '../src/defaults.generated.js';
import { getLanguage, languagePrompt, t } from '../src/i18n.js';
import test from 'node:test';
import { appendPhotoDetails as renderPhotoDetails } from '../src/photo-details.js';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { CATEGORIES,CATEGORY_PROMPT,runBatch,parseResult } from '../src/batch-core.js';
import { resolvePrompt } from '../src/core.js';
import { CLOUD_MODEL,CLOUD_INFO,CLOUD_PRECISION } from '../src/cloud.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function app(supported=true,installed=[],cloud=true,cloudClassify=async()=>'{"category":"Indoors","description":"A room."}',auto=false,mobile=false,shared=null){
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const source=readFileSync(new URL('../src/batch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',"'https://example.test/src/batch.js'");
 const element=()=>({children:[],append(...children){this.children.push(...children);},replaceChildren(){this.children=[];},addEventListener(name,handler){this.events??={};this.events[name]=handler;},showModal(){this.open=true;},close(){this.open=false;this.events?.close?.();},removeAttribute(){},setAttribute(name,value){this.attrs??={};this.attrs[name]=value;},click(){this.onclick?.();},getContext(){return {drawImage(){}};},toDataURL(){return 'data:thumb';}});
 const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,element()]));
 const originalFiles=[],revoked=[];class PhotoURL extends URL{static createObjectURL(file){originalFiles.push(file);return 'blob:original';}static revokeObjectURL(url){revoked.push(url);}}
 const events={};const workers=[];class Worker{constructor(){throw Error('Local model workers are no longer supported');}postMessage(data){this.sent.push(data);}terminate(){this.stopped=true;}}
 vm.runInNewContext('"use strict";\n'+source,{...(shared||{}),setInterval:()=>0,parseResult,defaults,getLanguage,languagePrompt,t,appendPhotoDetails:(container,item,label,cloud)=>renderPhotoDetails(container,item,label,cloud,{createElement:element}),CLOUD_MODEL,CLOUD_INFO,CLOUD_PRECISION,cloudAvailable:async()=>cloud,classifyCloud:cloudClassify,AbortController,setTimeout,clearTimeout,sha256:async()=> '123456789abc'+'0'.repeat(52),HASH_LABEL_LENGTH:12,precisionLabel:()=> 'precision',imageInfoLabel:()=> 'image info',logEvent(){},installDiagnostics(){},watchOperation:()=>({touch(){},stop(){}}),availableModels:async()=>installed,resolvePrompt,createDownloadView:()=>({reset(){},update(){}}),document:{getElementById:id=>{assert.ok(elements[id],id);return elements[id];},createElement:element},Worker,URL:PhotoURL,CATEGORIES,CATEGORY_PROMPT,runBatch,DEFAULT_MODEL:'256m',friendlyError:x=>x,preparePhoto:async()=>({url:'data:photo',width:10,height:10}),Image:class{async decode(){}},navigator:{gpu:{requestAdapter:async()=>supported?{}:null}},window:{location:shared?.pageLocation,matchMedia:()=>({matches:mobile}),addEventListener(name,handler){events[name]=handler;}},registerSW:()=>()=>{}});
 await tick();elements['image-concurrency'].value='1';if(!auto)elements['auto-categorize'].checked=false;return {e:elements,w:workers,originalFiles,revoked,events};
}
test('cloud quota failure pauses batch and keeps remaining photos pending',async()=>{
 let calls=0;const {e}=await app(false,[],true,async()=>{calls++;const error=new Error('Free quota reached');error.status=429;throw error;});
 e['cloud-consent'].checked=true;e.photos.onchange({target:{files:[{name:'a.jpg'},{name:'b.jpg'}]}});await e.start.onclick();
 assert.equal(calls,1);assert.match(e.status.textContent,/quota/);assert.match(e.summary.textContent,/1 of 2 processed/);assert.equal(e.retry.hidden,false);
});
test('stopping cloud aborts request and leaves photo pending',async()=>{
 let aborted=false;const {e}=await app(false,[],true,async(image,prompt,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));})));
 e['cloud-consent'].checked=true;e.photos.onchange({target:{files:[{name:'a.jpg'}]}});const run=e.start.onclick();await tick();e.cancel.onclick();await run;assert.equal(aborted,true);assert.match(e.summary.textContent,/0 of 1 processed/);
});

test('document settings opens as a floating panel and closes independently',async()=>{
 const {e}=await app();e['document-settings-panel'].hidden=true;
 e['document-settings'].onclick();assert.equal(e['document-settings-panel'].hidden,false);
 e['close-document-settings'].onclick();assert.equal(e['document-settings-panel'].hidden,true);
 e['document-settings'].onclick();e['document-settings'].onclick();assert.equal(e['document-settings-panel'].hidden,true);
});
test('parallel cloud requests all abort from the unified cancel button',async()=>{
 const signals=[];const {e}=await app(false,[],true,async(image,prompt,signal)=>{signals.push(signal);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError'))));});
 e['image-concurrency'].value='3';e.photos.onchange({target:{files:[{name:'a.jpg'},{name:'b.jpg'},{name:'c.jpg'},{name:'d.jpg'}]}});const run=e.start.onclick();await tick();
 assert.equal(signals.length,3);e.pick.onclick();await run;assert.ok(signals.every(signal=>signal.aborted));assert.match(e.summary.textContent,/0 of 4 processed/);
});

test('signed-in sessions sync uploads and classifications between two devices',async()=>{
 const records=[];let nextId=0;
 const shared={authConfig:async()=>({enabled:true}),credentials:()=>({access:'token'}),signOut(){},
  sessionAPI:async(path='',method='GET',body)=>{if(path==='')return {sessions:[{id:'session',name:'Site visit'}]};if(path==='/session')return {photos:records.map(p=>({...p}))};if(method==='DELETE'){const index=records.findIndex(p=>path.endsWith('/'+p.id));records.splice(index,1);return {deleted:true};}throw Error('unexpected '+path);},
  uploadPhoto:async(session,file)=>{const photo={id:String(++nextId),revision:2,state:'pending',mime:file.type,bytes:file.size,originalUrl:'original'};records.push(photo);return photo;},
  mergePhotos:async(existing,photos)=>photos.map(photo=>({...existing.find(i=>i.remoteId===photo.id),remoteId:photo.id,revision:photo.revision,state:photo.state,category:photo.category,description:photo.description,rawOutput:photo.rawOutput,file:{name:photo.id,type:photo.mime,size:photo.bytes},thumbnail:'data:photo',exportImage:'data:photo'})),
  savePhoto:async(session,item,changes)=>{const photo=records.find(p=>p.id===item.remoteId);assert.equal(photo.revision,item.revision);Object.assign(photo,changes);photo.revision++;Object.assign(item,photo);item.remoteId=photo.id;return photo;}
 };
 const phone=await app(false,[],true,async()=>' ',false,false,shared);assert.equal(phone.e['sessions-panel'].hidden,false);assert.equal(phone.e['session-select'].children[0].textContent,'Site visit');
 await phone.e.photos.onchange({target:{files:[{name:'phone.jpg',size:123,type:'image/jpeg'}]}});assert.equal(records.length,1);assert.equal(records[0].state,'pending');
 const laptop=await app(false,[],true,async()=>'{"category":"Outdoors","description":"A tree."}',false,false,shared);assert.match(laptop.e.summary.textContent,/0 of 1 processed/);await laptop.e.start.onclick();assert.equal(records[0].state,'done');assert.equal(records[0].description,'A tree.');assert.equal(laptop.e['export-document'].disabled,false);
 const reopenedPhone=await app(false,[],true,async()=>' ',false,false,shared);assert.match(reopenedPhone.e.summary.textContent,/1 of 1 processed \| 1 categorized/);assert.equal(reopenedPhone.e['export-document'].disabled,false);
 const remove=reopenedPhone.e.groups.children[0].children[1].children[0].children.find(c=>c.className?.includes('remove-photo'));await remove.onclick();assert.equal(records[0].state,'trash');const trash=reopenedPhone.e.groups.children.find(section=>section.children[0].textContent.startsWith('Trash'));await trash.children[1].children[0].children.find(c=>c.className?.includes('remove-photo')).onclick();assert.equal(records.length,0);
});

test('opening a session link selects it; remote renames and deletions update the picker',async()=>{
 const sessions=[{id:'a',name:'First'},{id:'b',name:'Second'}];
 const shared={pageLocation:{href:'https://audit.example/?session=b'},authConfig:async()=>({enabled:true}),credentials:()=>({}),signOut(){},sessionAPI:async path=>!path?{sessions:sessions.map(s=>({...s}))}:{photos:[]},mergePhotos:async()=>[]};
 const {e,events}=await app(false,[],true,undefined,false,false,shared);assert.equal(e['session-select'].value,'b');sessions[1].name='Renamed';await events.focus();assert.equal(e['session-select'].children[1].textContent,'Second');assert.equal(e['sync-cloud'].attrs['data-updates'],'true');await e['sync-cloud'].onclick();assert.equal(e['session-select'].children[1].textContent,'Renamed');
 sessions.pop();await events.focus();await e['sync-cloud'].onclick();assert.equal(e['session-select'].value,'a');sessions.pop();await events.focus();await e['sync-cloud'].onclick();assert.equal(e.pick.disabled,true);assert.equal(e['session-select'].children.length,0);
 sessions.push({id:'c',name:'New from laptop'});await events.focus();await e['sync-cloud'].onclick();assert.equal(e['session-select'].value,'c');assert.equal(e.pick.disabled,false);
});

test('an empty account waits for an explicit session instead of recreating a deleted one',async()=>{
 const calls=[];const shared={authConfig:async()=>({enabled:true}),credentials:()=>({}),signOut(){},sessionAPI:async(path='',method='GET')=>{calls.push(method);return {sessions:[]}},mergePhotos:async()=>[]};
 const {e}=await app(false,[],true,undefined,false,false,shared);assert.equal(e.pick.disabled,true);assert.equal(e['session-select'].children.length,0);assert.ok(calls.every(method=>method==='GET'));assert.match(e['session-status'].textContent,/Create one/);
});

test('returning from the photo picker cannot start a sync that drops selected photos',async()=>{
 let listingCalls=0,uploads=0;
 const shared={authConfig:async()=>({enabled:true}),credentials:()=>({}),signOut(){},sessionAPI:async path=>{if(!path){listingCalls++;return {sessions:[{id:'s',name:'Visit'}]}}return {photos:[]}},mergePhotos:async()=>[],uploadPhoto:async()=>{uploads++;return {id:'p',revision:2}}};
 const {e,events}=await app(false,[],true,undefined,false,false,shared);const before=listingCalls;e.pick.onclick();await events.focus();assert.equal(listingCalls,before);await e.photos.onchange({target:{files:[{name:'photo.jpg',size:100,type:'image/jpeg'}]}});assert.equal(uploads,1);assert.match(e.summary.textContent,/of 1 processed/);
});

test('selected photos are visible while cloud upload is still pending',async()=>{
 let finish;const shared={authConfig:async()=>({enabled:true}),credentials:()=>({}),signOut(){},sessionAPI:async path=>!path?{sessions:[{id:'s',name:'Visit'}]}:{photos:[]},mergePhotos:async()=>[],uploadPhoto:()=>new Promise(resolve=>{finish=resolve})};
 const {e}=await app(false,[],true,undefined,false,false,shared);const uploading=e.photos.onchange({target:{files:[{name:'photo.jpg',size:100,type:'image/jpeg'}]}});await tick();assert.equal(e.groups.children[0].children[1].children.length,1);const card=e.groups.children[0].children[1].children[0];assert.ok(card.children.some(child=>child.className==='open-original'));assert.ok(card.children.some(child=>child.textContent==='Uploading'));finish({id:'p',revision:2});await uploading;assert.ok(e.groups.children[0].children[1].children[0].children.some(child=>child.textContent==='Uploaded'));
});

test('a pending poll leaves controls enabled and accepts newly selected files',async()=>{
 let delay=false,finish;const records=[];
 const shared={authConfig:async()=>({enabled:true}),credentials:()=>({}),signOut(){},sessionAPI:async path=>{if(!path){if(delay)await new Promise(resolve=>{finish=resolve});return {sessions:[{id:'s',name:'Visit'}]}}return {photos:records}},mergePhotos:async(existing)=>existing,uploadPhoto:async()=>({id:'p',revision:2})};
 const {e,events}=await app(false,[],true,undefined,false,false,shared);delay=true;const poll=events.focus();await tick();assert.equal(e.pick.disabled,false);assert.equal(e['session-select'].disabled,false);assert.equal(e['new-session'].disabled,false);
 await e.photos.onchange({target:{files:[{name:'new.jpg',size:50,type:'image/jpeg'}]}});assert.match(e.summary.textContent,/of 1 processed/);delay=false;finish();await poll;assert.match(e.summary.textContent,/of 1 processed/);
});

test('an unchanged poll does not rebuild photo cards or disturb their controls',async()=>{
 const shared={authConfig:async()=>({enabled:true}),credentials:()=>({}),signOut(){},sessionAPI:async path=>!path?{sessions:[{id:'s',name:'Visit'}]}:{photos:[]},mergePhotos:async existing=>existing.length?existing:[{remoteId:'p',revision:1,state:'done',category:'Indoors',file:{},thumbnail:'data:photo',exportImage:'data:photo'}]};
 const {e,events}=await app(false,[],true,undefined,false,false,shared);const section=e.groups.children[0];await events.focus();assert.equal(e.groups.children[0],section);assert.equal(e['session-select'].disabled,false);
});

test('cloud-only categorization needs no WebGPU and preserves consent, raw output and view controls',async()=>{
 let calls=0;const {e,w}=await app(false,[],true,async()=>{calls++;return '{"category":"Documents","description":"A page."}'});
 assert.match(e['cloud-model-label'].textContent,/Amazon Bedrock/);e.photos.onchange({target:{files:[{name:'page.jpg'}]}});e['cloud-consent'].checked=false;e['cloud-consent'].onchange();await e.start.onclick();assert.equal(calls,0);
 e['cloud-consent'].checked=true;e['cloud-consent'].onchange();await e.start.onclick();assert.equal(w.length,0);assert.match(e.summary.textContent,/1 of 1 processed/);e['view-toggle'].onclick();assert.match(e.groups.className,/list-view/);e['view-toggle'].onclick();assert.equal(e.groups.className.includes('list-view'),false);
});
test('cloud prompt validation and automatic cancellation keep unfinished photos',async()=>{
 const signals=[];const {e}=await app(false,[],true,async(image,prompt,signal)=>{signals.push(signal);assert.match(prompt,/Pick a category/);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError'))));},true);
 e['category-prompt'].value='Pick a category';const selecting=e.photos.onchange({target:{files:[{name:'photo.jpg'}]}});await tick();assert.equal(signals.length,1);e.pick.onclick();await tick();assert.equal(signals[0].aborted,true);await selecting;assert.match(e.summary.textContent,/0 of 1 processed/);
});
test('cloud image preview opens the original and Trash can restore or shred it',async()=>{
 const {e,originalFiles}=await app();const file={name:'source.jpg'};await e.photos.onchange({target:{files:[file]}});await e.start.onclick();const card=()=>e.groups.children[0].children[1].children[0];await card().children.find(c=>c.className==='open-original').onclick();assert.equal(originalFiles.at(-1),file);e['close-original'].onclick();await card().children[0].onclick();assert.match(e.groups.children[0].children[0].textContent,/Trash/);const select=card().children[1].children[0];select.value='Indoors';await select.onchange();assert.match(e.groups.children[0].children[0].textContent,/Indoors/);await card().children[0].onclick();await card().children[0].onclick();assert.equal(e.groups.children.length,0);
});
test('cloud category carousel wraps on mobile and vertical scrolling does not change categories',async()=>{
 let i=0;const {e}=await app(false,[],true,async()=>JSON.stringify({category:i++?'Outdoors':'Indoors',description:'A scene.'}),false,true);await e.photos.onchange({target:{files:[{name:'a.jpg'},{name:'b.jpg'}]}});await e.start.onclick();
 const gesture=(x,y)=>{e['categorize-page'].events.touchstart({touches:[{clientX:150,clientY:100}],target:{closest:()=>null}});e['categorize-page'].events.touchend({changedTouches:[{clientX:x,clientY:y}]})};const active=()=>e.groups.children.findIndex(p=>p.className.includes('active-category'));assert.equal(active(),0);gesture(40,105);assert.equal(active(),1);gesture(40,105);assert.equal(active(),0);gesture(155,260);assert.equal(active(),0);
});

test('retry keeps failed upload cards in place and categorizes recovered photos in manual mode',async()=>{
 let attempts=0,calls=0,finish;
 const shared={authConfig:async()=>({enabled:true}),credentials:()=>({}),signOut(){},sessionAPI:async path=>!path?{sessions:[{id:'s',name:'Visit'}]}:{photos:[]},mergePhotos:async existing=>existing,
 uploadPhoto:async()=>{if(++attempts===1)throw Error('Network unavailable');return new Promise(resolve=>{finish=()=>resolve({id:'p',revision:2});});},savePhoto:async(session,item,changes)=>{Object.assign(item,changes);return item;}};
 const {e,originalFiles}=await app(false,[],true,async()=>{calls++;return '{"category":"Outdoors","description":"A tree."}';},false,false,shared);
 await e.photos.onchange({target:{files:[{name:'photo.jpg',type:'image/jpeg',size:10}]}});
 assert.equal(e.retry.hidden,false);const retry=e.retry.onclick();await tick();
 assert.equal(originalFiles.length,1,'retry must preserve the selected photo, not re-add it');
 assert.equal(e.retry.disabled,true);finish();await retry;
 assert.equal(calls,1);assert.match(e.summary.textContent,/1 of 1 processed \| 1 categorized/);assert.equal(e.retry.hidden,true);
});

test('restart categorization reruns completed photos and skips Trash',async()=>{
 let calls=0;const {e}=await app(false,[],true,async()=>{calls++;return '{"category":"Indoors","description":"A room."}';});
 await e.photos.onchange({target:{files:[{name:'a.jpg'},{name:'b.jpg'}]}});await e.start.onclick();
 const card=e.groups.children[0].children[1].children[0];await card.children.find(c=>c.className?.includes('remove-photo')).onclick();
 assert.equal(e['restart-categorization']?.hidden,false);await e['restart-categorization'].onclick();
 assert.equal(calls,3);assert.match(e.summary.textContent,/1 of 1 processed \| 1 categorized/);
});


test('retry resumes failed categorization without repeating completed photos',async()=>{
 let calls=0;const {e}=await app(false,[],true,async()=>{calls++;if(calls===2)throw Error('Temporary provider failure');return '{"category":"Indoors","description":"A room."}';});
 await e.photos.onchange({target:{files:[{name:'a.jpg'},{name:'b.jpg'},{name:'c.jpg'}]}});await e.start.onclick();
 assert.equal(calls,2);await e.retry.onclick();assert.equal(calls,4);assert.match(e.summary.textContent,/3 of 3 processed \| 3 categorized/);
});


test('status checks flag remote changes without merging; cloud click applies them',async()=>{
 let photos=[],checks=0,release,delay=false;
 const shared={authConfig:async()=>({enabled:true}),credentials:()=>({}),signOut(){},sessionAPI:async path=>{if(!path){if(delay)await new Promise(resolve=>{release=resolve});return {sessions:[{id:'s',name:'Visit'}]};}return {photos:photos.map(p=>({...p}))};},mergePhotos:async(existing,remote)=>{checks++;return remote.map(p=>({remoteId:p.id,revision:p.revision,state:p.state,category:p.category,file:{},thumbnail:'data:photo'}));}};
 const {e,events}=await app(false,[],true,undefined,false,false,shared);assert.equal(e['sync-cloud'].attrs['data-updates'],'false');
 delay=true;const check=events.focus();await tick();assert.equal(e['sync-cloud'].attrs['data-updates'],'false');delay=false;release();await check;
 const merged=checks;photos=[{id:'p',revision:1,state:'done',category:'Outdoors'}];await events.focus();
 assert.equal(checks,merged);assert.equal(e.groups.children.length,0);assert.equal(e['sync-cloud'].attrs['data-updates'],'true');
 await e['sync-cloud'].onclick();assert.match(e.summary.textContent,/1 of 1 processed/);assert.equal(e['sync-cloud'].attrs['data-updates'],'false');
 photos=[];await events.focus();assert.match(e.summary.textContent,/1 of 1 processed/);assert.equal(e['sync-cloud'].attrs['data-updates'],'true');
 await e['sync-cloud'].onclick();assert.equal(e.groups.children.length,0);assert.equal(e['sync-cloud'].attrs['data-updates'],'false');
});

test('a delayed status check cannot turn the cloud red after a newer manual sync',async()=>{
 let block=false,finish;const shared={authConfig:async()=>({enabled:true}),credentials:()=>({}),signOut(){},sessionAPI:async(path='',method,body,options)=>{if(!path)return {sessions:[{id:'s',name:'Visit'}]};if(block&&options?.conditional){block=false;return new Promise(resolve=>{finish=()=>resolve({photos:[{id:'old',revision:1,state:'done'}]});});}return {photos:[]};},mergePhotos:async()=>[]};
 const {e,events}=await app(false,[],true,undefined,false,false,shared);block=true;const check=events.focus();await tick();await e['sync-cloud'].onclick();finish();await check;assert.equal(e['sync-cloud'].attrs['data-updates'],'false');assert.equal(e.groups.children.length,0);
});
