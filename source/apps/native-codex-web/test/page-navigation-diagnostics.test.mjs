import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {safePerformanceEvents} from '../src/performance-events.mjs';
const source=await readFile(new URL('../public/page-navigation-diagnostics.js',import.meta.url),'utf8');
function fixture({mobile=true,storage=new Map(),scope='ai',width=360,pageId='12345678',navigationType='navigate'}={}){
 const events=[],listeners={},navigationListeners={};
 const context={URL,JSON,Date,Math,Number,innerWidth:width,innerHeight:807,devicePixelRatio:3,performance:{now:()=>20,getEntriesByType:()=>[{type:navigationType}]},crypto:{randomUUID:()=>pageId},navigator:{maxTouchPoints:mobile?5:0,userAgent:'Mozilla/5.0 Chrome/150.0.1 Mobile private-device'},document:{wasDiscarded:false},matchMedia:()=>({matches:mobile}),sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},addEventListener:(type,fn)=>listeners[type]=fn};
 context.window={__BETTER_CODEX_SCOPE__:{id:scope,token:'private-scope-token'},fetch:async(url,init)=>{assert.equal(url,'/w/'+scope+'/api/performance');events.push(...JSON.parse(init.body).events);return {ok:true};},navigation:{addEventListener:(type,fn)=>navigationListeners[type]=fn}};
 vm.runInNewContext(source,context);return {context,events,listeners,navigationListeners,storage};
}
test('resize does not navigate or send network requests; a new document correlates with the previous width change',()=>{
 const first=fixture();assert.equal(first.events.length,1);first.context.innerWidth=677;first.listeners.resize();assert.equal(first.events.length,1);assert.equal(first.listeners.beforeunload,undefined);
 first.listeners.pagehide({persisted:false});assert.equal(first.events.at(-1).reason,'document_hide');
 const next=fixture({width:677,storage:first.storage,pageId:'87654321',navigationType:'reload'});const event=next.events[0];assert.equal(event.navigationType,'reload');assert.equal(event.previousPageId,'12345678');assert.equal(event.previousWidth,677);assert.equal(event.standalone,true);assert(!JSON.stringify(event).includes('private'));
 assert.equal(fixture({storage:first.storage,scope:'secondary'}).events[0].previousPageId,undefined);
});
test('same-document routes are ignored; full navigation is observed without interception',()=>{
 const x=fixture();x.navigationListeners.navigate({destination:{sameDocument:true},navigationType:'push'});assert.equal(x.events.length,1);
 x.navigationListeners.navigate({destination:{sameDocument:false},navigationType:'reload',userInitiated:true,intercept(){throw Error('must not intercept')},preventDefault(){throw Error('must not cancel')}});
 assert.equal(x.events.at(-1).reason,'document_navigate');assert.equal(x.events.at(-1).userInitiated,true);assert.equal(fixture({mobile:false}).events.length,0);
});
test('navigation diagnostics reject private strings and invalid dimensions',()=>{
 const [e]=safePerformanceEvents([{phase:'navigation',reason:'document_start',navigationType:'reload',browser:'chrome',browserMajor:150,standalone:true,wasDiscarded:false,previousPageId:'12345678',previousWidth:360,width:677,devicePixelRatio:3,userAgent:'private',url:'https://private/',token:'secret',draft:'unsent',height:Infinity}]);
 assert.equal(e.navigationType,'reload');assert.equal(e.previousPageId,'12345678');assert.equal(e.width,677);for(const k of ['userAgent','url','token','draft','height'])assert.equal(e[k],undefined);
 const [bad]=safePerformanceEvents([{phase:'navigation',browser:'secret',navigationType:'private',previousPageId:'private-conversation'}]);assert.equal(bad.browser,undefined);assert.equal(bad.navigationType,undefined);assert.equal(bad.previousPageId,undefined);
});
