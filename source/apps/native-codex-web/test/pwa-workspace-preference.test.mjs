import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../public/native-loader.js',import.meta.url),'utf8')).replace('__BETTER_CODEX_NATIVE_RELEASE__',JSON.stringify({shell:'/betterCodex-native-assets/aaaaaaaaaaaaaaaa/shell.html',scope:'/scope.js'}));
function boot({href='https://example.test/?workspace=ai&view=chat&nativeList=1',standalone=false,local=new Map(),session=new Map()}={}){
 const storage=map=>({getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v)}),localStorage=storage(local),sessionStorage=storage(session),root={};let canonical=href;
 const context={window:{},URL,location:new URL(href),navigator:{},localStorage,sessionStorage,matchMedia:()=>({matches:standalone}),crypto:{getRandomValues:a=>a.fill(7)},document:{getElementById:()=>root,querySelector:()=>null,createElement:()=>({}),head:{append(){}}},history:{state:{},replaceState(state,title,url){canonical=new URL(url,href).href;}}};
 vm.runInNewContext(source,context);return {window:context.window,context,local,root,get canonical(){return canonical}};
}
test('legacy installed PWA start URL cannot overwrite the last selected workspace',()=>{const local=new Map([['betterCodex-preferred-workspace','secondary']]);const first=boot({standalone:true,local});assert.equal(first.window.__BETTER_CODEX_SCOPE__.id,'secondary');assert.equal(new URL(first.canonical).searchParams.get('workspace'),'secondary');const next=boot({standalone:true,local});assert.equal(next.window.__BETTER_CODEX_SCOPE__.id,'secondary');});
test('two installed PWA identities remember their own last workspace',()=>{const local=new Map();const launch=id=>'https://example.test/?pwa='+id+'&workspace='+id+'&launch=1';boot({href:launch('ai'),standalone:true,local}).window.__BETTER_CODEX_SET_PREFERRED_WORKSPACE__('secondary');boot({href:launch('secondary'),standalone:true,local}).window.__BETTER_CODEX_SET_PREFERRED_WORKSPACE__('ai');assert.equal(boot({href:launch('ai'),standalone:true,local}).window.__BETTER_CODEX_SCOPE__.id,'secondary');assert.equal(boot({href:launch('secondary'),standalone:true,local}).window.__BETTER_CODEX_SCOPE__.id,'ai');});
test('an intentional switch wins over saved launch state and survives native storage namespacing',()=>{const local=new Map([['betterCodex-preferred-workspace:browser','ai']]);const x=boot({href:'https://example.test/?workspace=secondary&switchWorkspace=1',local});assert.equal(x.window.__BETTER_CODEX_SCOPE__.id,'secondary');x.context.localStorage.setItem=(k,v)=>local.set('native:'+k,v);x.window.__BETTER_CODEX_SET_PREFERRED_WORKSPACE__('ai');assert.equal(local.get('betterCodex-preferred-workspace:browser'),'ai');assert(!new URL(x.canonical).searchParams.has('switchWorkspace'));});
test('notification deep links display the requested scope without changing the next launch',()=>{const local=new Map([['betterCodex-preferred-workspace:browser','secondary']]);const x=boot({href:'https://example.test/local/00000000-0000-4000-8000-4ba7215b54d2?workspace=ai&fromNotification=1',local});assert.equal(x.window.__BETTER_CODEX_SCOPE__.id,'ai');assert.equal(boot({local}).window.__BETTER_CODEX_SCOPE__.id,'secondary');const home=boot({href:'https://example.test/?workspace=ai&fromNotification=1',local});assert.equal(home.window.__BETTER_CODEX_SCOPE__.id,'ai');assert.equal(boot({local}).window.__BETTER_CODEX_SCOPE__.id,'secondary');});
test('notification device identity is shared across workspace wrappers, not the current view',()=>{const local=new Map(),a=boot({local}),key=a.window.__BETTER_CODEX_DEVICE_SETTINGS__.getDeviceKey();a.context.localStorage.setItem=(k,v)=>local.set('native:'+k,v);a.window.__BETTER_CODEX_DEVICE_SETTINGS__.setOwner('ai');const b=boot({href:'https://example.test/?workspace=secondary&switchWorkspace=1',local});assert.equal(b.window.__BETTER_CODEX_DEVICE_SETTINGS__.getDeviceKey(),key);assert.equal(b.window.__BETTER_CODEX_DEVICE_SETTINGS__.getOwner(),'ai');assert.equal(b.window.__BETTER_CODEX_SCOPE__.id,'secondary');});
test('invalid scopes are rejected before any network boot',()=>{const x=boot({href:'https://example.test/?workspace=unknown'});assert.equal(x.root.textContent,'工作区不可访问');assert.equal(x.window.__BETTER_CODEX_SCOPE__,undefined);});

test('cold launch and restored empty composer URLs always canonicalize to home without clearing drafts',()=>{
 for(const path of ['/', '/?workspace=ai&view=chat', '/?workspace=ai&view=chat&pwa=ai', '/betterCodex-native-assets/aaaaaaaaaaaaaaaa/shell.html?workspace=ai']){
  const local=new Map([['draft:ai','unfinished draft']]),x=boot({href:'https://example.test'+path,standalone:true,local});
  assert.equal(x.window.__BETTER_CODEX_SCOPE__.nativeList,true);assert.equal(new URL(x.canonical).pathname,'/');assert.equal(new URL(x.canonical).searchParams.get('nativeList'),'1');assert.equal(local.get('draft:ai'),'unfinished draft');
 }
});
test('conversation and notification links retain their conversation view',()=>{
 for(const suffix of ['', '&fromNotification=1']){
  const x=boot({href:'https://example.test/local/00000000-0000-4000-8000-4ba7215b54d2?workspace=ai'+suffix});
  assert.equal(x.window.__BETTER_CODEX_SCOPE__.nativeList,false);assert.equal(new URL(x.canonical).searchParams.has('nativeList'),false);
 }
});
