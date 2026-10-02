#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import {readFile,writeFile,copyFile,rename,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setup,exists,digest,capture,run,requireStopped} from './portable/setup.mjs';
import {readDeploymentConfig} from '../source/apps/native-codex-web/src/deployment-config.mjs';
import {PortablePlugins} from '../source/apps/native-codex-web/src/portable-plugins.mjs';

export function argumentsFor(argv){
 const options={};
 for(let i=0;i<argv.length;i++){
  const key=argv[i];if(!key.startsWith('--'))throw Error('Unexpected argument: '+key);
  const name=key.slice(2);
  if(['enable','help'].includes(name)){options[name]=true;continue;}
  if(!['home','workspace','label','port','app','native-url','codex-home','cache-dir','go','user','url','tailscale-bin'].includes(name)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('Unknown option or missing value: '+key);
  const value=argv[++i];if(name==='user')(options.user??=[]).push(value);else if(Object.hasOwn(options,name))throw Error('Duplicate option: '+key);else options[name]=value;
 }
 return options;
}
export async function doctor(home){
 const config=readDeploymentConfig(path.join(home,'deployment.json')),checks=[];
 const check=async(name,fn)=>{try{await fn();checks.push({name,ok:true});}catch(error){checks.push({name,ok:false,error:error.message});}};
 await check('Native application',async()=>{await stat(config.native.binary);await stat(config.native.appPath);});
 await check('OpenCodex source and local modification',async()=>{
  const dir=path.dirname(config.native.hostPackage),receipt=JSON.parse(await readFile(path.join(dir,'better-codex-source.json'),'utf8'));
  if(await digest(path.join(dir,'gateway/runtime/http/static-assets.cjs'))!==receipt.modifiedStaticAssetsSha256||await digest(path.join(dir,'gateway/runtime/http/renderer-source.cjs'))!==receipt.patchSha256)throw Error('Installed host modification changed');
  if(await digest(path.join(dir,'gateway/runner/platform/macos.cjs'))!==receipt.modifiedMacRunnerSha256||await digest(path.join(dir,'gateway/runner/platform/runner-integrity.cjs'))!==receipt.runnerPatchSha256)throw Error('Installed runner modification changed');
  await stat(path.join(dir,'gateway/dist/official/CodexAsarScanner.js'));
 });
 await check('Pinned official renderer',async()=>{
  if(await digest(config.native.rendererManifest)!==config.native.rendererManifestSha256)throw Error('Renderer manifest changed');
  const manifest=JSON.parse(await readFile(config.native.rendererManifest,'utf8'));
  for(const [relative,metadata] of Object.entries(manifest.files)){
   const file=path.resolve(manifest.webviewDir,relative);
   if(!file.startsWith(manifest.webviewDir+path.sep)||await digest(file)!==metadata.sha256||(await stat(file)).mode&0o222)throw Error('Renderer file changed: '+relative);
  }
 });
 await check('Relay binary',()=>stat(config.relayBinary));
 await check('Workspace plugins',async()=>{const plugins=await new PortablePlugins(config).start();await plugins.close();});
 const lock=path.join(config.stateDir,'host.lock');let running=false;
 if(await exists(lock)){const {pid}=JSON.parse(await readFile(lock,'utf8'));try{process.kill(pid,0);running=true;}catch{};}
 if(running)await check('Running entry',async()=>{const r=await fetch('http://127.0.0.1:'+config.port+'/__workbench_health',{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('Entry is unavailable');});
 const report={ok:checks.every(check=>check.ok),running,config:config.file,url:config.origin,checks};console.log(JSON.stringify(report,null,2));return report;
}
export function validateServeStatus(status,origin,port){
 if(!status||typeof status!=='object'||Array.isArray(status))throw Error('Invalid Tailscale Serve status');
 const expected=origin.replace('https://','')+':443',target='http://127.0.0.1:'+port;
 const tcp=Object.keys(status.TCP??{}),web=status.Web??{},hosts=Object.keys(web);
 if(Object.keys(status.AllowFunnel??{}).some(key=>status.AllowFunnel[key]))throw Error('Funnel is enabled; use a private Serve configuration on a separate device.');
 if(tcp.some(key=>key!=='443')||hosts.some(key=>key!==expected)||hosts.some(key=>Object.keys(web[key].Handlers??{}).some(route=>route!=='/'||web[key].Handlers[route].Proxy!==target)))throw Error('Existing Serve routes belong to another service; they were not changed.');
}
export async function tailscale(home,options){
 await requireStopped(home);const file=path.join(home,'deployment.json'),raw=JSON.parse(await readFile(file,'utf8')),config=readDeploymentConfig(file);
 const bin=options['tailscale-bin']||'tailscale',status=JSON.parse(await capture(bin,['status','--json']));
 if(status.BackendState!=='Running')throw Error('Sign in to Tailscale on this Mac first.');
 const dns=status.Self?.DNSName?.replace(/\.$/,''),origin=options.url||'https://'+dns,users=options.user||[status.User?.[status.Self?.UserID]?.LoginName].filter(Boolean);
 if(!dns||new URL(origin).hostname!==dns)throw Error('The URL must match this Mac in Tailscale.');
 const serve=JSON.parse(await capture(bin,['serve','status','--json']));validateServeStatus(serve,origin,config.port);
 raw.origin=origin;raw.access={mode:'tailscale-serve',users};
 const proposed=file+'.next-'+randomUUID();await writeFile(proposed,JSON.stringify(raw,null,2)+'\n',{mode:0o600,flag:'wx'});readDeploymentConfig(proposed);
 await copyFile(file,file+'.before-tailscale-'+Date.now());
 if(options.enable)await run(bin,['serve','--bg','--https=443','http://127.0.0.1:'+config.port]);
 await rename(proposed,file);
 console.log(JSON.stringify({configured:true,serveEnabled:!!options.enable,url:origin,allowedUsers:users,serveCommand:options.enable?null:[bin,'serve','--bg','--https=443','http://127.0.0.1:'+config.port],next:'Run start, then open the URL on a device signed in to Tailscale.'},null,2));
}
const help=`Better Codex — local Mac host + private Tailscale access

  setup [--workspace /path] [--port 4173] [--app /Applications/ChatGPT.app]
  start                         Keep this terminal open; Ctrl-C stops owned children
  doctor                        Verify installation without sending a model turn
  tailscale --enable            Configure private Serve and allow your tailnet login
  tailscale --user me@example.com [--user colleague@example.com] [--enable]
  update                        Rebuild from this checkout; stop the host first

All commands accept --home /path (default ~/.better-codex).
setup accepts --native-url ws://127.0.0.1:PORT to use an existing Native owner.
Dependencies are local; no sudo, account copy, login item, or public Funnel.
`;
export async function main(argv=process.argv.slice(2)){
 const [command='help',...rest]=argv,options=argumentsFor(rest),home=path.resolve(options.home||process.env.BETTER_CODEX_HOME||path.join(os.homedir(),'.better-codex'));
 if(command==='help'||options.help){console.log(help);return;}
 if(command==='setup'||command==='update')return setup(options);
 if(command==='doctor'){if(!(await doctor(home)).ok)process.exitCode=1;return;}
 if(command==='tailscale')return tailscale(home,options);
 if(command==='start'){
  const file=path.join(home,'deployment.json'),config=readDeploymentConfig(file);process.env.WORKBENCH_CONFIG=file;
  const {startPortableHost}=await import('../source/apps/native-codex-web/src/portable-host.mjs');const host=await startPortableHost(config);return host.wait();
 }
 throw Error('Unknown command. Use help.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error('Better Codex: '+error.message);process.exitCode=1;});
