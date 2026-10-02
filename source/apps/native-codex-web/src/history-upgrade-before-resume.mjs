import {mkdir,readFile,writeFile,rename,copyFile,chmod,open,unlink,realpath,access} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {CODEX} from './native.mjs';

const execute=promisify(execFile),idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const metadata=thread=>Object.fromEntries(['id','sessionId','cwd','model','modelProvider','reasoningEffort','name','projectId','section','daybreakEnabled','threadSource','environments','extra'].map(key=>[key,thread[key]??null]));

async function writeReceipt(file,record){
 record.updatedAt=new Date().toISOString();const temporary=file+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,JSON.stringify(record,null,2)+'\n',{mode:0o600});
 const fd=await open(temporary,'r');try{await fd.sync();}finally{await fd.close();}
 await rename(temporary,file);
 const directory=await open(path.dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
}
async function rolloutSettings(file){
 const hash=createHash('sha256');
 for await(const line of createInterface({input:createReadStream(file),crlfDelay:Infinity})){
  if(!line.trim())continue;const record=JSON.parse(line);
  if(record.type==='turn_context')hash.update(canonical(record.payload)+'\n');
  if(record.type==='session_meta'){
   const {history_mode,...original}=record.payload;hash.update(canonical(original)+'\n');
  }
 }
 return hash.digest('hex');
}
async function fileHash(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function exists(file){try{await access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}

// Call after workspace ownership validation and before the first thread/resume.
// This helper never resumes, starts, stops, archives, or unlocks a Native thread.
// Native's official CLI is the sole writer and arbitrates its own writer lock.
export class HistoryUpgradeBeforeResume {
 constructor({native,stateDir,nativeHome,binary=CODEX,runMigration}){
  if(!native||!path.isAbsolute(stateDir||'')||!path.isAbsolute(nativeHome||''))throw Error('Verified Native client, home and private state directory are required');
  Object.assign(this,{native,stateDir,nativeHome,binary});this.pending=new Map();
  this.runMigration=runMigration??(async threadId=>{
   let stdout;try{({stdout}=await execute(binary,['migrate-rollouts','--thread',threadId,'--apply','--json'],{env:{...process.env,CODEX_HOME:nativeHome},timeout:60000,maxBuffer:1024*1024}));}
   catch(error){throw Object.assign(Error('Native migration command did not complete'),{code:typeof error.code==='number'?error.code:null});}
   const report=JSON.parse(stdout);if(!Array.isArray(report.outcomes)||report.outcomes.length!==1||report.outcomes[0].thread_id!==threadId)throw Error('Native migration returned a different target');
   return {status:report.outcomes[0].status,bytesProcessed:report.outcomes[0].bytes_processed??0};
  });
 }
 async history(threadId){
  const hash=createHash('sha256'),seen=new Set();let cursor,turns=0,items=0;
  for(let page=0;page<10000;page++){
   const result=await this.native.rpc('thread/turns/list',{threadId,itemsView:'full',sortDirection:'asc',limit:100,...(cursor?{cursor}:{})});
   if(!Array.isArray(result.data))throw Error('Native history readback is missing');
   for(const turn of result.data){hash.update(canonical(turn)+'\n');turns++;items+=(turn.items||[]).length;}
   cursor=result.nextCursor;if(!cursor)return {sha256:hash.digest('hex'),turns,items};
   if(seen.has(cursor))throw Error('Native history pagination did not advance');seen.add(cursor);
  }
  throw Error('Native history pagination did not finish');
 }
 async snapshot(threadId){
  const head=(await this.native.rpc('thread/read',{threadId,includeTurns:false})).thread;
  if(head?.id!==threadId)throw Error('Native migration target changed');
  const home=await realpath(this.nativeHome),source=await realpath(head.path),relative=path.relative(path.join(home,'sessions'),source);
  if(relative==='..'||relative.startsWith('../')||path.isAbsolute(relative))throw Error('Migration target is outside active Native sessions');
  return {threadId,head,source,identitySha256:digest(metadata(head)),settingsSha256:await rolloutSettings(source),history:await this.history(threadId)};
 }
 async beforeResume({scope,threadId}){
  if(!/^[a-z][a-z0-9_-]*$/.test(scope||'')||!idPattern.test(threadId||''))throw Error('Invalid scoped migration target');
  const key=scope+':'+threadId;if(this.pending.has(key))return this.pending.get(key);
  const running=this.run(scope,threadId);this.pending.set(key,running);
  try{return await running;}finally{if(this.pending.get(key)===running)this.pending.delete(key);}
 }
 async acquireThreadLock(file){return open(file,'wx',0o600);}
 async run(scope,threadId){
  const head=(await this.native.rpc('thread/read',{threadId,includeTurns:false})).thread;
  if(head?.id!==threadId)throw Error('Native migration target changed');
  const directory=path.join(this.stateDir,'history-upgrades'),stem=createHash('sha256').update(scope+':'+threadId).digest('hex'),file=path.join(directory,stem+'.json'),lock=file+'.lock';
  let previous;try{previous=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous?.firstError)return {status:'needs_review',threadId,transactionId:previous.id};
  if(previous&&!['busy','verified'].includes(previous.state)){
   if(previous.state==='migrating'){try{await access(lock);return {status:'in_progress',threadId,transactionId:previous.id};}catch(error){if(error.code!=='ENOENT')throw error;}}
   return {status:'needs_review',threadId,transactionId:previous.id};
  }
  if(head.historyMode==='paginated')return {status:'already_paginated',threadId};
  if(head.historyMode!=='legacy')return {status:'unsupported',threadId};
  if(head.status?.type!=='notLoaded')return {status:'loaded',threadId};
  const cutover=path.join(this.stateDir,'history-upgrade-cutover.lock');
  if(await exists(cutover))return {status:'in_progress',threadId};
  await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);let fd;
  try{fd=await this.acquireThreadLock(lock);}catch(error){if(error.code==='EEXIST')return {status:'in_progress',threadId};throw error;}
  let record;
  try{
   // The publisher first creates its fence, then checks all thread locks. A
   // preparation that raced its scan must observe the fence after taking its
   // own lock and leave before running the official migration CLI.
   if(await exists(cutover))return {status:'in_progress',threadId};
   try{record=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
   if(record&&(record.threadId!==threadId||record.scope!==scope))throw Error('History migration transaction identity changed');
   if(record?.firstError)return {status:'needs_review',threadId,transactionId:record.id};
   if(record&&!['busy','verified'].includes(record.state))return {status:'needs_review',threadId,transactionId:record.id};
   record??={schemaVersion:1,id:randomUUID(),scope,threadId,createdAt:new Date().toISOString(),attempts:[]};
   const before=await this.snapshot(threadId);
   if(before.head.historyMode==='paginated')return {status:'already_paginated',threadId};
   if(before.head.status.type!=='notLoaded')return {status:'loaded',threadId};
   const backup=path.join(directory,stem+'.'+record.attempts.length+'.original.jsonl');await copyFile(before.source,backup);await chmod(backup,0o600);
   const summary=value=>({identitySha256:value.identitySha256,settingsSha256:value.settingsSha256,history:value.history});
   record.before=summary(before);record.backup={file:path.basename(backup),sha256:await fileHash(backup)};record.state='migrating';await writeReceipt(file,record);
   const outcome=await this.runMigration(threadId);record.attempts.push({at:new Date().toISOString(),...outcome});
   if(outcome.status==='skipped_busy'){record.state='busy';await writeReceipt(file,record);return {status:'busy',threadId,transactionId:record.id};}
   if(!['migrated','already_paginated'].includes(outcome.status))throw Error('Native migration did not commit: '+String(outcome.status||'unknown'));
   const after=await this.snapshot(threadId);record.after=summary(after);
   if(after.head.historyMode!=='paginated'||digest(record.before)!==digest(record.after))throw Error('Native migration history or settings readback did not match');
   record.state='verified';await writeReceipt(file,record);return {status:'verified',threadId,transactionId:record.id};
  }catch(error){
   if(record){record.firstError??={at:new Date().toISOString(),message:/^(Native|Migration|History) /.test(error.message)?error.message:'Native history readback failed',code:typeof error.code==='number'?error.code:null};record.state='pending';await writeReceipt(file,record);}
   return {status:'needs_review',threadId,transactionId:record?.id};
  }finally{await fd.close();await unlink(lock).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 }
}
