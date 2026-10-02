import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {acceptsGzip} from './official-http-text.mjs';
const names=['home.html','home.mjs','home.css','read-cache.mjs','conversation-shell.mjs'];
export async function loadShellAssets(){
 const entries=await Promise.all(names.map(async name=>[name,await readFile(new URL('../public/shell/'+name,import.meta.url))]));
 const version=createHash('sha256').update(Buffer.concat(entries.map(([,b])=>b))).digest('hex').slice(0,16),base='/dsh-shell/'+version,files=new Map(entries.map(([name,bytes])=>[name,{bytes,zipped:gzipSync(bytes),etag:'"'+createHash('sha256').update(bytes).digest('hex')+'"'}]));
 return {version,base,home(scope){return files.get('home.html').bytes.toString().replaceAll('__SCOPE__',scope).replaceAll('__SHELL_BASE__',base);},serve(req,res,pathname){
  if(!pathname.startsWith(base+'/'))return false;const name=pathname.slice(base.length+1),file=files.get(name);if(!file||name==='home.html')return false;
  const headers={'content-type':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable',etag:file.etag,vary:'Accept-Encoding','x-dsh-edge-cache':'static'};
  if(req.headers['if-none-match']===file.etag){res.writeHead(304,headers);res.end();return true;}
  const zipped=acceptsGzip(req.headers['accept-encoding']),body=zipped?file.zipped:file.bytes;if(zipped)headers['content-encoding']='gzip';headers['content-length']=body.length;res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:body);return true;
 }};
}
