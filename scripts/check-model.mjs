import assert from 'node:assert/strict';
import { AutoProcessor, AutoTokenizer, RawImage, env } from '@huggingface/transformers';
import { MODELS } from '../src/models.js';
import { prepareInputs, florenceTask } from '../src/inference.js';
env.cacheDir='./.model-test-cache';
const image=new RawImage(new Uint8ClampedArray(64*64*3).fill(128),64,64,3);
for(const model of Object.values(MODELS)){
 const options={revision:model.revision};
 const processor=await AutoProcessor.from_pretrained(model.id,options);
 const tokenizer=model.family==='moondream'?await AutoTokenizer.from_pretrained(model.id,options):processor.tokenizer;
 const inputs=await prepareInputs(model.family,processor,tokenizer,image,'Describe this image.',model.family==='florence'?florenceTask('caption'):undefined);
 assert.equal(inputs.input_ids.dims[0],1);
 assert.ok(inputs.input_ids.dims[1]>0);
 assert.ok(inputs.pixel_values.dims.length>=4);
 console.log(model.label,'processor OK',inputs.input_ids.dims,inputs.pixel_values.dims);
}
