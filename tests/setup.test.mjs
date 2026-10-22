import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MODELS,DEFAULT_MODEL,getModel } from '../src/models.js';
import { resolvePrompt } from '../src/core.js';
import { florenceTask } from '../src/inference.js';

const html=readFileSync(new URL('../describe.html',import.meta.url),'utf8');
const originalSource=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
function prepareSource(source){return source
 .replace(/\r\n/g,'\n').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',"'https://example.test/src/main.js'");
}
async function app(supported=true,lineEnding='\n',savedModel='256m'){
 const storage=new Map(savedModel?[['little-lens-model',savedModel]]:[]);
 const source=prepareSource(originalSource.replace(/\r?\n/g,lineEnding));
 const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,{hidden:false,disabled:false,textContent:'',value:'',setAttribute(){},removeAttribute(){},focus(){}}]));
 const workers=[];
 class Worker{constructor(){workers.push(this);}postMessage(data){this.last=data;}terminate(){this.stopped=true;}}
 vm.runInNewContext(source,{document:{getElementById:id=>{assert.ok(elements[id],`Missing element ${id}`);return elements[id];}},Worker,URL,MODELS,DEFAULT_MODEL,getModel,resolvePrompt,florenceTask,preparePhoto:async()=>({url:'data:image/png;base64,test',width:1,height:1}),localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},navigator:{gpu:{requestAdapter:async()=>supported?{}:null}},window:{addEventListener(){}},registerSW:()=>()=>{},friendlyError:x=>x,caches:{delete:async()=>true}});
 await new Promise(resolve=>setImmediate(resolve));
 return {elements,workers};
}
test('setup starts immediately, waits for readiness, and supports cancel and retry',async()=>{
 const {elements:e,workers:w}=await app();
 assert.equal(w[0].last.type,'load');assert.equal(e.spinner.hidden,false);assert.equal(e['load-model'].disabled,true);
 e.cancel.onclick();assert.equal(w[0].stopped,true);assert.equal(e.spinner.hidden,true);assert.equal(e['load-model'].disabled,false);
 e['load-model'].onclick();assert.equal(w.length,2);
 w[1].onmessage({data:{type:'ready'}});assert.equal(e.spinner.hidden,true);assert.equal(e.continue.hidden,false);
 e.continue.onclick();assert.equal(e.setup.hidden,true);assert.equal(e.workspace.hidden,false);
 await e.clear.onclick();assert.equal(e.setup.hidden,false);assert.equal(e.workspace.hidden,true);
});
test('unsupported browsers do not download; worker failures allow retry',async()=>{
 const unsupported=await app(false);assert.equal(unsupported.workers.length,0);assert.equal(unsupported.elements['load-model'].disabled,true);
 const {elements:e,workers:w}=await app();w[0].onmessage({data:{type:'error',message:'Network failed'}});
 assert.equal(e.status.textContent,'Network failed');assert.equal(e.spinner.hidden,true);assert.equal(e['load-model'].disabled,false);
});

for (const lineEnding of ['\n','\r\n']) {
 test(`setup works with ${lineEnding === '\n' ? 'LF' : 'CRLF'} source files`,async()=>{
  const {elements,workers}=await app(true,lineEnding);
  assert.equal(workers[0].last.type,'load');
  workers[0].onmessage({data:{type:'ready'}});
  assert.equal(elements.continue.hidden,false);
 });
}

test('first visit waits for model choice; switching releases the previous worker',async()=>{
 const {elements:e,workers:w}=await app(true,'\n',null);
 assert.equal(w.length,0);
 e['model-select'].value='500m';e['model-select'].onchange();e['load-model'].onclick();
 assert.equal(w[0].last.model,'500m');
 w[0].onmessage({data:{type:'ready'}});e.continue.onclick();e['change-model'].onclick();
 e['model-select'].value='256m';e['model-select'].onchange();
 assert.equal(w[0].stopped,true);assert.equal(e.continue.hidden,true);
 e['load-model'].onclick();assert.equal(w[1].last.model,'256m');
});
test('custom prompt is validated and sent with the photo and chosen model',async()=>{
 const {elements:e,workers:w}=await app(true,'\r\n','500m');
 w[0].onmessage({data:{type:'ready'}});e.continue.onclick();
 await e.photo.onchange({target:{files:[{}],value:''}});
 e.style.value='custom';e.style.onchange();assert.equal(e['custom-prompt-area'].hidden,false);
 e['custom-prompt'].value='   ';await e.describe.onclick();assert.equal(w[0].last.type,'load');
 e['custom-prompt'].value='  What is on the table?  ';await e.describe.onclick();
 assert.equal(w[0].last.prompt,'What is on the table?');assert.equal(w[0].last.model,'500m');assert.ok(w[0].last.image);
});

test('Florence exposes fixed tasks and sends a task instead of a chat prompt',async()=>{
 const {elements:e,workers:w}=await app(true,'\n','florence');
 assert.equal(e['prompt-controls'].hidden,true);assert.equal(e['florence-controls'].hidden,false);
 w[0].onmessage({data:{type:'ready'}});e.continue.onclick();
 await e.photo.onchange({target:{files:[{}],value:''}});
 e['florence-task'].value='ocr';await e.describe.onclick();
 assert.equal(w[0].last.task,'ocr');assert.equal(w[0].last.prompt,undefined);
});
