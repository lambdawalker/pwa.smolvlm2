import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function app(){
 const records=new Map();const indexedDB={open(){const r={};queueMicrotask(()=>{r.result={transaction(){const tx={objectStore(){return {put(value){return request(()=>{records.set(value.id,value)})},delete(id){return request(()=>records.delete(id))},getAll(){return request(()=>[...records.values()])}}}};function request(fn){const req={};queueMicrotask(()=>{req.result=fn();req.onsuccess?.();tx.oncomplete?.()});return req}return tx}};r.onsuccess?.()});return r}};
 const node=()=>({children:[],attrs:{},value:'',append(...children){this.children.push(...children)},setAttribute(k,v){this.attrs[k]=v},replaceChildren(){this.children=[]},get options(){return this.children},querySelector(){return null}});
 const elements=Object.fromEntries([...readFileSync(new URL('../index.html',import.meta.url),'utf8').matchAll(/id="([^"]+)"/g)].map(m=>[m[1],node()]));elements['export-selected'].checked=true;
 const items=[{remoteId:'a',state:'done',category:'Indoors',description:'A room.'},{remoteId:'b',state:'done',category:'Outdoors',description:'A tree.'},{remoteId:'c',state:'trash',category:'Documents'}];const calls=[];
 const bridge={group:async action=>action(),items,session:'s',categories:['Indoors','Outdoors'],render(){},edit:async(i,c)=>{calls.push([i.remoteId,c]);Object.assign(i,c)},trash:async photos=>calls.push(photos.map(p=>p.remoteId)),reclassify:async i=>calls.push(i.remoteId)};
 const window={auditBridge:bridge,addEventListener(){}};
 const source=readFileSync(new URL('../src/photo-tools.js',import.meta.url),'utf8').replace(/\r\n/g,'\n').replace(/^import .*;\n/gm,'');
 vm.runInNewContext(source,{window,document:{getElementById:id=>elements[id],createElement:node,querySelectorAll:()=>[]},credentials:()=>({email:'user@test'}),t:x=>x,setTimeout:()=>1,clearTimeout(){},console,indexedDB,queueMicrotask,crypto:globalThis.crypto});
 return {elements,items,calls,features:window.auditFeatures,node,records,bridge};
}
test('selection limits exported photos and bulk updates; search matches description/category',async()=>{
 const {elements,items,calls,features,node}=app();const card=node();features.decorate(card,items[1]);const check=card.children[0];check.checked=true;check.onchange();assert.deepEqual(Array.from(features.exportItems(),i=>i.remoteId),['b']);elements['selection-category'].value='Indoors';await elements['selection-move'].onclick();assert.equal(calls.length,1);assert.equal(calls[0][0],'b');assert.equal(items[1].category,'Indoors');elements['photo-search'].value='room';elements['photo-search'].oninput();assert.equal(features.filter(items[0]),true);assert.equal(features.filter(items[1]),false);
});
test('reclassification skips Trash and exports preserve shared ordering',async()=>{
 const {elements,items,calls,features,node}=app();for(const item of items){const card=node();features.decorate(card,item);card.children[0].checked=true;card.children[0].onchange()}await elements['selection-reclassify'].onclick();assert.deepEqual(calls,['a','b']);items[0].order=10;items[1].order=1;elements['export-selected'].checked=false;assert.equal(features.exportItems()[0].remoteId,'c');assert.equal(features.exportItems()[1].remoteId,'b');
});

test('upload recovery retains pending originals until success and scopes resume to account/session',async()=>{
 const {features,records,elements,bridge}=app();const file={name:'photo.jpg',type:'image/jpeg'};await features.persistFiles([file],'s');assert.equal(records.size,1);await features.persistFiles([file],'s');assert.equal(records.size,1);
 let resumed;bridge.resume=async files=>resumed=files;await elements['resume-uploads'].onclick();assert.equal(resumed[0],file);await features.uploadComplete({file});assert.equal(records.size,0);
 records.set('foreign',{id:'foreign',owner:'someone-else',session:'s',file});resumed=[];await elements['resume-uploads'].onclick();assert.equal(resumed.length,0);assert.equal(records.size,1);
});

test('moving an older photo without saved order earlier keeps the intended sequence',async()=>{const {features,items,node}=app();items[1].category='Indoors';items[2].state='done';items[2].category='Indoors';const card=node();features.decorate(card,items[1]);await card.children.at(-1).children[0].onclick();assert.deepEqual(items.slice().sort((a,b)=>(a.order||0)-(b.order||0)).map(i=>i.remoteId),['b','a','c']);});
