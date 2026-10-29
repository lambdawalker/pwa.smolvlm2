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
import { MODELS,getModel } from '../src/models.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function app(supported=true,installed=Object.keys(MODELS),cloud=false,cloudClassify=async()=>'Indoors',auto=false,mobile=false,shared=null){
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const source=readFileSync(new URL('../src/batch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',"'https://example.test/src/batch.js'");
 const element=()=>({children:[],append(...children){this.children.push(...children);},replaceChildren(){this.children=[];},addEventListener(name,handler){this.events??={};this.events[name]=handler;},showModal(){this.open=true;},close(){this.open=false;this.events?.close?.();},removeAttribute(){},setAttribute(){},click(){this.onclick?.();},getContext(){return {drawImage(){}};},toDataURL(){return 'data:thumb';}});
 const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,element()]));
 const originalFiles=[],revoked=[];class PhotoURL extends URL{static createObjectURL(file){originalFiles.push(file);return 'blob:original';}static revokeObjectURL(url){revoked.push(url);}}
 const events={};const workers=[];class Worker{constructor(){workers.push(this);this.sent=[];}postMessage(data){this.sent.push(data);}terminate(){this.stopped=true;}}
 vm.runInNewContext(source,{...(shared||{}),setInterval:()=>0,parseResult,defaults,getLanguage,languagePrompt,t,appendPhotoDetails:(container,item,label,cloud)=>renderPhotoDetails(container,item,label,cloud,{createElement:element}),CLOUD_MODEL,CLOUD_INFO,CLOUD_PRECISION,cloudAvailable:async()=>cloud,classifyCloud:cloudClassify,AbortController,setTimeout,clearTimeout,sha256:async()=> '123456789abc'+'0'.repeat(52),HASH_LABEL_LENGTH:12,precisionLabel:()=> 'precision',imageInfoLabel:()=> 'image info',logEvent(){},installDiagnostics(){},watchOperation:()=>({touch(){},stop(){}}),availableModels:async()=>installed,resolvePrompt,createDownloadView:()=>({reset(){},update(){}}),document:{getElementById:id=>{assert.ok(elements[id],id);return elements[id];},createElement:element},Worker,URL:PhotoURL,MODELS,getModel,CATEGORIES,CATEGORY_PROMPT,runBatch,DEFAULT_MODEL:'256m',friendlyError:x=>x,preparePhoto:async()=>({url:'data:photo',width:10,height:10}),Image:class{async decode(){}},navigator:{gpu:{requestAdapter:async()=>supported?{}:null}},window:{location:shared?.pageLocation,matchMedia:()=>({matches:mobile}),addEventListener(name,handler){events[name]=handler;}},registerSW:()=>()=>{}});
 await tick();elements['image-concurrency'].value='1';if(!auto)elements['auto-categorize'].checked=false;return {e:elements,w:workers,originalFiles,revoked,events};
}
test('main page uses 256M, sends images serially and resumes after stop',async()=>{
 const {e,w}=await app();e.photos.onchange({target:{files:[{name:'a.jpg'},{name:'b.jpg'}]}});
 const first=e.start.onclick();assert.equal(w[0].sent[0].model,'256m');assert.equal(e.pick.disabled,false);
 w[0].onmessage({data:{type:'ready'}});await tick();assert.equal(w[0].sent[1].type,'describe');assert.equal(w[0].sent.length,2);
 w[0].onmessage({data:{type:'complete',text:'{"category":"Indoors","description":"A scene."}'}});await tick();assert.equal(w[0].sent.length,3);
 e.cancel.onclick();await first;assert.equal(w[0].stopped,true);assert.match(e.summary.textContent,/1 of 2 processed/);
 w[0].onmessage({data:{type:'complete',text:'{"category":"Documents","description":"A scene."}'}});assert.match(e.summary.textContent,/1 of 2 processed/);
 const second=e.start.onclick();w[1].onmessage({data:{type:'ready'}});await tick();w[1].onmessage({data:{type:'complete',text:'{"category":"Computer screens","description":"A scene."}'}});await second;
 assert.match(e.summary.textContent,/2 of 2 processed \| 2 categorized/);assert.equal(e.start.disabled,true);assert.equal(e.pick.disabled,false);
});
test('unsupported browser never starts model download',async()=>{
 const {e,w}=await app(false);e.photos.onchange({target:{files:[{name:'a.jpg'}]}});assert.equal(e.start.disabled,true);await e.start.onclick();assert.equal(w.length,0);
});

