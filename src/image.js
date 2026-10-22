import { fitDimensions, validatePhoto } from './core.js';
export async function preparePhoto(file){
 validatePhoto(file);
 const url=URL.createObjectURL(file);
 try{
  const img=new Image(); img.src=url; await img.decode();
  if(img.naturalWidth*img.naturalHeight>60_000_000)throw new Error('This photo is very large. Export a smaller copy and try again.');
  const {width,height}=fitDimensions(img.naturalWidth,img.naturalHeight);
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.drawImage(img,0,0,width,height);
  return {url:canvas.toDataURL('image/jpeg',.88),width,height};
 }catch(e){
  if(e.message.includes('very large'))throw e;
  throw new Error('This browser cannot open that photo. For HEIC/HEIF, export it as JPEG or choose a screenshot.');
 }finally{URL.revokeObjectURL(url);}
}
