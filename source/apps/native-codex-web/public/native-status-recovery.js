// Reconcile display state from verified Native reads after missed terminal events.
// Never emit turn/completed: a cache repair must not send a second notification.
(()=>{
 const scope=window.__DSH_SCOPE__;if(!scope)return;
 let client=null,applying=false;const registered=new WeakSet(),epochs=new Map();
 const stats={statusCorrections:0,turnCorrections:0,supersededReads:0};
 const turns=c=>c?.turnHistory?.kind==='canonical'?Object.values(c.turnHistory.history.entitiesByKey||{}):c?.turns||[];
 const active=c=>c?.threadRuntimeStatus?.type==='active'||turns(c).some(t=>t.status==='inProgress');
 const epoch=id=>epochs.get(id)||0;
 function register(value){if(value.hostId!=='local'||registered.has(value))return;registered.add(value);client=value;
  for(const method of ['thread/status/changed','turn/started','turn/completed','thread/reverted','thread/closed'])value.addNotificationCallback?.(method,({params})=>{if(applying)return;const id=params?.threadId;if(id)epochs.set(id,epoch(id)+1);});
 }
 function beginRead(id,{fresh=false}={}){return {client,epoch:epoch(id),fresh};}
 function acceptRead(method,params,record,stamp){
  // The cloud API returns a bare durable record only after a fresh Native read
  // and its publication ACK. Offline/cache fallbacks explicitly say cloud-cache.
  const confirmed=record.source==='native'||record.source==null&&stamp?.fresh===true;
  const id=params.threadId;if(!client||stamp?.client!==client||!confirmed||record.scope!==scope.id||record.deleted||record.threadId!==id)return;
  if(stamp.epoch!==epoch(id)){stats.supersededReads++;return;}
  const result=record.payload?.result;
  if(method==='thread/read'&&result?.thread?.id===id&&result.thread.status){
   const status=result.thread.status,current=client.getConversation?.(id),summary=client.getThreadSummaries?.().find(t=>t.conversationId===id);
   if((current||summary)&&(JSON.stringify(current?.threadRuntimeStatus??summary?.threadRuntimeStatus)!==JSON.stringify(status)||summary&&JSON.stringify(summary.threadRuntimeStatus)!==JSON.stringify(status))){
    applying=true;try{client.onNotification?.('thread/status/changed',{threadId:id,status});stats.statusCorrections++;}finally{applying=false;}
   }
  }
  const authoritative=method==='thread/turns/list'?result?.data:method==='thread/read'?result?.thread?.turns:null;
  if(!authoritative)return;
  const loaded=new Map(turns(client.getConversation?.(id)).map(t=>[t.turnId,t]));
  for(const turn of authoritative){
   if(!['completed','failed','interrupted'].includes(turn.status)||loaded.get(turn.id)?.status!=='inProgress')continue;
   client.updateTurnState?.(id,turn.id,value=>{if(value.status!=='inProgress')return;value.status=turn.status;for(const key of ['error','durationMs'])if(Object.hasOwn(turn,key))value[key]=turn[key];});stats.turnCorrections++;
  }
 }
 window.__DSH_NATIVE_STATUS_RECOVERY__={register,beginRead,acceptRead,activeThreadIds:()=>[...new Set([...(client?.getCachedConversations?.()||[]).filter(active).map(c=>c.id),...(client?.getThreadSummaries?.()||[]).filter(t=>t.threadRuntimeStatus?.type==='active').map(t=>t.conversationId)])],diagnostics:()=>({...stats})};
})();
