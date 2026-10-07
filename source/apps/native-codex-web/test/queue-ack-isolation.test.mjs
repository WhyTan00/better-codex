import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile}from'node:fs/promises';import {webcrypto}from'node:crypto';
const source=await readFile(process.env.DSH_QUEUE_SOURCE||new URL('../public/native-queue-client.js',import.meta.url),'utf8');if(process.env.DSH_QUEUE_SCOPE)assert((await readFile(process.env.DSH_QUEUE_SCOPE,'utf8')).includes(source.trim()));
const A='11111111-1111-4111-a111-111111111111',B='22222222-2222-4222-a222-222222222222',settle=()=>new Promise(r=>setImmediate(r));
function fixture({rejectIdentity=false}={}){
 let revision=0,posts=0,release,holding=true;const writes=[],commands=new Map(),state={[A]:[],[B]:[]},errors=[];
 const cache={meta:async()=>null,saveMeta:async(key,value)=>{writes.push(structuredClone(value));if(holding){holding=false;await new Promise(r=>release=r);}},recordCommand:async command=>{if(rejectIdentity&&command.state==='pending')throw Error('fixture required identity failed');commands.set(command.id,structuredClone(command));},pendingCommands:async id=>[...commands.values()].filter(c=>['pending','unknown'].includes(c.state)&&(!id||c.threadId===id))};
 const result=()=>({state:structuredClone(state),revisions:{[A]:'r-'+revision,[B]:'r-'+revision},authority:'mac-native'});
 const q={pending:new Map(),messages:new Map(),options:{storage:{read:()=>({value:{}})},onQueueChanged(){},submissionHost:{getActiveTurnId:()=>null,hasFinalAnswer:()=>false}},sendMessage:async()=>{},startExecution(){},execution:{prepare:async(id,m)=>({status:'ready',submission:{start:{request:{input:[{type:'text',text:m.text}]}}}})}};
 const window={__DSH_SCOPE__:{id:'ai',token:'isolated'},__DSH_NATIVE_ONLINE__:true,__DSH_NATIVE_CACHE__:cache,dispatchEvent:e=>errors.push(e.detail)};
 const ctx={window,document:{visibilityState:'hidden',addEventListener(){}},location:{pathname:'/local/'+A},crypto:webcrypto,structuredClone,Event,CustomEvent:class{constructor(type,args){this.type=type;this.detail=args?.detail;}},setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout,addEventListener(){},removeEventListener(){},fetch:async(url,options)=>{if(options.method==='POST'){posts++;const request=JSON.parse(options.body).request;assert.equal(commands.get(request.commandId)?.state,'pending');revision++;if(request.operation==='sync')state[request.threadId]=request.messages;else if(request.operation==='send-now')state[request.threadId]=state[request.threadId].filter(m=>m.id!==request.messageId);else throw Error('unexpected fixture operation');}return new Response(JSON.stringify(result()));}};
 vm.runInNewContext(source,ctx);window.__DSH_INSTALL_NATIVE_QUEUE__({hostId:'local',turnCoordinator:q});return {q,writes,commands,errors,posts:()=>posts,release:()=>release?.(),state};
}
test('accepted queue edits and the next thread edit do not await optional snapshot storage',async()=>{
 const f=fixture();await f.q.options.storage.load();while(!f.writes.length)await settle();let first=false,second=false;
 const one=f.q.options.storage.update(s=>({...s,[A]:[{id:'a',text:'fixture A'}]})).then(()=>first=true);await settle();await settle();
 const two=f.q.options.storage.update(s=>({...s,[B]:[{id:'b',text:'fixture B'}]})).then(()=>second=true);await settle();await settle();
 try{assert(first,'first accepted edit must be available while display storage is busy');assert(second,'another thread edit cannot wait for the previous display checkpoint');assert.equal(f.posts(),2);assert.equal(f.q.options.storage.read().value[A][0].id,'a');assert.equal(f.q.options.storage.read().value[B][0].id,'b');}finally{f.release();await Promise.all([one,two]);}
 for(let i=0;i<8;i++)await settle();assert.equal(f.writes.at(-1).state[B][0].id,'b');assert.equal(f.errors.length,0);
});
test('send-now reports the accepted result before a stalled local queue checkpoint',async()=>{
 const f=fixture();f.state[A]=[{id:'a',text:'fixture A'}];await f.q.options.storage.load();while(!f.writes.length)await settle();let answer;
 const sending=f.q.sendQueuedMessageNow(A,'a').then(value=>answer=value);await settle();await settle();
 try{assert.equal(answer?.status,'sent','Native accepted send-now cannot wait for optional storage');assert.equal(f.posts(),1);assert.equal(f.q.options.storage.read().value[A].length,0);}finally{f.release();await sending;}
});
test('a failed required command identity still prevents every queue POST',async()=>{
 const f=fixture({rejectIdentity:true});await f.q.options.storage.load();try{await assert.rejects(f.q.options.storage.update(s=>({...s,[A]:[{id:'a',text:'fixture A'}]})),/尚未提交/);assert.equal(f.posts(),0);}finally{f.release();}
});
