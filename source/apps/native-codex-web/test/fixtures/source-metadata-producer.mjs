import './portable-test-environment.mjs';
// Synthetic inputs, real SyncAdapter metadata execution and reply producer.
// No database, Native RPC, model turn or production account is opened.
import {EventEmitter} from 'node:events';
import {SyncAdapter} from '../../src/sync-adapter.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;
const {request}=JSON.parse(input),scope=request.scope,threadId=request.body?.threadId||'11111111-1111-4111-a111-111111111111';
const generation='metadata-source';
const catalog={scope,key:'thread:'+threadId,threadId,kind:'catalog',sourceGeneration:generation,generation:'catalog-version',revision:42,payload:{id:threadId,cwd:'/workspace/example'},bytes:80};
const status={scope,key:'catalog-status',kind:'catalog-status',sourceGeneration:generation,generation:'catalog-version',revision:43,payload:{state:'ready'},bytes:17};
const bootstrap={scope,key:'bootstrap',kind:'bootstrap',sourceGeneration:generation,generation:'bootstrap-version',revision:40,payload:{config:{fixture:true}},bytes:27};
const native=new EventEmitter();native.start=async()=>{};
const feed=new EventEmitter();feed.sequence=16000;
feed.nativeCache={generation,catalog:async()=>{},changes(after){if(after!==0)throw Error('stale generation cursor was not reset');return {generation,records:[catalog],cursor:42,hasMore:false};},get(_scope,key){if(_scope!==scope)throw Error('workspace changed');return key==='bootstrap'?bootstrap:key==='catalog-status'?status:{payload:{itemsBackwardsCursor:'original-opaque-cursor'}};}};
feed.publish=()=>{throw Error('metadata reply entered foreground projection');};
const boundary={checked:async(_workspace,id)=>{if(id!==threadId)throw Error('thread identity changed');}};
const adapter=new SyncAdapter({native,feed,boundary});adapter.ready=true;adapter.ack=0;
adapter.socket={readyState:1,bufferedAmount:0,send(raw,callback){process.stdout.write(raw+'\n',callback);},terminate(){throw Error('unexpected fixture transport termination');}};
await adapter.handle(request);
if(adapter.ack!==0||feed.sequence!==16000||adapter.requests.size)throw Error('metadata changed global ACK or retained work');
