// Real QA only. Each mutation ID and created thread is checkpointed before the next step.
// Re-running reconciles the same request IDs; it never replays an unknown mutation.
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {randomUUID}from'node:crypto';
const base=process.env.NATIVE_QA_ORIGIN||'http://127.0.0.1:3091';const dir=new URL('../../../runtime/native-codex-web-20260908/',import.meta.url); // resolved explicitly below
const file='/workspace/example/workbench/runtime/native-codex-web-20260908/native-qa.json';
let evidence;try{evidence=JSON.parse(await readFile(file,'utf8'));}catch{evidence={createdAt:new Date().toISOString(),workspaces:{}};}
const save=()=>writeFile(file,JSON.stringify(evidence,null,2)+'\n');
for(const ws of ['ai','zyy']){
 const c=await(await fetch(base+'/api/context',{method:'POST',body:JSON.stringify({workspace:ws})})).json();
 const api=async(op,body,query={})=>{const u=new URL(`/api/w/${ws}/${op}`,base);for(const[k,v]of Object.entries(query))u.searchParams.set(k,v);const r=await fetch(u,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+c.token},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok)throw new Error(JSON.stringify(d));return d;};
 const q=evidence.workspaces[ws]||={newRequestId:randomUUID(),turnRequestId:randomUUID(),marker:'NATIVE_WEB_QA_'+ws.toUpperCase()+'_20260908'};await save();
 if(!q.threadId){const old=await api('request',null,{id:q.newRequestId});let r;if(old.state==='notFound')r=await api('mutate',{op:'new',requestId:q.newRequestId});else r=old;if(r.state!=='accepted')throw new Error('New request requires reconciliation: '+r.state);q.threadId=r.result.thread.id;q.policy=r.result.policy;await save();console.log(ws,'created',q.threadId);}
 if(!q.turnId){const old=await api('request',null,{id:q.turnRequestId});let r;if(old.state==='notFound')r=await api('mutate',{op:'send',requestId:q.turnRequestId,threadId:q.threadId,text:`This is a temporary QA conversation for the private native Codex Web workbench. Do not use any tools, read files, or perform business actions. Reply exactly: ${q.marker}`,attachments:[]});else r=old;if(r.state!=='accepted')throw new Error('Turn requires reconciliation: '+JSON.stringify(r));q.turnId=r.result.turn.id;await save();console.log(ws,'accepted',q.turnId);}
 const snap=await api('snapshot',null,{threadId:q.threadId});q.snapshotStatus=snap.thread.status;q.turns=snap.turns.map(t=>({id:t.id,status:t.status,itemsView:t.itemsView,items:t.items}));q.checkedAt=new Date().toISOString();await save();console.log(ws,'snapshot',JSON.stringify({status:q.snapshotStatus,turns:q.turns.map(t=>({id:t.id,status:t.status,items:t.items?.length}))}));
}
