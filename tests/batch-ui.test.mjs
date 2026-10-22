import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { CATEGORIES,CATEGORY_PROMPT,runBatch } from '../src/batch-core.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function app(supported=true){
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const source=readFileSync(new URL('../src/batch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',"'https://example.test/src/batch.js'");
 const element=()=>({children:[],append(...children){this.children.push(...children);},replaceChildren(){this.children=[];},removeAttribute(){},click(){this.onclick?.();},getContext(){return {drawImage(){}};},toDataURL(){return 'data:thumb';}});
 const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,element()]));
 const workers=[];class Worker{constructor(){workers.push(this);this.sent=[];}postMessage(data){this.sent.push(data);}terminate(){this.stopped=true;}}
 vm.runInNewContext(source,{createDownloadView:()=>({reset(){},update(){}}),document:{getElementById:id=>{assert.ok(elements[id],id);return elements[id];},createElement:element},Worker,URL,CATEGORIES,CATEGORY_PROMPT,runBatch,DEFAULT_MODEL:'256m',friendlyError:x=>x,preparePhoto:async()=>({url:'data:photo',width:10,height:10}),Image:class{async decode(){}},navigator:{gpu:{requestAdapter:async()=>supported?{}:null}},window:{addEventListener(){}},registerSW:()=>()=>{}});
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
