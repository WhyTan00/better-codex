#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {readFile} from 'node:fs/promises';
import {readDeploymentConfig} from '../source/apps/native-codex-web/src/deployment-config.mjs';
export async function verifyPortable({config,request=fetch,socketHeaders={},socketOptions={}}){
process.env.WORKBENCH_CONFIG=config.file;
const report={checks:[],modelTurnsSent:0,historyMutated:false,physicalPhoneAcceptance:false,liveTailscaleAcceptance:false};
const check=(name,ok)=>{report.checks.push({name,ok:!!ok});if(!ok)throw Error(name);};
const base=config.origin,get=async(route,options={})=>{const r=await request(base+route,{...options,signal:AbortSignal.timeout(30000)});return r;};
try{
 const session=await (await get('/dsh-scope-session?workspace=ai')).json();check('configured workspace',session.id==='ai'&&session.label===config.workspaces.ai.label);
 const headers={origin:base,'content-type':'application/json','x-dsh-scope':session.token};
 const rows=await get('/w/ai/api/request',{method:'POST',headers,body:JSON.stringify({request:{method:'thread/list',params:{limit:1,modelProviders:[]}}})});check('Native directory through portable entry',rows.ok&&Array.isArray((await rows.json()).data));
 const release=await (await get('/dsh-native-release.json')).json();
 for(const route of [release.shell,release.loader,release.scope,release.initial,release.primary,...release.startupAssets]){const r=await get(route);const bytes=await r.arrayBuffer();check('renderer resource '+route,r.ok&&bytes.byteLength>0);}
 const manifest=await (await get('/manifest.webmanifest?workspace=ai')).json();const icon=await get(manifest.icons[0].src);check('PWA icon is local and available',icon.ok&&icon.headers.get('content-type')==='image/svg+xml');await icon.body?.cancel();
 const context=await (await get('/api/context',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({workspace:'ai'})})).json();
 const plugins=await (await get('/api/w/ai/plugins',{headers:{'x-better-codex-capability':context.token}})).json();check('configured plugin list',Array.isArray(plugins.data)&&plugins.data.length===config.workspaces.ai.plugins.length);
 for(const plugin of plugins.data){const result=await get('/api/w/ai/plugins/'+plugin.id,{headers:{'x-better-codex-capability':context.token}});check('plugin read '+plugin.id,result.ok);await result.body?.cancel();}
 const status=JSON.parse(await readFile(path.join(config.stateDir,'observer/status.json'),'utf8'));check('observer and local relay connected',status.state==='connected'&&status.native==='ready');
 const {verifyFrontProtocols}=await import('./front-protocol-probes.mjs');await verifyFrontProtocols({base,report,request,socketHeaders,socketOptions});report.ok=true;
}catch(error){report.ok=false;report.error=error.message;}
return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const at=process.argv.indexOf('--home'),home=path.resolve(at<0?process.env.BETTER_CODEX_HOME||path.join(os.homedir(),'.better-codex'):process.argv[at+1]);
 const config=readDeploymentConfig(path.join(home,'deployment.json'));
 if(config.access.mode!=='loopback')throw Error('Run local verification before configuring Tailscale or CVM access.');
 const report=await verifyPortable({config});console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
}
