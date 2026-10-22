export const MODELS = {
 '256m': {family:'smolvlm',id:'HuggingFaceTB/SmolVLM2-256M-Video-Instruct',revision:'067788b187b95ebe7b2e040b3e4299e342e5b8fd',label:'SmolVLM2 · 256M',download:'About 350–650 MB',hint:'Smaller download and lower memory use. Recommended for phones.'},
 '500m': {family:'smolvlm',id:'HuggingFaceTB/SmolVLM2-500M-Video-Instruct',revision:'7399a563358e40b8862c9510a86139d2225b6b95',label:'SmolVLM2 · 500M',download:'About 550–900 MB',hint:'Larger model; needs more memory and may take longer on your phone.'},
 'smolvlm-500m': {family:'smolvlm',id:'HuggingFaceTB/SmolVLM-500M-Instruct',revision:'a7da5b986cb59b408707209984f360a5f4ad7e47',label:'SmolVLM · 500M (original)',download:'About 550–900 MB',hint:'Original image-focused SmolVLM. Supports descriptions and custom questions.'},
 'florence': {family:'florence',id:'onnx-community/Florence-2-base-ft',revision:'e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f',label:'Florence-2 Base · 230M',download:'About 450–850 MB',hint:'Task-based captions, text extraction and object detection. Not a general chat model.'},
 'moondream': {family:'moondream',id:'Xenova/moondream2',revision:'2d577a7ec3b54cce81456f5358d7aa815d587079',label:'Moondream2',download:'About 1.5–1.8 GB',hint:'Image questions and descriptions. Much larger download and memory use; may not fit on your phone.'},

};
export const DEFAULT_MODEL='256m';
export function getModel(key){if(!Object.hasOwn(MODELS,key))throw new Error('Choose a supported model.');return MODELS[key];}
