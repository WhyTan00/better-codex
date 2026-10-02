import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fail} from './registry.mjs';
export class Journal {
 constructor(dir){mkdirSync(dir,{recursive:true,mode:0o700});this.db=new DatabaseSync(path.join(dir,'requests.sqlite'));chmodSync(path.join(dir,'requests.sqlite'),0o600);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS requests (workspace TEXT, id TEXT, hash TEXT, state TEXT, result TEXT, PRIMARY KEY(workspace,id))');this.db.exec('CREATE TABLE IF NOT EXISTS managed_threads (id TEXT PRIMARY KEY, workspace TEXT, created_at TEXT)');this.db.exec('CREATE TABLE IF NOT EXISTS request_owners(workspace TEXT,id TEXT,pid INTEGER,started TEXT,owner TEXT,PRIMARY KEY(workspace,id))');this.owner=randomUUID();this.started=this.processStart(process.pid);
  this.db.exec('CREATE TABLE IF NOT EXISTS request_bindings(workspace TEXT,id TEXT,method TEXT,thread_id TEXT,client_message_id TEXT,PRIMARY KEY(workspace,id))');
  // Opening the same ledger from another live adapter must not invalidate its
  // in-flight operation. Only a missing/dead writer makes acceptance unknown.
  for(const row of this.db.prepare("SELECT r.workspace,r.id,o.pid,o.started FROM requests r LEFT JOIN request_owners o ON r.workspace=o.workspace AND r.id=o.id WHERE r.state='pending'").all())if(!row.pid||this.processStart(row.pid)!==row.started)this.db.prepare("UPDATE requests SET state='unknown' WHERE workspace=? AND id=? AND state='pending'").run(row.workspace,row.id);
 }
 processStart(pid){try{return execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim()||null;}catch{return null;}}
 ownsThread(ws,id){return !!this.db.prepare('SELECT id FROM managed_threads WHERE id=? AND workspace=?').get(id,ws);}
 manageThread(ws,id){this.db.prepare('INSERT OR IGNORE INTO managed_threads VALUES(?,?,?)').run(id,ws,new Date().toISOString());if(!this.ownsThread(ws,id))throw fail(403,'会话归属与当前工作区不一致');}
 get(ws,id){const row=this.db.prepare('SELECT * FROM requests WHERE workspace=? AND id=?').get(ws,id);return row?{...row,result:row.result?JSON.parse(row.result):null}:null;}
 binding(ws,id){return this.db.prepare('SELECT method,thread_id AS threadId,client_message_id AS clientUserMessageId FROM request_bindings WHERE workspace=? AND id=?').get(ws,id)||null;}
 async run(ws,id,payload,fn){if(typeof id!=='string'|| !/^[0-9a-f-]{36}$/i.test(id))throw fail(400,'请求需要唯一 UUID');const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  this.db.exec('BEGIN IMMEDIATE');let prev;try{prev=this.get(ws,id);if(!prev){this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(ws,id,hash,'pending',null);this.db.prepare('INSERT OR REPLACE INTO request_owners VALUES(?,?,?,?,?)').run(ws,id,process.pid,this.started,this.owner);const p=payload?.params;if(['turn/start','turn/steer'].includes(payload?.method)&&typeof p?.threadId==='string'&&typeof p?.clientUserMessageId==='string')this.db.prepare('INSERT INTO request_bindings VALUES(?,?,?,?,?)').run(ws,id,payload.method,p.threadId,p.clientUserMessageId);}this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  if(prev){if(prev.hash!==hash)throw fail(409,'同一请求标识不能用于不同操作');return {requestId:id,state:prev.state,result:prev.result};}
  try{const result=await fn();this.db.prepare('UPDATE requests SET state=?,result=? WHERE workspace=? AND id=?').run('accepted',JSON.stringify(result),ws,id);return{requestId:id,state:'accepted',result};}
  catch(e){const state=[503,504].includes(e.code)?'unknown':'rejected';const result={error:e.message,code:e.code||500,...(Number.isInteger(e.rpcCode)?{rpcCode:e.rpcCode}:{})};this.db.prepare('UPDATE requests SET state=?,result=? WHERE workspace=? AND id=?').run(state,JSON.stringify(result),ws,id);return{requestId:id,state,result};}
 }
 close(){this.db.prepare("UPDATE requests SET state='unknown' WHERE state='pending' AND EXISTS(SELECT 1 FROM request_owners o WHERE o.workspace=requests.workspace AND o.id=requests.id AND o.owner=?)").run(this.owner);this.db.close();}
}
