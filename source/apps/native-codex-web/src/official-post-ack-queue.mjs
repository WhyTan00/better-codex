// Skip only a proven empty, unchanged local Native queue no-op. Non-empty,
// unknown, retired and serialized mutations retain the exact SDK method.
export function patchPostAckEmptyQueue(source,{surface='initial'}={}){
 if(surface!=='initial')throw Error('Post-ACK queue SDK patch requires initial surface');
 const before='async resumeInterruptedQueuedMessages(e){await this.loadMessages(e),';
 const after='async resumeInterruptedQueuedMessages(e){if(!this.disposed&&this.pending.size===0&&!this.queueRefresh&&this.queueRefreshRequested==null&&this.options.storage.dshCanSkipEmptyResume?.(e)===!0){let dshMessages=this.messages.get(e),dshStored=this.options.storage.read();if(dshMessages&&dshMessages.refreshing!==!0&&Array.isArray(dshMessages.messages)&&dshMessages.messages.length===0&&dshStored?.isLoading===!1&&Object.hasOwn(dshStored.value??{},e)&&Array.isArray(dshStored.value[e])&&dshStored.value[e].length===0)return;}await this.loadMessages(e),';
 if(source.includes(after))return source;
 if(source.split(before).length!==2)throw Error('Pinned post-ACK queue contract changed');
 return source.replace(before,after);
}

// This private storage capability is installed only by the real local Native
// adapter. Cached startup state has no stamp; only a successful same-epoch
// Native queue GET can authorize the SDK's synchronous empty no-op.
export function patchPostAckEmptyQueueAdapter(source){
 const marker='const dshEmptyQueueReads=new Map();';
 if(source.includes(marker)){
  for(const value of ['dshCanSkipEmptyResume:id=>','dshReadEpoch=dshEmptyQueueEpoch,operation=','update:fn=>{dshQueueMutationPending++;','finally(()=>{dshQueueMutationPending--;refresh();})'])if(source.split(value).length!==2)throw Error('Pinned post-ACK Native queue adapter patch is incomplete');
  return source;
 }
 const replace=(before,after)=>{if(source.split(before).length!==2)throw Error('Pinned post-ACK Native queue adapter contract changed');source=source.replace(before,after);};
 replace('const applied=new Map(),reads=new Map(),mutating=new Set();',`const applied=new Map(),reads=new Map(),mutating=new Set();
  let dshEmptyQueueEpoch=0,dshQueueMutationPending=0;${marker}
  const dshRetireEmptyQueue=()=>{dshEmptyQueueEpoch++;dshEmptyQueueReads.clear();};
  const dshEmptyQueueEvents=['dsh:execution-state','dsh:app-host-state','dsh:authentication-required','dsh:session-ready','dsh:submission-unknown'];
  for(const event of dshEmptyQueueEvents)addEventListener(event,dshRetireEmptyQueue);`);
 replace('function accept(result,ticket=++sequence,readScope=null){','function accept(result,ticket=++sequence,readScope=null,dshReadEpoch=null){');
 replace('applied.set(id,ticket);','applied.set(id,ticket);if(readScope!==null&&dshReadEpoch===dshEmptyQueueEpoch)dshEmptyQueueReads.set(id,{epoch:dshReadEpoch,revision:result.revisions[id]});else dshEmptyQueueReads.delete(id);');
 replace('const ticket=++sequence,operation=api(null,threadId).then(result=>accept(result,ticket,key))','const ticket=++sequence,dshReadEpoch=dshEmptyQueueEpoch,operation=api(null,threadId).then(result=>accept(result,ticket,key,dshReadEpoch))');
 replace('if(id&&event.type===\'completed\')Promise.resolve()',"if(event.type==='dispatch'&&['turn/interrupt','thread/stop','thread/resume','thread/settings/update'].includes(event.method))dshRetireEmptyQueue();if(id&&event.type==='completed')Promise.resolve()");
 replace('q.options.storage={',`q.options.storage={
   dshCanSkipEmptyResume:id=>{const stamp=dshEmptyQueueReads.get(id);return !!(receiptClientActive()&&window.__DSH_EXECUTION_CONNECTED__===true&&navigator.onLine&&loaded&&stamp&&stamp.epoch===dshEmptyQueueEpoch&&typeof stamp.revision==='string'&&stamp.revision&&stamp.revision===revisions[id]&&Object.hasOwn(state,id)&&Array.isArray(state[id])&&state[id].length===0&&!refreshing&&!reads.size&&!mutating.size&&dshQueueMutationPending===0&&!inflightCommands.size&&!terminalWrites.size&&!submissionRequests.has(id)&&!receiptWaiting.has(id)&&![...controlRequests.values()].includes(id));},`);
 replace('update:fn=>{const next=writes.catch(()=>{}).then(async()=>{','update:fn=>{dshQueueMutationPending++;const next=writes.catch(()=>{}).then(async()=>{');
 replace('writes=next;next.catch(feedback).finally(()=>{refresh();}).catch(()=>{});return next;','writes=next;next.catch(feedback).finally(()=>{dshQueueMutationPending--;refresh();}).catch(()=>{});return next;');
 replace('clearInterval(timer);stopReceiptListener?.();','clearInterval(timer);for(const event of dshEmptyQueueEvents)removeEventListener(event,dshRetireEmptyQueue);dshRetireEmptyQueue();stopReceiptListener?.();');
 return source;
}
