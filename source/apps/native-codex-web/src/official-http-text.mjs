import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const zip=promisify(gzip);
export function acceptsGzip(value=''){
 const choices=String(value).split(',').map(s=>s.trim().split(';').map(v=>v.trim()));
 const entry=choices.find(([name])=>name.toLowerCase()==='gzip')||choices.find(([name])=>name==='*');
 return !!entry&&!entry.slice(1).some(p=>/^q=0(?:\.0*)?$/i.test(p));
}
// Only the public browser adapter is memoized. Per-page config/HTML includes
// credentials and is compressed transiently with no-store, never cached here.
export class TextResponses {
 constructor(){this.adapter=null;}
 async send(req,res,text,headers,{adapter=false}={}){
  let data;
  if(adapter&&this.adapter?.text===text)data=this.adapter;
  else {const bytes=Buffer.from(text);data={text,bytes};if(adapter){data.etag='"'+createHash('sha256').update(bytes).digest('hex')+'"';this.adapter=data;}}
  const h={...headers,vary:'Accept-Encoding'};
  if(adapter){h.etag=data.etag;if(String(req.headers['if-none-match']||'').split(',').map(s=>s.trim()).includes(data.etag)){res.writeHead(304,h);return res.end();}}
  let bytes=data.bytes;
  if(bytes.length>=1024&&acceptsGzip(req.headers['accept-encoding'])){if(adapter)data.zipped??=zip(bytes);bytes=await (data.zipped||zip(bytes));h['content-encoding']='gzip';}
  h['content-length']=bytes.length;res.writeHead(200,h);res.end(req.method==='HEAD'?undefined:bytes);
 }
}
