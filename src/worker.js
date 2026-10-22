import { AutoProcessor, AutoModelForVision2Seq, RawImage, TextStreamer, env } from '@huggingface/transformers';
import { getModel } from './models.js';
env.allowLocalModels=false;
env.useBrowserCache=true;
env.backends.onnx.wasm.numThreads=1;
env.backends.onnx.wasm.wasmPaths=new URL(`${import.meta.env.BASE_URL}ort/`,self.location.origin).href;
let processor, model, modelKey, busy=false;
self.onmessage=async ({data})=>{
 if(!['load','describe'].includes(data.type)||busy)return;
 busy=true;
 const send=(type,extra={})=>self.postMessage({type,...extra});
 try{
  const selected=getModel(data.model);
  if(model && modelKey!==data.model)throw new Error('Restart the worker before changing models.');
  const adapter=await navigator.gpu?.requestAdapter();
  if(!adapter)throw new Error('No compatible WebGPU adapter. Try an updated Chrome on Android or Safari on iOS 26+.');
  if(!model){
   send('loading');
   const progress_callback=p=>send('progress',{progress:p});
   processor=await AutoProcessor.from_pretrained(selected.id,{progress_callback,revision:selected.revision});
   const fp16=adapter.features.has('shader-f16');
   model=await AutoModelForVision2Seq.from_pretrained(selected.id,{
    revision:selected.revision,device:'webgpu',dtype:{embed_tokens:fp16?'fp16':'fp32',vision_encoder:fp16?'fp16':'fp32',decoder_model_merged:fp16?'q4f16':'q4'},progress_callback,
   });
  }
  modelKey=data.model;
  send('ready');
  if(data.type==='load')return;
  const image=await RawImage.fromURL(data.image);
  const messages=[{role:'user',content:[{type:'image'},{type:'text',text:data.prompt}]}];
  const text=processor.apply_chat_template(messages,{add_generation_prompt:true});
  const inputs=await processor(text,[image],{do_image_splitting:false});
  send('generating');const start=performance.now();
  const streamer=new TextStreamer(processor.tokenizer,{skip_prompt:true,skip_special_tokens:true,callback_function:text=>send('token',{text})});
  const output=await model.generate({...inputs,max_new_tokens:180,do_sample:false,repetition_penalty:1.1,streamer});
  // Decode only new tokens, never the user prompt.
  const generated=output.slice(null,[inputs.input_ids.dims.at(-1),null]);
  const result=processor.batch_decode(generated,{skip_special_tokens:true})[0].trim();
  send('complete',{text:result,seconds:(performance.now()-start)/1000});
 }catch(error){send('error',{message:error.message||String(error)});}
 finally{busy=false;}
};
