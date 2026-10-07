import path from 'node:path';
import {readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const modules=new Set(['agenda','portfolio','quant']);
export function pluginUiRoute(route){const m=route.match(/^\/dsh-plugin-ui\/ai\/(agenda|portfolio|quant)\/(manifest\.json|[a-f0-9]{64}\.js)$/);return m?{id:m[1],file:m[2]}:null;}
export function validPluginUiManifest(value,id){return modules.has(id)&&value?.schemaVersion===1&&value.workspace==='ai'&&value.id===id&&value.hostApiVersion===1&&/^[a-f0-9]{64}$/.test(value.sha256||'')&&value.url==='/dsh-plugin-ui/ai/'+id+'/'+value.sha256+'.js'&&Number.isSafeInteger(value.bytes)&&value.bytes>0&&value.bytes<=2*1024*1024;}
export async function readPluginUi(root,{id,file}){
 if(!modules.has(id)||!/^manifest\.json$|^[a-f0-9]{64}\.js$/.test(file))throw Error('Invalid plugin artifact');
 const dir=path.join(root,'ai',id),target=path.join(dir,file);
 for(const p of [root,path.join(root,'ai'),dir,target])if((await lstat(p)).isSymbolicLink())throw Error('Plugin artifact cannot be a link');
 const info=await lstat(target),limit=file==='manifest.json'?4096:2*1024*1024;if(!info.isFile()||info.size>limit)throw Error('Invalid plugin artifact size');
 const body=await readFile(target);
 if(file==='manifest.json'){if(!validPluginUiManifest(JSON.parse(body),id))throw Error('Invalid plugin manifest');}
 else if(createHash('sha256').update(body).digest('hex')!==file.slice(0,-3))throw Error('Plugin artifact changed');
 return {body,type:file==='manifest.json'?'application/json; charset=utf-8':'text/javascript; charset=utf-8',cache:file==='manifest.json'?'private, no-cache':'private, max-age=31536000, immutable'};
}
