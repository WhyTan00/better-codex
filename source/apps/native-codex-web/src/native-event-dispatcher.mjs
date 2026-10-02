// Order delivery within one scoped conversation, not across unrelated Native
// reads. This is transient event delivery only; Native owns execution state.
export class NativeEventDispatcher {
 constructor({boundary,clients,wants,emit,advance,filtered=()=>{},scopes=['ai','zyy']}){Object.assign(this,{boundary,clients,wants,emit,advance,filtered,scopes});this.generation=0;this.lanes=new Map();}
 barrier(){this.generation++;this.lanes.clear();}
 dispatch(message){
  const threadId=message.params?.threadId||message.params?.thread?.id;
  // Global account/host events are handled by the front's generation barrier;
  // never infer a workspace or forward a global payload without thread proof.
  if(typeof threadId!=='string'||!threadId)return Promise.resolve();
  const generation=this.generation,tasks=[];
  for(const scope of this.scopes){
   const key=JSON.stringify([scope,threadId]),previous=this.lanes.get(key)||Promise.resolve();
   const current=()=>generation===this.generation;
   const interested=()=>[...this.clients].filter(client=>client.scope===scope&&client.pageId&&!client.expired);
   const task=previous.catch(()=>{}).then(async()=>{
    if(!current())return;const candidates=interested();if(!candidates.length)return;
    // Unknown metadata may describe a child of the selected thread, so only
    // skip its ownership read when the existing routing metadata is known.
    if(this.boundary.threads.has(threadId)&&!candidates.some(client=>this.wants(client,message,this.boundary.threads))){this.filtered(scope,message.method);return;}
    const authorized=await this.boundary.notification(scope,message);if(!authorized||!current())return;
    const targets=interested().filter(client=>this.wants(client,message,this.boundary.threads));if(!targets.length){this.filtered(scope,message.method);return;}
    this.advance(scope);
    for(const client of targets)this.emit(client,message.id===undefined?{type:'mcp-notification',hostId:'local',method:message.method,params:message.params}:{type:'mcp-request',hostId:'local',request:message});
   }).catch(()=>{});
   this.lanes.set(key,task);task.finally(()=>{if(this.lanes.get(key)===task)this.lanes.delete(key);});tasks.push(task);
  }
  return Promise.all(tasks);
 }
}
