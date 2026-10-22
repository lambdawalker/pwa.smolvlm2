import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {RawImage} from '@huggingface/transformers';
const sharp=createRequire(import.meta.resolve('@huggingface/transformers'))('sharp');
const {imageSize}=createRequire(import.meta.resolve('pptxgenjs'))('image-size');
test('patched image dependencies remain compatible with the existing model runtime',async()=>{
 const png=await sharp({create:{width:32,height:24,channels:3,background:{r:100,g:120,b:140}}}).png().toBuffer();
 const dimensions=imageSize(png);assert.equal(dimensions.width,32);assert.equal(dimensions.height,24);
 const image=await RawImage.fromBlob(new Blob([png],{type:'image/png'}));assert.equal(image.width,32);assert.equal(image.height,24);
 const resized=await image.resize(16,12);assert.equal(resized.width,16);assert.equal(resized.height,12);assert.equal(resized.data.length,16*12*resized.channels);
});
