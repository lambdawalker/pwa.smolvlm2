import { AutoProcessor,RawImage,env } from '@huggingface/transformers';
import { MODELS } from '../src/models.js';
import { prepareInputs } from '../src/inference.js';
env.cacheDir='./.model-test-cache';
for(const key of ['256m','500m','smolvlm-500m']){
 const model=MODELS[key];const processor=await AutoProcessor.from_pretrained(model.id,{revision:model.revision});
 for(const width of [256,512,768,1536]){
  const height=Math.round(width*.75);const image=new RawImage(new Uint8ClampedArray(width*height*3).fill(128),width,height,3);
  const inputs=await prepareInputs(model.family,processor,processor.tokenizer,image,'Describe this image.');
  console.log(model.label,`${width}x${height}`,'=>',inputs.pixel_values.dims,'tokens:',inputs.input_ids.dims[1]);
 }
}
