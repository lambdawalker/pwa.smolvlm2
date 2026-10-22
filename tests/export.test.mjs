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
 assert.throws(()=>exportPlan(items,{columns:5}),/1–4 columns/);
 assert.throws(()=>exportPlan([]),/at least one/);
 assert.throws(()=>exportPlan([{state:'done',category:'Indoors'}]),/unavailable/);
});
test('both document formats and layouts produce zipped Office documents',async()=>{
 for(const type of ['docx','pptx'])for(const layout of ['cards','table']){
  const blob=await createDocument([item('Indoors'),item('Outdoors')],{type,layout,showCategory:true});
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

test('image sizes determine pagination and defaults hide category headings',async()=>{
 for(const [imageSize,rows] of [['small',4],['medium',3],['big',2]])for(const columns of [1,2,3,4]){
  const plan=exportPlan([item('Indoors')],{imageSize,columns});assert.equal(plan.perPage,rows*columns);assert.equal(plan.showCategory,false);assert.equal(plan.showDescription,true);
 }
 for(const type of ['docx','pptx']){
  const blob=await createDocument([item('Indoors')],{type,showDescription:false,showCategory:false,columns:4,imageSize:'big'});
  const zip=await JSZip.loadAsync(await blob.arrayBuffer());
  const path=type==='docx'?'word/document.xml':'ppt/slides/slide1.xml';const xml=await zip.file(path).async('string');
  assert.ok(!xml.includes('Indoors'));assert.ok(!xml.includes('A bright room'));
 }
});
