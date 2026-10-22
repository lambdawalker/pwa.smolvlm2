import { sha256 } from './input-info.js';
import { fitDimensions, validatePhoto } from './core.js';
export async function preparePhoto(file,{centerCrop=false}={}){
 validatePhoto(file);
 const url=URL.createObjectURL(file);
 try{
  const img=new Image(); img.src=url; await img.decode();
  if(img.naturalWidth*img.naturalHeight>60_000_000)throw new Error('This photo is very large. Export a smaller copy and try again.');
  const {width,height}=centerCrop?{width:384,height:384}:fitDimensions(img.naturalWidth,img.naturalHeight);
  const side=Math.min(img.naturalWidth,img.naturalHeight);
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);if(centerCrop)ctx.drawImage(img,(img.naturalWidth-side)/2,(img.naturalHeight-side)/2,side,side,0,0,width,height);else ctx.drawImage(img,0,0,width,height);
  const preparedURL=canvas.toDataURL('image/jpeg',.88);
  const encoded=Uint8Array.from(atob(preparedURL.split(',')[1]),c=>c.charCodeAt(0));
  const info={crop:centerCrop?{x:(img.naturalWidth-side)/2,y:(img.naturalHeight-side)/2,width:side,height:side}:null,sourceWidth:img.naturalWidth,sourceHeight:img.naturalHeight,sourceMime:file.type,sourceBytes:file.size,width,height,preparedBytes:encoded.length,
   sourceHash:await sha256(await file.arrayBuffer()),preparedHash:await sha256(encoded),pixelHash:await sha256(ctx.getImageData(0,0,width,height).data)};
  return {url:preparedURL,width,height,info};
 }catch(e){
  if(e.message.includes('very large'))throw e;
  throw new Error('This browser cannot open that photo. For HEIC/HEIF, export it as JPEG or choose a screenshot.');
 }finally{URL.revokeObjectURL(url);}
}
