import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/native-workbench-plugins.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({storage=new Map(),offline=false,scope='ai',only=['portfolio','quant','agenda','cockpit'],linkURL='http://localhost:3080/'}={}){
 const handlers={},timers=[],requests=[],nodes=[],navigations=[];let fail=false,hold=null,version=0;
 const emit=(name,e={})=>Promise.all((handlers[name]||[]).map(fn=>fn(e)));
 function node(tag){const n={tag,children:[],dataset:{},style:{},scrollTop:0,textContent:'',append(...v){this.children.push(...v);},replaceChildren(...v){this.children=v;},setAttribute(k,v){this[k]=v;},removeAttribute(k){delete this[k];},remove(){this.removed=true;}};nodes.push(n);return n;}
 const document={visibilityState:'visible',documentElement:node('html'),body:node('body'),createElement:node,querySelector(){return null;},querySelectorAll(){return [];},addEventListener(name,fn){(handlers[name]??=[]).push(fn);}};
 const navigator={onLine:!offline};
 const window={__BETTER_CODEX_SCOPE__:{id:scope},__BETTER_CODEX_NATIVE_CACHE__:{meta:async key=>storage.get(key),saveMeta:async(key,value)=>storage.set(key,structuredClone(value))},dispatchEvent:e=>emit(e.type),__BETTER_CODEX_NATIVE_SIDEBAR__:{openWorkbench(){},show(){}},fetch:async path=>{requests.push(path);if(!navigator.onLine)throw Error('offline');if(hold&&path.includes('/plugins/'))await hold;if(fail)throw Error('network failed');return{ok:true,json:async()=>path==='/api/context'?{token:'scoped-test-token'}:path.endsWith('/plugins')?{data:only.map(id=>({id,label:id,workspace:scope}))}:path.endsWith('/secondary')?{kind:'link',label:'打开私密书架',url:linkURL}:{kind:path.split('/').at(-1),snapshot:{asOf:'2026-09-12T00:00:00Z',totals:{marketValueCny:100+version},positions:[]}}};}};
 const history={state:{},pushState(state){this.state=state;},replaceState(state){this.state=state;},back(){this.state={};emit('popstate',{state:this.state});}};
 const context={window,document,navigator,history,location:{href:'https://example.test/?workspace='+scope,assign:url=>navigations.push(url)},URL,innerWidth:360,Event:class{constructor(type){this.type=type;}},setTimeout(fn,ms){timers.push({fn,ms,interval:false});},setInterval(fn,ms){timers.push({fn,ms,interval:true});},addEventListener(name,fn){(handlers[name]??=[]).push(fn);}};
 vm.runInNewContext(source,context);
 return {api:window.__BETTER_CODEX_NATIVE_WORKBENCH__,storage,requests,nodes,navigations,history,document,navigator,emit,timers,setFail(v){fail=v;},hold(v){hold=v;},bump(){version++;}};
}
test('preload fills all enabled snapshots and cached catalog opens after an offline reload',async()=>{
 const f=fixture();await f.api.preload();assert.equal(f.requests.filter(p=>p.includes('/plugins/')).length,4);assert(f.storage.has('plugin-definitions'));await f.api.preload();assert.equal(f.requests.filter(p=>p.includes('/plugins/')).length,4);
 const offline=fixture({storage:f.storage,offline:true});await offline.api.open('portfolio');assert.equal(offline.requests.length,0);assert(offline.nodes.some(n=>n.textContent==='100'));assert(offline.nodes.some(n=>String(n.textContent).includes('本机缓存')));
});
test('refresh is deduplicated, keeps the same scroll container and retains data on failure',async()=>{
 const f=fixture();await f.api.open('portfolio');const body=f.nodes.find(n=>n.className==='betterCodex-plugin-body');body.scrollTop=280;const contentCount=f.document.body.children.length;let release;f.hold(new Promise(r=>release=r));const update=f.api.refresh({force:true});await settle();assert(f.nodes.some(n=>n.textContent==='刷新中…'&&n.disabled));await f.api.refresh({force:true});release();await update;assert.equal(f.document.body.children.length,contentCount);assert.equal(body.scrollTop,280);assert.equal(f.requests.filter(p=>p.endsWith('/plugins/portfolio')).length,2);
 f.hold(null);f.setFail(true);await f.api.refresh({force:true});assert(f.nodes.some(n=>n.textContent==='100'));assert.equal(body.scrollTop,280);assert(f.nodes.some(n=>n.dataset.state==='error'));
});
test('automatic updates pause when hidden and resume for the visible plugin after connectivity returns',async()=>{
 const f=fixture();await f.api.open('portfolio');const count=f.requests.length;f.document.visibilityState='hidden';for(const t of f.timers.filter(t=>t.interval))await t.fn();await settle();assert.equal(f.requests.length,count);
 f.document.visibilityState='visible';f.bump();await f.emit('online');await settle();await settle();assert(f.requests.length>count);assert(f.nodes.some(n=>n.textContent==='101'));
});
test('a response from before an authentication failure cannot repaint private data',async()=>{
 const f=fixture();await f.api.open('portfolio');let release;f.hold(new Promise(r=>release=r));const update=f.api.refresh({force:true});await settle();await f.emit('betterCodex:authentication-required');release();await update;const panel=f.document.body.children.at(-1),body=panel.children.at(-1),content=body.children.at(-1);assert.equal(content.children.length,0);assert(f.nodes.some(n=>String(n.textContent).includes('重新登录')));
});
test('preload follows the current workspace catalog and does not request unlisted plugins',async()=>{
 const f=fixture({scope:'secondary',only:['secondary']});await f.api.preload();assert(f.requests.some(p=>p==='/api/w/secondary/plugins/secondary'));assert(!f.requests.some(p=>/portfolio|quant|agenda|cockpit/.test(p)));await f.api.open('portfolio');assert.equal(f.api.current,null);
});

test('secondary opens directly on the first click and cached reopen needs no extra request',async()=>{
 const f=fixture({scope:'secondary',only:['secondary']});await f.api.open('secondary');assert.deepEqual(f.navigations,['http://localhost:3080/']);assert.equal(f.history.state.betterCodexPluginPage,undefined);assert(!f.nodes.some(n=>n.tag==='a'));
 const cached=fixture({scope:'secondary',only:['secondary'],storage:f.storage,offline:true});await cached.api.open('secondary');assert.equal(cached.navigations.length,1);assert.equal(cached.requests.length,0);
});
test('preloading and history restoration never navigate the user away',async()=>{
 const f=fixture({scope:'secondary',only:['secondary']});await f.api.preload();assert.equal(f.navigations.length,0);await f.api.open('secondary',{restore:true});assert.equal(f.navigations.length,0);assert(f.nodes.some(n=>n.tag==='a'&&n.href==='http://localhost:3080/'));
});
test('link plugins refuse executable URLs and embedded credentials',async()=>{
 for(const linkURL of ['javascript:alert(1)','https://user:secret@localhost:3080/']){const f=fixture({scope:'secondary',only:['secondary'],linkURL});await f.api.open('secondary');assert.equal(f.navigations.length,0);assert(f.nodes.some(n=>String(n.textContent).includes('入口地址无效')));}
});
