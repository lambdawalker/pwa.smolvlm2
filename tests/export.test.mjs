import test from 'node:test';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
import {exportPlan} from '../src/export-plan.js';
import {createDocument} from '../src/export-document.js';
const image='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCYAAP/2Q==';
const item=category=>({state:'done',category,description:'A bright room with windows.',exportImage:image});
test('export paginates categories separately and skips unfinished photos',()=>{
 const items=[...Array.from({length:7},()=>item('Indoors')),item('Outdoors'),{state:'pending',category:'Documents'}];
 const plan=exportPlan(items);
 assert.deepEqual(plan.pages.map(p=>[p.category,p.items.length]),[['Indoors',6],['Indoors',1],['Outdoors',1]]);
 assert.equal(plan.columns,2);assert.equal(plan.rows,3);
 assert.throws(()=>exportPlan(items,{perPage:12,columns:1}),/four rows/);
 assert.throws(()=>exportPlan([]),/at least one/);
 assert.throws(()=>exportPlan([{state:'done',category:'Indoors'}]),/unavailable/);
});
test('both document formats and layouts produce zipped Office documents',async()=>{
 for(const type of ['docx','pptx'])for(const layout of ['cards','table']){
  const blob=await createDocument([item('Indoors'),item('Outdoors')],{type,layout});
  const bytes=new Uint8Array(await blob.arrayBuffer());assert.equal(String.fromCharCode(...bytes.slice(0,2)),'PK');assert.ok(bytes.length>1000);
  const zip=await JSZip.loadAsync(bytes);
  if(type==='docx'){
   const xml=await zip.file('word/document.xml').async('string');
   assert.match(xml,/Indoors/);assert.match(xml,/Outdoors/);assert.match(xml,/A bright room/);assert.match(xml,/pageBreakBefore/);
   assert.ok(Object.keys(zip.files).some(name=>name.startsWith('word/media/')&&name.endsWith('.jpg')));
  }else{
   const slides=Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name));assert.equal(slides.length,2);
   const xml=await zip.file(slides[0]).async('string');assert.match(xml,/Indoors/);assert.match(xml,/A bright room/);assert.match(xml,/<p:pic>/);
   if(layout==='table')assert.match(xml,/<a:tbl>/);
  }

 }
});
