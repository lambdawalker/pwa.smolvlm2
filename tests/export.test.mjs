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
 assert.deepEqual(plan.pages.map(p=>[p.category,p.items.length]),[['Indoors',7],['Outdoors',1]]);
 assert.equal(plan.type,'pptx');assert.equal(plan.columns,2);assert.equal(plan.rows,7);
 assert.throws(()=>exportPlan(items,{columns:17}),/1–16 columns/);
 assert.throws(()=>exportPlan([]),/at least one/);
 assert.throws(()=>exportPlan([{state:'done',category:'Indoors'}]),/unavailable/);
});
test('both document formats and layouts produce zipped Office documents',async()=>{
 for(const type of ['docx','pptx'])for(const layout of ['cards','table']){
  const blob=await createDocument([item('Indoors'),item('Outdoors')],{type,layout,showDescription:true});
  const bytes=new Uint8Array(await blob.arrayBuffer());assert.equal(String.fromCharCode(...bytes.slice(0,2)),'PK');assert.ok(bytes.length>1000);
  const zip=await JSZip.loadAsync(bytes);
  if(type==='docx'){
   const xml=await zip.file('word/document.xml').async('string');
   assert.match(xml,/Indoors/);assert.match(xml,/Outdoors/);assert.match(xml,/A bright room/);assert.match(xml,/pageBreakBefore/);assert.doesNotMatch(xml,/w:shd|w:val="single"/);
   assert.ok(Object.keys(zip.files).some(name=>name.startsWith('word/media/')&&name.endsWith('.jpg')));
  }else{
   const slides=Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name));assert.equal(slides.length,2);
   const xml=await zip.file(slides[0]).async('string');assert.match(xml,/Indoors/);assert.match(xml,/A bright room/);assert.match(xml,/<p:pic>/);
   assert.doesNotMatch(xml,/<a:tbl>|roundRect|F0F5F2|D9D9D9/);
  }

 }
});

test('rows determine pagination and always includes category headings',async()=>{
 for(const rows of [1,2,3,4,5,6])for(const columns of [1,2,3,4]){
  const plan=exportPlan([item('Indoors')],{rows,columns});assert.equal(plan.perPage,rows*columns);assert.equal(plan.orientation,'portrait');assert.equal(plan.showDescription,false);
 }
 for(const type of ['docx','pptx']){
  const blob=await createDocument([item('Indoors')],{type,showDescription:false,showCategory:false,columns:4,imageSize:'big'});
  const zip=await JSZip.loadAsync(await blob.arrayBuffer());
  const path=type==='docx'?'word/document.xml':'ppt/slides/slide1.xml';const xml=await zip.file(path).async('string');
  assert.ok(xml.includes('Indoors'));assert.ok(!xml.includes('A bright room'));
 }
});
test('portrait orientation is encoded in both document formats',async()=>{
 for(const type of ['docx','pptx']){
  const blob=await createDocument([item('Indoors')],{type,orientation:'portrait'});
  const zip=await JSZip.loadAsync(await blob.arrayBuffer());
  const xml=await zip.file(type==='docx'?'word/document.xml':'ppt/presentation.xml').async('string');
  if(type==='docx')assert.match(xml,/w:orient="portrait"/);
  else {const size=xml.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);assert.ok(size);assert.ok(Number(size[2])>Number(size[1]));}
 }
});

test('Spanish documents localize headings and Word restricts layout to table',async()=>{
 assert.equal(exportPlan([item('Indoors')],{type:'docx',layout:'cards',rows:2}).layout,'table');
 assert.equal(exportPlan([item('Indoors')],{type:'pptx',layout:'cards',rows:2}).layout,'cards');
 for(const type of ['docx','pptx']){
  const blob=await createDocument([item('Indoors')],{type,language:'es',rows:2});const zip=await JSZip.loadAsync(await blob.arrayBuffer());const xml=await zip.file(type==='docx'?'word/document.xml':'ppt/slides/slide1.xml').async('string');assert.match(xml,/Interiores/);assert.ok(!xml.includes('A bright room'));
 }
 assert.throws(()=>exportPlan([item('Indoors')],{rows:0}),/1–16 rows/);
});

test('typed dimensions support 16 by 16 and reject invalid values',async()=>{
 const plan=exportPlan([item('Indoors')],{rows:'16',columns:'16'});assert.equal(plan.perPage,256);
 for(const invalid of [0,17,1.5,'',NaN])for(const field of ['rows','columns'])assert.throws(()=>exportPlan([item('Indoors')],{[field]:invalid}),/1–16/);
 for(const type of ['docx','pptx'])for(const layout of ['table','cards'])for(const showDescription of [false,true]){
  const blob=await createDocument([item('Indoors')],{type,layout,showDescription,rows:16,columns:16});const zip=await JSZip.loadAsync(await blob.arrayBuffer());
  const xml=await zip.file(type==='docx'?'word/document.xml':'ppt/slides/slide1.xml').async('string');assert.ok(!/(?:w:w|cx|cy)="-/.test(xml));
 }
});

test('photo geometry maximizes square photos within cells with positive gutters',async()=>{
 const {gridGeometry}=await import('../src/export-document.js');
 for(const columns of [1,2,16])for(const rows of [1,7,16])for(const description of [false,true]){
  const g=gridGeometry(6.7,12.05,columns,rows,description);assert.ok(g.gap>0);assert.ok(g.size<=g.w);assert.ok(g.size+g.text<=g.h);assert.ok(Math.abs(g.size-Math.min(g.w,g.h-g.text-(description?.035:0)))<.001);
 }
});
