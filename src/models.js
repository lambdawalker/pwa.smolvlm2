export const MODELS = {
 '256m': {id:'HuggingFaceTB/SmolVLM2-256M-Video-Instruct',revision:'067788b187b95ebe7b2e040b3e4299e342e5b8fd',label:'SmolVLM2 · 256M',download:'About 350–650 MB',hint:'Smaller download and lower memory use. Recommended for phones.'},
 '500m': {id:'HuggingFaceTB/SmolVLM2-500M-Video-Instruct',revision:'7399a563358e40b8862c9510a86139d2225b6b95',label:'SmolVLM2 · 500M',download:'About 550–900 MB',hint:'Larger model; needs more memory and may take longer on your phone.'},
};
export const DEFAULT_MODEL='256m';
export function getModel(key){if(!Object.hasOwn(MODELS,key))throw new Error('Choose a supported model.');return MODELS[key];}
