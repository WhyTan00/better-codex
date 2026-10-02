import path from 'node:path';
import {readFile,realpath,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {freezeConfig} from './deployment-config.mjs';

const idPattern=/^[a-z][a-z0-9-]{0,63}$/;
const fail=(code,message)=>Object.assign(new Error(message),{code});
const inside=(target,root)=>target===root||target.startsWith(root+path.sep);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2'};
const JSON_LIMIT=1024*1024;
function boundedJSON(value){
 const text=JSON.stringify(value);
 if(typeof text!=='string'||Buffer.byteLength(text)>JSON_LIMIT)throw fail(413,'Plugin result exceeds its response limit');
 return JSON.parse(text);
}
async function ownedPath(value,base,label){
 if(typeof value!=='string'||!value||path.isAbsolute(value)||value.includes('\0'))throw Error('Invalid plugin '+label);
 const target=await realpath(path.resolve(base,value));
 if(!inside(target,base))throw Error('Plugin '+label+' escapes its package');
 return target;
}

// Installed modules are trusted local code, not a process sandbox. Their HTTP
// API is scoped; project storage, idempotency and revisions stay in the module.
export class PortablePlugins {
 constructor(config){this.config=config;this.definitions=new Map();this.modules=new Map();}
 async start(){
  for(const filename of this.config.plugins){
   const base=await realpath(path.dirname(filename)),raw=JSON.parse(await readFile(filename,'utf8'));
   if(!plain(raw)||raw.schema!=='workbench.plugin.v1'||Object.keys(raw).some(k=>!['schema','id','label','description','entry','ui','readOnly','actions','config'].includes(k))||!idPattern.test(raw.id)||this.definitions.has(raw.id))throw Error('Invalid or duplicate plugin manifest');
   if(typeof raw.label!=='string'||!raw.label.trim()||raw.label.length>120||raw.description!=null&&(typeof raw.description!=='string'||raw.description.length>500)||raw.readOnly!=null&&typeof raw.readOnly!=='boolean')throw Error('Invalid plugin presentation or write policy');
   const readOnly=raw.readOnly!==false,actions=raw.actions??[];
   if(!Array.isArray(actions)||actions.length>32||actions.some(action=>!idPattern.test(action))||new Set(actions).size!==actions.length||readOnly&&actions.length)throw Error('Invalid plugin actions');
   if(raw.config!=null&&!plain(raw.config))throw Error('Invalid plugin configuration');
   let ui=null;
   if(raw.ui){
    if(!plain(raw.ui)||Object.keys(raw.ui).some(k=>!['directory','entry'].includes(k)))throw Error('Invalid plugin UI');
    const directory=await ownedPath(raw.ui.directory,base,'UI directory'),entry=raw.ui.entry??'index.html';
    if(!(await stat(directory)).isDirectory()||typeof entry!=='string'||entry.startsWith('.')||entry.includes('/')||path.extname(entry)!=='.html')throw Error('Invalid plugin UI entry');
    await ownedPath(entry,directory,'UI entry');ui={directory,entry};
   }
   if(!raw.entry&&!ui)throw Error('Plugin needs a read adapter or local UI');
   const entry=raw.entry?await ownedPath(raw.entry,base,'entry'):null;
   if(entry&&!['.mjs','.js'].includes(path.extname(entry)))throw Error('Plugin entry must be a JavaScript module');
   if(actions.length&&!entry)throw Error('Writable plugin needs an adapter');
   this.definitions.set(raw.id,freezeConfig({id:raw.id,label:raw.label,description:raw.description??'',readOnly,actions,entry,ui,config:raw.config??{}}));
  }
  for(const ws of Object.values(this.config.workspaces))for(const id of ws.plugins)if(!this.definitions.has(id))throw Error('Enabled plugin has no manifest: '+id);
  return this;
 }
 workspace(scope){const ws=this.config.workspaces[scope];if(!ws)throw fail(403,'Workspace is not available');return ws;}
 definition(scope,id){const ws=this.workspace(scope),definition=this.definitions.get(id);if(!ws.plugins.includes(id)||!definition)throw fail(404,'Plugin is not enabled in this workspace');return definition;}
 list(scope){const ws=this.workspace(scope);return ws.plugins.map(id=>{const p=this.definition(scope,id);return {id:p.id,workspace:scope,label:p.label,description:p.description,readOnly:ws.readOnly||p.readOnly,actions:ws.readOnly?[]:p.actions,portable:true};});}
 async module(definition){
  if(!definition.entry)return null;
  if(!this.modules.has(definition.id))this.modules.set(definition.id,import(pathToFileURL(definition.entry).href));
  return this.modules.get(definition.id);
 }
 context(scope,definition){const ws=this.workspace(scope);return freezeConfig({workspace:{id:ws.id,label:ws.label,root:ws.root,readOnly:ws.readOnly},config:definition.config});}
 async load(scope,id){
  const definition=this.definition(scope,id),module=await this.module(definition);
  const snapshot=typeof module?.read==='function'?boundedJSON(await module.read(this.context(scope,definition))):{};
  if(!plain(snapshot))throw fail(502,'Plugin read adapter must return an object');
  return {kind:definition.ui?'frame':'document',label:definition.label,...(definition.ui?{url:'/plugins/'+scope+'/'+id+'/'+definition.ui.entry}:{}),snapshot};
 }
 async invoke(scope,id,request){
  const definition=this.definition(scope,id),ws=this.workspace(scope);
  if(ws.readOnly||definition.readOnly)throw fail(403,'Plugin is read-only');
  if(!plain(request)||Object.keys(request).some(key=>!['operation','requestId','expectedRevision','data'].includes(key))||!definition.actions.includes(request.operation)||typeof request.requestId!=='string'||!/^[0-9a-f-]{36}$/i.test(request.requestId)||typeof request.expectedRevision!=='string'||!request.expectedRevision||request.expectedRevision.length>256)throw fail(400,'An allowed action, stable request ID and source revision are required');
  const module=await this.module(definition);
  if(typeof module?.invoke!=='function')throw fail(503,'Plugin action adapter is unavailable');
  // Never retry a plugin mutation; the owning adapter checks the source
  // revision and retains the stable request result in its own transaction.
  return boundedJSON(await module.invoke(this.context(scope,definition),boundedJSON(request)));
 }
 async asset(scope,id,relative){
  const definition=this.definition(scope,id);
  if(!definition.ui)throw fail(404,'Plugin has no UI');
  let decoded;try{decoded=decodeURIComponent(relative);}catch{throw fail(400,'Invalid plugin asset path');}
  if(!decoded||decoded.includes('\\')||decoded.split('/').some(part=>!part||part.startsWith('.')))throw fail(404,'Plugin asset is not available');
  const type=MIME[path.extname(decoded).toLowerCase()];if(!type)throw fail(404,'Plugin asset type is not available');
  let file;try{file=await ownedPath(decoded,definition.ui.directory,'asset');}catch{throw fail(404,'Plugin asset is not available');}
  const info=await stat(file);if(!info.isFile()||info.size>8*1024*1024)throw fail(413,'Plugin asset exceeds its limit');
  return {bytes:await readFile(file),type};
 }
 async close(){await Promise.allSettled([...this.modules.values()].map(async promise=>{const module=await promise;await module.close?.();}));}
}
