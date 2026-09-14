import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {webcrypto,randomUUID} from 'node:crypto';
const source=await readFile(new URL('../public/native-queue-client.js',import.meta.url),'utf8'),threadId='00000000-0000-4000-8000-4ba7215b54d2';
function fixture({unknown=false}={}){
 const commands=new Map(),receipts=new Map();let state={[threadId]:[]},posts=0;
 const cache={meta:async()=>null,saveMeta:async()=>{},recordCommand:async c=>commands.set(c.id,structuredClone(c)),pendingCommands:async id=>[...commands.values()].filter(c=>['pending','unknown'].includes(c.state)&&(!id||c.threadId===id))};
 const window={__BETTER_CODEX_SCOPE__:{id:'ai',token:'test'},__BETTER_CODEX_NATIVE_ONLINE__:true,__BETTER_CODEX_NATIVE_CACHE__:cache};
 const value=()=>({state:structuredClone(state),revisions:{[threadId]:'revision'},authority:'mac-native'});
 const context={window,location:{pathname:'/local/'+threadId},document:{visibilityState:'hidden'},crypto:webcrypto,structuredClone,setInterval:()=>1,clearInterval(){},setTimeout,addEventListener(){},fetch:async(url,options)=>{
  const u=new URL(url,'http://127.0.0.1');if(u.searchParams.has('commandId'))return new Response(JSON.stringify(receipts.get(u.searchParams.get('commandId'))||{state:'not_found'}));
  if(options.method==='POST'){posts++;const r=JSON.parse(options.body).request;assert.equal(commands.get(r.commandId)?.state,'pending','identity must commit before transmission');if(!unknown){state={[threadId]:r.messages};receipts.set(r.commandId,{state:'accepted',result:value()});}throw Error('response lost');}
  return new Response(JSON.stringify(value()));
 }};
 function client(){const q={options:{storage:{read:()=>({value:{}})},onQueueChanged(){},submissionHost:{getActiveTurnId:()=>null}},pending:new Map(),messages:new Map(),startExecution(){},execution:{prepare:async(id,m)=>({status:'ready',submission:{start:{request:{input:[{type:'text',text:m.text}]}}}})}};vm.runInNewContext(source,context);window.__BETTER_CODEX_INSTALL_NATIVE_QUEUE__({hostId:'local',turnCoordinator:q});return q;}
 return {client,commands,receipts,get posts(){return posts}};
}
test('lost response queries the original command receipt and never posts twice',async()=>{
 const f=fixture(),q=f.client();await q.options.storage.load();const message={id:randomUUID(),text:'queued'};const result=await q.options.storage.update(()=>({[threadId]:[message]}));assert.equal(result[threadId][0].id,message.id);assert.equal(f.posts,1);assert.equal([...f.commands.values()][0].state,'accepted');
 const afterReload=f.client();await afterReload.options.storage.load();await new Promise(r=>setTimeout(r,5));assert.equal(f.posts,1);
});
test('unconfirmed request survives reload and blocks a new automatic submission',async()=>{
 const f=fixture({unknown:true}),q=f.client();await q.options.storage.load();await assert.rejects(q.options.storage.update(()=>({[threadId]:[{id:randomUUID(),text:'first'}]})),/待核对/);assert.equal([...f.commands.values()][0].state,'unknown');
 const afterReload=f.client();await afterReload.options.storage.load();await assert.rejects(afterReload.options.storage.update(()=>({[threadId]:[{id:randomUUID(),text:'retry'}]})),/待核对/);assert.equal(f.posts,1);
});
