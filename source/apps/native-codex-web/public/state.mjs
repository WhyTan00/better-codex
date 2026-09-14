export class ViewState {
 constructor(){this.epoch=0;this.workspace=null;this.abort=null;this.streamAbort=null;this.reset();}
 reset(){this.thread=null;this.threads=[];this.turns=new Map();this.items=new Map();this.touched=new Map();this.approvals=new Map();this.approvalTouched=new Map();this.retiredGenerations=new Set();this.draft='';this.attachments=[];this.token=null;this.cursor=null;this.threadCursor=null;this.seq=0;this.generation=null;this.pending=null;this.statusSeq=0;this.hostSeq=0;}
 switchWorkspace(id){this.abort?.abort();this.streamAbort?.abort();this.epoch++;this.reset();this.workspace=id;this.abort=new AbortController();return this.epoch;}
 current(epoch,threadId){return epoch===this.epoch&&(!threadId||this.thread?.id===threadId);}
 select(thread){this.streamAbort?.abort();this.epoch++;this.thread=thread;this.turns.clear();this.items.clear();this.touched.clear();this.approvals.clear();this.approvalTouched.clear();this.attachments=[];this.draft='';this.cursor=null;this.pending=null;this.statusSeq=0;this.hostSeq=0;}
 adoptGeneration(generation){if(!generation||generation===this.generation)return true;if(this.retiredGenerations.has(generation))return false;if(this.generation)this.retiredGenerations.add(this.generation);this.generation=generation;this.seq=0;this.statusSeq=0;this.hostSeq=0;this.touched.clear();this.approvalTouched.clear();for(const turn of this.turns.values())turn.liveSeq=0;return true;}
 snapshot(data,{older=false,startedSeq=this.seq}={}){const changed=this.generation!==data.generation;if(!this.adoptGeneration(data.generation))return false;if(changed)startedSeq=0;const previousStatus=this.thread?.status;this.thread={...this.thread,...data.thread};if(this.statusSeq>startedSeq)this.thread.status=previousStatus;if(this.hostSeq<=startedSeq)this.thread.hostInterrupted=data.hostState==='interrupted';
  // A snapshot may race the event stream. Its server-side seq is not an ACK of
  // events delivered here, so never advance the stream watermark from a read.
  if(!older){this.cursor=data.nextCursor;const incoming=new Map((data.approvals||[]).map(a=>[a.key,a]));for(const[key,seq]of this.approvalTouched){if(seq>startedSeq){if(this.approvals.has(key))incoming.set(key,this.approvals.get(key));else incoming.delete(key);}}this.approvals=incoming;}
  for(const t of data.turns||[]){const old=this.turns.get(t.id);this.turns.set(t.id,{...t,items:undefined,...(old?.loadedItemOrder?{loadedItemOrder:old.loadedItemOrder,itemCursor:old.itemCursor,itemsView:old.itemsView}:{}),...(old?.liveSeq>startedSeq?old:{})});for(const item of t.items||[]){if((this.touched.get(item.id)||0)>startedSeq)continue;this.items.set(item.id,{...item,turnId:t.id});}}
 }
 event(e){if(e.workspace!==this.workspace||!this.adoptGeneration(e.generation))return false;if(e.seq&&e.seq<=this.seq)return false;this.seq=e.seq||this.seq;
  const p=e.params||{},tid=p.threadId||p.thread?.id;if(tid&&tid!==this.thread?.id)return false;
  if(e.method==='approval/pending'){this.approvals.set(p.key,p);this.approvalTouched.set(p.key,e.seq);}
  else if(e.method==='approval/resolving'){const a=this.approvals.get(p.key);if(a)a.state='resolving';this.approvalTouched.set(p.key,e.seq);}
  else if(e.method==='serverRequest/resolved'){for(const[k,a]of this.approvals)if(a.id===p.requestId){this.approvals.delete(k);this.approvalTouched.set(k,e.seq);}}
  else if(e.method==='host/interrupted'){for(const k of this.approvals.keys())this.approvalTouched.set(k,e.seq);this.approvals.clear();this.hostSeq=e.seq;if(this.thread)this.thread={...this.thread,hostInterrupted:true};}
  else if(e.method==='thread/status/changed'&&this.thread){this.thread.status=p.status;this.statusSeq=e.seq;}
  else if(e.method==='turn/started'||e.method==='turn/completed'){this.turns.set(p.turn.id,{...p.turn,items:undefined,liveSeq:e.seq});for(const item of p.turn.items||[]){this.items.set(item.id,{...item,turnId:p.turn.id});this.touched.set(item.id,e.seq);}if(e.method==='turn/completed'){for(const k of this.approvals.keys())this.approvalTouched.set(k,e.seq);this.approvals.clear();}}
  else if(e.method==='item/started'||e.method==='item/completed'){this.items.set(p.item.id,{...p.item,turnId:p.turnId});this.touched.set(p.item.id,e.seq);}
  else if(e.method.startsWith('item/')&&e.method.endsWith('/delta')){const item=this.items.get(p.itemId)||{id:p.itemId,turnId:p.turnId,type:e.method.includes('agentMessage')?'agentMessage':e.method.includes('reasoning')?'reasoning':'commandExecution'};
   if(e.method.includes('agentMessage'))item.text=(item.text||'')+(p.delta||'');else if(e.method.includes('reasoning'))item.liveSummary=(item.liveSummary||'')+(p.delta||'');else item.liveOutput=(item.liveOutput||'')+(p.delta||'');this.items.set(item.id,item);this.touched.set(item.id,e.seq);}
  return true;
 }
}
export function parseSSE(buffer,onEvent){let index;while((index=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2);const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data){try{onEvent(JSON.parse(data));}catch{}}}return buffer;}

