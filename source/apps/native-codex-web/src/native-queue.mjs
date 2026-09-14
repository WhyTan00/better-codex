import {createHash,randomUUID} from 'node:crypto';
import {workspace,validateId,fail} from './registry.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Native owns payload ordering, persistence and execution. This table retains
// renderer metadata and consumed/deleted identities, never an execution loop.
export class NativeQueue {
 constructor({boundary,journal}) {
  Object.assign(this,{boundary,journal,db:journal.db});
  this.db.exec(`CREATE TABLE IF NOT EXISTS native_queue_ui (
   workspace TEXT NOT NULL,thread_id TEXT NOT NULL,message_id TEXT NOT NULL,
   native_id TEXT,metadata TEXT NOT NULL,state TEXT NOT NULL,
   PRIMARY KEY(workspace,thread_id,message_id))`);
 }
 rows(scope,threadId){return this.db.prepare('SELECT * FROM native_queue_ui WHERE workspace=? AND thread_id=?').all(scope,threadId);}
 async snapshot(scope,threadId){
  await this.boundary.native.start();
  await this.boundary.checked(workspace(scope),threadId);
  const data=[],seen=new Set();let cursor;
  do {const r=await this.boundary.native.rpc('thread/queue/list',{threadId,limit:100,...(cursor?{cursor}:{})});data.push(...r.data);cursor=r.nextCursor;if(cursor&&seen.has(cursor))throw fail(503,'队列分页异常');seen.add(cursor);} while(cursor);
  const rows=this.rows(scope,threadId),byId=new Map(rows.map(r=>[r.message_id,r]));
  const messages=data.map(item=>{
   const row=byId.get(item.clientUserMessageId);
   if(row&&['pending','unknown'].includes(row.state))this.db.prepare("UPDATE native_queue_ui SET state='queued',native_id=? WHERE workspace=? AND thread_id=? AND message_id=?").run(item.id,scope,threadId,row.message_id);
   const text=item.input.filter(i=>i.type==='text').map(i=>i.text).join('\n');
   return row?JSON.parse(row.metadata):{id:item.clientUserMessageId,text,cwd:workspace(scope).root,createdAt:0,context:{prompt:text,addedFiles:[],imageAttachments:[],fileAttachments:[],commentAttachments:[]},betterCodexNativeOnly:true};
  });
  for(const row of rows)if(row.state==='queued'&&!data.some(i=>i.id===row.native_id))this.db.prepare("UPDATE native_queue_ui SET state='consumed' WHERE workspace=? AND thread_id=? AND message_id=?").run(scope,threadId,row.message_id);
  return {threadId,messages,revision:hash([data,messages]),native:data};
 }
 requestStatus(scope,id){workspace(scope);validateId(id);const r=this.journal.get(scope,id);return r?{requestId:id,state:r.state,result:r.result}:{requestId:id,state:'not_found'};}
 async read(scope,threadId){
  const ids=threadId?[validateId(threadId)]:this.db.prepare("SELECT DISTINCT thread_id FROM native_queue_ui WHERE workspace=? AND state IN ('queued','pending','unknown')").all(scope).map(r=>r.thread_id);
  const state={},revisions={};for(const id of ids){const s=await this.snapshot(scope,id);state[id]=s.messages;revisions[id]=s.revision;}
  return {state,revisions,authority:'mac-native'};
 }
 async command(scope,request,clientId){
  const {threadId,operation,commandId}=request;validateId(threadId);
  if(!clientId)throw fail(400,'队列操作缺少客户端身份');
  return this.boundary.serial('native-queue:'+scope+':'+threadId,async()=>{
   const result=await this.journal.run(scope,commandId,{kind:'native-queue',...request},async()=>{
    await this.boundary.writable(workspace(scope),threadId);
    const current=await this.snapshot(scope,threadId);
    if(request.revision!==current.revision)throw fail(409,'队列已在 Mac 或另一页面改变，请核对后重试');
    const call=(method,params)=>this.boundary.call(scope,{id:randomUUID(),method,params:{threadId,...params}},{clientId});
    if(operation==='sync'){
     const desired=request.messages;
     if(!Array.isArray(desired)||desired.length>100||new Set(desired.map(m=>m?.id)).size!==desired.length)throw fail(400,'队列内容无效');
     // Validate everything before deleting or adding anything.
     for(const message of desired){validateId(message.id);if(Buffer.byteLength(JSON.stringify(message))>10*1024*1024)throw fail(413,'排队消息过大');
      const old=current.messages.find(m=>m.id===message.id);
      if(!old||hash(old)!==hash(message)){const input=request.inputs?.[message.id];if(!Array.isArray(input)||!input.length)throw fail(400,'排队消息尚未准备完成');await this.boundary.validateInput(scope,input);}
      const prior=this.rows(scope,threadId).find(r=>r.message_id===message.id);
      if(!old&&prior&&['consumed','unknown','pending'].includes(prior.state))throw fail(409,'这条消息已经执行或结果待核对，不会重复加入');
     }
     for(const old of current.native)if(!desired.some(m=>m.id===old.clientUserMessageId)){
      const r=await call('thread/queue/delete',{queuedSubmissionId:old.id});if(!r.deleted)throw fail(409,'消息已由 Mac 开始执行');
      this.db.prepare("UPDATE native_queue_ui SET state='deleted' WHERE workspace=? AND thread_id=? AND message_id=?").run(scope,threadId,old.clientUserMessageId);
     }
     const ids=[];
     for(const message of desired){const old=current.native.find(m=>m.clientUserMessageId===message.id),metadata=JSON.stringify(message);let nativeId=old?.id;
      if(request.inputs?.[message.id])await this.boundary.files?.retainQueuedInput?.(scope,request.inputs[message.id]);
      if(!old){
       this.db.prepare("INSERT INTO native_queue_ui VALUES(?,?,?,?,?,'pending') ON CONFLICT(workspace,thread_id,message_id) DO UPDATE SET metadata=excluded.metadata,state='pending'").run(scope,threadId,message.id,null,metadata);
       try {const r=await call('thread/queue/add',{clientUserMessageId:message.id,input:request.inputs[message.id]});nativeId=r.queuedSubmission.id;}
       catch(e){this.db.prepare("UPDATE native_queue_ui SET state=? WHERE workspace=? AND thread_id=? AND message_id=?").run([409,503,504].includes(e.code)?'unknown':'rejected',scope,threadId,message.id);throw e;}
      }else if(hash(current.messages.find(m=>m.id===message.id))!==hash(message))await call('thread/queue/update',{queuedSubmissionId:old.id,input:request.inputs[message.id]});
      this.db.prepare("INSERT INTO native_queue_ui VALUES(?,?,?,?,?,'queued') ON CONFLICT(workspace,thread_id,message_id) DO UPDATE SET native_id=excluded.native_id,metadata=excluded.metadata,state='queued'").run(scope,threadId,message.id,nativeId,metadata);ids.push(nativeId);
     }
     // A newly added item may already be running. Reorder only remaining IDs.
     const latest=await this.snapshot(scope,threadId),remaining=new Set(latest.native.map(m=>m.id)),order=ids.filter(id=>remaining.has(id));
     if(order.length>1&&JSON.stringify(order)!==JSON.stringify(latest.native.map(m=>m.id)))await call('thread/queue/reorder',{queuedSubmissionIds:order});
    }else if(operation==='send-now'){
     const item=current.native.find(m=>m.clientUserMessageId===request.messageId);if(!item)throw fail(409,'消息已由 Mac 处理');
     // This front may attach after turn/started. Resolve from the Native head,
     // never infer idleness from an empty local notification map.
     const head=await this.boundary.native.rpc('thread/turns/list',{threadId,limit:1,sortDirection:'desc'});
     const activeTurn=head.data?.find(turn=>turn.status==='inProgress');
     const activeId=activeTurn?.id;
     const thread=await this.boundary.checked(workspace(scope),threadId,{fresh:true});
     if(thread.status?.type==='active'&&!activeId)throw fail(409,'正在核对当前运行轮次，消息仍在队列中，请稍后重试');
     if(activeId){
      // Claim before steering. A lost ACK remains unknown in the journal;
      // never restore automatically and risk executing the same input twice.
      const r=await call('thread/queue/delete',{queuedSubmissionId:item.id});if(!r.deleted)throw fail(409,'消息已由 Mac 开始执行');
      this.db.prepare("UPDATE native_queue_ui SET state='unknown' WHERE workspace=? AND thread_id=? AND message_id=?").run(scope,threadId,request.messageId);
      await call('turn/steer',{expectedTurnId:activeId,input:item.input,clientUserMessageId:item.clientUserMessageId});
     }else await call('thread/queue/start',{queuedSubmissionId:item.id});
     this.db.prepare("UPDATE native_queue_ui SET state='consumed' WHERE workspace=? AND thread_id=? AND message_id=?").run(scope,threadId,request.messageId);
    }else throw fail(400,'未知队列操作');
    return this.read(scope,threadId);
   });
   if(result.state==='accepted')return result.result;
   throw fail(['unknown','pending'].includes(result.state)?409:result.result?.code||400,['unknown','pending'].includes(result.state)?'Mac 接收结果待核对，不会自动重发':result.result?.error||'队列操作失败');
  });
 }
}
