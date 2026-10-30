import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {defaults} from '../src/defaults.generated.js';
import {getLanguage,languagePrompt,t} from '../src/i18n.js';
import {CATEGORIES,CATEGORY_PROMPT} from '../src/batch-core.js';
import {resolvePrompt} from '../src/core.js';
import {sameImageHashes,validImageHashes} from '../src/image-hash.js';
import {mergePhotos} from '../src/session-sync.js';
import {appendPhotoDetails} from '../src/photo-details.js';
import {CLOUD_MODEL,CLOUD_INFO,CLOUD_PRECISION} from '../src/cloud.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
async function app({photos=[],sessions=[{id:'s',name:'Visit'}],auth=true,mobile=false,upload,api,prepare,fetchPhoto}={}){
 const source=readFileSync(new URL('../src/batch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',"'https://example.test/src/batch.js'");
 const element=()=>({children:[],attrs:{},append(...children){this.children.push(...children)},replaceChildren(){this.children=[]},addEventListener(name,handler){this.events??={};this.events[name]=handler},setAttribute(name,value){this.attrs[name]=value},removeAttribute(){},showModal(){this.open=true},close(){this.open=false;this.events?.close?.()},click(){return this.onclick?.()}});
 const e=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,element()]));
 const events={},calls=[],files=[],revoked=[];let serial=0;
 class PhotoURL extends URL{static createObjectURL(file){files.push(file);return 'blob:photo'}static revokeObjectURL(url){revoked.push(url)}}
 const sessionAPI=async(path='',method='GET',body,options)=>{
  calls.push({path,method,body,options});if(api){const response=await api(path,method,body,options);if(response!==undefined)return response}
  if(!path)return {sessions:sessions.map(s=>({...s}))};
  if(path.endsWith('/classify-pending'))return {photos:[],remaining:false};
  if(path.endsWith('/classify')){const photo=photos.find(p=>path.includes('/'+p.id+'/'));photo.jobId='job-'+(++serial);photo.state='pending';photo.revision++;photo.promptHash='b'.repeat(64);return {...photo}}
  if(method==='GET')return {photos:photos.map(p=>({...p}))};
  if(method==='DELETE'){const id=path.split('/').at(-1);const index=photos.findIndex(p=>p.id===id);if(index>=0)photos.splice(index,1);return {deleted:true}}
  throw Error('Unexpected '+method+' '+path);
 };
 const uploadPhoto=upload|| (async(session,file,photo,settings)=>{const saved={id:'p'+(++serial),revision:2,state:'pending',jobId:settings.consent?'job-'+serial:undefined,promptHash:'a'.repeat(64),mime:file.type,bytes:file.size,preparedUrl:'data:photo',originalUrl:'original'};photos.push(saved);calls.push({path:'upload',settings});return {...saved}});
 const savePhoto=async(session,item,changes)=>{const photo=photos.find(p=>p.id===item.remoteId);Object.assign(photo,changes);photo.revision++;Object.assign(item,{state:photo.state,category:photo.category,revision:photo.revision});return photo};
 vm.runInNewContext('"use strict";\n'+source,{defaults,getLanguage,languagePrompt,t,CATEGORIES,CATEGORY_PROMPT,resolvePrompt,sameImageHashes,validImageHashes,CLOUD_MODEL,CLOUD_INFO,CLOUD_PRECISION,mergePhotos,sessionAPI,uploadPhoto,savePhoto,imageData:async()=> 'data:photo',appendPhotoDetails:(node,item,label,cloud)=>appendPhotoDetails(node,item,label,cloud,{createElement:element}),authConfig:async()=>({enabled:auth}),credentials:()=>({access:'token'}),signOut(){},cloudAvailable:async()=>true,preparePhoto:prepare|| (async()=>({url:'data:photo',width:384,height:384})),fetch:fetchPhoto|| (async()=>new Response(new Blob(['image']))),logEvent(){},installDiagnostics(){},registerSW:()=>()=>{},AbortController,DOMException,setTimeout,clearTimeout,setInterval:()=>0,URL:PhotoURL,document:{getElementById:id=>{assert.ok(e[id],id);return e[id]},createElement:element},window:{location:{href:'https://example.test/'},matchMedia:()=>({matches:mobile}),addEventListener(name,handler){events[name]=handler}}});
 await tick();return {e,events,calls,files,revoked,photos,sessions};
}
const file={name:'photo.jpg',size:100,type:'image/jpeg'};
const cards=e=>e.groups.children.flatMap(section=>section.children[1].children);
const action=(e,label)=>cards(e).flatMap(c=>c.children).find(child=>child.textContent===label);
test('categorization has no browser start, stop or restart controls and uploads queue AWS jobs',async()=>{
 for(const id of ['start','cancel','restart-categorization','auto-categorize','image-concurrency'])assert.doesNotMatch(html,new RegExp('id="'+id+'"'));
 const {e,calls}=await app();await e.photos.onchange({target:{files:[file]}});const upload=calls.find(c=>c.path==='upload');assert.equal(upload.settings.consent,true);assert.match(upload.settings.prompt,/Return only JSON/);assert.ok(cards(e).some(card=>card.children.some(child=>child.textContent==='Queued in AWS')));assert.equal(action(e,'Retry'),undefined);
});
test('photos appear immediately while uploads are pending; processing does not block upload controls',async()=>{
 let finish;const {e}=await app({upload:()=>new Promise(resolve=>{finish=resolve})});const selecting=e.photos.onchange({target:{files:[file]}});await tick();assert.equal(cards(e).length,1);assert.equal(e.pick.disabled,false);finish({id:'p',revision:2,state:'pending',jobId:'job'});await selecting;assert.equal(e.pick.disabled,false);
});
test('failed uploads retry in place and preserve the selected file',async()=>{
 let tries=0;const {e,files}=await app({upload:async()=>{if(++tries===1)throw Error('Network unavailable');return {id:'p',revision:2,state:'pending',jobId:'job'}}});await e.photos.onchange({target:{files:[file]}});assert.equal(e['retry-uploads'].hidden,false);await e['retry-uploads'].onclick();assert.equal(files.length,1);assert.equal(tries,2);assert.equal(e['retry-uploads'].hidden,true);assert.equal(cards(e).length,1);
});
test('results arrive only on cloud click; checking keeps the icon unchanged until updates exist',async()=>{
 const {e,events,photos}=await app();await e.photos.onchange({target:{files:[file]}});assert.equal(e['sync-cloud'].attrs['data-updates'],'false');await events.focus();assert.equal(e['sync-cloud'].attrs['data-updates'],'false');photos[0].state='done';photos[0].revision++;photos[0].category='Indoors';photos[0].description='A room.';await events.focus();assert.equal(e['sync-cloud'].attrs['data-updates'],'true');assert.match(e.summary.textContent,/0 of 1/);await e['sync-cloud'].onclick();assert.match(e.summary.textContent,/1 of 1 processed \| 1 categorized/);assert.equal(e['sync-cloud'].attrs['data-updates'],'false');
});
test('Retry and Reclassify enqueue only the selected photo with the current prompt',async()=>{
 const photos=[{id:'a',revision:3,state:'error',processingError:'Provider failed',mime:'image/jpeg',preparedUrl:'data:a'},{id:'b',revision:3,state:'done',category:'Outdoors',description:'A tree.',mime:'image/jpeg',preparedUrl:'data:b'}];const {e,calls}=await app({photos});e['category-prompt'].value='Classify this photo and use a short description';await action(e,'Retry').onclick();assert.equal(photos[0].state,'pending');assert.equal(photos[1].state,'done');const request=calls.find(c=>c.path.endsWith('/a/classify'));assert.match(request.body.prompt,/Classify this photo/);await action(e,'Reclassify').onclick();assert.equal(photos[1].state,'pending');
});
test('consent off permits storage but does not authorize categorization',async()=>{
 const {e,calls}=await app();e['cloud-consent'].checked=false;e['cloud-consent'].onchange();await e.photos.onchange({target:{files:[file]}});assert.equal(calls.find(c=>c.path==='upload').settings.consent,false);assert.equal(action(e,'Retry').disabled,true);
});
test('duplicates are skipped without displaying another photo',async()=>{
 const {e}=await app({upload:async()=>({duplicate:true,id:'existing'})});await e.photos.onchange({target:{files:[file]}});assert.equal(cards(e).length,0);assert.match(e['duplicate-notice'].textContent,/1/);
});
test('original photos open and Trash can be restored or shredded',async()=>{
 const photos=[{id:'p',revision:2,state:'done',category:'Indoors',description:'A room.',mime:'image/jpeg',preparedUrl:'data:p'}];const {e,files}=await app({photos});const card=cards(e)[0];await card.children.find(c=>c.className==='open-original').onclick();assert.equal(files.length,1);await card.children.find(c=>c.className?.includes('remove-photo')).onclick();assert.equal(photos[0].state,'trash');const select=cards(e)[0].children.find(c=>c.className==='category-title').children[0];select.value='Indoors';await select.onchange();assert.equal(photos[0].state,'done');await cards(e)[0].children.find(c=>c.className?.includes('remove-photo')).onclick();await cards(e)[0].children.find(c=>c.className?.includes('remove-photo')).onclick();assert.equal(photos.length,0);
});
test('document panel and grid/list toggle remain independent',async()=>{
 const {e}=await app();e['document-settings-panel'].hidden=true;e['document-settings'].onclick();assert.equal(e['document-settings-panel'].hidden,false);e['close-document-settings'].onclick();assert.equal(e['document-settings-panel'].hidden,true);e['view-toggle'].onclick();assert.match(e.groups.className,/list-view/);e['view-toggle'].onclick();assert.doesNotMatch(e.groups.className,/list-view/);
});
test('mobile category swipe wraps and vertical motion does not switch category',async()=>{
 const {e}=await app({mobile:true,photos:[{id:'a',revision:1,state:'done',category:'Indoors'},{id:'b',revision:1,state:'done',category:'Outdoors'}]});const swipe=(x,y)=>{e['categorize-page'].events.touchstart({touches:[{clientX:150,clientY:100}],target:{closest:()=>null}});e['categorize-page'].events.touchend({changedTouches:[{clientX:x,clientY:y}]})};const active=()=>e.groups.children.findIndex(s=>s.className.includes('active-category'));assert.equal(active(),0);swipe(40,110);assert.equal(active(),1);swipe(40,110);assert.equal(active(),0);swipe(145,300);assert.equal(active(),0);
});
test('session renames and deletions wait for explicit sync',async()=>{
 const {e,events,sessions}=await app();sessions[0].name='Renamed';await events.focus();assert.equal(e['session-select'].children[0].textContent,'Visit');await e['sync-cloud'].onclick();assert.equal(e['session-select'].children[0].textContent,'Renamed');sessions.splice(0);await events.focus();assert.equal(e.pick.disabled,false);await e['sync-cloud'].onclick();assert.equal(e.pick.disabled,true);
});
test('indexing only downloads missing hashes, and cleanup stays explicit',async()=>{
 const hashes={sourceHash:'a'.repeat(64),dHash:'0000000000000000',hashVersion:'dhash-8-v1'};let downloads=0,cleanups=0;const photos=[{id:'p',revision:1,state:'done',category:'Indoors',originalUrl:'original'}];
 const {e}=await app({photos,prepare:async()=>{downloads++;return {url:'data:photo',info:hashes}},api:async(path,method)=>{if(path.endsWith('/hashes')){const updated=!photos[0].sha256Verified;Object.assign(photos[0],hashes,{sha256Verified:true});return {photo:photos[0],updated}}if(path.endsWith('/deduplicate')){cleanups++;return {moved:1,remaining:false}}}});await e['index-hashes'].onclick();await e['index-hashes'].onclick();assert.equal(downloads,1);assert.equal(cleanups,0);await e['deduplicate-photos'].onclick();assert.equal(cleanups,1);assert.equal(e['sync-cloud'].attrs['data-updates'],'true');
});
test('background categorization requires signed-in sessions',async()=>{
 const {e}=await app({auth:false});assert.equal(e.pick.disabled,true);assert.match(e.status.textContent,/signed-in session/);
});
