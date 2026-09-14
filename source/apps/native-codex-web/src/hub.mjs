import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Native} from './native.mjs';
import {workspace,belongs,fail,validateId,publicThread} from './registry.mjs';
export class Hub extends EventEmitter {
 constructor({journal,nativeFactory=ws=>new Native(ws)}={}){super();this.journal=journal;this.factory=nativeFactory;this.hosts=new Map();this.metadata=new Map();this.liveTurns=new Map();this.owners=new Map();this.loaded=new Set();this.active=new Map();this.approvals=new Map();this.queues=new Map();this.generation=randomUUID();this.sequence={ai:0,secondary:0};this.eventChains=new Map();}
 async host(ws){if(!this.hosts.has(ws.id)){const h=this.factory(ws);this.hosts.set(ws.id,h);
   const enqueue=(m,request)=>{const before=this.eventChains.get(ws.id)||Promise.resolve();this.eventChains.set(ws.id,before.then(()=>this.nativeEvent(ws,m,request)).catch(()=>{}));};
   h.on('notification',m=>enqueue(m,false));h.on('request',m=>enqueue(m,true));h.on('interrupted',info=>{for(const [id,w]of this.owners)if(w===ws.id){this.loaded.delete(id);this.active.delete(id);this.liveTurns.delete(id);}for(const [k,a]of this.approvals)if(a.workspace===ws.id)this.approvals.delete(k);this.publish(ws.id,'host/interrupted',info);});}
  const h=this.hosts.get(ws.id);await h.start();if(h.state==='interrupted')throw fail(503,'原生宿主已中断，需要人工恢复');return h;}
 publish(ws,method,params){const event={generation:this.generation,seq:++this.sequence[ws],workspace:ws,method,params};this.emit('event',event);}
 async checked(ws,id){validateId(id);const known=this.owners.get(id);if(known&&known!==ws.id)throw fail(404,'会话不存在或不属于此工作区');
  const h=await this.host(ws);let t;try{t=(await h.rpc('thread/read',{threadId:id,includeTurns:false})).thread;}catch(e){if(e.code===503||e.code===504)throw e;if(this.journal.ownsThread(ws.id,id)&&this.loaded.has(id)&&this.metadata.has(id))return this.metadata.get(id);throw fail(404,'会话不存在或不属于此工作区');}
  if(!await belongs(t.cwd,ws))throw fail(404,'会话不存在或不属于此工作区');this.owners.set(id,ws.id);this.metadata.set(id,t);return t;}
 async list(ws,{cursor=null,search=''}={}){const h=await this.host(ws);const r=await h.rpc('thread/list',{limit:50,cursor,searchTerm:search.slice(0,160)||null,useStateDbOnly:true,modelProviders:[],sortKey:'updated_at'});const data=[];for(const t of r.data){if(await belongs(t.cwd,ws)){this.owners.set(t.id,ws.id);data.push({...publicThread(t),writable:h.isShared||this.journal.ownsThread(ws.id,t.id)});}}return{data,nextCursor:r.nextCursor,generation:this.generation};}
 async snapshot(ws,id,cursor=null){const t=await this.checked(ws,id);const h=await this.host(ws);let page;try{page=await h.rpc('thread/turns/list',{threadId:id,limit:12,cursor,sortDirection:'desc',itemsView:'summary'});}catch(e){const fresh=Date.now()/1000-(t.createdAt||0)<60;if(!this.loaded.has(id)||e.code!==502||(!this.liveTurns.has(id)&&!fresh)||!/(not supported yet|not found|not materialized|no rollout)/i.test(e.message))throw e;page={data:[],nextCursor:null,persistencePending:true};}
  if(!cursor){const live=this.liveTurns.get(id);if(live){const persisted=page.data.find(x=>x.id===live.id);if(persisted&&persisted.status!=='inProgress'){this.liveTurns.delete(id);}else {page.data=page.data.filter(x=>x.id!==live.id);page.data.unshift({...live,items:[...live.items.values()]});}}}
  return{thread:{...publicThread(t),writable:h.isShared||this.journal.ownsThread(ws.id,id)},turns:page.data,nextCursor:page.nextCursor,approvals:[...this.approvals.values()].filter(a=>a.workspace===ws.id&&a.threadId===id),hostState:h.state,generation:this.generation,seq:this.sequence[ws.id]};}
 async items(ws,id,turnId,cursor){await this.checked(ws,id);return(await this.host(ws)).rpc('thread/items/list',{threadId:id,turnId,limit:40,cursor:cursor||null,sortDirection:'desc'});}
 serial(key,fn){const prev=this.queues.get(key)||Promise.resolve();const next=prev.catch(()=>{}).then(fn);this.queues.set(key,next);next.finally(()=>{if(this.queues.get(key)===next)this.queues.delete(key);}).catch(()=>{});return next;}
 async mutate(ws,body,attachments){const {op,threadId,requestId}=body;
  if(!['new','send','stop','approval'].includes(op))throw fail(400,'不支持的操作');
  // Authorization runs before deduplication/result lookup, including guessed thread IDs.
  if(op!=='new'){await this.checked(ws,threadId);if(!this.journal.ownsThread(ws.id,threadId)&&!(op==='send'&&(await this.host(ws)).isShared))throw fail(403,'此操作需要当前宿主持有会话');}
  return this.serial(`${ws.id}:${threadId||'new'}`,()=>this.journal.run(ws.id,requestId,body,async()=>{
   const h=await this.host(ws);
   if(op==='new'){const r=await h.rpc('thread/start',{cwd:ws.root});this.journal.manageThread(ws.id,r.thread.id);this.metadata.set(r.thread.id,r.thread);this.owners.set(r.thread.id,ws.id);this.loaded.add(r.thread.id);return{thread:{...publicThread(r.thread),writable:true},policy:{approvalPolicy:r.approvalPolicy,sandbox:r.sandbox,model:r.model,reasoningEffort:r.reasoningEffort,serviceTier:r.serviceTier}};}
   if(op==='approval')return this.answer(ws,body,h);
   if(op==='stop'){const turnId=this.active.get(threadId);if(!turnId)throw fail(409,'没有本宿主正在执行的任务');return h.rpc('turn/interrupt',{threadId,turnId});}
   if(typeof body.text!=='string'||body.text.length>60000||(!body.text.trim()&&!body.attachments?.length))throw fail(400,'请输入消息（最多 60000 字符）');
   const t=await this.checked(ws,threadId);if(t.status?.type==='active'||this.active.has(threadId))throw fail(409,'任务正在执行，请等待或停止后发送');
   if(!this.loaded.has(threadId)){await h.rpc('thread/resume',{threadId,excludeTurns:true});if(!this.journal.ownsThread(ws.id,threadId))this.journal.manageThread(ws.id,threadId);this.loaded.add(threadId);}
   const input=[{type:'text',text:body.text},...await attachments.resolve(ws,threadId,body.attachments||[])];
   const r=await h.rpc('turn/start',{threadId,input,clientUserMessageId:requestId});this.active.set(threadId,r.turn.id);return r;
  }));
 }
 async nativeEvent(ws,m,request){const p=m.params||{};const id=p.threadId||p.thread?.id;
  if(!id){if(m.method==='serverRequest/resolved'){const key=`${ws.id}:${JSON.stringify(p.requestId)}`;const a=this.approvals.get(key);if(a){this.approvals.delete(key);this.publish(ws.id,m.method,{...p,threadId:a.threadId});}}else if(request){const h=await this.host(ws);if(!h.isShared)h.send({id:m.id,error:{code:-32601,message:'Unsupported unscoped request'}});}return;}
  if(p.thread?.cwd){if(!await belongs(p.thread.cwd,ws))return;this.owners.set(id,ws.id);}
  if(this.owners.get(id)!==ws.id){try{await this.checked(ws,id);}catch{return;}}
  if(m.method==='serverRequest/resolved'){this.approvals.delete(`${ws.id}:${JSON.stringify(p.requestId)}`);}
  if(request){const key=`${ws.id}:${JSON.stringify(m.id)}`;const a={key,workspace:ws.id,threadId:id,id:m.id,method:m.method,params:p,state:'pending'};this.approvals.set(key,a);this.publish(ws.id,'approval/pending',a);return;}
  if(m.method==='turn/started'){this.active.set(id,p.turn.id);this.liveTurns.set(id,{...p.turn,items:new Map(),itemsView:'full'});}
  if(m.method==='thread/status/changed'&&this.metadata.has(id))this.metadata.get(id).status=p.status;
  const live=this.liveTurns.get(id);if(live&&p.turnId===live.id&&p.item){live.items.set(p.item.id,p.item);if(live.items.size>100){live.items.delete(live.items.keys().next().value);live.itemsView='summary';}}
  if(live&&p.turnId===live.id&&m.method.endsWith('/delta')){const item=live.items.get(p.itemId);if(item){const field=m.method.includes('agentMessage')?'text':m.method.includes('reasoning')?'liveSummary':'aggregatedOutput';item[field]=((item[field]||'')+(p.delta||'')).slice(-100000);}}
  if(m.method==='turn/completed'){this.active.delete(id);if(live){Object.assign(live,{...p.turn,items:live.items});for(const item of p.turn.items||[])live.items.set(item.id,item);}for(const[k,a]of this.approvals)if(a.threadId===id)this.approvals.delete(k);}
  // Only thread-scoped native v2 events are exposed. Legacy codex/event duplicates are excluded.
  if(/^(thread|turn|item|error|serverRequest)\//.test(m.method)||m.method==='error')this.publish(ws.id,m.method,p.thread?{...p,thread:publicThread(p.thread)}:p);
 }
 async answer(ws,b,h){const a=this.approvals.get(b.approvalKey);if(!a||a.workspace!==ws.id||a.threadId!==b.threadId||a.state!=='pending')throw fail(409,'审批已处理或已失效');let result;
  if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(a.method)){if(!['accept','decline','cancel'].includes(b.decision))throw fail(400,'无效审批决定');if(a.params.availableDecisions&&!a.params.availableDecisions.includes(b.decision))throw fail(400,'该决定不可用');result={decision:b.decision};}
  else if(a.method==='item/tool/requestUserInput'){const answers={};for(const q of a.params.questions||[]){const text=b.answers?.[q.id];if(typeof text!=='string'||text.length>4000)throw fail(400,'请完整回答');answers[q.id]={answers:[text]};}result={answers};}
  else throw fail(409,'此原生请求尚不支持回答，可停止任务');
  a.state='resolving';h.send({id:a.id,result});this.publish(ws.id,'approval/resolving',{key:a.key,threadId:a.threadId});return{approvalKey:a.key,state:'resolving'};
 }
 async close(){await Promise.all([...this.hosts.values()].map(h=>h.close()));}
}
