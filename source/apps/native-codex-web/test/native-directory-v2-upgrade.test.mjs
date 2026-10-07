import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {mkdtempSync,rmSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {NativeReadCache,catalogEntry,nativeReadKey} from '../src/native-read-cache.mjs';import {Journal} from '../src/journal.mjs';import {workspace} from '../src/registry.mjs';
const parent='11111111-1111-4111-a111-111111111111',request='55555555-5555-4555-a555-555555555555';
// Real legacy SQLite state, not a new constructor with its migration marker removed.
// In particular v1 is already committed and remains present for the entire upgrade.
function legacyDatabase(dir){
 const db=new DatabaseSync(path.join(dir,'native-read.sqlite'));db.exec(`
 CREATE TABLE cache_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE cache_changes(revision INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,key TEXT NOT NULL);
 CREATE TABLE cache_records(scope TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,thread_id TEXT,generation TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT,hash TEXT NOT NULL,confirmed_at TEXT NOT NULL,bytes INTEGER NOT NULL,accessed_at INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,key));
 CREATE TABLE cache_thread_versions(scope TEXT,thread_id TEXT,generation TEXT NOT NULL,PRIMARY KEY(scope,thread_id));
 INSERT INTO cache_meta VALUES('generation','legacy-source-v1'),('read-key-v2','1'),('user-directory-source-v1','1');`);
 const rows=[];function put(scope,key,kind,id,payload,generation='original-'+id){const raw=JSON.stringify(payload),revision=Number(db.prepare('INSERT INTO cache_changes(scope,key) VALUES(?,?)').run(scope,key).lastInsertRowid),hash=createHash('sha256').update('['+raw+',false,'+JSON.stringify(generation)+']').digest('hex');db.prepare('INSERT OR REPLACE INTO cache_thread_versions VALUES(?,?,?)').run(scope,id,generation);db.prepare('INSERT INTO cache_records VALUES(?,?,?,?,?,?,?,?,?,?,?,0)').run(scope,key,kind,id,generation,revision,raw,hash,'2026-01-01T00:00:00Z',Buffer.byteLength(raw),1);rows.push({scope,key,kind,id,payload,generation,revision});}
 const main={id:parent,cwd:workspace('ai').root,source:'exec',name:'synthetic user',status:{type:'idle'}};put('ai','thread:'+parent,'catalog',parent,catalogEntry(main));
 const shapes=[{source:{subagent:{thread_spawn:{parent_thread_id:parent}}}},{source:JSON.stringify({subagent:{thread_spawn:{parent_thread_id:parent}}})},{parentThreadId:parent,canAcceptDirectInput:false}];
 const children=shapes.map((shape,i)=>({...main,id:`22222222-2222-4222-a222-${String(i+1).padStart(12,'0')}`,...shape,name:'synthetic child'}));
 for(const child of children){put('ai','thread:'+child.id,'catalog',child.id,catalogEntry(child));put('ai',nativeReadKey('thread/read',{threadId:child.id,includeTurns:true}),'history',child.id,{method:'thread/read',params:{threadId:child.id,includeTurns:true},result:{thread:{...child,turns:[{id:child.id,items:[{id:'kept',type:'agentMessage',text:'retained original'}]}]}}});}
 put('ai','catalog-status','catalog-status','',{state:'ready',count:4});const before=db.prepare('SELECT * FROM cache_records ORDER BY scope,key').all();db.close();return{before,children};
}
test('v1-marked upgrade retires only new-shape child projections and preserves bodies, generation, parent and command ledger',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'better-codex-directory-upgrade-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const fixture=legacyDatabase(root),ledger=new Journal(path.join(root,'ledger'));t.after(()=>ledger.close());ledger.manageThread('ai',parent);ledger.manageThread('ai',fixture.children[0].id);
 await ledger.run('ai',request,{method:'turn/start',params:{threadId:fixture.children[0].id,clientUserMessageId:request}},async()=>({turn:{id:request,status:'inProgress'}}));const beforeLedger={receipt:ledger.get('ai',request),binding:ledger.binding('ai',request),owners:ledger.db.prepare('SELECT * FROM request_owners').all()};
 const cache=new NativeReadCache(root,{boundary:{}});t.after(()=>{if(!cache.closedForTest)cache.close();});assert.equal(cache.meta('user-directory-source-v1'),'1');assert.equal(cache.generation,'legacy-source-v1');
 for(const child of fixture.children)assert.equal(cache.get('ai','thread:'+child.id).deleted,true,'v1 must not suppress the v2 retirement');
 assert.equal(cache.meta('user-directory-source-v2'),'1');const after=cache.db.prepare('SELECT * FROM cache_records ORDER BY scope,key').all();for(const row of fixture.before.filter(x=>x.kind==='history'||x.thread_id===parent))assert.deepEqual(after.find(x=>x.scope===row.scope&&x.key===row.key),row,'original body/parent bytes and identities must be untouched');
 assert.equal(cache.get('ai','catalog-status').payload.count,1);assert(ledger.ownsThread('ai',parent));assert(ledger.ownsThread('ai',fixture.children[0].id));assert.deepEqual({receipt:ledger.get('ai',request),binding:ledger.binding('ai',request),owners:ledger.db.prepare('SELECT * FROM request_owners').all()},beforeLedger);
 const versions=cache.db.prepare('SELECT * FROM cache_thread_versions ORDER BY thread_id').all(),revision=cache.db.prepare('SELECT MAX(revision) value FROM cache_changes').get().value;cache.close();cache.closedForTest=true;
 const reopened=new NativeReadCache(root,{boundary:{}});t.after(()=>reopened.close());assert.equal(reopened.meta('user-directory-source-v2'),'1');assert.equal(reopened.generation,'legacy-source-v1');assert.equal(reopened.db.prepare('SELECT MAX(revision) value FROM cache_changes').get().value,revision,'repeat cold start must not retombstone/republish');assert.deepEqual(reopened.db.prepare('SELECT * FROM cache_thread_versions ORDER BY thread_id').all(),versions);
});