test('changing batch model releases the worker, preserves results and applies to remaining photos',async()=>{
 const {e,w}=await app();e.photos.onchange({target:{files:[{name:'a.jpg'}]}});
 const first=e.start.onclick();w[0].onmessage({data:{type:'ready'}});await tick();
 assert.equal(e['batch-model'].disabled,true);
 w[0].onmessage({data:{type:'complete',text:'{"category":"Indoors","description":"A scene."}'}});await first;
 e['batch-model'].value='500m';e['batch-model'].onchange();assert.equal(w[0].stopped,true);assert.match(e.summary.textContent,/1 of 1 processed/);
 e.photos.onchange({target:{files:[{name:'b.jpg'}]}});
 const second=e.start.onclick();assert.equal(w[1].sent[0].model,'500m');w[1].onmessage({data:{type:'ready'}});await tick();assert.equal(w[1].sent[1].model,'500m');
 w[1].onmessage({data:{type:'complete',text:'{"category":"Outdoors","description":"A scene."}'}});await second;assert.match(e.summary.textContent,/2 of 2 processed/);
});
test('Florence cannot be selected for prompt-based categorization',async()=>{
 const {e}=await app();e['batch-model'].value='florence';e['batch-model'].onchange();assert.equal(e['batch-model'].value,'256m');
});

test('only downloaded models are offered and an empty cache cannot start',async()=>{
 const {e,w}=await app(true,[]);assert.equal(e['no-models'].hidden,false);assert.equal(e['batch-model'].children.length,0);await e.start.onclick();assert.equal(w.length,0);
 const one=await app(true,['500m']);assert.equal(one.e['batch-model'].children.length,1);assert.equal(one.e['batch-model'].value,'500m');
});
test('custom categorization prompt is validated and passed with the image',async()=>{
 const {e,w}=await app();e.photos.onchange({target:{files:[{name:'a.jpg'}]}});e['category-prompt'].value=' ';await e.start.onclick();assert.equal(w.length,0);
 e['category-prompt'].value='  Pick Indoors or Outdoors.  ';const run=e.start.onclick();w[0].onmessage({data:{type:'ready'}});await tick();assert.equal(w[0].sent[1].prompt,'Pick Indoors or Outdoors. Keep the description to one sentence, as short as possible.');assert.equal(w[0].sent[1].cachedOnly,true);w[0].onmessage({data:{type:'complete',text:'An uncertain answer'}});await run;
 const cards=e.groups.children.flatMap(s=>s.children[1].children);assert.ok(cards.some(card=>card.children?.some(child=>child.children?.some(n=>n.children?.some(span=>span.textContent==='An uncertain answer')))));
});

test('cloud works without WebGPU or downloads, requires consent and preserves raw answers',async()=>{
 let calls=0;const {e,w}=await app(false,[],true,async(image,prompt,signal)=>{calls++;assert.equal(image,'data:photo');assert.equal(prompt,CATEGORY_PROMPT+' Keep the description to one sentence, as short as possible.');assert.equal(signal.aborted,false);return '{"category":"Documents","description":"A scene."}';});
 assert.equal(e['batch-model'].value,CLOUD_MODEL);e.photos.onchange({target:{files:[{name:'a.jpg'}]}});
 assert.equal(e['cloud-consent'].checked,true);e['cloud-consent'].checked=false;e['cloud-consent'].onchange();await e.start.onclick();assert.equal(calls,0);assert.equal(e.start.disabled,true);
 e['cloud-consent'].checked=true;e['cloud-consent'].onchange();assert.equal(e.start.disabled,false);
 await e.start.onclick();assert.equal(calls,1);assert.equal(w.length,0);assert.match(e.summary.textContent,/1 of 1 processed \| 1 categorized/);
});
test('cloud quota failure pauses batch and keeps remaining photos pending',async()=>{
 let calls=0;const {e}=await app(false,[],true,async()=>{calls++;const error=new Error('Free quota reached');error.status=429;throw error;});
 e['cloud-consent'].checked=true;e.photos.onchange({target:{files:[{name:'a.jpg'},{name:'b.jpg'}]}});await e.start.onclick();
 assert.equal(calls,1);assert.match(e.status.textContent,/quota/);assert.match(e.summary.textContent,/1 of 2 processed/);assert.equal(e.retry.hidden,false);
});
test('stopping cloud aborts request and leaves photo pending',async()=>{
 let aborted=false;const {e}=await app(false,[],true,async(image,prompt,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));})));
 e['cloud-consent'].checked=true;e.photos.onchange({target:{files:[{name:'a.jpg'}]}});const run=e.start.onclick();await tick();e.cancel.onclick();await run;assert.equal(aborted,true);assert.match(e.summary.textContent,/0 of 1 processed/);
});

