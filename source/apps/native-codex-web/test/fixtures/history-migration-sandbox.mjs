// Isolated Native capability experiment only. Production must never archive a
// live legacy thread as a way to release its writer for migration.
import {mkdir,readFile,writeFile,rename,copyFile,chmod,open,unlink,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const execute=promisify(execFile),ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(message,code=409)=>Object.assign(Error(message),{code});
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const settings=result=>Object.fromEntries(['model','modelProvider','reasoningEffort','cwd','approvalPolicy','approvalsReviewer','sandbox','activePermissionProfile','runtimeWorkspaceRoots','serviceTier'].map(key=>[key,result[key]??null]));
const metadata=thread=>Object.fromEntries(['id','sessionId','cwd','model','modelProvider','reasoningEffort','name','projectId','section','daybreakEnabled','threadSource'].map(key=>[key,thread[key]??null]));
async function fileDigest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}

// Use Native's migration implementation. This adapter never writes a Native
// database, changes historyMode by hand, or constructs a replacement thread.
export function nativeRolloutMigration({binary='/Applications/ChatGPT.app/Contents/Resources/codex',codexHome}){
 if(!path.isAbsolute(codexHome||''))throw Error('A verified Native home is required');
 return async threadId=>{
  if(!ID.test(threadId))throw fail('Invalid migration target',400);
  const {stdout}=await execute(binary,['migrate-rollouts','--thread',threadId,'--apply','--json'],{env:{...process.env,CODEX_HOME:codexHome},maxBuffer:1024*1024});
  const report=JSON.parse(stdout),outcomes=report.outcomes;
  if(!Array.isArray(outcomes)||outcomes.length!==1||outcomes[0].thread_id!==threadId)throw fail('原生历史升级返回了不匹配的目标');
  return {status:outcomes[0].status,bytesProcessed:outcomes[0].bytes_processed??0};
 };
}

