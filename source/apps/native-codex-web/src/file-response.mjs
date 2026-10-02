import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createGzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {fileEtag,fileMime} from './official-files.mjs';
import {acceptsGzip} from './official-http-text.mjs';
import {fail} from './registry.mjs';
export function byteRange(value,size){if(!value)return null;const m=/^bytes=(\d*)-(\d*)$/.exec(value);if(!m||!m[1]&&!m[2])return false;let start,end;if(!m[1]){const length=Number(m[2]);if(!Number.isSafeInteger(length)||length<=0)return false;start=Math.max(0,size-length);end=size-1;}else{start=Number(m[1]);end=m[2]?Number(m[2]):size-1;}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return false;return {start,end:Math.min(end,size-1)};}
export async function serveFileResponse({files,scope,entry,req,res}){
 const target=await files.resolve(scope,entry.target),handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW),started=performance.now();
 try{const s=await handle.stat();if(!s.isFile())throw fail(400,'请选择文件');if(s.size>256*1024*1024)throw fail(413,'文件超过256 MB下载上限');const version=entry.immutableVersion||fileEtag(s);if(entry.version&&entry.version!==version)throw fail(409,'文件已更新，请重新点击文件');
  const etag='"'+version+'"',ttl=Math.max(0,Math.min(300,Math.floor((entry.expiresAt-Date.now())/1000))),mime=entry.mime||fileMime(target),headers={'content-type':mime,'cache-control':'private, max-age='+ttl+', immutable',etag,'accept-ranges':'bytes','last-modified':s.mtime.toUTCString(),'x-dsh-edge-cache':'file','x-dsh-cache-expires':String(Math.min(entry.expiresAt,Date.now()+ttl*1000)),'content-security-policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:",...(entry.download?{'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(entry.name||path.basename(target))}:{})};
  if(req.headers['if-none-match']===etag){res.writeHead(304,headers);return res.end();}
  const range=req.headers['if-range']&&req.headers['if-range']!==etag?null:byteRange(req.headers.range,s.size);if(range===false){res.writeHead(416,{'content-range':'bytes */'+s.size,'cache-control':'no-store'});return res.end();}
  let status=200;if(range){status=206;headers['content-range']=`bytes ${range.start}-${range.end}/${s.size}`;headers['content-length']=range.end-range.start+1;}
  const compress=!range&&s.size>1024&&/^(?:text\/|application\/json)/.test(mime)&&acceptsGzip(req.headers['accept-encoding']);headers.vary='Accept-Encoding';if(compress)headers['content-encoding']='gzip';else headers['content-length']=range?range.end-range.start+1:s.size;
  res.writeHead(status,headers);if(req.method==='HEAD')return res.end();const stream=handle.createReadStream({...range||{},autoClose:false});if(compress)await pipeline(stream,createGzip({level:3}),res);else await pipeline(stream,res);
  console.log(JSON.stringify({event:'file-transfer',scope,status,bytes:range?range.end-range.start+1:s.size,compressed:compress,durationMs:Math.round((performance.now()-started)*10)/10}));
 }finally{await handle.close();}
}
