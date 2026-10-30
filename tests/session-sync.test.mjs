import test from 'node:test';
import assert from 'node:assert/strict';
import {mergePhotos,savePhoto,uploadPhoto} from '../src/session-sync.js';
const json=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
test('remote photos merge by revision, retain cached images, and disappear after removal on another device',async()=>{
 const old={remoteId:'a',revision:2,exportImage:'data:a',state:'done',file:{name:'local'}};
 const remote={id:'a',revision:3,state:'done',category:'Outdoors',description:'A tree.',rawOutput:'{}',originalUrl:'signed-original',preparedUrl:'signed-prepared'};
 const result=await mergePhotos([old],[remote]);assert.equal(result[0].category,'Outdoors');assert.equal(result[0].exportImage,'data:a');assert.equal(result[0].originalUrl,'signed-original');assert.equal(result[0].revision,3);
 assert.deepEqual(await mergePhotos(result,[]),[]);assert.deepEqual(await mergePhotos([],[{id:'incomplete',state:'uploading'}]),[]);
});
test('new remote photos appear immediately with lazy images and an export source',async()=>{
 const oldFetch=globalThis.fetch,oldReader=globalThis.FileReader;
 globalThis.fetch=async()=>new Response(new Blob(['image'],{type:'image/jpeg'}));globalThis.FileReader=class{readAsDataURL(){this.result='data:image/jpeg;base64,aW1hZ2U=';this.onload();}};
 try{const result=await mergePhotos([],[{id:'b',revision:2,state:'done',mime:'image/jpeg',bytes:25,preparedUrl:'signed',originalUrl:'original'}]);assert.equal(result[0].thumbnail,'signed');assert.equal(result[0].preparedUrl,'signed');assert.equal(result[0].exportImage,undefined);assert.equal(result[0].file.size,25);}finally{globalThis.fetch=oldFetch;globalThis.FileReader=oldReader;}
});
test('upload becomes pending only after both files succeed; updates use revision checks',async()=>{
 const oldFetch=globalThis.fetch;const calls=[];globalThis.fetch=async(url,options={})=>{calls.push({url,options});if(String(url).startsWith('data:'))return new Response(new Blob(['prepared']));if(options.method==='PUT')return new Response('');if(options.method==='POST')return json({photo:{id:'p',revision:1},originalUploadUrl:'https://storage/original',preparedUploadUrl:'https://storage/prepared'});if(options.method==='PATCH')return json({id:'p',revision:2,state:'pending'});return json({});};
 try{const photo=await uploadPhoto('s',new Blob(['original'],{type:'image/jpeg'}),{url:'data:image/jpeg;base64,eA=='});assert.equal(photo.revision,2);const writes=calls.filter(c=>['PUT','PATCH'].includes(c.options.method));assert.deepEqual(writes.map(c=>c.options.method),['PUT','PUT','PATCH']);assert.equal(JSON.parse(writes.at(-1).options.body).state,'pending');const item={remoteId:'p',revision:2,state:'pending'};await savePhoto('s',item,{state:'done',category:'Indoors'});assert.equal(JSON.parse(calls.at(-1).options.body).revision,2);}finally{globalThis.fetch=oldFetch;}
});

test('failed local uploads remain available for retry after session sync',async()=>{const failed={uploadFailed:true,state:'error',thumbnail:'data:photo'};assert.deepEqual(await mergePhotos([failed],[]),[failed]);});

test('sync preserves active edits and unsaved uploads without awaiting photo downloads',async()=>{
 const editing={remoteId:'a',revision:2,state:'done',category:'Indoors',dirty:true,exportImage:'data:cached'};
 const upload={state:'uploading',thumbnail:'blob:local'};
 const result=await mergePhotos([editing,upload],[{id:'a',revision:3,state:'trash',preparedUrl:'signed'},{id:'b',revision:1,state:'pending',preparedUrl:'other'}]);
 assert.equal(result[0],editing);assert.equal(editing.category,'Indoors');assert.equal(editing.revision,2);assert.equal(result[1].thumbnail,'other');assert.equal(result[2],upload);
});
test('shredded remote photos disappear even when an edit is pending locally',async()=>{
 const editing={remoteId:'a',revision:1,dirty:true,state:'done'};assert.deepEqual(await mergePhotos([editing],[]),[]);assert.equal(editing.shredded,true);
 const stale={remoteId:'b',state:'done'};assert.deepEqual(await mergePhotos([stale],[{id:'b',state:'shredded'}]),[]);assert.equal(stale.shredded,true);
});
test('saved conflicts become Needs attention and a missing photo is never restored',async()=>{
 const oldFetch=globalThis.fetch;const item={remoteId:'a',revision:1,state:'done',category:'Indoors'};
 try{globalThis.fetch=async()=>json({id:'a',revision:3,state:'review',category:'Outdoors',conflict:true});await savePhoto('s',item,{state:'done',category:'Outdoors'});assert.equal(item.state,'review');assert.equal(item.conflict,true);assert.equal(item.dirty,false);
 globalThis.fetch=async()=>new Response(JSON.stringify({error:'Photo permanently removed.'}),{status:404});await savePhoto('s',item,{state:'done'});assert.equal(item.shredded,true);
 }finally{globalThis.fetch=oldFetch;}
});

