import {randomUUID} from 'node:crypto';
// Shared by feed and adapter. Appending and advancing the sender sequence is
// one FULL-synchronous SQLite transaction; only a committed cloud ACK retires it.
export class SyncOutbox {
 constructor(cache){this.cache=cache;this.db=cache.db;this.db.exec('CREATE TABLE IF NOT EXISTS sync_outbox(seq INTEGER PRIMARY KEY,raw TEXT NOT NULL,bytes INTEGER NOT NULL)');
  if(!cache.meta('outbox-epoch'))cache.setMeta('outbox-epoch',randomUUID());this.epoch=cache.meta('outbox-epoch');this.sequence=Number(cache.meta('outbox-sequence')||0);this.ack=Number(cache.meta('outbox-ack')||0);
 }
 append(value){return this.cache.transaction(()=>{const seq=this.sequence+1,frame={...value,type:'publish',epoch:this.epoch,seq},raw=JSON.stringify(frame);this.db.prepare('INSERT INTO sync_outbox VALUES(?,?,?)').run(seq,raw,Buffer.byteLength(raw));this.cache.setMeta('outbox-sequence',seq);this.sequence=seq;return frame;});}
 entries(){return this.db.prepare('SELECT seq,raw,bytes FROM sync_outbox ORDER BY seq').all();}
 acknowledge(seq){if(!Number.isSafeInteger(seq)||seq<this.ack||seq>this.sequence)throw Error('invalid durable ACK');this.cache.transaction(()=>{this.db.prepare('DELETE FROM sync_outbox WHERE seq<=?').run(seq);this.cache.setMeta('outbox-ack',seq);});this.ack=seq;}
}
