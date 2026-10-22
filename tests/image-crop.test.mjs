import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/image.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace('export async function','async function');
test('categorization scales proportionally then center crops to 384 square',async()=>{
 for(const [width,height,expected] of [[1086,1448,[0,181,1086,1086]],[1448,1086,[181,0,1086,1086]],[100,100,[0,0,100,100]]]){
  let args;const canvas={getContext:()=>({fillRect(){},drawImage(...a){args=a.slice(1)},getImageData:()=>({data:new Uint8Array()})}),toDataURL:()=> 'data:image/jpeg;base64,AA=='};
  const context=vm.createContext({validatePhoto(){},sha256:async()=> 'hash',URL:{createObjectURL:()=> 'url',revokeObjectURL(){}},Image:class{naturalWidth=width;naturalHeight=height;async decode(){}},document:{createElement:()=>canvas},atob,Uint8Array});
  vm.runInContext(source,context);
  const result=await context.preparePhoto({arrayBuffer:async()=>new ArrayBuffer(0)},{centerCrop:true});
  assert.deepEqual(args,[...expected,0,0,384,384]);assert.equal(result.width,384);assert.equal(result.height,384);
 }
});
