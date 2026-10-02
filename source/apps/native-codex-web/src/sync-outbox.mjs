import {randomUUID} from 'node:crypto';
import {SCOPES} from './registry.mjs';
import {statfsSync} from 'node:fs';
export const OUTBOX_BUDGET={maxBytes:256*1024*1024,maxFrames:65536,maxAgeMs:3*86400000,minFreeBytes:256*1024*1024};
// Shared by feed and adapter. Appending and advancing the sender sequence is
// one FULL-synchronous SQLite transaction; only a committed cloud ACK retires it.
export class SyncOutbox {
 constructor(cache,options={}){this.cache=cache;this.db=cache.db;this.limits={...OUTBOX_BUDGET,...options};this.diskFree=options.diskFree||(()=>{const s=statfsSync(cache.dir);return Number(s.bavail)*Number(s.bsize);});this.db.exec('CREATE TABLE IF NOT EXISTS sync_outbox(seq INTEGER PRIMARY KEY,raw TEXT NOT NULL,bytes INTEGER NOT NULL)');
  if(!cache.meta('outbox-epoch'))cache.setMeta('outbox-epoch',randomUUID());this.epoch=cache.meta('outbox-epoch');this.sequence=Number(cache.meta('outbox-sequence')||0);this.ack=Number(cache.meta('outbox-ack')||0);
  cache.transaction(()=>{if(cache.meta('outbox-bytes')==null){const row=this.db.prepare('SELECT COALESCE(SUM(bytes),0) bytes,COUNT(*) frames FROM sync_outbox').get();cache.setMeta('outbox-bytes',row.bytes);cache.setMeta('outbox-frames',row.frames);cache.setMeta('outbox-oldest-at',row.frames?1:0);}
   this.db.exec(`CREATE TRIGGER IF NOT EXISTS outbox_insert AFTER INSERT ON sync_outbox BEGIN
    UPDATE cache_meta SET value=CAST(value AS INTEGER)+NEW.bytes WHERE key='outbox-bytes';
    UPDATE cache_meta SET value=CAST(value AS INTEGER)+1 WHERE key='outbox-frames';
    UPDATE cache_meta SET value=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE key='outbox-oldest-at' AND value='0'; END;
    CREATE TRIGGER IF NOT EXISTS outbox_delete AFTER DELETE ON sync_outbox BEGIN
    UPDATE cache_meta SET value=CAST(value AS INTEGER)-OLD.bytes WHERE key='outbox-bytes';
    UPDATE cache_meta SET value=CAST(value AS INTEGER)-1 WHERE key='outbox-frames';
    UPDATE cache_meta SET value='0' WHERE key='outbox-oldest-at' AND (SELECT value FROM cache_meta WHERE key='outbox-frames')='0'; END;`);
   // Additive metadata/triggers keep the old three-column table rollback-safe.
   if(cache.meta('outbox-clean')==='0')for(const scope of SCOPES)cache.setMeta('outbox-rebuild:'+scope,randomUUID());
   cache.setMeta('outbox-clean',0);
  });
 }
 stats(){const bytes=Number(this.cache.meta('outbox-bytes')),frames=Number(this.cache.meta('outbox-frames')),oldest=Number(this.cache.meta('outbox-oldest-at'));if(!this.spaceAt||Date.now()-this.spaceAt>1000){try{this.freeBytes=this.diskFree();}catch{this.freeBytes=0;}this.spaceAt=Date.now();}return {bytes,frames,oldestAgeMs:oldest>1?Date.now()-oldest:0,oldestAgeKnown:oldest!==1,freeBytes:this.freeBytes};}
 pressure(stats=this.stats()){return stats.bytes>=this.limits.maxBytes||stats.frames>=this.limits.maxFrames||stats.oldestAgeMs>=this.limits.maxAgeMs||stats.freeBytes<this.limits.minFreeBytes;}
 defer(scopes){this.deferred??=new Map();this.deferrals??=new Map();for(const scope of new Set(scopes)){if(!SCOPES.includes(scope))continue;this.deferrals.set(scope,(this.deferrals.get(scope)||0)+1);if(!this.deferred.has(scope))this.deferred.set(scope,this.cache.meta('outbox-rebuild:'+scope)||randomUUID());try{if(!this.cache.meta('outbox-rebuild:'+scope))this.cache.setMeta('outbox-rebuild:'+scope,this.deferred.get(scope));}catch{ /* Unclean startup also forces source reconciliation. */ }}}
 rebuildToken(scope){const marker=this.deferred?.get(scope)||this.cache.meta('outbox-rebuild:'+scope);return marker?marker+':'+(this.deferrals?.get(scope)||0):null;}
 finishRebuild(scope,token){if(this.rebuildToken(scope)!==token)return false;this.cache.setMeta('outbox-rebuild:'+scope,'');this.deferred?.delete(scope);return true;}
 close(){if(!this.deferred?.size)this.cache.setMeta('outbox-clean',1);}
 append(value){return this.appendBatch([value])[0];}
 appendBatch(values,persist){
  if(!values.length)return [];
  const frames=values.map((value,index)=>({...value,type:'publish',epoch:this.epoch,seq:this.sequence+index+1}));
  const rows=frames.map(frame=>{const raw=JSON.stringify(frame);return {seq:frame.seq,raw,bytes:Buffer.byteLength(raw)};}),stats=this.stats();
  if(rows.some(r=>r.bytes>64*1024*1024)||this.pressure(stats)||stats.bytes+rows.reduce((n,r)=>n+r.bytes,0)>this.limits.maxBytes||stats.frames+rows.length>this.limits.maxFrames)throw Object.assign(Error('projection outbox capacity reached'),{code:'OUTBOX_CAPACITY'});
  this.cache.transaction(()=>{const insert=this.db.prepare('INSERT INTO sync_outbox VALUES(?,?,?)');for(const row of rows)insert.run(row.seq,row.raw,row.bytes);this.cache.setMeta('outbox-sequence',frames.at(-1).seq);persist?.();});
  // Never advance memory or expose a frame until the entire durable batch exists.
  this.sequence=frames.at(-1).seq;return frames;
 }
 entries({after=this.ack,limit=128,maxBytes=8*1024*1024}={}){
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>128||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8*1024*1024)throw Error('invalid outbox window');
  // Inspect sizes before loading payloads. One existing large frame can make
  // progress, but never materialize the rest of the durable backlog with it.
  const heads=this.db.prepare('SELECT seq,bytes FROM sync_outbox WHERE seq>? ORDER BY seq LIMIT ?').all(after,limit);let bytes=0,last=after;
  for(const row of heads){if(last>after&&bytes+row.bytes>maxBytes)break;if(row.bytes>64*1024*1024)throw Error('outbox frame exceeds transport capacity');bytes+=row.bytes;last=row.seq;}
  return last===after?[]:this.db.prepare('SELECT seq,raw,bytes FROM sync_outbox WHERE seq>? AND seq<=? ORDER BY seq').all(after,last);
 }
 acknowledge(seq){if(!Number.isSafeInteger(seq)||seq<this.ack||seq>this.sequence)throw Error('invalid durable ACK');if(seq===this.ack)return;this.cache.transaction(()=>{this.db.prepare('DELETE FROM sync_outbox WHERE seq<=?').run(seq);this.cache.setMeta('outbox-ack',seq);});this.ack=seq;}
}
