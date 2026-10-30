import {gridGeometry,pageTitle} from './export-document.js';
const DPI=300;
// Bounded for standard Letter/A4 text areas. PNG density records physical size;
// the raster bounds contain only the heading, photos and enabled captions.
export function pngPageGeometry(plan,page){
 const maxWidth=Math.round((plan.orientation==='landscape'?8.75:6.25)*DPI);
 const maxHeight=Math.round((plan.orientation==='landscape'?6.25:8.75)*DPI);
 const titleReserve=72;
 const g=gridGeometry(maxWidth/DPI,(maxHeight-titleReserve-24)/DPI,plan.columns,plan.rows,plan.showDescription);
 const gap=Math.max(1,Math.round(g.gap*DPI)),text=plan.showDescription?Math.floor(g.text*DPI):0,descriptionGap=plan.showDescription?11:0;
 const size=Math.max(1,Math.floor(Math.min(g.size*DPI,(maxWidth-(plan.columns-1)*gap)/plan.columns,(maxHeight-titleReserve-gap-(plan.rows-1)*gap)/plan.rows-text-descriptionGap)));
 const columns=Math.min(plan.columns,page.items.length),rows=Math.ceil(page.items.length/plan.columns);
 const width=columns*size+(columns-1)*gap,title=pageTitle(page,plan);
 const titleFont=Math.max(8,Math.min(54,Math.floor(width/Math.max(Array.from(title).length*.62,1))));
 const top=Math.ceil(titleFont*1.2)+gap,tileHeight=size+text+descriptionGap;
 const cells=page.items.map((item,i)=>({item,x:i%plan.columns*(size+gap),y:top+Math.floor(i/plan.columns)*(tileHeight+gap),size}));
 return {width,height:top+rows*tileHeight+(rows-1)*gap,maxWidth,maxHeight,size,gap,text,descriptionGap,title,titleFont,cells};
}
const crcTable=Uint32Array.from({length:256},(_,i)=>{let n=i;for(let b=0;b<8;b++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
export function withPngDensity(bytes,dpi=DPI){
 const signature=[137,80,78,71,13,10,26,10];
 if(bytes.length<33||signature.some((b,i)=>bytes[i]!==b)||!Number.isFinite(dpi)||dpi<=0)throw Error('Invalid PNG image or print density.');
 const physical=new Uint8Array(21),data=new DataView(physical.buffer),ppm=Math.round(dpi/.0254);
 data.setUint32(0,9);physical.set([112,72,89,115],4);data.setUint32(8,ppm);data.setUint32(12,ppm);physical[16]=1;data.setUint32(17,crc32(physical.subarray(4,17)));
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),parts=[bytes.subarray(0,8)];let offset=8,inserted=false,ended=false;
 while(offset+12<=bytes.length){
  const length=view.getUint32(offset),end=offset+12+length;if(end>bytes.length)throw Error('Invalid PNG chunk.');
  const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
  if(type!=='pHYs')parts.push(bytes.subarray(offset,end));
  if(type==='IHDR'&&!inserted){parts.push(physical);inserted=true;}
  offset=end;if(type==='IEND'){ended=true;break;}
 }
 if(!inserted||!ended)throw Error('Invalid PNG structure.');
 const result=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
}
function loadImage(url){return new Promise((resolve,reject)=>{const image=new Image();image.decoding='async';image.onload=()=>resolve(image);image.onerror=()=>reject(Error('Could not load a photo for PNG export.'));image.src=url;});}
function wrapText(context,text,width){
 const lines=[];let line='';
 for(const character of Array.from(text.replace(/\s+/gu,' ').trim())){
  if(line&&context.measureText(line+character).width>width){const space=line.lastIndexOf(' ');if(space>0){lines.push(line.slice(0,space));line=line.slice(space+1)+character;}else{lines.push(line);line=character.trimStart();}}
  else line+=character;
 }
 if(line)lines.push(line.trim());return lines;
}
function drawDescription(context,text,x,y,width,height){
 let low=1,high=32,best={font:1,lines:[]};
 while(low<=high){const font=Math.floor((low+high)/2);context.font=`${font}px Arial, sans-serif`;const lines=wrapText(context,text,width);if(lines.length*Math.ceil(font*1.2)<=height){best={font,lines};low=font+1;}else high=font-1;}
 context.font=`${best.font}px Arial, sans-serif`;context.textAlign='center';context.fillStyle='#222222';context.textBaseline='top';const lineHeight=Math.ceil(best.font*1.2);
 context.save();context.beginPath();context.rect(x,y,width,height);context.clip();best.lines.forEach((line,i)=>context.fillText(line,x+width/2,y+i*lineHeight,width));context.restore();return y+best.lines.length*lineHeight;
}
function pngBlob(canvas){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('Could not create PNG image. Try fewer photos per page.')),'image/png'));}
export function pngContentBounds({data,width,height}){
 const rowHasInk=y=>{for(let x=0;x<width;x++)if(data[(y*width+x)*4+3])return true;return false;};
 let top=0,bottom=height-1;while(top<height&&!rowHasInk(top))top++;if(top===height)return null;while(bottom>top&&!rowHasInk(bottom))bottom--;
 const columnHasInk=x=>{for(let y=top;y<=bottom;y++)if(data[(y*width+x)*4+3])return true;return false;};
 let left=0,right=width-1;while(left<width&&!columnHasInk(left))left++;while(right>left&&!columnHasInk(right))right--;
 return {x:left,y:top,width:right-left+1,height:bottom-top+1};
}
export async function renderPage(plan,page,{createCanvas,loadImage:decode}){
 const g=pngPageGeometry(plan,page),canvas=createCanvas();let cropped;
 try{
  canvas.width=g.width;canvas.height=g.height;const context=canvas.getContext('2d');if(!context)throw Error('PNG export requires Canvas support.');
  context.fillStyle='#111111';context.font=`bold ${g.titleFont}px Arial, sans-serif`;context.textBaseline='top';context.fillText(g.title,0,0,g.width);
  for(const cell of g.cells){
   const image=await decode(cell.item.image);
   try{const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height,edge=Math.min(width,height);context.drawImage(image,(width-edge)/2,(height-edge)/2,edge,edge,cell.x,cell.y,cell.size,cell.size);}finally{image.close?.();}
   if(plan.showDescription)drawDescription(context,cell.item.description,cell.x,cell.y+cell.size+g.descriptionGap,cell.size,g.text);
  }
  const bounds=pngContentBounds(context.getImageData(0,0,g.width,g.height));if(!bounds)throw Error('PNG export produced an empty page.');
  let output=canvas;
  if(bounds.x||bounds.y||bounds.width!==g.width||bounds.height!==g.height){
   cropped=createCanvas();cropped.width=bounds.width;cropped.height=bounds.height;const cropContext=cropped.getContext('2d');if(!cropContext)throw Error('PNG export requires Canvas support.');
   cropContext.drawImage(canvas,bounds.x,bounds.y,bounds.width,bounds.height,0,0,bounds.width,bounds.height);output=cropped;
  }
  const blob=await pngBlob(output);return withPngDensity(new Uint8Array(await blob.arrayBuffer()));
 }finally{canvas.width=canvas.height=1;if(cropped)cropped.width=cropped.height=1;}
}
export async function createPngExport(plan,{createCanvas=()=>document.createElement('canvas'),loadImage:decode=loadImage,onProgress=()=>{}}={}){
 const files=[];
 for(const [index,page] of plan.pages.entries()){
  onProgress(index+1,plan.pages.length);
  const data=await renderPage(plan,page,{createCanvas,loadImage:decode});
  files.push({name:`audit-page-${String(index+1).padStart(3,'0')}-${page.category.toLowerCase().replaceAll(' ','-')}.png`,data});
 }
 if(files.length===1)return new Blob([files[0].data],{type:'image/png'});
 const {default:JSZip}=await import('jszip');const zip=new JSZip();for(const file of files)zip.file(file.name,file.data);
 return zip.generateAsync({type:'blob',mimeType:'application/zip',compression:'STORE',streamFiles:true});
}
