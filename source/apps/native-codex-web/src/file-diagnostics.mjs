import {createHmac,randomBytes} from 'node:crypto';

// Bounded operational evidence: never retain file names, paths or contents.
export class FileDiagnostics {
 constructor({limit=100,emit=()=>{}}={}){this.limit=limit;this.emit=emit;this.entries=[];this.key=randomBytes(32);this.sequence=0;}
 observe(files){for(const operation of ['bytes','read','metadata','entries','nativeAttachmentRequest']){
  const original=files[operation].bind(files);
  files[operation]=async(scope,input,...rest)=>{
   const value=typeof input==='string'?input:input?.path||input?.directoryPath||'',entry={sequence:++this.sequence,at:new Date().toISOString(),scope,operation,fileRef:createHmac('sha256',this.key).update(scope+':'+value).digest('hex').slice(0,16),state:'pending'},start=performance.now();
   if(operation==='nativeAttachmentRequest'&&['fs/createDirectory','fs/writeFile','fs/remove'].includes(input))entry.method=input;
   this.entries.push(entry);if(this.entries.length>this.limit)this.entries.shift();
   try{const result=await original(scope,input,...rest);Object.assign(entry,{state:'completed',...(result?.contentKind?{contentKind:result.contentKind}:{}),...(Buffer.isBuffer(result?.bytes)?{bytes:result.bytes.length}:{})});return result;}
   catch(e){Object.assign(entry,{state:'failed',code:typeof e.code==='number'?e.code:['ENOENT','EACCES','EPERM','ELOOP','EISDIR','ENOTDIR'].includes(e.code)?e.code:'unknown'});throw e;}
   finally{entry.durationMs=Math.round((performance.now()-start)*10)/10;this.emit({...entry});}
  };
 }return files;}
 snapshot(scope){return this.entries.filter(e=>e.scope===scope).map(e=>({...e}));}
}