// Per-tab drafts contain text and already-uploaded attachment metadata, never credentials.
// Namespacing by both workspace and thread prevents cross-workspace restoration.
export class DraftStore {
 constructor(storage=null){this.storage=storage;this.memory=new Map();}
 key(workspace,threadId){if(!['ai','secondary'].includes(workspace)||typeof threadId!=='string'||!threadId)throw new Error('Invalid draft scope');return `native-web-draft:${workspace}:${threadId}`;}
 normalize(value){return {text:typeof value?.text==='string'?value.text.slice(0,60000):'',attachments:Array.isArray(value?.attachments)?value.attachments.filter(a=>a&&typeof a.id==='string').slice(0,5).map(a=>({id:a.id,name:String(a.name||''),mime:String(a.mime||''),size:Number(a.size)||0,threadId:String(a.threadId||'')})):[]};}
 get(workspace,threadId){const key=this.key(workspace,threadId);let raw;try{raw=this.storage?.getItem(key);}catch{}if(!raw)raw=this.memory.get(key);try{return this.normalize(raw?JSON.parse(raw):null);}catch{return this.normalize(null);}}
 set(workspace,threadId,value){const key=this.key(workspace,threadId),draft=this.normalize(value),raw=JSON.stringify(draft);this.memory.set(key,raw);try{if(!draft.text&&!draft.attachments.length)this.storage?.removeItem(key);else this.storage?.setItem(key,raw);}catch{}return draft;}
 acknowledge(workspace,threadId,sent){const draft=this.get(workspace,threadId);if(draft.text===sent.text)draft.text='';const sentIds=new Set(sent.attachments||[]);draft.attachments=draft.attachments.filter(a=>!sentIds.has(a.id));return this.set(workspace,threadId,draft);}
}

export function isWorkbenchRoute(value){const u=new URL(value);return u.pathname==='/workbench'||u.searchParams.get('view')==='workbench';}
export function workbenchReturnUrl(value,scope){const u=new URL(value),back=u.searchParams.get('returnTo'),fallback='/ui/official?workspace='+scope;if(!back)return fallback;try{const r=new URL(back,u.origin);return r.origin===u.origin&&/^\/(?:local\/[0-9a-f-]{36})?$/i.test(r.pathname)&&r.searchParams.get('workspace')===scope?r.pathname+r.search:fallback;}catch{return fallback;}}
