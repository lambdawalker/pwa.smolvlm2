import test from 'node:test';
import assert from 'node:assert/strict';
import {t,languagePrompt} from '../src/i18n.js';
test('Spanish keeps canonical categories in model requests and localizes UI counts',()=>{
 assert.equal(t('Indoors','es'),'Interiores');assert.equal(t('1 need attention','es'),'1 requieren atención');
 assert.equal(t('2 of 3 processed | 2 categorized | ','es'),'2 de 3 procesadas | 2 clasificadas | ');
 assert.match(languagePrompt('Return JSON.','es'),/description in Spanish/);assert.match(languagePrompt('Return JSON.','es'),/category values exactly/);
 assert.equal(languagePrompt('Return JSON.','en'),'Return JSON.');
});
