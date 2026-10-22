import { AutoProcessor, AutoModelForVision2Seq, RawImage, TextStreamer, env } from '@huggingface/transformers';
const MODEL='HuggingFaceTB/SmolVLM2-256M-Video-Instruct';
const REVISION='067788b187b95ebe7b2e040b3e4299e342e5b8fd';
env.allowLocalModels=false;
env.useBrowserCache=true;
env.backends.onnx.wasm.numThreads=1;
env.backends.onnx.wasm.wasmPaths=new URL(`${import.meta.env.BASE_URL}ort/`,self.location.origin).href;
let processor, model, busy=false;
self.onmessage=async ({data})=>{
 if(data.type!=='describe'||busy)return;
 busy=true;
 const send=(type,extra={})=>self.postMessage({type,...extra});
 try{
  const adapter=await navigator.gpu?.requestAdapter();
  if(!adapter)throw new Error('No compatible WebGPU adapter. Try an updated Chrome on Android or Safari on iOS 26+.');
  if(!model){
   send('loading');
   const progress_callback=p=>send('progress',{progress:p});
   processor=await AutoProcessor.from_pretrained(MODEL,{progress_callback,revision:REVISION});
   const fp16=adapter.features.has('shader-f16');
   model=await AutoModelForVision2Seq.from_pretrained(MODEL,{
    revision:REVISION,device:'webgpu',dtype:{embed_tokens:fp16?'fp16':'fp32',vision_encoder:fp16?'fp16':'fp32',decoder_model_merged:fp16?'q4f16':'q4'},progress_callback,
   });
  }
  send('ready');
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
