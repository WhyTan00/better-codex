import './portable-test-environment.mjs';
// Synthetic-only producer for the Go consumer contract test. It imports the
// real adapter/delivery/key code. V3 uses the real cache worker under a SQLite
// write lock; the boundary is synthetic and sends no real Native RPC.
import {EventEmitter} from 'node:events';
import {SyncAdapter} from '../../src/sync-adapter.mjs';
import {nativeReadKey} from '../../src/native-read-cache.mjs';
import {CacheService} from '../../src/cache-service.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
let input='';for await(const chunk of process.stdin)input+=chunk;
const {request,size=1024*1024}=JSON.parse(input),body=request.body;
const result=body.method==='thread/read'?{thread:{id:body.params.threadId}}:{data:[{id:'synthetic-turn',items:[{id:'process',type:'commandExecution',output:'x'.repeat(size)},{id:'final',type:'agentMessage',text:'small final'}]}],nextCursor:'unchanged-native-cursor'};
const payload={method:body.method,params:body.params,result};
const record={scope:request.scope,threadId:body.params.threadId,key:nativeReadKey(body.method,body.params),kind:'history',revision:42,sourceGeneration:'synthetic-source',generation:'synthetic-thread',payload,bytes:Buffer.byteLength(JSON.stringify(payload))};
const native=new EventEmitter();native.start=async()=>{};
const feed=new EventEmitter();feed.sequence=16000;feed.nativeCache={read:async()=>record,get:()=>record};feed.publish=()=>{throw Error('source read attempted foreground publication');};
let dir,service,holder,blocked;
if(body.sourceReadVersion===3){
 dir=await mkdtemp(path.join(tmpdir(),'dsh-source-wire-'));
 service=await CacheService.create({dir,boundary:{call:async(scope,rpc)=>{if(scope!==request.scope||rpc.method!==body.method||JSON.stringify(rpc.params)!==JSON.stringify(body.params))throw Error('source RPC changed');return result;},checked:async()=>({id:body.params.threadId})}});
 feed.nativeCache=service;holder=new DatabaseSync(path.join(dir,'native-read.sqlite'));holder.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
 blocked=service.rpc('cache.setMeta',['test-held','1']);await new Promise(resolve=>setTimeout(resolve,20));
}
const adapter=new SyncAdapter({native,feed});adapter.ready=true;adapter.ack=0;
adapter.socket={readyState:1,bufferedAmount:0,send(raw,callback){process.stdout.write(raw+'\n',callback);},terminate(){throw Error('unexpected fixture transport termination');}};
await adapter.handle(request);
if(service){holder.exec('COMMIT');holder.close();await blocked;await service.close();await rm(dir,{recursive:true,force:true});}
if(adapter.ack!==0||feed.sequence!==16000||adapter.requests.size||adapter.readQueuedBytes)throw Error('foreground read changed durable ACK or retained work');
