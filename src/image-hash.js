// Version the full-image 9 x 8 resize separately from the 384 x 384 inference crop.
export const IMAGE_HASH_VERSION='dhash-8-v1';
export function validImageHashes(value){return !!value&&/^[a-f0-9]{64}$/.test(value.sourceHash)&&/^[a-f0-9]{16}$/.test(value.dHash)&&value.hashVersion===IMAGE_HASH_VERSION;}
export function sameImageHashes(left,right){return validImageHashes(left)&&validImageHashes(right)&&left.sourceHash===right.sourceHash&&left.dHash===right.dHash;}
export function dHashPixels(pixels){
 if(pixels.length!==9*8*4)throw Error('dHash requires 9 x 8 RGBA pixels.');
 const luminance=i=>30*pixels[i]+59*pixels[i+1]+11*pixels[i+2];
 let hash=0n;
 for(let y=0;y<8;y++)for(let x=0;x<8;x++)if(luminance((y*9+x)*4)>luminance((y*9+x+1)*4))hash|=1n<<BigInt(y*8+x);
 return hash.toString(16).padStart(16,'0');
}
export function imageDHash(image){
 const canvas=document.createElement('canvas');canvas.width=9;canvas.height=8;
 const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='low';
 ctx.drawImage(image,0,0,9,8);
 return dHashPixels(ctx.getImageData(0,0,9,8).data);
}
