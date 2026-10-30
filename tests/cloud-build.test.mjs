import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
test('the shipped app has no local model runtime or download controls',()=>{
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));assert.equal(pkg.dependencies['@huggingface/transformers'],undefined);assert.equal(existsSync(new URL('../src/worker.js',import.meta.url)),false);
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');assert.doesNotMatch(html,/batch-model|file-downloads|Manage on-device/);assert.match(html,/Amazon Bedrock/);
 const assets=readFileSync(new URL('../scripts/assets.mjs',import.meta.url),'utf8');assert.doesNotMatch(assets,/node_modules\/onnxruntime/);
});
