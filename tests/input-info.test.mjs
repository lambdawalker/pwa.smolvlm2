import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256,precisionLabel,HASH_LABEL_LENGTH } from '../src/input-info.js';
test('prompt hashes use SHA-256 of exact UTF-8 bytes',async()=>{
 assert.equal(await sha256('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 assert.equal(await sha256('abc'),await sha256(new TextEncoder().encode('abc')));
 assert.notEqual(await sha256('abc'),await sha256('abc '));assert.equal(HASH_LABEL_LENGTH,12);
});
test('precision labels retain separate encoder and decoder dtypes',()=>{
 const label=precisionLabel({vision_encoder:'fp16',decoder_model_merged:'q4f16'});assert.match(label,/vision_encoder: fp16/);assert.match(label,/decoder_model_merged: q4f16/);
});