test('Google is default even with local models, and layouts switch',async()=>{
 const {e}=await app(true,['256m','smolvlm-500m'],true);
 assert.equal(e['batch-model'].value,CLOUD_MODEL);assert.equal(e['cloud-consent'].checked,true);
 assert.equal(e['settings-page'].hidden,true);assert.equal(e['categorize-page'].hidden,false);
 e['view-toggle'].onclick();assert.match(e.groups.className,/list-view/);
 e['view-toggle'].onclick();assert.equal(e.groups.className.includes('list-view'),false);
});

test('automatic mode starts on selection and the same button stops processing',async()=>{
 const {e,w}=await app(true,['256m'],false,undefined,true);
 assert.equal(e['auto-categorize'].checked,true);
 e.photos.onchange({target:{files:[{name:'a.jpg'},{name:'b.jpg'}]}});
 assert.equal(w.length,1);assert.equal(e['cancel-brain-icon'].hidden,false);assert.equal(e.start.disabled,false);
 assert.equal(e['batch-progress'].max,2);assert.equal(e['batch-progress'].value,0);
 await e.start.onclick();await tick();assert.equal(w[0].stopped,true);assert.equal(e['brain-icon'].hidden,false);
});

test('attention count highlights failures and identifies the scroll target',async()=>{
 const {e,w}=await app();
 assert.equal(e['attention-count'].disabled,true);assert.equal(e.status.hidden,true);
 e.photos.onchange({target:{files:[{name:'a.jpg'}]}});const run=e.start.onclick();w[0].onmessage({data:{type:'ready'}});await tick();w[0].onmessage({data:{type:'complete',text:'uncertain'}});await run;
 assert.equal(e['attention-count'].textContent,'1 need attention');assert.equal(e['attention-count'].disabled,false);assert.match(e['attention-count'].className,/has-attention/);assert.ok(e.groups.children.some(group=>group.id==='needs-attention'));
});

