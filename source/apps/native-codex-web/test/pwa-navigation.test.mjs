import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const script=await readFile(new URL('../public/native-navigation.js',import.meta.url),'utf8');
const a='00000000-0000-4000-8000-4ba7215b54d2',b='00000000-0000-4000-8000-f82fe242e2a8';
function boot({path='/local/'+a+'?workspace=secondary',existingState=null,embedded=false}={}){
 const entries=[{state:existingState,url:'http://localhost:3080'+path}],listeners=[];let index=0,exits=0,list=path.includes('nativeList=1');
 const location={origin:'http://localhost:3080'};function update(){Object.assign(location,Object.fromEntries(['href','pathname','search','hash'].map(k=>[k,new URL(entries[index].url)[k]])));}update();
 const history={get state(){return entries[index].state},replaceState(state,_title,url){entries[index]={state,url:new URL(url??location.href,location.href).href};update()},pushState(state,_title,url){entries.splice(index+1);entries.push({state,url:new URL(url??location.href,location.href).href});index++;update()},back(){if(index===0){exits++;return;}index--;update();for(const f of listeners)f({state:history.state})},forward(){if(index+1<entries.length){index++;update();for(const f of listeners)f({state:history.state})}}};
 const window={__BETTER_CODEX_SCOPE__:{id:'secondary'},__BETTER_CODEX_NATIVE_SIDEBAR__:{get isList(){return list},show(){list=true}}};
 window.parent=embedded?{}:window;
 vm.runInNewContext(script,{window,location,history,URL,addEventListener:(type,fn)=>{if(type==='popstate')listeners.push(fn)}});
 function open(id,{routerPush=true}={}){list=false;window.__BETTER_CODEX_NAVIGATION__.beginConversation('/local/'+id);if(routerPush)history.pushState({usr:{native:true},idx:1},'', '/local/'+id+'?workspace=secondary');}
 return {entries,window,history,location,open,get exits(){return exits},get list(){return list}};
}
test('fresh standalone deep link returns to its workspace list before leaving the app',()=>{const x=boot();assert.equal(x.entries.length,2);x.history.back();assert.equal(x.exits,0);assert.equal(x.list,true);assert.equal(new URL(x.location.href).searchParams.get('nativeList'),'1');assert.equal(new URL(x.location.href).searchParams.get('workspace'),'secondary');x.history.back();assert.equal(x.exits,1);});
test('stale page flags cannot remove the list ancestor after a fresh PWA launch',()=>{for(const existingState of [{betterCodexThreadPage:true},{betterCodexNavVersion:2,betterCodexNavIndex:9,betterCodexThreadPage:true,usr:{draft:'preserved'}}]){const x=boot({existingState});x.history.back();assert.equal(x.exits,0);assert.equal(x.list,true);assert.equal(x.history.state.usr?.draft,existingState.usr?.draft);}});
test('list selection keeps one list/detail pair and retains the native router state',()=>{const x=boot({path:'/?workspace=secondary&view=chat&nativeList=1'});x.open(a);assert.equal(x.entries.length,2);assert.equal(x.history.state.usr.native,true);x.history.back();assert.equal(x.list,true);assert.equal(x.exits,0);x.history.back();assert.equal(x.exits,1);});
test('Back after a conversation-to-conversation route shows the list, not the previous detail',()=>{const x=boot();x.history.pushState({usr:{native:true}},'','/local/'+b+'?workspace=secondary');x.history.back();assert.equal(x.list,true);assert.equal(x.history.state.betterCodexListPage,true);assert.equal(x.exits,0);});
test('reopening the same cached conversation still creates a real Back target',()=>{const x=boot();x.history.back();x.open(a,{routerPush:false});x.history.back();assert.equal(x.list,true);assert.equal(x.exits,0);assert.equal(x.entries.length,2);});
test('explicit list action uses Back instead of pushing a list above the detail',()=>{const x=boot();x.window.__BETTER_CODEX_NAVIGATION__.backToList();assert.equal(x.list,true);assert.equal(x.entries.length,2);assert.equal(x.exits,0);});
test('embedded renderers leave navigation to their outer shell',()=>{const x=boot({path:'/local/'+a+'?workspace=secondary&betterCodexEmbedded=1',embedded:true});assert.equal(x.entries.length,1);assert.equal(x.window.__BETTER_CODEX_NAVIGATION__,undefined);});

test('a copied top-level embedded URL still has a list ancestor',()=>{const x=boot({path:'/local/'+a+'?workspace=secondary&betterCodexEmbedded=1'});x.history.back();assert.equal(x.list,true);assert.equal(x.exits,0);});
