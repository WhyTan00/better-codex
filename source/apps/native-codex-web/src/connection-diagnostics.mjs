// Connection metadata only. Never record URL/query, headers, raw errors or RPC bodies.
import {appendFile,mkdir,rename,stat,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const enums={
 sampling:['key','large','app_host_start','slow','failure'],
 frameKind:['mcp-response','mcp-notification','mcp-request','fetch-response','persisted-atom-sync','app-host-port-message','opencodex:ipc-result','dsh:sync-state','hello-ack','dsh:pong','other'],
 component:['front','page-ws','native','cloud-bridge','app-host'],
 stage:['wire_queued','wire_sent','wire_failed','boot','attempt','open','ready','hello','closed','failed','reconnecting','syncing','received','pending','dispatch','stopped','replaced','rejected','heartbeat','committed','skipped','started','background','foreground','downloaded','verified','installed'],
 reason:['socket_closed','socket_error','upgrade_rejected','resume_unavailable','protocol_error','scope_renewal','rpc_timeout','rpc_error','rpc_send_failed','native_rejected','initialize_failed','native_disconnected','native_ready','ping_failed','read_failed','write_failed','sequence_gap','backpressure','shutdown','unknown','connect_deadline','page_resume_unavailable','page_ack_invalid','page_session_limit'],
 errorCode:['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','EPIPE','ENOTFOUND','EAI_AGAIN','EAI_FAIL','EAI_NODATA','ERR_SOCKET_CLOSED','ABORT_ERR','ERR_ABORTED','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','EPROTO','ERR_SSL_WRONG_VERSION_NUMBER','EACCES','EPERM','ENOSPC','SQLITE_BUSY','SQLITE_CANTOPEN','401','403','404','408','409','429','500','501','502','503','504','unknown'],
 errorName:['Error','TypeError','ReferenceError','RangeError','SyntaxError','AbortError'],
 failureClass:['timeout','connection','native_rejected','rpc_contract','dns','tls','auth','http','parse','storage','aborted','writer_busy','unknown'],
 scope:['ai','zyy'],
 method:['GET','status','readRecords','requestSync','native-bootstrap','focusThread','diagnosticContext','getTheme','setTheme','saveDocument','getNotificationSettings','setDeviceOwner','setCompletionNotifications','startSync','stopSync','openSettings','initialize','thread/read','thread/list','thread/loaded/list','thread/turns/list','thread/items/list','thread/resume','thread/revert','thread/rollback','thread/start','turn/start','turn/steer','turn/interrupt','thread/stop','thread/queue/add','thread/queue/update','thread/queue/remove','thread/queue/list','thread/goal/get','thread/goal/set','thread/goal/clear','thread/archive','thread/unarchive','thread/section/move','thread/settings/update','config/read','account/read','getAuthStatus','permissionProfile/list','model/list','other','readStream','readThreadRecords','openDeliverable','resolveDeliverable','thread/name/set','thread/fork','thread/queue/delete','thread/queue/reorder','thread/queue/start','account/rateLimits/read','modelProvider/capabilities/read','configRequirements/read','experimentalFeature/list','remoteControl/status/read','collaborationMode/list','skills/list','app/list','mcpServerStatus/list','plugin/list','plugin/installed','thread/metadata/update','thread/unsubscribe','externalAgentConfig/import/readHistories','codex-home','home-directory','locale-info','worktree-shell-environment-config'],
 routeClass:['native_ws','scope_session','native_read','native_catalog','native_bootstrap','cloud_events','performance','asset','local_file','other'],
 state:['connecting','disconnected','ready','connected','transport_connected','stopped'],
 transportPhase:['connecting','dns','tcp','tls','http_upgrade','hello','ready'],
 readPhase:['source_reply','native_connect','cache_read','cache_lookup','native_read','local_commit','publish_ack','cloud_reuse','reply_queue'],
};
const numbers=['wireSequence','payloadBytes','senderQueueFrames','attempt','retryDelayMs','closeCode','statusCode','durationMs','lastMessageAgeMs','lastPongAgeMs','bufferedBytes','pendingRequests','pendingFrames','sequence','ack','generation','socketState','processId','count','rpcCode','sentSequence','recordRevision','responseBytes','targetSequence','normalizeMs','evictMs','monotonicMs','timerLagMs','outboxBytes','oldestAgeMs','freeBytes'];
const booleans=['replayed','handshakeComplete','resumed','nativeReady','timedOut','cacheHit','sharedRead','sourceVerified','projectionCommitted'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hex=/^[a-f0-9]{16}$/;
const page=/^[a-f0-9-]{8,12}$/i;

// This is intentionally the same two-lane FNV hash used by the browser
// diagnostic logger. RPC ids never cross a process boundary in clear text.
export function hashDiagnosticId(value){
 let a=2166136261,b=2246822507;
 for(const c of String(value??'')){a=Math.imul(a^c.charCodeAt(0),16777619);b=Math.imul(b^c.charCodeAt(0),3266489909);}
 return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
}

// Normalize the identifiers that may be carried from a browser MCP request
// into the front/native connection log. Unknown ids are deliberately omitted.
export function rpcDiagnosticContext({id,method,params={},scope,connectionId,pageId}={}){
 const out={};
 if(id!==undefined&&id!==null)out.rpcIdHash=hashDiagnosticId(id);
 if(enums.method.includes(method))out.method=method;
 const scoped=enums.scope.includes(scope);
 if(scoped)out.scope=scope;
 // A thread/turn/client trace is a workspace identity. Never emit it from an
 // unscoped helper call, even if a caller accidentally supplies the fields.
 if(scoped){const trace=params?.traceId||params?.clientUserMessageId;for(const [key,value] of [['traceId',trace],['threadId',params?.threadId],['turnId',params?.turnId??params?.beforeTurnId]])if(uuid.test(value||''))out[key]=value;}
 if(uuid.test(connectionId||''))out.connectionId=connectionId;
 if(page.test(pageId||''))out.pageId=pageId;
 return out;
}

export function errorDiagnosticFields(error){
 const out={};
 const name=error?.name;
 if(enums.errorName.includes(name))out.errorName=name;
 const code=error?.rpcCode;
 if(Number.isSafeInteger(code)&&code>=-32768&&code<=99999)out.rpcCode=code;
 if(error?.code!=null&&enums.errorCode.includes(String(error.code)))out.errorCode=String(error.code);
 const errorCode=String(error?.code||'').toUpperCase();
 if(error?.rpcCode===-32601)out.failureClass='rpc_contract';
 else if(errorCode==='504'||error?.name==='AbortError'||errorCode==='ETIMEDOUT')out.failureClass='timeout';
 else if(errorCode==='ABORT_ERR'||errorCode==='ERR_ABORTED')out.failureClass='aborted';
 else if(['ENOTFOUND','EAI_AGAIN','EAI_FAIL','EAI_NODATA'].includes(errorCode))out.failureClass='dns';
 else if(['CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','EPROTO','ERR_SSL_WRONG_VERSION_NUMBER','ERR_TLS_CERT_ALTNAME_INVALID'].includes(errorCode)||/\bTLS\b|certificate|ssl/i.test(String(error?.message||'')))out.failureClass='tls';
 else if(errorCode==='401'||errorCode==='403'||errorCode==='UNAUTHORIZED'||errorCode==='FORBIDDEN')out.failureClass='auth';
 else if(/^[45][0-9]{2}$/.test(errorCode)||Number.isInteger(error?.statusCode)&&error.statusCode>=400&&error.statusCode<=599)out.failureClass='http';
 else if(error?.name==='SyntaxError'||errorCode==='ERR_INVALID_JSON'||/json|parse/i.test(String(error?.message||'')))out.failureClass='parse';
 else if(['EACCES','EPERM','ENOSPC','SQLITE_BUSY','SQLITE_CANTOPEN'].includes(errorCode))out.failureClass='storage';
 else if(error?.rpcCode!==undefined)out.failureClass='native_rejected';
 else if(error?.code||error?.message)out.failureClass='connection';
 return out;
}
// CapnWeb sends Error name/message, not custom status/code properties. Use a
// fixed public classification and log only the original whitelisted metadata.
export function appHostError(error){
 const message=String(error?.message||''),code=String(error?.code||''),fields=errorDiagnosticFields(error);
 fields.errorFrames=[...String(error?.stack||'').matchAll(/\/(official-app-host|official-settings|official-files|official-boundary|registry)\.mjs:([1-9][0-9]{0,5}):([1-9][0-9]{0,5})/g)].slice(0,4).map(m=>m[1]+'.mjs:'+m[2]+':'+m[3]);
 let failureClass=fields.failureClass||'unknown';
 if(/RpcTarget|instance property|non-serializable|not a function|does not exist|not implemented/i.test(message))failureClass='rpc_contract';
 else if(/disposed|disconnected|connection|socket|no such export ID|page.*replaced/i.test(message))failureClass='connection';
 else if(code==='409'&&/另一页面.*持有|writer|write.*lock/i.test(message))failureClass='writer_busy';
 else if(!error?.code&&!error?.rpcCode&&failureClass==='connection')failureClass='unknown';
 const label={rpc_contract:'页面服务接口不匹配，请重新连接',connection:'页面连接已中断，请恢复连接后核对操作结果',writer_busy:'另一页面正在处理此会话，请等待操作完成',auth:'页面访问未获授权，请核对登录及当前工作区',timeout:'页面服务响应超时，请核对操作结果',storage:'页面服务暂时无法保存数据',http:'页面服务拒绝了这项操作',unknown:'页面服务调用失败，请恢复连接后核对操作结果'}[failureClass]||'页面服务调用失败，请核对操作结果';
 return {fields:{...fields,failureClass},error:new Error('DSH_APP_HOST_'+failureClass.toUpperCase()+': '+label)};
}
export function safeConnectionEvent(value){
 const out={};for(const[k,allowed]of Object.entries(enums))if(allowed.includes(value[k]))out[k]=value[k];
 for(const k of numbers)if(k!=='rpcCode'&&Number.isSafeInteger(value[k])&&value[k]>=0)out[k]=value[k];
 if(Number.isSafeInteger(value.rpcCode)&&value.rpcCode>=-32768&&value.rpcCode<=99999)out.rpcCode=value.rpcCode;
 for(const k of booleans)if(typeof value[k]==='boolean')out[k]=value[k];
 for(const k of ['connectionId','processIdTag','parentTraceId','traceId','threadId','turnId'])if(uuid.test(value[k]||''))out[k]=value[k];
 if(page.test(value.pageId||''))out.pageId=value.pageId;
 if(hex.test(value.rpcIdHash||''))out.rpcIdHash=value.rpcIdHash;
 if(hex.test(value.readIdHash||''))out.readIdHash=value.readIdHash;
 if(hex.test(value.uiVersion||''))out.uiVersion=value.uiVersion;
 if(Array.isArray(value.errorFrames))out.errorFrames=value.errorFrames.filter(frame=>typeof frame==='string'&&/^(?:official-app-host|official-settings|official-files|official-boundary|registry)\.mjs:[1-9][0-9]{0,5}:[1-9][0-9]{0,5}$/.test(frame)).slice(0,4);
 return out;
}
export class ConnectionDiagnostics {
 constructor({file,maxBytes=1024*1024,maxArchives=2,retentionMs=7*86400000}={}){this.file=file;this.maxBytes=maxBytes;this.maxArchives=Math.max(1,Math.min(31,Math.trunc(maxArchives)));this.retentionMs=retentionMs;this.processIdTag=randomUUID();this.chain=Promise.resolve();this.pending=0;this.dropped=0;this.failures=0;this.sequence=0;this.bytes=null;this.queue=[];this.queuedBytes=0;this.running=false;}
 event(value){
  if(!this.file||this.closed)return;
  const record={at:new Date().toISOString(),processIdTag:this.processIdTag,eventSequence:this.sequence+1,...safeConnectionEvent(value)};
  if(this.dropped)record.droppedEvents=this.dropped;
  const raw=JSON.stringify(record)+'\n',bytes=Buffer.byteLength(raw);
  // Metadata bursts must not spend one open/write/close per phase or lose a
  // whole request after 128 queued lines. Both memory bounds include in-flight
  // data, and overflow remains explicit on the next accepted record.
  if(this.pending>=4096||this.queuedBytes+bytes>4*1024*1024){this.dropped++;return;}
  this.sequence++;this.dropped=0;this.pending++;this.queuedBytes+=bytes;this.queue.push({raw,bytes});
  if(!this.running){this.running=true;this.chain=this.chain.then(()=>this.drain());}
 }
 async prepare(){
  if(this.bytes!==null)return;
  await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});this.bytes=0;
  for(let index=0;index<=this.maxArchives;index++){const p=index?this.file+'.'+index:this.file;try{const s=await stat(p);if(Date.now()-s.mtimeMs>this.retentionMs)await unlink(p);else if(p===this.file)this.bytes=s.size;}catch(e){if(e.code!=='ENOENT')throw e;}}
 }
 async rotate(){
  await unlink(this.file+'.'+this.maxArchives).catch(e=>{if(e.code!=='ENOENT')throw e;});
  for(let index=this.maxArchives-1;index>=0;index--)await rename(index?this.file+'.'+index:this.file,this.file+'.'+(index+1)).catch(e=>{if(e.code!=='ENOENT')throw e;});
  this.bytes=0;
 }
 async drain(){
  while(this.queue.length){
   let batch=[],bytes=0;
   try{
    await this.prepare();
    if(this.bytes+this.queue[0].bytes>this.maxBytes)await this.rotate();
    while(this.queue.length&&batch.length<64){
     const next=this.queue[0];
     if(batch.length&&(bytes+next.bytes>64*1024||this.bytes+bytes+next.bytes>this.maxBytes))break;
     batch.push(this.queue.shift());bytes+=next.bytes;
    }
    await appendFile(this.file,batch.map(entry=>entry.raw).join(''),{mode:0o600});this.bytes+=bytes;
   }catch{
    this.failures++;this.bytes=null;
    if(!batch.length){const entry=this.queue.shift();batch=[entry];bytes=entry.bytes;}
   }finally{this.pending-=batch.length;this.queuedBytes-=bytes;}
  }
  this.running=false;
 }
 flush(){return this.chain;}
 close(){this.closed=true;return this.flush();}
}
