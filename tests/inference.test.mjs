import test from 'node:test';
import assert from 'node:assert/strict';
import {modelDtypes,prepareInputs,decodeResult,florenceTask} from '../src/inference.js';

test('each model family selects supported ONNX components',()=>{
 assert.equal(modelDtypes('florence',false).encoder_model,'fp32');
 assert.equal(modelDtypes('florence',true).decoder_model_merged,'q4f16');
 assert.equal(modelDtypes('moondream',false).vision_encoder,'q8');
 assert.equal(modelDtypes('moondream',true).decoder_model_merged,'q4');
 assert.throws(()=>florenceTask('custom'));
});
test('Moondream uses its question template and separate image processor',async()=>{
 let text;const tokenizer=t=>{text=t;return {input_ids:'tokens'}};
 const processor=async image=>({pixel_values:image});
 const got=await prepareInputs('moondream',processor,tokenizer,'image','What color?',undefined);
 assert.equal(text,'<image>\n\nQuestion: What color?\n\nAnswer:');
 assert.deepEqual(got,{input_ids:'tokens',pixel_values:'image'});
});
test('Florence uses image-first preprocessing and preserves encoder-decoder output',async()=>{
 const processor=async(image,prompts)=>({image,prompts});processor.construct_prompts=task=>[task];
 const task=florenceTask('ocr');assert.deepEqual(await prepareInputs('florence',processor,null,'image',undefined,task),{image:'image',prompts:['<OCR>']});
 const output={};processor.batch_decode=actual=>{assert.equal(actual,output);return ['<s>text</s>'];};
 processor.post_process_generation=(text,t,size)=>{assert.equal(t,task);assert.deepEqual(size,[640,480]);return {[task]:'Read me'};};
 assert.equal(decodeResult('florence',processor,null,output,{},task,[640,480]),'Read me');
 processor.post_process_generation=()=>({[task]:{labels:['cat'],bboxes:[[1,2,3,4]]}});
 assert.deepEqual(JSON.parse(decodeResult('florence',processor,null,output,{},task,[640,480])),{labels:['cat'],bboxes:[[1,2,3,4]]});
});