test('card preview opens the original source file and releases it on close',async()=>{
 const {e,w,originalFiles,revoked}=await app();const file={name:'source.jpg'};
 e.photos.onchange({target:{files:[file]}});const run=e.start.onclick();w[0].onmessage({data:{type:'ready'}});await tick();w[0].onmessage({data:{type:'complete',text:'{"category":"Indoors","description":"A room."}'}});await run;
 const card=e.groups.children[0].children[1].children[0];const image=card.children.find(child=>child.className==='open-original');image.onclick();
 assert.equal(originalFiles[0],file);assert.equal(e['original-image'].src,'blob:original');assert.equal(e['original-viewer'].open,true);
 e['close-original'].onclick();assert.equal(e['original-viewer'].open,false);assert.deepEqual(revoked,['blob:original']);
});
test('document settings opens as a floating panel and closes independently',async()=>{
 const {e}=await app();e['document-settings-panel'].hidden=true;
 e['document-settings'].onclick();assert.equal(e['document-settings-panel'].hidden,false);
 e['close-document-settings'].onclick();assert.equal(e['document-settings-panel'].hidden,true);
 e['document-settings'].onclick();e['document-settings'].onclick();assert.equal(e['document-settings-panel'].hidden,true);
});
test('category tabs navigate and removing the final image drops its page',async()=>{
 const {e,w}=await app();
 e.photos.onchange({target:{files:[{name:'room.jpg'},{name:'yard.jpg'}]}});const run=e.start.onclick();
 w[0].onmessage({data:{type:'ready'}});await tick();
 w[0].onmessage({data:{type:'complete',text:'{"category":"Indoors","description":"A room."}'}});await tick();
 w[0].onmessage({data:{type:'complete',text:'{"category":"Outdoors","description":"A yard."}'}});await run;
 assert.equal(e['category-tabs'].children.length,2);
 let pages=e.groups.children;assert.match(pages[0].className,/active-category/);
 e['category-tabs'].children[1].onclick();assert.match(pages[1].className,/active-category/);
 e['category-tabs'].children[0].onclick();assert.match(pages[0].className,/active-category/);
 e['category-tabs'].children[1].onclick();assert.match(pages[1].className,/active-category/);
 const remove=pages[1].children[1].children[0].children.find(child=>child.className?.includes('remove-photo'));
 assert.equal(remove.disabled,false);await remove.onclick();assert.equal(e['category-tabs'].children.length,1);assert.match(e.summary.textContent,/1 of 1 processed/);assert.match(e.groups.children[0].className,/active-category/);
});

