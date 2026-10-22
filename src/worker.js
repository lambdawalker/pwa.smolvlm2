import { AutoProcessor, AutoTokenizer, AutoModelForVision2Seq, Florence2ForConditionalGeneration, Moondream1ForConditionalGeneration, RawImage, TextStreamer, env } from '@huggingface/transformers';
import { getModel } from './models.js';
import { florenceTask, modelDtypes, prepareInputs, decodeResult } from './inference.js';
env.allowLocalModels=false;
env.useBrowserCache=true;
env.backends.onnx.wasm.numThreads=1;
env.backends.onnx.wasm.wasmPaths=new URL(`${import.meta.env.BASE_URL}ort/`,self.location.origin).href;
let processor, tokenizer, model, modelKey, busy=false;
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
   tokenizer=selected.family==='moondream'?await AutoTokenizer.from_pretrained(selected.id,{progress_callback,revision:selected.revision}):processor.tokenizer;
   const Model=selected.family==='florence'?Florence2ForConditionalGeneration:selected.family==='moondream'?Moondream1ForConditionalGeneration:AutoModelForVision2Seq;
   model=await Model.from_pretrained(selected.id,{
    revision:selected.revision,device:'webgpu',dtype:modelDtypes(selected.family,fp16),progress_callback,
   });
  }
  modelKey=data.model;
  send('ready');
  if(data.type==='load')return;
  const image=await RawImage.fromURL(data.image);

  const task=selected.family==='florence'?florenceTask(data.task):undefined;
  const inputs=await prepareInputs(selected.family,processor,tokenizer,image,data.prompt,task);
  send('generating');const start=performance.now();
  const generation={...inputs,max_new_tokens:selected.family==='florence'?512:180,do_sample:false};
  if(selected.family!=='florence'){
   generation.repetition_penalty=1.1;
   generation.streamer=new TextStreamer(tokenizer,{skip_prompt:true,skip_special_tokens:true,callback_function:text=>send('token',{text})});
  }
  const output=await model.generate(generation);
  const result=decodeResult(selected.family,processor,tokenizer,output,inputs,task,image.size);
  send('complete',{text:result,seconds:(performance.now()-start)/1000});
 }catch(error){send('error',{message:error.message||String(error)});}
 finally{busy=false;}
};
