import test from 'node:test';
import assert from 'node:assert/strict';
import {dHashPixels,sameImageHashes} from '../src/image-hash.js';
const pixels=fn=>Uint8ClampedArray.from(Array.from({length:72},(_,i)=>[...fn(i%9,Math.floor(i/9)),255]).flat());
test('dHash follows Kotlin luminance, row order and least-significant-bit first',()=>{
 assert.equal(dHashPixels(pixels(x=>[255-x*20,255-x*20,255-x*20])),'ffffffffffffffff');
 assert.equal(dHashPixels(pixels(x=>[x*20,x*20,x*20])),'0000000000000000');
 assert.equal(dHashPixels(pixels((x,y)=>y===0&&x===0?[255,255,255]:[0,0,0])),'0000000000000001');
 assert.equal(dHashPixels(pixels((x,y)=>y===7&&x===7?[255,255,255]:[0,0,0])),'8000000000000000');
 assert.throws(()=>dHashPixels(new Uint8Array(10)),/pixels/);
});
test('duplicate checks require exact valid SHA-256 and dHash matches, including all-zero dHash',()=>{
 const a={sourceHash:'a'.repeat(64),dHash:'0000000000000000',hashVersion:'dhash-8-v1'};
 assert.equal(sameImageHashes(a,{...a}),true);assert.equal(sameImageHashes(a,{...a,dHash:'1000000000000000'}),false);
 assert.equal(sameImageHashes(a,{...a,sourceHash:'b'.repeat(64)}),false);assert.equal(sameImageHashes({},{}),false);
 assert.equal(sameImageHashes(a,{...a,hashVersion:'other'}),false);
});
