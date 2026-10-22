import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { CATEGORIES,CATEGORY_PROMPT,runBatch } from '../src/batch-core.js';
import { resolvePrompt } from '../src/core.js';
import { MODELS,getModel } from '../src/models.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function app(supported=true,installed=Object.keys(MODELS)){
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const source=readFileSync(new URL('../src/batch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',"'https://example.test/src/batch.js'");
 const element=()=>({children:[],append(...children){this.children.push(...children);},replaceChildren(){this.children=[];},removeAttribute(){},click(){this.onclick?.();},getContext(){return {drawImage(){}};},toDataURL(){return 'data:thumb';}});
 const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,element()]));
 const workers=[];class Worker{constructor(){workers.push(this);this.sent=[];}postMessage(data){this.sent.push(data);}terminate(){this.stopped=true;}}
 vm.runInNewContext(source,{availableModels:async()=>installed,resolvePrompt,createDownloadView:()=>({reset(){},update(){}}),document:{getElementById:id=>{assert.ok(elements[id],id);return elements[id];},createElement:element},Worker,URL,MODELS,getModel,CATEGORIES,CATEGORY_PROMPT,runBatch,DEFAULT_MODEL:'256m',friendlyError:x=>x,preparePhoto:async()=>({url:'data:photo',width:10,height:10}),Image:class{async decode(){}},navigator:{gpu:{requestAdapter:async()=>supported?{}:null}},window:{addEventListener(){}},registerSW:()=>()=>{}});
 await tick();return {e:elements,w:workers};
}
test('main page uses 256M, sends images serially and resumes after stop',async()=>{
 const {e,w}=await app();e.photos.onchange({target:{files:[{name:'a.jpg'},{name:'b.jpg'}]}});
 const first=e.start.onclick();assert.equal(w[0].sent[0].model,'256m');assert.equal(e.pick.disabled,true);
 w[0].onmessage({data:{type:'ready'}});await tick();assert.equal(w[0].sent[1].type,'describe');assert.equal(w[0].sent.length,2);
 w[0].onmessage({data:{type:'complete',text:'Indoors'}});await tick();assert.equal(w[0].sent.length,3);
 e.cancel.onclick();await first;assert.equal(w[0].stopped,true);assert.match(e.summary.textContent,/1 of 2 processed/);
 w[0].onmessage({data:{type:'complete',text:'Documents'}});assert.match(e.summary.textContent,/1 of 2 processed/);
 const second=e.start.onclick();w[1].onmessage({data:{type:'ready'}});await tick();w[1].onmessage({data:{type:'complete',text:'Computer screens'}});await second;
 assert.match(e.summary.textContent,/2 of 2 processed · 2 categorized/);assert.equal(e.start.disabled,true);assert.equal(e.pick.disabled,false);
});
test('unsupported browser never starts model download',async()=>{
 const {e,w}=await app(false);e.photos.onchange({target:{files:[{name:'a.jpg'}]}});assert.equal(e.start.disabled,true);await e.start.onclick();assert.equal(w.length,0);
});

test('changing batch model releases the worker, preserves results and applies to remaining photos',async()=>{
 const {e,w}=await app();e.photos.onchange({target:{files:[{name:'a.jpg'}]}});
 const first=e.start.onclick();w[0].onmessage({data:{type:'ready'}});await tick();
 assert.equal(e['batch-model'].disabled,true);
 w[0].onmessage({data:{type:'complete',text:'Indoors'}});await first;
 e['batch-model'].value='500m';e['batch-model'].onchange();assert.equal(w[0].stopped,true);assert.match(e.summary.textContent,/1 of 1 processed/);
 e.photos.onchange({target:{files:[{name:'b.jpg'}]}});
 const second=e.start.onclick();assert.equal(w[1].sent[0].model,'500m');w[1].onmessage({data:{type:'ready'}});await tick();assert.equal(w[1].sent[1].model,'500m');
 w[1].onmessage({data:{type:'complete',text:'Outdoors'}});await second;assert.match(e.summary.textContent,/2 of 2 processed/);
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
 e['category-prompt'].value='  Pick Indoors or Outdoors.  ';const run=e.start.onclick();w[0].onmessage({data:{type:'ready'}});await tick();assert.equal(w[0].sent[1].prompt,'Pick Indoors or Outdoors.');assert.equal(w[0].sent[1].cachedOnly,true);w[0].onmessage({data:{type:'complete',text:'An uncertain answer'}});await run;
 const cards=e.groups.children.flatMap(s=>s.children[1].children);assert.ok(cards.some(card=>card.children?.some(child=>child.textContent==='An uncertain answer')));
});
