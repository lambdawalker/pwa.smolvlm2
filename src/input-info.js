export const HASH_LABEL_LENGTH=12;
export async function sha256(value){
 const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function precisionLabel(dtype){return dtype?Object.entries(dtype).map(([part,type])=>`${part}: ${type}`).join(' · '):'Precision: waiting for model';}
export function imageInfoLabel(info){
 if(!info)return '';
 return `Source: ${info.sourceWidth}×${info.sourceHeight} · ${info.sourceMime||'unknown MIME'} · ${info.sourceBytes} bytes\nPrepared: ${info.width}×${info.height} · JPEG quality 0.88 · ${info.preparedBytes} bytes\nFile ID: ${info.sourceHash.slice(0,HASH_LABEL_LENGTH)} · Image ID: ${info.preparedHash.slice(0,HASH_LABEL_LENGTH)} · Pixel ID: ${info.pixelHash.slice(0,HASH_LABEL_LENGTH)}`;
}
