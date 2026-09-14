import {readFile,writeFile,rename} from 'node:fs/promises';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// Read-only, sequential backfill. Live commands retain the adapter's priority
// queue. Completed pages resume after restart; cloud acknowledgement is required.
export class CacheWorker {
 constructor({adapter,stateFile,scopes}){Object.assign(this,{adapter,stateFile,scopes});this.closed=false;this.running=false;}
 start(){if(this.running||this.closed)return;this.running=true;this.run().catch(()=>{}).finally(()=>{this.running=false;if(!this.closed)this.timer=setTimeout(()=>this.start(),60000);});}
 close(){this.closed=true;clearTimeout(this.timer);}
 async ready(){while(!this.closed){const a=this.adapter;if(a.ready&&a.native.state==='ready'&&a.bufferBytes<256*1024&&a.queuedBytes<256*1024)return;await pause(200);}throw Error('stopped');}
 async confirm(seq){const deadline=Date.now()+45000;while(!this.closed&&this.adapter.ack<seq){if(Date.now()>deadline)throw Error('backfill acknowledgement pending');await pause(100);}}
 async save(){const temp=this.stateFile+'.next';await writeFile(temp,JSON.stringify(this.progress),{mode:0o600});await rename(temp,this.stateFile);}
 async run(){
  this.progress??=JSON.parse(await readFile(this.stateFile,'utf8').catch(()=>'{}'));
  const {adapter:a}=this;if(this.progress.__storeId!==a.storeID){this.progress={__storeId:a.storeID};await this.save();}
  for(const scope of this.scopes){let cursor=null;const ids=[];do{
   await this.ready();const page=await a.feed.catalog(scope,cursor);ids.push(...page.data.map(t=>t.id));
   // Catalog pages are cached independently by the gateway; only head refresh
   // drives the sidebar notification. Historical rows remain searchable there.
   const seq=a.feed.publish({scope,threadId:'',event:{type:cursor?'catalogPage':'catalog'},data:page});await this.confirm(seq);
   for(const thread of page.data){await this.ready();const key=scope+':'+thread.id,prior=this.progress[key];if(prior?.complete&&prior.updatedAt===thread.updatedAt&&thread.status?.type!=='active')continue;
    try{let next;if(prior&&!prior.complete&&prior.updatedAt===thread.updatedAt)next=prior.cursor;else{const head=thread.status?.type==='active'?await a.feed.watch(scope,thread.id):await a.feed.readSnapshot(scope,thread.id,null,true);await this.confirm(a.feed.sequence);next=head.nextCursor;this.progress[key]={updatedAt:thread.updatedAt,cursor:next,complete:!next};await this.save();}
     while(next){await this.ready();const older=await a.feed.readSnapshot(scope,thread.id,next,true);const sequence=a.feed.publish({scope,threadId:thread.id,event:{type:'historyPage'},data:older});await this.confirm(sequence);next=older.nextCursor;this.progress[key]={updatedAt:thread.updatedAt,cursor:next,complete:!next};await this.save();await pause(100);}
    }catch{await pause(500);}
   }
   cursor=page.nextCursor;
  }while(cursor&&!this.closed);if(!this.closed){const seq=a.feed.publish({scope,threadId:'',event:{type:'catalogComplete'},data:{ids}});await this.confirm(seq);}}
 }
}
