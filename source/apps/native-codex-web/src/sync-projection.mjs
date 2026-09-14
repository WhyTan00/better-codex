// Display projection of official v2 items. Credentials, developer/system
// messages and raw tool arguments/output never enter the cloud read model.
export function displayItem(value,turnId){
 const item=value?.item??value;if(!item?.id||typeof item.type!=='string')return null;
 const base={id:item.id,turnId,type:item.type};
 if(item.type==='userMessage')return {...base,text:(item.content||[]).filter(x=>x.type==='text').map(x=>x.text||'').join('\n'),attachments:(item.content||[]).filter(x=>x.type!=='text').map(x=>({type:x.type}))};
 if(item.type==='agentMessage')return {...base,text:item.text||'',phase:item.phase||'final_answer'};
 if(item.type==='plan')return {...base,text:item.text||'',status:item.status||'completed'};
 if(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch','imageGeneration','contextCompaction','collabAgentToolCall'].includes(item.type))return {...base,status:item.status||'completed',detailAvailable:true};
 return null;
}
export function displayThread(t){return {id:t.id,name:t.name||'',preview:t.preview||'',status:t.status,createdAt:t.createdAt,updatedAt:t.updatedAt,model:t.model??null,reasoningEffort:t.reasoningEffort??null};}
export function displayTurn(t){return {id:t.id,status:t.status,startedAt:t.startedAt??null,completedAt:t.completedAt??null,items:(t.items||[]).map(x=>displayItem(x,t.id)).filter(Boolean),detailsAvailable:true};}
export function mergeFetchedSnapshot(fetched,live,startRevision){
 if(!live)return fetched;
 const turns=new Map(fetched.turns.map(t=>[t.id,t]));
 for(const current of live.turns){
  if((current._revision||0)<=startRevision)continue;
  const stored=turns.get(current.id);
  if(!stored){turns.set(current.id,current);continue;}
  const items=new Map(stored.items.map(i=>[i.id,i]));
  for(const item of current.items)if((item._revision||0)>startRevision)items.set(item.id,item);
  turns.set(current.id,{...stored,...current,items:[...items.values()]});
 }
 return {...fetched,turns:[...turns.values()].sort((a,b)=>(a.startedAt||0)-(b.startedAt||0))};
}
export function applyDisplayEvent(snapshot,event,revision){
 if(event.type==='snapshot')return event.snapshot;
 snapshot??={thread:{id:event.threadId,status:{type:'idle'}},turns:[],nextCursor:null};
 if(event.type==='status'){snapshot.thread.status=event.status;return snapshot;}
 let turn=snapshot.turns.find(t=>t.id===event.turnId||t.id===event.turn?.id);
 if(event.type==='turn'){
  if(!turn){turn={...event.turn,items:(event.turn.items||[]).map(i=>({...i,_revision:revision}))};snapshot.turns.push(turn);}else {const items=new Map(turn.items.map(i=>[i.id,i]));for(const i of event.turn.items||[])items.set(i.id,{...i,_revision:revision});Object.assign(turn,event.turn,{items:[...items.values()]});}
  turn._revision=revision;snapshot.thread.status={type:turn.status==='inProgress'?'active':'idle'};return snapshot;
 }
 if(!turn){turn={id:event.turnId,status:'inProgress',startedAt:Date.now()/1000,items:[]};snapshot.turns.push(turn);}
 turn._revision=revision;
 if(event.type==='item'){const i=turn.items.findIndex(x=>x.id===event.item.id),item={...event.item,_revision:revision};if(i<0)turn.items.push(item);else turn.items[i]=item;}
 if(event.type==='delta'){let item=turn.items.find(x=>x.id===event.itemId);if(!item){item={id:event.itemId,turnId:event.turnId,type:'agentMessage',phase:'commentary',text:''};turn.items.push(item);}item.text=(item.text||'')+event.delta;item._revision=revision;}
 return snapshot;
}
export function publicSnapshot(snapshot){return JSON.parse(JSON.stringify(snapshot,(key,value)=>key.startsWith('_')?undefined:value));}

export function displayDetailPage(page){return {...page,data:(page.data||[]).filter(entry=>displayItem(entry,'detail')!==null)};}
