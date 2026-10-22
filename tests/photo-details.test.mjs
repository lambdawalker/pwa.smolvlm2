import test from 'node:test';
import assert from 'node:assert/strict';
import {jsonTokens,appendPhotoDetails} from '../src/photo-details.js';
test('JSON output is pretty printed and tokenized without HTML',()=>{
 const raw='{"description":"<script>alert(1)</script>","n":3,"ok":true,"none":null}';
 const tokens=jsonTokens(raw);assert.equal(tokens.map(t=>t.text).join(''),JSON.stringify(JSON.parse(raw),null,2));
 assert.deepEqual([...new Set(tokens.map(t=>t.kind))].sort(),['','boolean','key','null','number','string']);
 assert.deepEqual(jsonTokens('not json'),[{text:'not json',kind:''}]);
});
test('details group original and sent metadata with unknown cloud precision',()=>{
 const node=()=>({children:[],append(...n){this.children.push(...n)}});const root=node();
 appendPhotoDetails(root,{info:{sourceWidth:800,sourceHeight:600,sourceMime:'image/png',sourceBytes:1000,width:384,height:384,preparedBytes:200},promptHash:'123456789abcffff'},'Gemma',true,{createElement:node});
 assert.deepEqual(root.children.filter((_,i)=>i%2===0).map(n=>n.textContent),['Original','Sent','Prompt']);
 assert.equal(root.children[3].children[3].textContent,'image/jpeg');
 assert.equal(root.children[5].children[5].textContent,'unknown');
});
