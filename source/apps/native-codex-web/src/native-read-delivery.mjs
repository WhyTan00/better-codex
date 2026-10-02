import {nativeReadKey,normalizeReadParams} from './native-read-cache.mjs';

// Negotiated only by the authenticated gateway. No stream cursor, ACK, or
// command receipt is advanced by this read-only source-verified response.
export const SOURCE_READ_VERSION=3,MAX_SOURCE_READ_BYTES=256*1024;
// Version 2 uses the existing cache payload and bridge transport ceilings.
// Version 1 remains byte-for-byte compatible with older gateways.
export const MAX_SOURCE_PAYLOAD_BYTES=48*1024*1024,MAX_SOURCE_TRANSFER_BYTES=64*1024*1024;
export function sourceReadEligible(method,params,version=1){
 const p=normalizeReadParams(method,params);
 if(version===2||version===3)return method==='thread/read'&&typeof p.includeTurns==='boolean'||
  method==='thread/turns/list'&&['summary','notLoaded','full'].includes(p.itemsView)&&['asc','desc'].includes(p.sortDirection)&&p.limit<=20||
  method==='thread/items/list'&&['asc','desc'].includes(p.sortDirection)&&p.limit<=100;
 if(version!==1)return false;
 return !p.cursor&&(method==='thread/read'&&p.includeTurns===false||method==='thread/turns/list'&&['summary','notLoaded','full'].includes(p.itemsView)&&p.sortDirection==='desc'&&p.limit<=20);
}
export function sourceReadResult(scope,body,record){
 const version=body.sourceReadVersion;
 if(![1,2,3].includes(version)||!sourceReadEligible(body.method,body.params,version)||!record||record.deleted||record.kind!=='history'||record.scope!==scope||record.threadId!==body.params?.threadId||record.key!==nativeReadKey(body.method,body.params)||!record.sourceGeneration||!record.generation||!Number.isSafeInteger(record.revision)||record.revision<1||record.payload?.method!==body.method||nativeReadKey(body.method,record.payload?.params)!==record.key)return null;
 if(version>=2&&(!Number.isSafeInteger(record.bytes)||record.bytes<0||record.bytes>MAX_SOURCE_PAYLOAD_BYTES||Buffer.byteLength(JSON.stringify(record.payload))>MAX_SOURCE_PAYLOAD_BYTES))return null;
 if(record.sourceOnly&&version!==3)return null;
 const value={...record,source:version===3&&record.source==='mac-cache'?'mac-cache':'native',readDelivery:{version,sourceVerified:true,projectionCommitted:false,...(version===3?{sourceOnly:record.sourceOnly===true}: {})}};
 return Buffer.byteLength(JSON.stringify(value))<=(version===1?MAX_SOURCE_READ_BYTES:MAX_SOURCE_TRANSFER_BYTES)?value:null;
}
export function readAbort(reason='canceled'){return Object.assign(Error('只读请求已结束'),{code:'ABORT_ERR',name:'AbortError',failureClass:reason==='deadline'?'timeout':'aborted'});}
export function checkReadInterest(signal){if(signal?.aborted)throw signal.reason||readAbort();}
export function withReadInterest(work,signal){
 if(!signal)return work;
 // Observe the shared operation even if this waiter has already gone away.
 return new Promise((resolve,reject)=>{
  const aborted=()=>{signal.removeEventListener('abort',aborted);reject(signal.reason||readAbort());};
  Promise.resolve(work).then(value=>{signal.removeEventListener('abort',aborted);if(signal.aborted)aborted();else resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});
  if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});
 });
}