test('upload becomes the enabled cancel control while a batch runs',async()=>{
 const {e,w}=await app();e.photos.onchange({target:{files:[{name:'a.jpg'}]}});const run=e.start.onclick();
 assert.equal(e.pick.disabled,false);assert.equal(e['upload-icon'].hidden,true);assert.equal(e['cancel-brain-icon'].hidden,false);assert.equal(e.start.hidden,true);
 e.pick.onclick();await run;assert.equal(w[0].stopped,true);assert.equal(e['upload-icon'].hidden,false);assert.equal(e['cancel-brain-icon'].hidden,true);
});
test('parallel cloud requests all abort from the unified cancel button',async()=>{
 const signals=[];const {e}=await app(false,[],true,async(image,prompt,signal)=>{signals.push(signal);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError'))));});
 e['image-concurrency'].value='3';e.photos.onchange({target:{files:[{name:'a.jpg'},{name:'b.jpg'},{name:'c.jpg'},{name:'d.jpg'}]}});const run=e.start.onclick();await tick();
 assert.equal(signals.length,3);e.pick.onclick();await run;assert.ok(signals.every(signal=>signal.aborted));assert.match(e.summary.textContent,/0 of 4 processed/);
});

test('mobile swipes over empty space wrap once and vertical gestures leave the category unchanged',async()=>{
 const {e,w}=await app(true,['256m'],false,undefined,false,true);
 e.photos.onchange({target:{files:[{name:'a.jpg'},{name:'b.jpg'}]}});const run=e.start.onclick();w[0].onmessage({data:{type:'ready'}});await tick();w[0].onmessage({data:{type:'complete',text:'{"category":"Indoors","description":"Room"}'}});await tick();w[0].onmessage({data:{type:'complete',text:'{"category":"Outdoors","description":"Yard"}'}});await run;
 const swipe=(x,y,target={closest:()=>null})=>{e['categorize-page'].events.touchstart({touches:[{clientX:150,clientY:200}],target});e['categorize-page'].events.touchend({changedTouches:[{clientX:x,clientY:y}]});};
 const active=()=>e.groups.children.findIndex(page=>page.className.includes('active-category'));
 assert.equal(active(),0);swipe(50,205);assert.equal(active(),1);swipe(50,205);assert.equal(active(),0);swipe(250,205);assert.equal(active(),1);
 swipe(155,350);assert.equal(active(),1);swipe(50,205,{closest:()=>({})});assert.equal(active(),1);
});

test('signed-in sessions sync uploads and classifications between two devices',async()=>{
 const records=[];let nextId=0;
 const shared={authConfig:async()=>({enabled:true}),credentials:()=>({access:'token'}),signOut(){},
  sessionAPI:async(path='',method='GET',body)=>{if(path==='')return {sessions:[{id:'session',name:'Site visit'}]};if(path==='/session')return {photos:records.map(p=>({...p}))};if(method==='DELETE'){const index=records.findIndex(p=>path.endsWith('/'+p.id));records.splice(index,1);return {deleted:true};}throw Error('unexpected '+path);},
  uploadPhoto:async(session,file)=>{const photo={id:String(++nextId),revision:2,state:'pending',mime:file.type,bytes:file.size,originalUrl:'original'};records.push(photo);return photo;},
  mergePhotos:async(existing,photos)=>photos.map(photo=>({...existing.find(i=>i.remoteId===photo.id),remoteId:photo.id,revision:photo.revision,state:photo.state,category:photo.category,description:photo.description,rawOutput:photo.rawOutput,file:{name:photo.id,type:photo.mime,size:photo.bytes},thumbnail:'data:photo',exportImage:'data:photo'})),
  savePhoto:async(session,item,changes)=>{const photo=records.find(p=>p.id===item.remoteId);assert.equal(photo.revision,item.revision);Object.assign(photo,changes);photo.revision++;item.revision=photo.revision;return photo;}
 };
 const phone=await app(false,[],true,async()=>' ',false,false,shared);assert.equal(phone.e['sessions-panel'].hidden,false);assert.equal(phone.e['session-select'].children[0].textContent,'Site visit');
 await phone.e.photos.onchange({target:{files:[{name:'phone.jpg',size:123,type:'image/jpeg'}]}});assert.equal(records.length,1);assert.equal(records[0].state,'pending');
 const laptop=await app(false,[],true,async()=>'{"category":"Outdoors","description":"A tree."}',false,false,shared);assert.match(laptop.e.summary.textContent,/0 of 1 processed/);await laptop.e.start.onclick();assert.equal(records[0].state,'done');assert.equal(records[0].description,'A tree.');assert.equal(laptop.e['export-document'].disabled,false);
 const reopenedPhone=await app(false,[],true,async()=>' ',false,false,shared);assert.match(reopenedPhone.e.summary.textContent,/1 of 1 processed \| 1 categorized/);assert.equal(reopenedPhone.e['export-document'].disabled,false);
 const remove=reopenedPhone.e.groups.children[0].children[1].children[0].children.find(c=>c.className?.includes('remove-photo'));await remove.onclick();assert.equal(records.length,0);
});

test('opening a session link selects it; remote renames and deletions update the picker',async()=>{
 const sessions=[{id:'a',name:'First'},{id:'b',name:'Second'}];
 const shared={pageLocation:{href:'https://audit.example/?session=b'},authConfig:async()=>({enabled:true}),credentials:()=>({}),signOut(){},sessionAPI:async path=>!path?{sessions:sessions.map(s=>({...s}))}:{photos:[]},mergePhotos:async()=>[]};
 const {e,events}=await app(false,[],true,undefined,false,false,shared);assert.equal(e['session-select'].value,'b');sessions[1].name='Renamed';await events.focus();assert.equal(e['session-select'].children[1].textContent,'Renamed');
 sessions.pop();await events.focus();assert.equal(e['session-select'].value,'a');sessions.pop();await events.focus();assert.equal(e.pick.disabled,true);assert.equal(e['session-select'].children.length,0);
 sessions.push({id:'c',name:'New from laptop'});await events.focus();assert.equal(e['session-select'].value,'c');assert.equal(e.pick.disabled,false);
});

test('an empty account waits for an explicit session instead of recreating a deleted one',async()=>{
 const calls=[];const shared={authConfig:async()=>({enabled:true}),credentials:()=>({}),signOut(){},sessionAPI:async(path='',method='GET')=>{calls.push(method);return {sessions:[]}},mergePhotos:async()=>[]};
 const {e}=await app(false,[],true,undefined,false,false,shared);assert.equal(e.pick.disabled,true);assert.equal(e['session-select'].children.length,0);assert.ok(calls.every(method=>method==='GET'));assert.match(e['session-status'].textContent,/Create one/);
});
