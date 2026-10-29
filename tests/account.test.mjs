import test from 'node:test';
import assert from 'node:assert/strict';
import {authConfig,cognito,signIn,credentials,authorizedFetch,token} from '../src/account.js';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
test('signup, email verification, login and refresh use Cognito; API calls carry access tokens',async()=>{
 const originalFetch=globalThis.fetch,originalStorage=globalThis.sessionStorage;const values=new Map();globalThis.sessionStorage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};const calls=[];
 globalThis.fetch=async(url,options={})=>{calls.push({url,options});if(url==='/api/auth-config')return json({enabled:true,region:'us-east-1',clientId:'client'});if(url==='/api/sessions')return json({sessions:[]});const body=JSON.parse(options.body);const operation=options.headers['X-Amz-Target'].split('.').at(-1);if(operation==='InitiateAuth')return json({AuthenticationResult:{AccessToken:body.AuthFlow==='REFRESH_TOKEN_AUTH'?'renewed':'access',RefreshToken:'refresh',ExpiresIn:900}});return json({});};
 try{
  assert.equal((await authConfig()).enabled,true);await cognito('SignUp',{Username:'alice@example.com',Password:'SecretPassword12'});await cognito('ConfirmSignUp',{Username:'alice@example.com',ConfirmationCode:'123456'});await signIn('alice@example.com','SecretPassword12');assert.equal(credentials().access,'access');assert.ok(!JSON.stringify(credentials()).includes('Password'));
  await authorizedFetch('/api/sessions');assert.equal(calls.at(-1).options.headers.get('Authorization'),'Bearer access');await token(true);assert.equal(credentials().access,'renewed');assert.ok(calls.some(c=>c.options.body?.includes('REFRESH_TOKEN_AUTH')));
 }finally{globalThis.fetch=originalFetch;globalThis.sessionStorage=originalStorage;}
});
