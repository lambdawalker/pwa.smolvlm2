import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const originalSource=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
function prepareSource(source){return source
 .replace(/\r\n/g,'\n').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',"'https://example.test/src/main.js'");
}
async function app(supported=true,lineEnding='\n'){
 const source=prepareSource(originalSource.replace(/\r?\n/g,lineEnding));
 const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,{hidden:false,disabled:false,textContent:'',setAttribute(){},removeAttribute(){},focus(){}}]));
 const workers=[];
 class Worker{constructor(){workers.push(this);}postMessage(data){this.last=data;}terminate(){this.stopped=true;}}
 vm.runInNewContext(source,{document:{getElementById:id=>{assert.ok(elements[id],`Missing element ${id}`);return elements[id];}},Worker,URL,navigator:{gpu:{requestAdapter:async()=>supported?{}:null}},window:{addEventListener(){}},registerSW:()=>()=>{},friendlyError:x=>x,caches:{delete:async()=>true}});
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
