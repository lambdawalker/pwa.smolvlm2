import assert from 'node:assert/strict';
import { AutoProcessor, RawImage, env } from '@huggingface/transformers';
env.cacheDir='./.model-test-cache';
const processor=await AutoProcessor.from_pretrained('HuggingFaceTB/SmolVLM2-256M-Video-Instruct',{revision:'067788b187b95ebe7b2e040b3e4299e342e5b8fd'});
const prompt=processor.apply_chat_template([{role:'user',content:[{type:'image'},{type:'text',text:'Describe this image.'}]}],{add_generation_prompt:true});
const image=new RawImage(new Uint8ClampedArray(64*64*3).fill(128),64,64,3);
const inputs=await processor(prompt,[image],{do_image_splitting:false});
console.log('Processor OK',Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.dims])));

assert.equal(inputs.input_ids.dims[0], 1);
assert.deepEqual(inputs.pixel_values.dims, [1,1,3,512,512]);
assert.ok(inputs.input_ids.dims[1] > 64);
