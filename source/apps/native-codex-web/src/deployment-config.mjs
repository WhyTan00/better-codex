import path from 'node:path';
import os from 'node:os';
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.hasOwn(value,key);
const idPattern=/^[a-z][a-z0-9-]{0,63}$/;
const inside=(value,root)=>value===root||value.startsWith(root+path.sep);
export function freezeConfig(value){if(value&&typeof value==='object'){Object.values(value).forEach(freezeConfig);Object.freeze(value);}return value;}
function fields(value,allowed,label){
 if(!plain(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw Error('Invalid '+label+' configuration');
}
function text(value,label,max=4096){if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw Error('Invalid '+label);return value;}
function localPath(value,base,label){return path.resolve(base,text(value,label));}
function loopbackURL(value,label,protocols=['http:']){
 let u;try{u=new URL(value);}catch{throw Error('Invalid '+label);}
 if(!protocols.includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error(label+' must use a loopback origin');
 return u.origin;
}
function port(value,fallback,label){value=value??fallback;if(!Number.isSafeInteger(value)||value<1024||value>65535)throw Error('Invalid '+label+' port');return value;}

// The deployment file is the only workspace/plugin source for a portable
// installation. It does not import a maintainer's registry or credentials.
export function readDeploymentConfig(filename){
 const file=path.resolve(filename),base=path.dirname(file),raw=JSON.parse(readFileSync(file,'utf8'));
 fields(raw,['schema','stateDir','origin','port','frontPort','relayPort','relayBinary','native','access','workspaces','plugins','dependencyPackage'],'deployment');
 if(raw.schema!=='workbench.deployment.v1')throw Error('Unsupported deployment schema');
 const entryPort=port(raw.port,4173,'entry'),frontPort=port(raw.frontPort,3084,'front'),relayPort=port(raw.relayPort,18985,'relay');
 if(new Set([entryPort,frontPort,relayPort]).size!==3)throw Error('Entry, front and relay ports must differ');
 fields(raw.access??{mode:'loopback'},['mode','users','proxyKeyFile'],'access');
 const mode=raw.access?.mode??'loopback';if(!['loopback','tailscale-serve','cvm-proxy'].includes(mode))throw Error('Unsupported access mode');
 let publicURL;try{publicURL=new URL(raw.origin??'http://127.0.0.1:'+entryPort);}catch{throw Error('Invalid public origin');}
 if(publicURL.username||publicURL.password||publicURL.search||publicURL.hash||publicURL.pathname!=='/')throw Error('Public origin cannot contain credentials, a path or query');
 const users=raw.access?.users??[];
 if(!Array.isArray(users)||users.length>32||users.some(user=>typeof user!=='string'||user!==user.trim()||!user||user.length>254||/[\r\n\0]/.test(user))||new Set(users).size!==users.length)throw Error('Invalid allowed Tailscale users');
 if(mode==='loopback'){
  loopbackURL(publicURL.href,'Public origin');
  if(Number(publicURL.port||80)!==entryPort||users.length)throw Error('Loopback origin must use the entry port and no tailnet identity policy');
 }else if(mode==='tailscale-serve'){
  if(publicURL.protocol!=='https:'||!publicURL.hostname.endsWith('.ts.net')||!users.length)throw Error('Tailscale Serve requires an HTTPS ts.net origin and explicit allowed users');
 }else if(publicURL.protocol!=='https:'||!publicURL.hostname.includes('.')||!users.length||users.some(user=>!/^[-a-zA-Z0-9_@.]{1,128}$/.test(user)))throw Error('CVM requires an HTTPS domain and explicit allowed users');
 const proxyKeyFile=mode==='cvm-proxy'?localPath(raw.access.proxyKeyFile,base,'CVM proxy key file'):null;
 if(mode!=='cvm-proxy'&&raw.access?.proxyKeyFile)throw Error('Proxy credentials require CVM mode');
 fields(raw.native,['rpcUrl','webOrigin','hostPackage','codecPath','codexHome','appPath','binary','managed','rendererManifest','rendererManifestSha256'],'native');
 const rpcUrl=text(raw.native.rpcUrl,'native RPC URL');
 if(rpcUrl.startsWith('unix://')){if(!path.isAbsolute(rpcUrl.slice(7))||rpcUrl.includes('\0'))throw Error('Invalid native Unix socket');}
 else loopbackURL(rpcUrl,'Native RPC URL',['ws:']);
 if(raw.native.managed!=null&&typeof raw.native.managed!=='boolean')throw Error('Invalid Native ownership policy');
 const webOrigin=loopbackURL(raw.native.webOrigin,'Native web origin');
 for(const value of [rpcUrl,webOrigin])if(!value.startsWith('unix://')&&[entryPort,frontPort,relayPort].includes(Number(new URL(value).port||80)))throw Error('Native endpoint conflicts with a workbench listener');
 if(!rpcUrl.startsWith('unix://')&&Number(new URL(rpcUrl).port)===Number(new URL(webOrigin).port))throw Error('Native RPC and host ports must differ');
 if(raw.native.managed&&rpcUrl.startsWith('unix://'))throw Error('Managed Native requires a loopback WebSocket; Unix sockets are external-owner only');
 if(raw.native.managed&&(!raw.native.binary||!raw.native.appPath))throw Error('Managed Native requires a binary and Desktop application');
 const hostPackage=localPath(raw.native.hostPackage,base,'native host package');
 const stateDir=localPath(raw.stateDir,base,'state directory');
 const codexHome=localPath(raw.native.codexHome??path.join(os.homedir(),'.codex'),base,'native home');
 if(inside(stateDir,codexHome)||inside(codexHome,stateDir))throw Error('Workbench state must be separate from native account state');
 if(!plain(raw.workspaces)||!own(raw.workspaces,'ai')||Object.keys(raw.workspaces).length>2)throw Error('A primary workspace is required');
 const workspaces={},roots=[];
 for(const[id,ws]of Object.entries(raw.workspaces)){
  // These are the existing wire scope slots, not users or personal folders.
  // Keeping them stable preserves installed clients and persisted cursor IDs.
  if(!['ai','zyy'].includes(id))throw Error('Unsupported wire workspace slot');
  fields(ws,['label','root','readOnly','plugins','projectBindings'],'workspace');
  const root=realpathSync(localPath(ws.root,base,'workspace root'));
  if(roots.some(other=>inside(root,other)||inside(other,root)))throw Error('Workspace roots overlap');
  roots.push(root);
  if(ws.readOnly!=null&&typeof ws.readOnly!=='boolean')throw Error('Invalid workspace readOnly policy');
  const plugins=ws.plugins??[];
  if(!Array.isArray(plugins)||plugins.length>64||plugins.some(id=>typeof id!=='string'||!idPattern.test(id))||new Set(plugins).size!==plugins.length)throw Error('Invalid enabled plugins');
  const projectBindings=ws.projectBindings??[];
  if(!Array.isArray(projectBindings)||projectBindings.length>64)throw Error('Invalid project bindings');
  const bindingIds=new Set(),bindingRoots=new Set();
  for(const binding of projectBindings){
   fields(binding,['id','name','root'],'project binding');
   if(!idPattern.test(binding.id)||bindingIds.has(binding.id)||path.isAbsolute(binding.root||''))throw Error('Invalid project binding');
   text(binding.name,'project name',120);
   const actual=realpathSync(localPath(binding.root,root,'project root'));
   if(actual===root||!inside(actual,root)||bindingRoots.has(actual))throw Error('Project binding escapes or duplicates the workspace');
   bindingIds.add(binding.id);bindingRoots.add(actual);
  }
  workspaces[id]={id,label:text(ws.label,'workspace label',120),root,readOnly:ws.readOnly===true,plugins:[...plugins],projectBindings};
 }
 const plugins=raw.plugins??[];
 if(!Array.isArray(plugins)||plugins.length>64||plugins.some(value=>typeof value!=='string'))throw Error('Plugins must be local manifest paths');
 return freezeConfig({
  schema:raw.schema,file,base,portable:true,stateDir,origin:publicURL.origin,port:entryPort,frontPort,relayPort,
  relayBinary:localPath(raw.relayBinary,base,'relay binary'),access:{mode,users:[...users],...(proxyKeyFile?{proxyKeyFile}:{})},workspaces,
  plugins:plugins.map(value=>localPath(value,base,'plugin manifest')),
  dependencyPackage:raw.dependencyPackage?localPath(raw.dependencyPackage,base,'dependency package'):fileURLToPath(new URL('../package.json',import.meta.url)),
  native:{rpcUrl,webOrigin,hostPackage,rendererManifest:raw.native.rendererManifest?localPath(raw.native.rendererManifest,base,'renderer manifest'):null,rendererManifestSha256:raw.native.rendererManifestSha256??null,managed:raw.native.managed===true,appPath:raw.native.appPath?localPath(raw.native.appPath,base,'Desktop application'):null,binary:raw.native.binary?localPath(raw.native.binary,base,'Native binary'):null,codecPath:raw.native.codecPath?localPath(raw.native.codecPath,base,'codec path'):path.join(path.dirname(hostPackage),'web-shell/codex-app-host-message-codec.js'),codexHome},
 });
}
