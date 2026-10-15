import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const source=await readFile(process.env.DSH_PENDING_SOURCE||new URL('../public/native-android-ui.js',import.meta.url),'utf8'),A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
if(process.env.DSH_PENDING_SCOPE)assert((await readFile(process.env.DSH_PENDING_SCOPE,'utf8')).includes(source.trim()));
class Node{constructor(){this.children=[];this.parentNode=null;this.dataset={};this.attributes={};this.textContent='';this.hidden=false;this.scrollHeight=100;this.clientHeight=50;}append(...nodes){for(const n of nodes){n.remove();this.children.push(n);n.parentNode=this;}}remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null;}setAttribute(k,v){this.attributes[k]=v;}getAttribute(k){return this.attributes[k]??null;}closest(){return null;}get isConnected(){return !!this.parentNode||this.root===true;}get lastElementChild(){return this.children.at(-1);}get childElementCount(){return this.children.length;}}
function setup(saved=null){const host=new Node();host.root=true;const frames=new Map(),listeners={},store=new Map(),native=[],location={pathname:'/local/'+A};let frame=0,selected=null;const context={scope:{id:'ai'},location,document:{documentElement:{dataset:{}},body:new Node(),visibilityState:'visible',createElement:()=>new Node(),querySelector:()=>host,querySelectorAll:()=>native,addEventListener(){},removeEventListener(){}},navigator:{clipboard:{writeText:async()=>{}}},localStorage:{setItem(){},getItem(){return null},removeItem(){}},sessionStorage:{setItem(){},getItem(){return null},removeItem(){}},crypto:{randomUUID:()=> 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},Date,Map,Set,WeakMap,Promise,encodeURIComponent,getComputedStyle:()=>({flexDirection:'column'}),requestAnimationFrame:fn=>{frames.set(++frame,fn);return frame},cancelAnimationFrame:id=>frames.delete(id),addEventListener:(k,fn)=>(listeners[k]??=[]).push(fn),removeEventListener(){},MutationObserver:class{observe(){}},setTimeout,clearTimeout,queueMicrotask,afterVisiblePaint:async()=>{},__DSH_CLIENT_LOG__:{event(){}},__DSH_NATIVE_CACHE__:{meta:async key=>key.startsWith('dsh-pending-display')?saved:null,saveMeta:async(k,v)=>store.set(k,structuredClone(v))},__DSH_NAVIGATION__:{presentationPath:()=>selected??location.pathname},__DSH_NATIVE_SIDEBAR__:{isList:false}};context.window=context;const start=source.indexOf(' const pendingKey='),end=source.indexOf('\n let dialog=',start);assert(start>0&&end>start);vm.runInNewContext(source.slice(start,end),context);
 const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();for(const fn of [...frames.values()]){frames.clear();fn();}};
 return{context,location,native,store,flush,begin:v=>context.__DSH_ANDROID_PENDING__.begin(v),select(path){selected=path;for(const fn of listeners['dsh:conversation-selection']||[])fn({detail:{path}})},render:()=>vm.runInNewContext('renderPending()',context),visible:()=>host.children.flatMap(x=>x.children).filter(x=>x.className==='dsh-inline-prompt').length};}
test('a known Native thread never treats a retained clientThreadId as a second transcript destination',async()=>{const f=setup(),p=f.begin({id:'message-a',text:'A prompt',threadId:A,clientThreadId:B});p.finish({threadId:A});await f.flush();assert.equal(f.visible(),1);f.location.pathname='/local/'+B;f.render();assert.equal(f.visible(),0);f.location.pathname='/local/'+A;f.render();assert.equal(f.visible(),1);});
test('selection removes the outgoing local prompt before the address and cached transcript finish changing',async()=>{const f=setup(),p=f.begin({id:'message-a',text:'A prompt',threadId:A});await f.flush();assert.equal(f.visible(),1);f.select('/local/'+B);assert.equal(f.location.pathname,'/local/'+A);assert.equal(f.visible(),0);p.finish({threadId:A});await f.flush();assert.equal(f.visible(),0);f.select('/local/'+A);await f.flush();assert.equal(f.visible(),1);});
test('durable accepted prompts reopen only in the Native destination while body history is pending',async()=>{const saved={version:2,records:[{id:'message-a',text:'A prompt',threadId:A,clientThreadId:B,path:'/local/'+A,state:'accepted'}]},f=setup(saved);await f.flush();assert.equal(f.visible(),1);f.location.pathname='/local/'+B;f.render();assert.equal(f.visible(),0);});
test('an unaccepted new task can paint at home or its temporary ID but not an unrelated local address',async()=>{const f=setup();f.location.pathname='/';f.begin({id:'message-new',text:'new prompt',threadId:null,clientThreadId:B});await f.flush();assert.equal(f.visible(),1);f.location.pathname='/local/'+B;f.render();assert.equal(f.visible(),1);f.location.pathname='/local/'+A;f.render();assert.equal(f.visible(),0);});

