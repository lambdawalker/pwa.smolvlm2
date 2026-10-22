export const PROMPTS = {
 brief: 'Describe this image in two clear, factual sentences.',
 detail: 'Describe the visible subjects, setting, colors, and actions in this image. Be factual and concise.',
 alt: 'Write concise alt text for this image. Describe the main visible subject and relevant context. Do not begin with "Image of".',
};
export function fitDimensions(width,height,max=768){
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('Invalid image dimensions.');
 const scale=Math.min(1,max/Math.max(width,height));return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
}
export function validatePhoto(file){
 if(!file)throw new Error('Choose a photo first.');
 if(file.size>30*1024*1024)throw new Error('Choose a photo smaller than 30 MB.');
 if(file.type && !file.type.startsWith('image/'))throw new Error('Choose an image file.');
}
export function friendlyError(message){
 if(/out of memory|allocation|buffer size|device lost/i.test(message))return 'This device ran out of GPU memory. Close other tabs and retry, or try a newer device.';
 if(/fetch|network|offline|load failed/i.test(message))return 'A model file could not be loaded. Connect to the internet and retry; cached files will be reused.';
 return message || 'Something went wrong. Please try again.';
}

export function resolvePrompt(style,custom=''){
 if(style!=='custom'){
  if(!Object.hasOwn(PROMPTS,style))throw new Error('Choose a description style.');
  return PROMPTS[style];
 }
 const prompt=custom.trim();
 if(!prompt)throw new Error('Enter a question or instruction for your photo.');
 if(prompt.length>1000)throw new Error('Keep your prompt under 1,000 characters.');
 return prompt;
}
