import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import crc32 from 'jszip/lib/crc32.js';
import {exportPlan} from '../src/export-plan.js';
import * as png from '../src/export-png.js';
const bytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64'));
const item=(category='Indoors')=>({state:'done',category,description:'A room with windows.',exportImage:'data:image/png;base64,'+Buffer.from(bytes).toString('base64')});
function chunks(data){const view=new DataView(data.buffer,data.byteOffset,data.byteLength),result=[];for(let offset=8;offset<data.length;){const length=view.getUint32(offset),type=String.fromCharCode(...data.slice(offset+4,offset+8));result.push({type,data:data.slice(offset+8,offset+8+length),crc:view.getUint32(offset+8+length),body:data.slice(offset+4,offset+8+length)});offset+=length+12;}return result;}
test('PNG uses the same category/page grouping and supports saved PNG format',()=>{
 const plan=exportPlan([...Array.from({length:43},()=>item()),item('Outdoors')],{type:'png',columns:2,rows:7});assert.equal(plan.pages.length,5);assert.deepEqual(plan.pages.map(p=>p.items.length),[14,14,14,1,1]);assert.equal(plan.layout,'table');
});
test('PNG print metadata is 300 DPI with a valid CRC and replaces existing density',()=>{
 const updated=png.withPngDensity(bytes,300),physical=chunks(updated).filter(c=>c.type==='pHYs');assert.equal(physical.length,1);assert.equal(new DataView(physical[0].data.buffer).getUint32(0),11811);assert.equal(physical[0].data[8],1);assert.equal(crc32(physical[0].body)>>>0,physical[0].crc);
 assert.equal(chunks(png.withPngDensity(updated,300)).filter(c=>c.type==='pHYs').length,1);assert.throws(()=>png.withPngDensity(new Uint8Array(8),300),/PNG/);
});
test('tight PNG geometry has no outer gutter, no empty rows, and fits Word page bounds',()=>{
 for(const columns of [1,2,16])for(const rows of [1,7,16])for(const showDescription of [false,true])for(const orientation of ['portrait','landscape']){
  const plan=exportPlan(Array.from({length:columns*rows},()=>item()),{type:'png',columns,rows,showDescription,orientation});
  const g=png.pngPageGeometry(plan,plan.pages[0]);assert.ok(g.width<=g.maxWidth);assert.ok(g.height<=g.maxHeight);assert.equal(g.cells[0].x,0);assert.equal(Math.max(...g.cells.map(c=>c.x+c.size)),g.width);assert.equal(Math.max(...g.cells.map(c=>c.y+c.size+(showDescription?g.descriptionGap+g.text:0))),g.height);
  for(const cell of g.cells){assert.ok(cell.x>=0&&cell.y>=0&&cell.size>0);assert.ok(cell.x+cell.size<=g.width);assert.ok(cell.y+cell.size<=g.height);}
  if(columns>1)assert.equal(g.cells[1].x-g.cells[0].size,g.gap);
  if(rows>1){const last=png.pngPageGeometry(plan,{...plan.pages[0],items:[plan.pages[0].items[0]]});assert.ok(last.height<g.height);assert.equal(last.width,last.size);}
 }
});
function environment(){const draws=[];return {draws,createCanvas:()=>({width:0,height:0,getContext:()=>({getImageData:(x,y,width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4).fill(255)}),fillRect(){},fillText(){},save(){},restore(){},beginPath(){},rect(){},clip(){},drawImage(...args){if(args.length===9)draws.push(args)},measureText:text=>({width:text.length*6})}),toBlob:callback=>callback(new Blob([bytes],{type:'image/png'}))}),loadImage:async()=>({width:384,height:384,close(){}})};}
test('one page downloads directly as PNG; four pages package four named images in a ZIP',async()=>{
 for(const count of [1,43]){
  const plan=exportPlan(Array.from({length:count},()=>item()),{type:'png',columns:2,rows:7,showDescription:true});const env=environment();const blob=await png.createPngExport(plan,env);assert.equal(env.draws.length,count);
  if(count===1)assert.equal(blob.type,'image/png');else{assert.equal(blob.type,'application/zip');const zip=await JSZip.loadAsync(await blob.arrayBuffer());const names=Object.keys(zip.files);assert.equal(names.length,4);assert.ok(names.every(name=>/^audit-page-\d{3}-indoors\.png$/.test(name)));for(const name of names){const data=await zip.file(name).async('uint8array');assert.equal(chunks(data).filter(c=>c.type==='pHYs').length,1);}}
 }
});

test('PNG trim removes every transparent outer row and column without removing internal gaps',()=>{
 const data=new Uint8ClampedArray(5*6*4);for(const [x,y] of [[1,2],[3,4]])data[(y*5+x)*4+3]=255;assert.deepEqual(png.pngContentBounds({width:5,height:6,data}),{x:1,y:2,width:3,height:3});
});