test('Native creation binds the pending input before its route is displayed without marking the send accepted',async()=>{const f=setup();f.location.pathname='/';const p=f.begin({id:'message-new',text:'new prompt',threadId:null,clientThreadId:B});f.context.__DSH_ANDROID_PENDING__.bindThread(B,A);f.select('/local/'+A);f.location.pathname='/local/'+A;await f.flush();assert.equal(f.visible(),1);assert.equal(p.isCurrent(),true);f.select('/local/'+B);await f.flush();assert.equal(f.visible(),0);});


test('accepted intent survives a durable item whose turn is missing from the cold history index',async()=>{
 const f=setup(),id='message-a',generation='native-view',item={id,clientId:id,type:'userMessage',content:[{type:'text',text:'persisted input'}]};
 let ready=false;f.context.__DSH_NATIVE_CACHE__.meta=async key=>key==='catalog-generation'?generation:key==='confirmed-user-items-v1:'+A?{scope:'ai',threadId:A,sourceGeneration:generation,generation,turns:[{items:[item]}]}:null;
 f.context.__DSH_NATIVE_CACHE__.readKey=()=> 'head';f.context.__DSH_NATIVE_CACHE__.get=async()=>({scope:'ai',sourceGeneration:generation,generation,payload:{result:{thread:{id:A}}}});
 f.context.__DSH_READ_COMMITTED_HISTORY__=async()=>({response:{thread:{id:A}},sourceGeneration:generation,generation,page:{data:ready?[{items:[item]}]:[]}});
 const pending=f.begin({id,text:'persisted input',threadId:A});pending.finish({threadId:A});await f.flush();
 await vm.runInNewContext('reconcilePendingHistory()',f.context);await f.flush();
 assert.equal(vm.runInNewContext('acceptedDisplays.has("message-a")',f.context),true,'item persistence is not a restorable turn index');
 assert([...f.store.values()].some(value=>value?.records?.some(row=>row.id===id)));
 ready=true;await vm.runInNewContext('reconcilePendingHistory()',f.context);await f.flush();assert.equal(vm.runInNewContext('acceptedDisplays.has("message-a")',f.context),false);
});

test('an exact Native receipt advances the retained row before SDK send completion',async()=>{
 const f=setup(),M='cccccccc-cccc-4ccc-8ccc-cccccccccccc',T='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 const p=f.begin({id:M,text:'receipt fixture',threadId:A,state:'preparing'});await f.flush();
 const state=()=>vm.runInNewContext('pendingPrompts.get("'+M+'").record.state',f.context);
 assert.equal(state(),'preparing');assert.equal(f.context.__DSH_ANDROID_PENDING__.acceptNativeReceipt({threadId:A,traceId:M,turnId:T}),true);
 assert.equal(state(),'accepted','does not wait for the outer SDK promise or storage writer');
 p.fail(true,'late callback');assert.equal(state(),'accepted');
 assert.equal(f.context.__DSH_ANDROID_PENDING__.acceptNativeReceipt({threadId:A,traceId:M,turnId:T}),false,'duplicate receipt does not cause another write');
 f.select('/local/'+B);await f.flush();assert.equal(f.visible(),0);f.select('/local/'+A);await f.flush();assert.equal(f.visible(),1);
});
test('receipt cannot accept another thread, a missing turn, retired history, or an auth-locked row',async()=>{
 const M='cccccccc-cccc-4ccc-8ccc-cccccccccccc',T='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 for(const mode of ['wrong-thread','wrong-message','missing-turn','history-rewritten','locked']){
  const f=setup();f.begin({id:M,text:'receipt fixture',threadId:A});const receipt={threadId:A,traceId:M,turnId:T};
  if(mode==='wrong-thread')receipt.threadId=B;if(mode==='wrong-message')receipt.traceId=T;if(mode==='missing-turn')delete receipt.turnId;
  if(mode==='history-rewritten')vm.runInNewContext('pendingHistoryEpochs.set("'+A+'",1)',f.context);if(mode==='locked')vm.runInNewContext('pendingAuthLocked=true',f.context);
  assert.equal(f.context.__DSH_ANDROID_PENDING__.acceptNativeReceipt(receipt),false,mode);assert.equal(vm.runInNewContext('pendingPrompts.get("'+M+'").record.state',f.context),'sending');
 }
});
