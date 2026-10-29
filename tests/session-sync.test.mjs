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
test('new photos from the other device load their prepared image for document export',async()=>{
 const oldFetch=globalThis.fetch,oldReader=globalThis.FileReader;
 globalThis.fetch=async()=>new Response(new Blob(['image'],{type:'image/jpeg'}));globalThis.FileReader=class{readAsDataURL(){this.result='data:image/jpeg;base64,aW1hZ2U=';this.onload();}};
 try{const result=await mergePhotos([],[{id:'b',revision:2,state:'done',mime:'image/jpeg',bytes:25,preparedUrl:'signed',originalUrl:'original'}]);assert.equal(result[0].exportImage,'data:image/jpeg;base64,aW1hZ2U=');assert.equal(result[0].file.size,25);}finally{globalThis.fetch=oldFetch;globalThis.FileReader=oldReader;}
});
test('upload becomes pending only after both files succeed; updates use revision checks',async()=>{
 const oldFetch=globalThis.fetch;const calls=[];globalThis.fetch=async(url,options={})=>{calls.push({url,options});if(String(url).startsWith('data:'))return new Response(new Blob(['prepared']));if(options.method==='PUT')return new Response('');if(options.method==='POST')return json({photo:{id:'p',revision:1},originalUploadUrl:'https://storage/original',preparedUploadUrl:'https://storage/prepared'});if(options.method==='PATCH')return json({id:'p',revision:2,state:'pending'});return json({});};
 try{const photo=await uploadPhoto('s',new Blob(['original'],{type:'image/jpeg'}),{url:'data:image/jpeg;base64,eA=='});assert.equal(photo.revision,2);const writes=calls.filter(c=>['PUT','PATCH'].includes(c.options.method));assert.deepEqual(writes.map(c=>c.options.method),['PUT','PUT','PATCH']);assert.equal(JSON.parse(writes.at(-1).options.body).state,'pending');const item={remoteId:'p',revision:2,state:'pending'};await savePhoto('s',item,{state:'done',category:'Indoors'});assert.equal(JSON.parse(calls.at(-1).options.body).revision,2);}finally{globalThis.fetch=oldFetch;}
});

test('failed local uploads remain available for retry after session sync',async()=>{const failed={uploadFailed:true,state:'error',thumbnail:'data:photo'};assert.deepEqual(await mergePhotos([failed],[]),[failed]);});
