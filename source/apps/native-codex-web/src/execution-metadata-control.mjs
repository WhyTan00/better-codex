import {SUBMISSION_CONTEXT_PROTOCOL} from './submission-context.mjs';
import {rpcDiagnosticContext,errorDiagnosticFields} from './connection-diagnostics.mjs';
export const EXECUTION_METADATA_PROTOCOL='dsh-execution-metadata-v1';
const methods=new Set(['thread/read','thread/goal/get','config/read','configRequirements/read']);
export function validateExecutionMetadata(method,params){
 if(!methods.has(method)||!params||typeof params!=='object'||Array.isArray(params))throw Object.assign(Error('只允许读取执行元数据'),{code:403});
 const only=keys=>Object.keys(params).every(key=>keys.includes(key));
 if(method==='thread/read'&&(!only(['threadId','includeTurns'])||params.includeTurns!==false)||method==='thread/goal/get'&&!only(['threadId'])||['thread/read','thread/goal/get'].includes(method)&&!(/^[a-f0-9-]{36}$/i.test(params.threadId||'')))throw Object.assign(Error('会话读取参数无效'),{code:403});
 if(method==='config/read'&&(!only(['cwd','includeLayers'])||params.includeLayers!==false||params.cwd!=null&&typeof params.cwd!=='string')||method==='configRequirements/read'&&!only([]))throw Object.assign(Error('执行配置读取参数无效'),{code:403});
}
// A read-only control response is never put behind retained history receipts.
// It is tied to one authenticated wire and is never replayed after replacement.
export async function readExecutionMetadata({message:m,page,wire,epoch,native,boundary,pages,identityGeneration,log}){
 const id=m.requestId,started=performance.now(),nativeGeneration=native.generation,identity=identityGeneration();
 const context=rpcDiagnosticContext({id,method:m.method,params:m.params,scope:page.scope,pageId:page.diagnosticPageId,connectionId:page.connectionId});
 const current=()=>!page.expired&&page.wire===wire&&wire.readyState===1&&native.state==='ready'&&native.generation===nativeGeneration&&identityGeneration()===identity;
 const response={type:'dsh:execution-metadata-result',protocol:EXECUTION_METADATA_PROTOCOL,requestId:id,scope:page.scope,resumeId:page.resumeId,connectionId:page.connectionId,frontEpoch:epoch,nativeGeneration};
 try{
  if(!/^[a-f0-9-]{36}$/i.test(id||'')||m.protocol!==EXECUTION_METADATA_PROTOCOL||m.scope!==page.scope||m.resumeId!==page.resumeId||m.connectionId!==page.connectionId||m.frontEpoch!==epoch||m.nativeGeneration!==nativeGeneration||!current())throw Object.assign(Error('执行读取连接已更换'),{code:409});
  validateExecutionMetadata(m.method,m.params);
  const pending=page.executionMetadataPending??=new Set();if(pending.has(id)||pending.size>=16)throw Object.assign(Error('执行读取已有请求'),{code:429});pending.add(id);
  log({component:'front',stage:'dispatch',...context});
  try{if(m.submissionContextProtocol!=null){if(m.submissionContextProtocol!==SUBMISSION_CONTEXT_PROTOCOL||m.method!=='thread/read')throw Object.assign(Error('发送信息协议不匹配'),{code:400});response.result=await boundary.readSubmissionContext(page.scope,m.params.threadId);}else response.result=await boundary.call(page.scope,{id,method:m.method,params:m.params},{clientId:page.stableId,pageId:page.diagnosticPageId,connectionId:page.connectionId});}
  finally{pending.delete(id);}
  if(!current())throw Object.assign(Error('执行读取连接已更换'),{code:409});
  if(Buffer.byteLength(JSON.stringify(response))>256*1024)throw Object.assign(Error('执行元数据超过控制通道大小'),{code:413});
  log({component:'front',stage:'received',...context,durationMs:Math.round(performance.now()-started)});
 }catch(error){delete response.result;response.error={code:Number(error.code)||503,message:error.message};log({component:'front',stage:'failed',...context,...errorDiagnosticFields(error),durationMs:Math.round(performance.now()-started)});}
 if(!page.expired&&page.wire===wire&&wire.readyState===1)pages.control(page,response);
}
