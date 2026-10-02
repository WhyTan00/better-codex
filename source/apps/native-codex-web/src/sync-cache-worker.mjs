import {readFile,writeFile,rename} from 'node:fs/promises';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export const WARM_HISTORY_POLICY={recentHeads:20,foregroundQuietMs:1500};
// Directory metadata and recent/used heads are warmed while idle. Older pages
// are populated by actual reads, rather than an endless full-history sweep.
export class CacheWorker {
 constructor({adapter,stateFile,scopes,now=()=>Date.now(),wait=pause}){Object.assign(this,{adapter,stateFile,scopes,now,wait});this.closed=false;this.running=false;this.hot=new Map();this.lastForegroundAt=0;}
 touch(scope,threadId){this.lastForegroundAt=this.now();if(!threadId)return;const key=scope+':'+threadId;this.hot.delete(key);this.hot.set(key,this.now());while(this.hot.size>100)this.hot.delete(this.hot.keys().next().value);}
 foregroundBusy(){const a=this.adapter;return this.now()-this.lastForegroundAt<WARM_HISTORY_POLICY.foregroundQuietMs||a.requests?.size>0||a.readQueue?.length>0||a.controlQueue?.length>0||[...(a.feed.cache?.values()||[])].some(s=>s.turns?.some(t=>t.status==='inProgress'));}
 start(){if(this.running||this.closed)return;this.running=true;this.run().catch(()=>{}).finally(()=>{this.running=false;if(!this.closed)this.timer=setTimeout(()=>this.start(),60000);});}
 close(){this.closed=true;clearTimeout(this.timer);}
 async ready(){while(!this.closed){const a=this.adapter,c=a.feed.nativeCache;if(a.cachePersistence==='memory'||c?.healthy===false)throw Error('volatile cache: pause background history');if(a.ready&&!this.foregroundBusy()&&(c?.pendingBytes||0)<256*1024&&!a.feed.outbox?.pressure()&&!a.hasUnloadedFrames&&a.native.state==='ready'&&a.bufferBytes<256*1024&&a.queuedBytes<256*1024)return;await this.wait(200);}throw Error('stopped');}
 async confirm(seq){if(!Number.isSafeInteger(seq)||seq<1)throw Error('publication deferred');const deadline=Date.now()+45000;while(!this.closed&&this.adapter.ack<seq){if(Date.now()>deadline)throw Error('backfill acknowledgement pending');await pause(100);}if(this.closed)throw Error('stopped');}
 async save(){const temp=this.stateFile+'.next';await writeFile(temp,JSON.stringify(this.progress),{mode:0o600});await rename(temp,this.stateFile);}
 async run(){
  if(this.adapter.cachePersistence==='memory')return;
  this.progress??=JSON.parse(await readFile(this.stateFile,'utf8').catch(()=>'{}'));
  const {adapter:a}=this;if(this.progress.__storeId!==a.storeID){this.progress={__storeId:a.storeID};await this.save();}
  for(const scope of this.scopes){for(const key of a.feed.nativeCache?.warmHeads||[])if(key.startsWith(scope+':'))a.feed.nativeCache.warmHeads.delete(key);let cursor=null,recent=0;const ids=[],rebuild=a.supportsProjectionRecovery&&a.feed.outbox?.rebuildToken(scope);if(rebuild){a.feed.snapshotVersions.clear();a.feed.pinVersions.delete(scope);}
   do{
   await this.ready();const page=await a.feed.catalog(scope,cursor);ids.push(...page.data.map(t=>t.id));
   // Catalog pages are cached independently by the gateway; only head refresh
   // drives the sidebar notification. Historical rows remain searchable there.
   const seq=a.feed.publish({scope,threadId:'',event:{type:cursor?'catalogPage':'catalog'},data:page});await this.confirm(seq);
   const selected=page.data.filter(thread=>recent++<WARM_HISTORY_POLICY.recentHeads||this.hot.has(scope+':'+thread.id)||a.feed.interests.has(thread.id));
   for(const t of selected)a.feed.nativeCache?.warmHeads?.add(scope+':'+t.id);
   selected.sort((x,y)=>(this.hot.get(scope+':'+y.id)||0)-(this.hot.get(scope+':'+x.id)||0));
   for(const thread of selected){await this.ready();const key=scope+':'+thread.id,prior=this.progress[key];
    if(rebuild){
     // Reconcile current/recent heads and approvals after a source reset.
     // Unopened historical pages remain available through scoped Mac reads.
     const head=await a.feed.readSnapshot(scope,thread.id,null,true);await this.confirm(a.feed.sequence);
     if(a.feed.nativeCache){await a.feed.nativeCache.read(scope,'thread/read',{threadId:thread.id,includeTurns:false},{fresh:true});await a.feed.nativeCache.read(scope,'thread/turns/list',{threadId:thread.id,limit:20,itemsView:'summary',sortDirection:'desc'},{fresh:true});}
     const approvals=[...a.boundary.approvals.values()].filter(v=>v.params?.threadId===thread.id&&['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput'].includes(v.method)).map(v=>({id:v.id,method:v.method,threadId:thread.id,questions:v.params.questions,availableDecisions:v.params.availableDecisions}));
     await this.confirm(a.feed.publish({scope,threadId:thread.id,event:{type:'approvals',approvals}}));
     continue;
    }
    if((prior?.headSynced||prior?.complete)&&prior.updatedAt===thread.updatedAt&&thread.status?.type!=='active')continue;
    try{const head=await a.feed.readSnapshot(scope,thread.id,null,true);await this.confirm(a.feed.sequence);
     await this.ready();if(a.feed.nativeCache){await a.feed.nativeCache.read(scope,'thread/read',{threadId:thread.id,includeTurns:false},{fresh:true});await this.ready();await a.feed.nativeCache.read(scope,'thread/turns/list',{threadId:thread.id,limit:20,itemsView:'summary',sortDirection:'desc'},{fresh:true});}
     this.progress[key]={updatedAt:thread.updatedAt,cursor:head.nextCursor,complete:!head.nextCursor,headSynced:true};await this.save();
    }catch{if(a.cachePersistence==='memory')return;await this.wait(500);}
   }
   cursor=page.nextCursor;
  }while(cursor&&!this.closed);if(!this.closed){const seq=a.feed.publish({scope,threadId:'',event:{type:'catalogComplete'},data:{ids}});await this.confirm(seq);if(rebuild)a.feed.outbox.finishRebuild(scope,rebuild);}}
 }
}
