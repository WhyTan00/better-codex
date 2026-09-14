import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {workspace,belongs} from './registry.mjs';
import {displayItem,displayThread,displayTurn,applyDisplayEvent,mergeFetchedSnapshot,publicSnapshot} from './sync-projection.mjs';

// The existing native host remains the only execution authority. This feed
// reuses its official paginated history and turn/item events, not rollout files.
export class SyncFeed extends EventEmitter {
 constructor({native,boundary,outbox=null,nativeCache=null}){super();Object.assign(this,{native,boundary,outbox,nativeCache});this.epoch=outbox?.epoch||randomUUID();this.sequence=outbox?.sequence||0;this.cache=new Map();this.scopes=new Map();this.loading=new Map();this.snapshotVersions=new Map();this.pinVersions=new Map();this.interests=new Map();this.deltas=new Map();this.attachments=new Set();this.eventChain=Promise.resolve();
  native.on('notification',event=>{this.eventChain=this.eventChain.then(()=>this.observe(event)).catch(()=>{});});
  native.on('request',event=>{boundary.observe(event);this.eventChain=this.eventChain.then(()=>this.observeRequest(event)).catch(()=>{});});
  native.on('interrupted',()=>{this.attachments.clear();this.publish({event:{type:'host',online:false}});});
  native.on('ready',()=>{this.publish({event:{type:'host',online:true}});for(const[threadId,scope]of this.interests)this.watch(scope,threadId).catch(()=>{});});
 }
 publish(value){const frame=this.outbox?this.outbox.append(value):{...value,type:'publish',epoch:this.epoch,seq:this.sequence+1};this.sequence=frame.seq;this.emit('publish',frame);return frame.seq;}
 async scopeFor(id){if(this.scopes.has(id))return this.scopes.get(id);const t=(await this.native.rpc('thread/read',{threadId:id,includeTurns:false})).thread;for(const scope of ['ai','secondary'])if(await belongs(t.cwd,workspace(scope))){this.scopes.set(id,scope);return scope;}return null;}
 async catalog(scope,cursor=null,search=''){const result=await this.boundary.call(scope,{method:'thread/list',params:{limit:40,cursor,searchTerm:search||null,sortKey:'updated_at'}});if(!cursor)await this.pins(scope);for(const thread of result.data)this.nativeCache?.rememberThread(scope,thread);const data=result.data.map(displayThread);for(const t of data)this.scopes.set(t.id,scope);return {data,nextCursor:result.nextCursor??null};}
 async pins(scope){let cursor=null;const seen=new Set(),data=[];do{const page=await this.boundary.call(scope,{method:'thread/list',params:{sectionId:'01984de2-8f74-7c91-a3b2-5c5e937cf318',sortKey:'section_position',sortDirection:'asc',limit:40,cursor}});data.push(...page.data.map(displayThread));cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('pin cursor repeated');seen.add(cursor);}while(cursor);const result={ids:data.map(t=>t.id),data},version=JSON.stringify(result);if(this.pinVersions.get(scope)!==version){this.pinVersions.set(scope,version);this.publish({scope,threadId:'',event:{type:'pins'},data:result});}return result;}
 async ensureAttached(scope,id){if(this.attachments.has(id)||this.boundary.unmaterialized.has(id))return;if(!(await this.boundary.loadedIds()).has(id))return;try{await this.native.rpc('thread/resume',{threadId:id,excludeTurns:true});this.attachments.add(id);}catch(e){if(this.boundary.journal.ownsThread(scope,id)&&/no rollout found|not materialized/.test(e.message)){this.boundary.unmaterialized.add(id);return;}throw e;}}
 async watch(scope,id){await this.boundary.checked(workspace(scope),id);this.interests.delete(id);this.interests.set(id,scope);while(this.interests.size>100)this.interests.delete(this.interests.keys().next().value);
  // Attaching to a thread already loaded in this SAME host adds a notification
  // listener. Historical threads on another host remain read-only until Send.
  await this.ensureAttached(scope,id);
  const snapshot=await this.snapshot(scope,id);for(const a of this.boundary.approvals.values())if(a.params?.threadId===id)await this.observeRequest(a);return snapshot;
 }
 async snapshot(scope,id,cursor=null){const key=JSON.stringify([scope,id,cursor]);if(this.loading.has(key))return this.loading.get(key);const work=this.readSnapshot(scope,id,cursor).finally(()=>this.loading.delete(key));this.loading.set(key,work);return work;}
 async readSnapshot(scope,id,cursor,background=false){const startRevision=this.sequence,t=await this.boundary.checked(workspace(scope),id,{fresh:!this.boundary.unmaterialized.has(id)});if(!cursor&&!background){this.interests.delete(id);this.interests.set(id,scope);while(this.interests.size>100)this.interests.delete(this.interests.keys().next().value);await this.ensureAttached(scope,id);}let page;try{page=await this.boundary.call(scope,{method:'thread/turns/list',params:{threadId:id,cursor,limit:6,sortDirection:'desc',itemsView:'summary'}});}catch(e){if(!this.boundary.unmaterialized.has(id))throw e;page={data:[],nextCursor:null};}const turns=page.data.map(displayTurn).reverse();
  for(const turn of turns)if(turn.status==='inProgress'){
   const tail=await this.boundary.call(scope,{method:'thread/items/list',params:{threadId:id,turnId:turn.id,limit:100,sortDirection:'desc'}});
   const items=tail.data.slice().reverse().map(x=>displayItem(x,turn.id)).filter(Boolean),ids=new Set(items.map(x=>x.id));turn.items=[...turn.items.filter(x=>!ids.has(x.id)),...items];turn.detailsAvailable=true;
  }
  const fetched={thread:displayThread(t),turns,nextCursor:page.nextCursor??null,confirmedAt:new Date().toISOString()};
  if(cursor)return publicSnapshot(fetched);
  this.flushDeltas();const merged=mergeFetchedSnapshot(fetched,this.cache.get(id),startRevision);this.cache.delete(id);this.cache.set(id,merged);while(this.cache.size>100)this.cache.delete(this.cache.keys().next().value);
  const projection=publicSnapshot(merged),version=JSON.stringify({...projection,confirmedAt:undefined});if(this.snapshotVersions.get(id)!==version){this.snapshotVersions.set(id,version);this.publish({scope,threadId:id,event:{type:'snapshot',snapshot:projection}});}return projection;
 }
 update(scope,id,event){event.threadId=id;const revision=this.sequence+1;this.cache.set(id,applyDisplayEvent(this.cache.get(id),event,revision));while(this.cache.size>150)this.cache.delete(this.cache.keys().next().value);this.publish({scope,threadId:id,event});}
 flushDeltas(){clearTimeout(this.deltaTimer);this.deltaTimer=null;for(const value of this.deltas.values())this.update(value.scope,value.threadId,{type:'delta',turnId:value.turnId,itemId:value.itemId,delta:value.delta});this.deltas.clear();}
 async observe(m){const p=m.params||{},resolved=m.method==='serverRequest/resolved'?this.boundary.approvals.get(String(p.requestId)):null;this.boundary.observe(m);await this.nativeCache?.observe(m);const id=p.threadId||p.thread?.id||resolved?.params?.threadId;if(!id)return;
  let scope=this.scopes.get(id);if(!scope){try{scope=await this.scopeFor(id);}catch{return;}}if(!scope)return;
  if(m.method==='thread/started'){this.scopes.set(id,scope);this.publish({scope,threadId:'',event:{type:'thread',thread:displayThread(p.thread)}});return;}
  if(m.method==='thread/status/changed'){if(p.status?.type==='active'&&!this.interests.has(id))this.watch(scope,id).catch(()=>{});if(this.interests.has(id))this.update(scope,id,{type:'status',status:p.status});this.publish({scope,threadId:'',event:{type:'threadStatus',threadId:id,status:p.status}});return;}
  if(m.method==='thread/name/updated')this.publish({scope,threadId:'',event:{type:'threadName',threadId:id,name:p.threadName||p.name||''}});
  if(m.method.startsWith('thread/section/'))this.pins(scope).catch(()=>{});
  // Completion is a workspace event even when no browser is watching this thread.
  if(m.method==='turn/started'||m.method==='turn/completed'){this.flushDeltas();this.update(scope,id,{type:'turn',turn:displayTurn(p.turn),turnId:p.turn.id});if(this.interests.has(id))this.snapshot(scope,id).catch(()=>{});return;}
  if(!this.interests.has(id))return;
  if(m.method==='item/agentMessage/delta'){const key=id+':'+p.itemId,v=this.deltas.get(key)||{scope,threadId:id,turnId:p.turnId,itemId:p.itemId,delta:''};v.delta+=p.delta||'';this.deltas.set(key,v);if(!this.deltaTimer)this.deltaTimer=setTimeout(()=>this.flushDeltas(),60);return;}
  if(m.method==='item/started'||m.method==='item/completed'){this.flushDeltas();const item=displayItem(p.item,p.turnId);if(item)this.update(scope,id,{type:'item',turnId:p.turnId,item});return;}
  if(m.method==='thread/name/updated')this.publish({scope,threadId:'',event:{type:'threadName',threadId:id,name:p.threadName||p.name||''}});
  if(['thread/reverted','thread/archived','thread/unarchived'].includes(m.method)&&this.interests.has(id))this.snapshot(scope,id).catch(()=>{});
  if(m.method==='serverRequest/resolved')this.publish({scope,threadId:id,event:{type:'approvalResolved',requestId:p.requestId}});
 }
 async observeRequest(m){const id=m.params?.threadId;if(!id)return;const scope=await this.scopeFor(id);if(!scope)return;const p=m.params||{};
  // Only the normal user decision surface is projected. Raw command text and
  // tool arguments stay on the Mac and can be requested explicitly as details.
  if(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput'].includes(m.method))this.publish({scope,threadId:id,event:{type:'approval',request:{id:m.id,method:m.method,threadId:id,questions:p.questions,availableDecisions:p.availableDecisions}}});
 }
 close(){clearTimeout(this.deltaTimer);this.deltas.clear();}
}
