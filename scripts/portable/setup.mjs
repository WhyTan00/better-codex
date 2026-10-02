import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,constants} from 'node:fs';
import {access,readFile,writeFile,mkdir,rename,chmod,readdir,stat,open,copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readDeploymentConfig} from '../../source/apps/native-codex-web/src/deployment-config.mjs';
export const repository=fileURLToPath(new URL('../../',import.meta.url));
export async function exists(file){try{await access(file);return true;}catch{return false;}}
export async function digest(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
export function run(command,args,options={}){return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'inherit',...options});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(path.basename(command)+' failed ('+code+')')));});}
export async function capture(command,args,options={}){let text='';await new Promise((resolve,reject)=>{const child=spawn(command,args,{...options,stdio:['ignore','pipe','inherit']});child.stdout.on('data',data=>{text+=data;if(text.length>8*1024*1024){child.kill();reject(Error('Command output exceeded limit'));}});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(path.basename(command)+' failed ('+code+')')));});return text;}
async function download(url,file,sha){
 if(await exists(file)){if(await digest(file)!==sha)throw Error('Cached download checksum mismatch: '+path.basename(file));return;}
 const temporary=file+'.part-'+randomUUID();console.log('Downloading '+path.basename(file));
 await run('curl',['--fail','--location','--proto','=https','--connect-timeout','20','--max-time','1800',url,'-o',temporary]);
 if(await digest(temporary)!==sha)throw Error('Download checksum mismatch: '+path.basename(file));await rename(temporary,file);
}
async function atomicJSON(file,value){const temp=file+'.next-'+randomUUID();await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temp,file);}
export async function requireStopped(home){
 const configFile=path.join(home,'deployment.json');
 const stateDir=await exists(configFile)?readDeploymentConfig(configFile).stateDir:path.join(home,'state');
 const file=path.join(stateDir,'host.lock');if(!await exists(file))return;
 const lock=JSON.parse(await readFile(file,'utf8'));let alive=false;try{process.kill(lock.pid,0);alive=true;}catch(error){if(error.code!=='ESRCH')throw error;}
 if(alive)throw Error('The local host is running. Stop it in its terminal before setup or update.');
 // Stale ownership is retained for inspection; only the known dead lock moves.
 await rename(file,file+'.stale-'+Date.now());
}
async function installedApp(requested){
 for(const app of [requested,'/Applications/ChatGPT.app','/Applications/Codex.app'].filter(Boolean)){
  for(const relative of ['Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','Contents/Resources/codex']){const binary=path.join(app,relative);if(await exists(binary))return {app:path.resolve(app),binary};}
 }
 throw Error('Install the official Codex desktop application and sign in, then run setup again (or pass --app).');
}
async function prepareRenderer({archive,root,host,pin}){
 const manifest=path.join(root,'manifest.json');if(await exists(manifest))return {manifest,sha:await digest(manifest)};
 const staging=root+'.staging-'+randomUUID();await mkdir(staging,{recursive:true,mode:0o700});
 const listing=await capture('/usr/bin/unzip',['-Z1',archive]);const names=listing.split('\n').filter(name=>name.endsWith('/Contents/Resources/app.asar'));if(names.length!==1)throw Error('Official archive layout changed');
 const asarFile=path.join(staging,'app.asar'),handle=await open(asarFile,'wx',0o600);
 try{await run('/usr/bin/unzip',['-p',archive,names[0]],{stdio:['ignore',handle.fd,'inherit']});}finally{await handle.close();}
 const require=createRequire(path.join(host,'package.json')),asar=require('@electron/asar'),files={};const webview=path.join(staging,'webview');await mkdir(webview);
 for(const name of asar.listPackage(asarFile)){
  if(!name.startsWith('/webview/'))continue;const metadata=asar.statFile(asarFile,name.slice(1));if(metadata.files)continue;
  const relative=name.slice('/webview/'.length);if(metadata.link||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Unexpected renderer archive link');
  const bytes=asar.extractFile(asarFile,name.slice(1)),target=path.join(webview,relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{mode:0o400});files[relative]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 }
 if(!files['index.html'])throw Error('Official renderer is missing its entry');
 async function freeze(directory){for(const item of await readdir(directory,{withFileTypes:true}))if(item.isDirectory())await freeze(path.join(directory,item.name));await chmod(directory,0o500);}
 await freeze(webview);
 await atomicJSON(path.join(staging,'manifest.json'),{schema:1,version:pin.version,build:pin.build,webviewDir:path.join(root,'webview'),sourceSha256:pin.sha256,files});
 await rename(staging,root);return {manifest,sha:await digest(manifest)};
}
export async function setup(options){
 if(process.platform!=='darwin'||!['arm64','x64'].includes(process.arch))throw Error('The portable host currently supports macOS arm64 and x64');
 if(Number(process.versions.node.split('.')[0])<24)throw Error('Node.js 24 or later is required. Use install.sh.');
 process.umask(0o077);const home=path.resolve(options.home||process.env.BETTER_CODEX_HOME||path.join(os.homedir(),'.better-codex'));
 await mkdir(home,{recursive:true,mode:0o700});await requireStopped(home);
 const configFile=path.join(home,'deployment.json'),previous=await exists(configFile)?JSON.parse(await readFile(configFile,'utf8')):null;
 const app=await installedApp(options.app||previous?.native.appPath),pins=JSON.parse(await readFile(path.join(repository,'dependencies.lock.json'),'utf8'));
 const deps=path.join(home,'dependencies'),cache=path.resolve(options['cache-dir']||path.join(home,'downloads'));await mkdir(deps,{recursive:true});await mkdir(cache,{recursive:true});
 const cli=path.join(deps,'host-cli-0.2.0');await mkdir(cli,{recursive:true});
 for(const name of ['package.json','package-lock.json'])await copyFile(path.join(repository,'packages/host-cli',name),path.join(cli,name));
 await run('npm',['ci','--prefix',cli,'--ignore-scripts','--no-audit','--no-fund']);
 const patch=await readFile(path.join(repository,'integrations/opencodex/renderer-source.cjs')),rendererPatchSha=createHash('sha256').update(patch).digest('hex'),integrityPatch=await readFile(path.join(repository,'integrations/opencodex/runner-integrity.cjs')),patchSha=createHash('sha256').update(patch).update(integrityPatch).update('mac-framework-copy-v1').digest('hex');
 const host=path.join(deps,'opencodex-'+pins.opencodex.version+'-'+patchSha.slice(0,12)),hostReady=path.join(host,'better-codex-source.json');
 if(!await exists(hostReady)){
  if(await exists(host))throw Error('Existing host is incomplete; its data was retained at '+host);
  const buildHost=host+'.staging-'+randomUUID();
  const archive=path.join(cache,'opencodex-'+pins.opencodex.version+'.tar.gz');await download(pins.opencodex.url,archive,pins.opencodex.sha256);await mkdir(buildHost);
  await run('/usr/bin/tar',['-xzf',archive,'-C',buildHost,'--strip-components=1']);
  const file=path.join(buildHost,'gateway/runtime/http/static-assets.cjs');if(await digest(file)!==pins.opencodex.staticAssetsSha256)throw Error('Upstream host source contract changed');
  const text=await readFile(file,'utf8'),before='  getOfficialBundle,\n  patchedAssetCacheMaxBytes';if(text.split(before).length!==2)throw Error('Upstream renderer injection point changed');
  await writeFile(path.join(buildHost,'gateway/runtime/http/renderer-source.cjs'),patch);
  const macFile=path.join(buildHost,'gateway/runner/platform/macos.cjs');if(await digest(macFile)!==pins.opencodex.macRunnerSha256)throw Error('Upstream Mac runner contract changed');
  const macSource=await readFile(macFile,'utf8'),macAnchor='() => signRunnerExecutable(runnerExecutablePath)';if(macSource.split(macAnchor).length!==2)throw Error('Upstream Mac runner injection point changed');
  await writeFile(path.join(buildHost,'gateway/runner/platform/runner-integrity.cjs'),integrityPatch);
  await writeFile(macFile,macSource.replace('recursive: true, force: true });\n  writeJson(markerPath,', 'recursive: true, force: true, verbatimSymlinks: true });\n  writeJson(markerPath,').replace('source: realpathSafe(layout.frameworksDir),', "copyPolicy: 'relative-symlinks-v1',\n    source: realpathSafe(layout.frameworksDir),").replace(macAnchor,"() => { require('./runner-integrity.cjs').refreshRunnerIntegrity(runnerAppPath); signRunnerExecutable(runnerExecutablePath); }"));
  const updated=text.replace(before,'  getOfficialBundle: runtimeOfficialBundle,\n  patchedAssetCacheMaxBytes').replace('  const staticModificationRuntime = createHostModificationRuntime({',"  // 固定 HTTP 资源，不改变官方 main/native 的版本归属。\n  const getOfficialBundle = require('./renderer-source.cjs').createRendererBundleProvider({getOfficialBundle: runtimeOfficialBundle});\n  const staticModificationRuntime = createHostModificationRuntime({");
  await writeFile(file,updated);
  const pnpm=path.join(cli,'node_modules/pnpm/bin/pnpm.cjs');await run(process.execPath,[pnpm,'install','--frozen-lockfile','--ignore-scripts'],{cwd:buildHost});await run(process.execPath,[pnpm,'run','build:gateway'],{cwd:buildHost});
  await atomicJSON(path.join(buildHost,'better-codex-source.json'),{upstream:pins.opencodex,patchSha256:rendererPatchSha,runnerPatchSha256:createHash('sha256').update(integrityPatch).digest('hex'),modifiedMacRunnerSha256:await digest(macFile),modifiedStaticAssetsSha256:await digest(file),license:'AGPL-3.0-only',sourceLocation:host});
  await rename(buildHost,host);
 }
 const archive=path.join(cache,path.basename(new URL(pins.renderer.url).pathname));await download(pins.renderer.url,archive,pins.renderer.sha256);
 const renderer=await prepareRenderer({archive,root:path.join(deps,'renderer-'+pins.renderer.version+'-'+pins.renderer.build),host,pin:pins.renderer});
 let go=options.go||'go';try{await capture(go,['version']);}catch{
  const arch=process.arch==='x64'?'amd64':'arm64',name='go'+pins.go.version+'.darwin-'+arch+'.tar.gz',file=path.join(cache,name);await download('https://go.dev/dl/'+name,file,pins.go[process.arch]);const directory=path.join(deps,'go-'+pins.go.version);await mkdir(directory,{recursive:true});await run('/usr/bin/tar',['-xzf',file,'-C',directory,'--strip-components=1']);go=path.join(directory,'bin/go');
 }
 const binary=path.join(deps,'sync-gateway-'+Date.now());await run(go,['build','-trimpath','-buildvcs=false','-o',binary,'.'],{cwd:path.join(repository,'source/apps/sync-gateway')});
 const root=path.resolve(options.workspace||previous?.workspaces.ai.root||path.join(os.homedir(),'Code'));await mkdir(root,{recursive:true});
 const port=Number(options.port||4173);if(!Number.isSafeInteger(port)||port<1024||port>65531)throw Error('Invalid base port');
 const config=previous?structuredClone(previous):{schema:'workbench.deployment.v1',stateDir:path.join(home,'state'),origin:'http://127.0.0.1:'+port,port,frontPort:port+3,relayPort:port+4,access:{mode:'loopback'},workspaces:{ai:{label:options.label||'Workspace',root,plugins:['project-overview']}},plugins:[path.join(repository,'examples/plugins/project-overview/plugin.json')],native:{rpcUrl:options['native-url']||'ws://127.0.0.1:'+(port+2),webOrigin:'http://127.0.0.1:'+(port+1),managed:!options['native-url'],codexHome:path.resolve(options['codex-home']||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'))}};
 await mkdir(path.resolve(home,config.native.codexHome),{recursive:true,mode:0o700});
 Object.assign(config,{relayBinary:binary,dependencyPackage:path.join(cli,'package.json')});Object.assign(config.native,{appPath:app.app,binary:app.binary,hostPackage:path.join(host,'package.json'),rendererManifest:renderer.manifest,rendererManifestSha256:renderer.sha});
 const proposed=path.join(home,'deployment.proposed-'+randomUUID()+'.json');await atomicJSON(proposed,config);readDeploymentConfig(proposed);
 if(previous)await copyFile(configFile,path.join(home,'deployment.before-'+Date.now()+'.json'));await rename(proposed,configFile);
 const command=path.join(home,'better-codex');
 await writeFile(command,'#!/bin/sh\nPATH='+quote(path.dirname(process.execPath))+':"$PATH"; export PATH\nif [ "$#" -eq 0 ]; then set -- help; fi\nexec '+quote(process.execPath)+' '+quote(path.join(repository,'scripts/better-codex.mjs'))+' "$@" --home '+quote(home)+'\n',{mode:0o700});await chmod(command,0o700);
 const launcher=path.join(home,'start');await writeFile(launcher,'#!/bin/sh\nexec '+quote(command)+' start "$@"\n',{mode:0o700});await chmod(launcher,0o700);
 console.log(JSON.stringify({installed:true,config:configFile,start:launcher,url:config.origin+'/?workspace=ai&view=chat&nativeList=1',nativeAuthentication:'Use the official Desktop account; no credentials were copied.'},null,2));return {home,config};
}
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
