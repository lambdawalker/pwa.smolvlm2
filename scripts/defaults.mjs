import {readFile,writeFile} from 'node:fs/promises';
import {parse} from 'yaml';
const file=new URL('../config/categorization-defaults.yaml',import.meta.url);
const defaults=parse(await readFile(file,'utf8'));
const fail=message=>{throw new Error(`Invalid categorization-defaults.yaml: ${message}`);};
function choice(object,key,values){if(!values.includes(object?.[key]))fail(`${key} must be one of ${values.join(', ')}`);}
function integer(object,key,min,max){if(!Number.isInteger(object?.[key])||object[key]<min||object[key]>max)fail(`${key} must be an integer from ${min} to ${max}`);}
const i=defaults?.interface,d=defaults?.document;
choice(i,'language',['en','es']);choice(i,'model',['gemma-cloud','256m','500m','smolvlm-500m','moondream']);choice(i,'view',['grid','list']);integer(i,'simultaneousImages',1,3);
for(const key of ['autoCategorize','leftHanded','cloudConsent','showImageDetails','showTroubleshooting'])if(typeof i[key]!=='boolean')fail(`${key} must be true or false`);
if(typeof i.prompt!=='string'||!i.prompt.trim()||i.prompt.length>850)fail('prompt must contain 1–850 characters (leaving room for the Spanish instruction)');
choice(d,'type',['docx','pptx']);choice(d,'orientation',['portrait','landscape']);choice(d,'layout',['table','cards']);integer(d,'rows',1,16);integer(d,'columns',1,16);
if(typeof d.addDescription!=='boolean')fail('addDescription must be true or false');
await writeFile(new URL('../src/defaults.generated.js',import.meta.url),'// Generated from config/categorization-defaults.yaml. Do not edit.\nexport const defaults = '+JSON.stringify(defaults,null,2)+';\n');