test('conditional sync skips unchanged data and force loading a session ignores the cached version',async()=>{
 const oldFetch=globalThis.fetch;let count=0;const requests=[];
 globalThis.fetch=async(url,options)=>{requests.push(options.headers);count++;if(count===2)return new Response(null,{status:304});return new Response(JSON.stringify({photos:[]}),{headers:{etag:'"version"'}})};
 try{const {sessionAPI}=await import('../src/session-sync.js');await sessionAPI('/conditional-test');const unchanged=await sessionAPI('/conditional-test','GET',undefined,{conditional:true});assert.equal(unchanged.unchanged,true);assert.equal(requests[1].get('If-None-Match'),'"version"');await sessionAPI('/conditional-test');assert.equal(requests[2].has('If-None-Match'),false);}finally{globalThis.fetch=oldFetch;}
});
test('a shred winning a simultaneous update removes the photo instead of showing a conflict',async()=>{
 const oldFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>options.method==='PATCH'?new Response(JSON.stringify({error:'changed'}),{status:409}):json({photos:[]});
 try{const item={remoteId:'p',revision:1,state:'done'};await savePhoto('s',item,{category:'Indoors'});assert.equal(item.shredded,true);assert.equal(item.dirty,false);}finally{globalThis.fetch=oldFetch;}
});

test('an older poll snapshot cannot revert a newly saved category or discard an upload finished after the poll started',async()=>{
 const edited={remoteId:'a',revision:3,state:'done',category:'Outdoors',exportImage:'data:photo'};
 const newUpload={remoteId:'b',revision:2,state:'pending',thumbnail:'data:new'};
 const snapshot=[{id:'a',revision:2,state:'done',category:'Indoors',preparedUrl:'signed'}];
 const result=await mergePhotos([edited,newUpload],snapshot,{knownAtStart:new Map([['a',2]])});assert.equal(edited.category,'Outdoors');assert.equal(edited.revision,3);assert.ok(result.includes(newUpload));assert.ok(!newUpload.shredded);
 await mergePhotos([newUpload],[],{knownAtStart:new Map([['b',2]])});assert.equal(newUpload.shredded,true);
});

test('categorization skips queued photos moved to Trash or shredded by background sync',async()=>{
 const {runBatch}=await import('../src/batch-core.js');const items=[{state:'pending'},{state:'pending'},{state:'pending'}];let calls=0;
 await runBatch(items,async()=>{calls++;items[1].state='trash';items[2].shredded=true;return '{"category":"Indoors","description":"A room."}'},()=>{},()=>false,1);assert.equal(calls,1);assert.equal(items[1].state,'trash');
});

test('sync preserves queued recategorization but remote Trash still wins',async()=>{
 const item={remoteId:'p',revision:2,state:'pending',reprocess:true};
 await mergePhotos([item],[{id:'p',revision:2,state:'done',category:'Indoors'}]);assert.equal(item.state,'pending');
 await mergePhotos([item],[{id:'p',revision:3,state:'trash'}]);assert.equal(item.state,'trash');assert.equal(item.reprocess,undefined);
});

test('upload skips object PUTs when both hashes match a stored photo',async()=>{
 const oldFetch=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return json({duplicate:true,photo:{id:'existing',revision:3,state:'done'}});};
 try{const info={sourceHash:'a'.repeat(64),dHash:'0000000000000000',hashVersion:'dhash-8-v1'};const result=await uploadPhoto('s',new Blob(['original'],{type:'image/jpeg'}),{url:'data:unused',info});assert.equal(result.duplicate,true);assert.equal(result.id,'existing');assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].options.body).dHash,info.dHash);}finally{globalThis.fetch=oldFetch;}
});
