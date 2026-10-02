import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile,writeFile,open,unlink} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {readDeploymentConfig} from './deployment-config.mjs';
import {createPortableEntry} from './portable-entry.mjs';

const source=path.dirname(fileURLToPath(import.meta.url));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function vacant(port){
 const server=net.createServer();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 await new Promise(resolve=>server.close(resolve));
}
async function ready(url,children,{timeout=90000}={}){
 const end=Date.now()+timeout;
 while(Date.now()<end){
  if(children.some(child=>child.exitCode!==null||child.signalCode))throw Error('A core process exited; see the local logs');
  try{const response=await fetch(url,{signal:AbortSignal.timeout(1500)});await response.body?.cancel();if(response.ok)return;}catch{}
  await delay(250);
 }
 throw Error('Core startup did not become ready: '+new URL(url).pathname);
}

// 一个前台 supervisor 拥有其启动的进程；外部 Native 只连接，不接管或停止。
export async function startPortableHost(config,{startHost=true}={}){
 process.umask(0o077);
 await mkdir(config.stateDir,{recursive:true,mode:0o700});
 const lockPath=path.join(config.stateDir,'host.lock');
 let lock;
 try{lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\n');}
 catch(error){if(error.code==='EEXIST')throw Error('This state directory is already owned. Use doctor before removing a stale host.lock.');throw error;}
 const children=[],logs=[];let entry,closing=false;
 const exited=new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
 let failChild;const failed=new Promise((_,reject)=>{failChild=reject;});failed.catch(()=>{});
 async function child(name,command,args,env={}){
  const log=await open(path.join(config.stateDir,name+'.log'),'a',0o600);logs.push(log);
  const cp=spawn(command,args,{cwd:config.workspaces.ai.root,env:{...process.env,...env},stdio:['ignore',log.fd,log.fd]});children.push(cp);
  cp.once('error',()=>failChild(Error(name+' could not start')));
  cp.once('exit',()=>{if(!closing)failChild(Error(name+' exited; remaining processes are stopping'))});
  return cp;
 }
 async function close(){
  if(closing)return;closing=true;await entry?.close().catch(()=>{});
  // 按依赖逆序关停本 supervisor 的子进程；不按端口或进程名杀进程。
  for(const cp of [...children].reverse())if(cp.exitCode===null&&!cp.signalCode){cp.kill('SIGTERM');await Promise.race([new Promise(resolve=>cp.once('exit',resolve)),delay(8000)]);if(cp.exitCode===null&&!cp.signalCode)cp.kill('SIGKILL');}
  await Promise.allSettled(logs.map(log=>log.close()));await lock.close();await unlink(lockPath);
 }
 try{
  for(const port of [config.port,config.frontPort,config.relayPort,...(startHost?[Number(new URL(config.native.webOrigin).port)]:[]),...(config.native.managed?[Number(new URL(config.native.rpcUrl).port)]:[])])await vacant(port);
  const keyFile=path.join(config.stateDir,'bridge.key');
  try{await writeFile(keyFile,randomBytes(48).toString('base64url')+'\n',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  const env={WORKBENCH_CONFIG:config.file,CODEX_HOME:config.native.codexHome};
  if(config.native.managed)await child('native',config.native.binary,['app-server','--listen',config.native.rpcUrl],env);
  if(startHost){
   if(!config.native.appPath||!config.native.rendererManifest)throw Error('Run setup to install the pinned renderer and configure the Desktop host');
   const bytes=await readFile(config.native.rendererManifest),manifest=JSON.parse(bytes);
   if(createHash('sha256').update(bytes).digest('hex')!==config.native.rendererManifestSha256)throw Error('Renderer manifest changed; run doctor');
   await child('desktop-host',process.execPath,[path.join(path.dirname(config.native.hostPackage),'gateway/dev/run-gateway.cjs')],{
    ...env,HOST:'127.0.0.1',PORT:String(new URL(config.native.webOrigin).port),CODEX_DESKTOP_APP_PATH:config.native.appPath,
    CODEX_APP_SERVER_WS_URL:config.native.rpcUrl,CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED:'1',
    CODEX_WEB_RUNTIME_DIR:path.join(config.stateDir,'desktop-runtime'),CODEX_WEB_OFFICIAL_USER_DATA_DIR:path.join(config.stateDir,'desktop-profile'),
    CODEX_WEB_OFFICIAL_BUNDLE_DIR:path.join(config.stateDir,'desktop-bundle'),CODEX_WEB_CONFIG_PATH:path.join(config.stateDir,'desktop-host.yaml'),
    CODEX_WEB_REPORTS_DIR:path.join(config.stateDir,'desktop-reports'),CODEX_WEB_OFFICIAL_AUTO_SCAN_UPGRADE:'1',
    DSH_WEB_RENDERER_DIR:manifest.webviewDir,DSH_WEB_RENDERER_MANIFEST:config.native.rendererManifest,DSH_WEB_RENDERER_MANIFEST_SHA256:config.native.rendererManifestSha256,
   });
  }
  await ready(config.native.webOrigin+'/codex-web-config.js',children);
  await child('relay',config.relayBinary,['-listen','127.0.0.1:'+config.relayPort,'-state-dir',path.join(config.stateDir,'relay'),'-key-file',keyFile,'-origin',config.origin,...(config.access.mode==='loopback'?['-local-development']:[])]);
  await child('observer',process.execPath,[path.join(source,'sync-adapter.mjs')],env);
  await child('front',process.execPath,[path.join(source,'official-front.mjs')],{...env,PORT:String(config.frontPort),DSH_OFFICIAL_STATE_DIR:path.join(config.stateDir,'front'),DSH_OFFICIAL_PUBLIC_ORIGIN:config.origin});
  await ready('http://127.0.0.1:'+config.frontPort+'/readyz',children);
  entry=await createPortableEntry(config);await new Promise((resolve,reject)=>{entry.server.once('error',reject);entry.server.listen(config.port,'127.0.0.1',resolve);});
  console.log(JSON.stringify({ready:true,url:config.origin+'/?workspace=ai&view=chat&nativeList=1',access:config.access.mode,pid:process.pid}));
  return {close,wait:()=>Promise.race([exited,failed]).finally(close)};
 }catch(error){await close();throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const filename=process.env.WORKBENCH_CONFIG;if(!filename)throw Error('Set WORKBENCH_CONFIG to the generated deployment.json');
 const host=await startPortableHost(readDeploymentConfig(filename));await host.wait();
}
