import { mkdir, readdir, copyFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
// Ship ONNX Runtime's matching binaries locally; no CDN dependency when offline.
await mkdir('public/ort', {recursive:true});
for (const name of await readdir('node_modules/onnxruntime-web/dist')) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(name)) await copyFile(`node_modules/onnxruntime-web/dist/${name}`, `public/ort/${name}`);
}
// Dependency-free PNG icons. A cream lens on a forest-green tile.
function crc32(bytes) { let c=0xffffffff; for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0; }
function chunk(type,data){const t=Buffer.from(type),n=Buffer.alloc(4),crc=Buffer.alloc(4);n.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([n,t,data,crc]);}
await mkdir('public/icons',{recursive:true});
for(const size of [180,192,512]){
 const pixels=Buffer.alloc(size*(size*3+1));
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const r=Math.hypot(x-size/2,y-size/2)/size;
  const cream=(r>.205&&r<.25)||(x>size*.64&&x<size*.70&&y>size*.28&&y<size*.34);
  const color=cream?[245,242,220]:[22,79,70];const i=y*(size*3+1)+1+x*3;pixels.set(color,i);
 }
 const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=2;
 await writeFile(`public/icons/icon-${size}.png`,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
}