export class HistoryMigration {
 constructor({native,stateDir,runMigration,isArchived,validate,withExclusiveAccess}){
  Object.assign(this,{native,stateDir,runMigration,isArchived,validate,withExclusiveAccess});this.pending=new Map();
  if(!native||!stateDir||!runMigration||!isArchived||!validate)throw Error('History migration requires Native, validation and durable state');
 }
 async head(threadId){return (await this.native.rpc('thread/read',{threadId,includeTurns:false})).thread;}
 async history(threadId){
  const hash=createHash('sha256'),seen=new Set();let cursor,count=0,items=0;
  for(let page=0;page<10000;page++){
   const reply=await this.native.rpc('thread/turns/list',{threadId,limit:2,itemsView:'full',sortDirection:'asc',...(cursor?{cursor}:{})});
   if(!Array.isArray(reply.data))throw fail('无法核对原生历史内容');
   for(const turn of reply.data){hash.update(canonical(turn)+'\n');count++;items+=(turn.items||[]).length;}
   cursor=reply.nextCursor;if(!cursor)return {sha256:hash.digest('hex'),turns:count,items};
   if(seen.has(cursor))throw fail('原生历史分页没有前进');seen.add(cursor);
  }
  throw fail('原生历史超过本次可核对范围');
 }
 async loaded(threadId){const seen=new Set();let cursor;for(let page=0;page<10000;page++){const reply=await this.native.rpc('thread/loaded/list',cursor?{cursor}:{});if(reply.data?.includes(threadId))return true;cursor=reply.nextCursor;if(!cursor)return false;if(seen.has(cursor))throw fail('无法核对会话持有状态');seen.add(cursor);}throw fail('无法核对会话持有状态');}
 async save(file,record){record.updatedAt=new Date().toISOString();const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(record,null,2)+'\n',{mode:0o600});const fd=await open(tmp,'r');try{await fd.sync();}finally{await fd.close();}await rename(tmp,file);const directory=await open(path.dirname(file),'r');try{await directory.sync();}finally{await directory.close();}}
 async restore(scope,threadId,record){
  if(await this.isArchived(scope,threadId))await this.native.rpc('thread/unarchive',{threadId});
  if(record.wasLoaded&&!await this.loaded(threadId))await this.native.rpc('thread/resume',{threadId,excludeTurns:true});
  const head=await this.head(threadId);if(head.id!==threadId||await this.isArchived(scope,threadId))throw fail('历史升级后的会话可见状态尚未恢复');return head;
 }
 async ensure(scope,threadId){
  if(!/^[a-z][a-z0-9_-]*$/.test(scope)||!ID.test(threadId))throw fail('Invalid migration target',400);
  const key=scope+':'+threadId;if(this.pending.has(key))return this.pending.get(key);
  const operation=this.run(scope,threadId);this.pending.set(key,operation);
  try{return await operation;}finally{if(this.pending.get(key)===operation)this.pending.delete(key);}
 }
 async run(scope,threadId){
  const directory=path.join(this.stateDir,'history-migrations');await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
  const stem=createHash('sha256').update(scope+':'+threadId).digest('hex'),file=path.join(directory,stem+'.json'),lock=file+'.lock';let fd;
  try{fd=await open(lock,'wx',0o600);await fd.writeFile(JSON.stringify({pid:process.pid,threadId,scope}));}catch(error){if(error.code==='EEXIST')throw fail('此会话的历史升级已在进行或等待恢复');throw error;}
  try{
   let record;try{record=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
   if(record?.threadId!==undefined&&(record.threadId!==threadId||record.scope!==scope))throw fail('历史升级事务归属不符');
   let head=await this.validate(scope,threadId);
   if(record&&record.state!=='complete'){
    try{head=await this.restore(scope,threadId,record);}catch(error){record.recoveryError={at:new Date().toISOString(),message:error.message};await this.save(file,record);throw error;}
    // A failed command is never replaced with a new transaction to erase its
    // first error. A crash after a successful migration can be observed safely.
    if(record.firstError)throw fail('此会话上次历史升级未通过，原会话已恢复；需要核对该事务后再编辑');
    const restored=await this.history(threadId),resumed=await this.native.rpc('thread/resume',{threadId,excludeTurns:true});
    if(head.historyMode==='paginated'&&digest(restored)===digest(record.before.history)&&digest(settings(resumed))===record.before.settingsSha256){record.state='complete';record.recoveredAfterInterruption=true;await this.save(file,record);return head;}
    record.firstError={at:new Date().toISOString(),message:'Interrupted migration did not reach verified completion'};record.state='failed';await this.save(file,record);throw fail('历史兼容升级被中断，已保留原会话和首错');
   }
   if(head.historyMode==='paginated')return head;
   if(head.historyMode!=='legacy')throw fail('当前原生历史格式不支持编辑');
   // Archive shuts down a loaded Native thread. An outer idle check is not an
   // atomic lock against a Desktop turn/start. The caller must fence every
   // writer during this one-time migration; ordinary page ownership is not it.
   if(typeof this.withExclusiveAccess!=='function')throw fail('旧会话需要受控历史升级；当前无法独占写入，原历史未改动');
   return await this.withExclusiveAccess(scope,threadId,async()=>{
    head=await this.validate(scope,threadId);if(head.historyMode==='paginated')return head;
    if(head.status?.type!=='idle'||await this.isArchived(scope,threadId))throw fail('只能升级当前工作区已停止且未归档的会话');
    if(record)throw fail('历史升级记录与当前格式不一致');
    const wasLoaded=await this.loaded(threadId),resumed=await this.native.rpc('thread/resume',{threadId,excludeTurns:true});
    if(resumed.thread?.id!==threadId||resumed.thread.status?.type!=='idle')throw fail('任务尚未停止完成，请稍后再编辑消息');
    record={schemaVersion:1,id:randomUUID(),scope,threadId,state:'prepared',createdAt:new Date().toISOString(),wasLoaded,before:{history:await this.history(threadId),settingsSha256:digest(settings(resumed)),metadataSha256:digest(metadata(resumed.thread))}};
    await this.save(file,record);
    try{
     await this.validate(scope,threadId);record.state='archiving';await this.save(file,record);await this.native.rpc('thread/archive',{threadId});
     if(!await this.isArchived(scope,threadId)||await this.loaded(threadId))throw fail('原生会话尚未释放，历史升级没有执行');
     const archived=await this.head(threadId);if(archived.id!==threadId||!archived.path)throw fail('无法备份目标会话原件');
     const source=await realpath(archived.path),backup=path.join(directory,stem+'.original.jsonl');await copyFile(source,backup);await chmod(backup,0o600);record.backup={file:path.basename(backup),sha256:await fileDigest(backup)};
     record.state='migrating';await this.save(file,record);const outcome=await this.runMigration(threadId);record.migration=outcome;
     if(!['migrated','already_paginated'].includes(outcome?.status))throw fail('原生历史升级未提交：'+String(outcome?.status||'unknown'));
     record.state='restoring';await this.save(file,record);await this.native.rpc('thread/unarchive',{threadId});
     const afterResume=await this.native.rpc('thread/resume',{threadId,excludeTurns:true}),after=afterResume.thread;
     if(after?.id!==threadId||after.historyMode!=='paginated')throw fail('原生历史格式没有完成升级');
     if(after.status?.type!=='idle')throw fail('历史升级期间会话收到新的写入');
     const history=await this.history(threadId);record.after={history,settingsSha256:digest(settings(afterResume)),metadataSha256:digest(metadata(after))};
     if(digest(record.before)!==digest(record.after))throw fail('历史升级前后的内容或会话设置不一致，未执行编辑');
     if(await this.isArchived(scope,threadId))throw fail('会话可见状态没有恢复');
     record.state='complete';await this.save(file,record);return after;
    }catch(error){
     record.firstError??={at:new Date().toISOString(),message:error.message};record.state='failed';
     try{await this.restore(scope,threadId,record);record.restored=true;}catch(restoreError){record.recoveryError={at:new Date().toISOString(),message:restoreError.message};record.restored=false;}
     await this.save(file,record);throw error;
    }
   });
  }finally{await fd.close();await unlink(lock).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 }
}
