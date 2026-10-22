import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadFetch } from '../src/downloads.js';
test('downloads start smallest first and hold slots until bodies finish',async()=>{
 const started=[],controllers=new Map();const sizes=new Map([['large',50],['small',1],['medium',20],['fourth',30]]);
 const fetch=createDownloadFetch(async url=>{started.push(url);return new Response(new ReadableStream({start(c){controllers.set(url,c);}}));},{sizes,limit:3});
 const jobs=['large','small','medium','fourth'].map(url=>fetch(url).then(r=>r.text()));
 await new Promise(r=>setTimeout(r,20));assert.deepEqual(started,['small','medium','fourth']);
 controllers.get('small').close();await new Promise(r=>setTimeout(r,20));assert.deepEqual(started,['small','medium','fourth','large']);
 for(const [url,c] of controllers)if(url!=='small')c.close();await Promise.all(jobs);
});
test('failed requests release slots and unknown sizes still load',async()=>{
 const fetch=createDownloadFetch(async url=>{if(url==='bad')throw Error('offline');return new Response('ok');},{limit:1});
 const result=await Promise.allSettled([fetch('bad'),fetch('good').then(r=>r.text())]);assert.equal(result[0].status,'rejected');assert.equal(result[1].value,'ok');
});
test('file progress merges network URLs with loader filenames and identifies cache hits',async()=>{
 const {createDownloadView}=await import('../src/download-view.js');
 const element=()=>({children:[],append(...v){this.children.push(...v);},replaceChildren(...v){this.children=[...v];},setAttribute(){},removeAttribute(){delete this.value;}});
 const previous=globalThis.document;globalThis.document={createElement:element};
 try{const container=element();const view=createDownloadView(container);
 view.update({file:'onnx/model.onnx',status:'initiate'});
 view.update({file:'https://huggingface.co/test/model/resolve/revision/onnx/model.onnx',status:'progress',transfer:true,loaded:50,total:100,progress:50});
 assert.equal(container.children.length,1);assert.equal(container.children[0].children[1].value,50);
 view.update({file:'onnx/model.onnx',status:'done'});assert.equal(container.children[0].children[2].textContent,'Downloaded');
 view.update({file:'config.json',status:'done'});assert.equal(container.children[1].children[2].textContent,'Ready from cache');
 view.reset();assert.equal(container.children.length,0);
 }finally{globalThis.document=previous;}
});
