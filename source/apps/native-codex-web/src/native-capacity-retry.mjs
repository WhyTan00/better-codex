import {createHash} from 'node:crypto';
import {workspace,fail,validateId} from './registry.mjs';
export const CAPACITY_RETRY_DELAY_MS=180000;
const capacityError=error=>{
 if(error?.codexErrorInfo==='serverOverloaded')return true;
 if(error?.codexErrorInfo&&error.codexErrorInfo!=='other')return false;
 return /\bmodel\b[^\n]{0,100}\b(?:at|in|an)\s+(?:an?\s+)?capacity\b|\bmodel\b[^\n]{0,100}\b(?:temporarily\s+)?overloaded\b/i.test(String(error?.message||''));
};
const continuationId=(threadId,turnId)=>{
 const h=createHash('sha256').update('capacity-continuation:ai:'+threadId+':'+turnId).digest('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
// Only the front owns this delayed continuation. Native still owns the turn,
// writer and queue; no prompt or executable queue is copied into these intents.
export class NativeCapacityRetry {
 constructor({boundary,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){Object.assign(this,{boundary,now,setTimer,clearTimer});this.entries=new Map();this.errors=new Map();this.closed=false;}
 status(entry){return entry?{threadId:entry.threadId,failedTurnId:entry.failedTurnId,dueAt:entry.dueAt,state:entry.state,...(entry.retryTurnId?{retryTurnId:entry.retryTurnId}:{})}:null;}
 publish(entry,state){entry.state=state;this.entries.delete(entry.threadId);this.entries.set(entry.threadId,entry);while(this.entries.size>256){const id=[...this.entries].find(([,e])=>!['verifying','waiting','checking','dispatching'].includes(e.state))?.[0];if(!id)break;this.entries.delete(id);}}
 cancel(scope,threadId,expectedTurnId){const entry=this.entries.get(threadId);if(!entry||entry.scope!==scope)return null;if(expectedTurnId!=null&&expectedTurnId!==entry.failedTurnId)throw fail(409,'等待重试的回合已改变');if(['verifying','waiting','checking','dispatching'].includes(entry.state)&&!entry.dispatched){this.clearTimer(entry.timer);this.publish(entry,'cancelled');}return this.status(entry);}
 manual(scope,method,params){if(['turn/start','turn/steer','turn/interrupt','thread/stop','thread/revert','thread/archive','thread/delete','thread/settings/update'].includes(method))this.cancel(scope,params?.threadId);}
 observe(message){
  if(this.closed)return;const p=message.params||{},threadId=p.threadId,turnId=p.turnId||p.turn?.id;if(!threadId||!turnId)return;
  const key=threadId+':'+turnId;
  if(message.method==='error'){
   if(p.willRetry===false&&capacityError(p.error)){this.errors.set(key,true);while(this.errors.size>512)this.errors.delete(this.errors.keys().next().value);}return;
  }
  if(message.method==='turn/started'){
   const entry=this.entries.get(threadId);if(entry&&turnId!==entry.failedTurnId){if(entry.state==='dispatching'){entry.retryTurnId=turnId;this.publish(entry,'running');}else this.cancel(entry.scope,threadId);}return;
  }
  if(message.method!=='turn/completed')return;
  const isCapacity=p.turn?.status==='failed'&&(capacityError(p.turn.error)||this.errors.has(key));this.errors.delete(key);
  if(!isCapacity){this.cancel('ai',threadId);return;}
  if(this.entries.get(threadId)?.failedTurnId===turnId)return;
  this.cancel('ai',threadId);const entry={scope:'ai',threadId,failedTurnId:turnId,dueAt:this.now()+CAPACITY_RETRY_DELAY_MS,state:'verifying'};this.entries.set(threadId,entry);
  this.schedule(entry).catch(()=>{if(this.current(entry,'verifying'))this.publish(entry,'unavailable');});
 }
 current(entry,...states){return !this.closed&&this.entries.get(entry.threadId)===entry&&states.includes(entry.state);}
 async schedule(entry){
  await this.boundary.checked(workspace('ai'),entry.threadId,{fresh:true});if(!this.current(entry,'verifying'))return;
  this.publish(entry,'waiting');entry.timer=this.setTimer(()=>this.run(entry).catch(()=>{}),Math.max(0,entry.dueAt-this.now()));entry.timer?.unref?.();
 }
 async run(entry){
  if(!this.current(entry,'waiting')||this.now()<entry.dueAt)return;this.publish(entry,'checking');
  try{
   const b=this.boundary;
   if(b.native.state!=='ready'||!(await b.loadedIds()).has(entry.threadId)){if(this.current(entry,'checking'))this.publish(entry,'unavailable');return;}
   const thread=await b.checked(workspace('ai'),entry.threadId,{fresh:true});
   if(!this.current(entry,'checking'))return;
   if(!['idle','systemError'].includes(thread.status?.type)||b.active.has(entry.threadId)){this.publish(entry,'superseded');return;}
   const latest=(await b.native.rpc('thread/turns/list',{threadId:entry.threadId,limit:1,itemsView:'summary',sortDirection:'desc'})).data?.[0];
   if(!this.current(entry,'checking'))return;
   if(latest?.id!==entry.failedTurnId||latest.status!=='failed'||[...b.approvals.values()].some(a=>a.params?.threadId===entry.threadId)){this.publish(entry,'superseded');return;}
   const queue=await b.native.rpc('thread/queue/list',{threadId:entry.threadId,limit:1});
   if(!this.current(entry,'checking'))return;
   if(!Array.isArray(queue.data)||queue.data.length||queue.nextCursor){this.publish(entry,'superseded');return;}
   this.publish(entry,'dispatching');
   const result=await b.call('ai',{id:'capacity:'+entry.failedTurnId,method:'turn/start',params:{threadId:entry.threadId,input:[],clientUserMessageId:continuationId(entry.threadId,entry.failedTurnId)}},{clientId:'native-capacity-retry',capacityGuard:()=>{const current=this.current(entry,'dispatching')&&!b.active.has(entry.threadId);if(current)entry.dispatched=true;return current;}});
   if(this.entries.get(entry.threadId)===entry&&!this.closed){entry.retryTurnId=result.turn?.id;this.publish(entry,'submitted');}
  }catch(error){if(this.current(entry,'checking','dispatching','running'))this.publish(entry,[503,504].includes(error.code)||/待核对|重复执行/.test(error.message||'')?'unknown':'unavailable');}
 }
 async read(scope,params){validateId(params.threadId);if(Object.keys(params).some(k=>k!=='threadId'))throw fail(400,'重试状态参数无效');await this.boundary.checked(workspace(scope),params.threadId);const entry=this.entries.get(params.threadId);return {enabled:scope==='ai',retry:entry?.scope===scope?this.status(entry):null};}
 async stop(scope,params){validateId(params.threadId);if(Object.keys(params).some(k=>!['threadId','failedTurnId'].includes(k))||typeof params.failedTurnId!=='string'||!params.failedTurnId||params.failedTurnId.length>256)throw fail(400,'停止重试参数无效');await this.boundary.writable(workspace(scope),params.threadId);return {retry:this.cancel(scope,params.threadId,params.failedTurnId)};}
 connectionLost(){for(const e of this.entries.values())if(['verifying','waiting','checking','dispatching','running'].includes(e.state)){this.clearTimer(e.timer);this.publish(e,['dispatching','running'].includes(e.state)?'unknown':'unavailable');}}
 close(){this.closed=true;for(const e of this.entries.values())this.clearTimer(e.timer);this.errors.clear();}
}
