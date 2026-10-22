import assert from 'node:assert/strict';
import { AutoProcessor, RawImage, env } from '@huggingface/transformers';
import { MODELS } from '../src/models.js';
env.cacheDir='./.model-test-cache';
for(const model of Object.values(MODELS)){
const processor=await AutoProcessor.from_pretrained(model.id,{revision:model.revision});
const prompt=processor.apply_chat_template([{role:'user',content:[{type:'image'},{type:'text',text:'Describe this image.'}]}],{add_generation_prompt:true});
const image=new RawImage(new Uint8ClampedArray(64*64*3).fill(128),64,64,3);
const inputs=await processor(prompt,[image],{do_image_splitting:false});
console.log(model.label,'Processor OK',Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.dims])));

assert.equal(inputs.input_ids.dims[0], 1);
assert.deepEqual(inputs.pixel_values.dims, [1,1,3,512,512]);
assert.ok(inputs.input_ids.dims[1] > 64);

}
