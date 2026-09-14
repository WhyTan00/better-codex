import {fail} from './registry.mjs';

// Native queue consumers in different tabs must agree on who sends a message.
// Keep leases and sent tombstones beside the existing idempotency journal so
// replacing the browser/front cannot turn one queued prompt into two turns.
export class QueuedSendLocks {
 constructor(db,{now=Date.now,leaseMs=5*60*1000}={}){
  Object.assign(this,{db,now,leaseMs});
  db.exec('CREATE TABLE IF NOT EXISTS queued_send_locks (workspace TEXT, thread_id TEXT, message_id TEXT, lock_id TEXT, client_id TEXT, expires_at INTEGER, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace,thread_id,message_id))');
 }
 validate({conversationId,messageId,lockId},clientId){
  for(const value of [conversationId,messageId,lockId,clientId])if(typeof value!=='string'||!value||value.length>160)throw fail(400,'无效排队消息身份');
 }
 acquire(scope,p,clientId){
  this.validate(p,clientId);const at=this.now();
  const result=this.db.prepare(`INSERT INTO queued_send_locks VALUES(?,?,?,?,?,?,0)
   ON CONFLICT(workspace,thread_id,message_id) DO UPDATE SET lock_id=excluded.lock_id,client_id=excluded.client_id,expires_at=excluded.expires_at
   WHERE queued_send_locks.sent=0 AND (queued_send_locks.expires_at<=? OR (queued_send_locks.lock_id=excluded.lock_id AND queued_send_locks.client_id=excluded.client_id))`).run(scope,p.conversationId,p.messageId,p.lockId,clientId,at+this.leaseMs,at);
  return {acquired:result.changes===1};
 }
 release(scope,p,clientId){
  this.validate(p,clientId);if(typeof p.sent!=='boolean')throw fail(400,'缺少排队消息发送结果');
  const row=this.db.prepare('SELECT * FROM queued_send_locks WHERE workspace=? AND thread_id=? AND message_id=?').get(scope,p.conversationId,p.messageId);
  if(!row)return {released:false};
  if(row.lock_id!==p.lockId||row.client_id!==clientId)throw fail(409,'排队消息已由另一页面接管');
  if(p.sent)this.db.prepare('UPDATE queued_send_locks SET sent=1 WHERE workspace=? AND thread_id=? AND message_id=?').run(scope,p.conversationId,p.messageId);
  else if(!row.sent)this.db.prepare('DELETE FROM queued_send_locks WHERE workspace=? AND thread_id=? AND message_id=?').run(scope,p.conversationId,p.messageId);
  return {released:true};
 }
}
