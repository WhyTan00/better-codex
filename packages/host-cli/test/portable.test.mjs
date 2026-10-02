import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {readDeploymentConfig} from '../../../source/apps/native-codex-web/src/deployment-config.mjs';
import {PortablePlugins} from '../../../source/apps/native-codex-web/src/portable-plugins.mjs';
import {createPortableEntry} from '../../../source/apps/native-codex-web/src/portable-entry.mjs';
import {argumentsFor,validateServeStatus,tailscale} from '../../../scripts/better-codex.mjs';
import {requireStopped} from '../../../scripts/portable/setup.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'better-codex-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const name of ['primary','secondary','plugin','plugin/ui'])await mkdir(path.join(root,name),{recursive:true});
 await writeFile(path.join(root,'plugin/adapter.mjs'),`let count=0;export async function read(c){return {summary:c.workspace.label,revision:'v1'}};export async function invoke(c,r){return {count:++count,request:r,scope:c.workspace.id}};`);
 await writeFile(path.join(root,'plugin/ui/index.html'),'<!doctype html><title>Local project</title>');
 await writeFile(path.join(root,'plugin/plugin.json'),JSON.stringify({schema:'workbench.plugin.v1',id:'example',label:'Example',entry:'adapter.mjs',readOnly:false,actions:['save'],ui:{directory:'ui'}}));
 const raw={schema:'workbench.deployment.v1',stateDir:'state',origin:'http://127.0.0.1:4173',port:4173,frontPort:4176,relayPort:4177,relayBinary:'relay',native:{rpcUrl:'ws://127.0.0.1:4175',webOrigin:'http://127.0.0.1:4174',hostPackage:'package.json',codexHome:'native'},access:{mode:'loopback'},workspaces:{ai:{label:'Primary',root:'primary',plugins:['example']},zyy:{label:'Secondary',root:'secondary',readOnly:true,plugins:['example']}},plugins:['plugin/plugin.json']};
 const file=path.join(root,'deployment.json'),load=async()=>{await writeFile(file,JSON.stringify(raw));return readDeploymentConfig(file);};
 return {root,raw,load,config:await load()};
}
test('configuration rejects intersecting roots, unsafe origins and managed Unix ownership',async t=>{
 const f=await fixture(t);assert.equal(f.config.workspaces.ai.label,'Primary');assert(Object.isFrozen(f.config.workspaces));
 f.raw.workspaces.zyy.root='primary';await assert.rejects(f.load,/overlap/);f.raw.workspaces.zyy.root='secondary';
 f.raw.origin='http://0.0.0.0:4173';await assert.rejects(f.load,/loopback/);
 f.raw.origin='https://example.ts.net';f.raw.access={mode:'tailscale-serve',users:[]};await assert.rejects(f.load,/explicit allowed users/);
 f.raw.access.users=['a@example.com'];assert.equal((await f.load()).access.mode,'tailscale-serve');
 f.raw.native={...f.raw.native,rpcUrl:'unix:///tmp/native.sock',managed:true,binary:'codex',appPath:'Desktop.app'};await assert.rejects(f.load,/external-owner/);
});
test('plugins preserve source ownership, workspace read policy and package containment',async t=>{
 const f=await fixture(t),plugins=await new PortablePlugins(f.config).start();t.after(()=>plugins.close());
 assert.equal((await plugins.load('ai','example')).snapshot.summary,'Primary');
 const input={operation:'save',requestId:'11111111-1111-4111-8111-111111111111',expectedRevision:'v1',data:{text:'local'}};
 assert.deepEqual(await plugins.invoke('ai','example',input),{count:1,request:input,scope:'ai'});
 await assert.rejects(plugins.invoke('zyy','example',input),e=>e.code===403);
 await assert.rejects(plugins.invoke('ai','example',{...input,expectedRevision:''}),e=>e.code===400);
 assert.throws(()=>plugins.list('unknown'),e=>e.code===403);
 await writeFile(path.join(f.root,'outside.html'),'outside');await symlink(path.join(f.root,'outside.html'),path.join(f.root,'plugin/ui/escape.html'));
 await assert.rejects(plugins.asset('ai','example','escape.html'),e=>e.code===404);
 await assert.rejects(plugins.asset('ai','example','%2e%2e/outside.html'),e=>e.code===404);
});
test('entry binds tailnet identity, rejects cross-origin and cross-workspace capabilities, and strips forged proxy headers',async t=>{
 const f=await fixture(t),front=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({headers:req.headers,url:req.url}));});
 await new Promise(resolve=>front.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>front.close(resolve)));
 const config={...f.config,origin:'https://example.ts.net',access:{mode:'tailscale-serve',users:['a@example.com','b@example.com']},frontPort:front.address().port};
 const entry=await createPortableEntry(config);await new Promise(resolve=>entry.server.listen(0,'127.0.0.1',resolve));t.after(()=>entry.close());
 const request=(url,options={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:entry.server.address().port,path:url,method:options.method||'GET',headers:{host:'example.ts.net',origin:config.origin,'tailscale-user-login':'a@example.com',...options.headers}},res=>{let body='';res.on('data',data=>body+=data);res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(body)}));});req.on('error',reject);req.end(options.body);});
 assert.equal((await request('/',{headers:{'tailscale-user-login':'outsider@example.com'}})).status,401);
 assert.equal((await request('/',{headers:{origin:'https://attacker.example'}})).status,403);
 assert.equal((await request('/',{headers:{host:'attacker.example'}})).status,403);
 const context=await request('/api/context',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspace:'ai'})});assert.equal(context.status,200);const {token}=await context.json();
 const auth={authorization:'Bearer '+token};assert.equal((await request('/api/w/ai/plugins',{headers:auth})).status,200);
 assert.equal((await request('/api/w/zyy/plugins',{headers:auth})).status,401);
 assert.equal((await request('/api/w/ai/plugins',{headers:{...auth,'tailscale-user-login':'b@example.com'}})).status,401);
 assert.equal((await request('/_sync-agent')).status,404);
 const proxy=await (await request('/w/ai/api/request',{headers:{'x-dsh-authenticated':'forged','x-forwarded-host':'evil'}})).json();
 assert.equal(proxy.headers['x-dsh-authenticated'],'1');assert.equal(proxy.headers['x-forwarded-host'],undefined);assert.equal(proxy.headers['tailscale-user-login'],undefined);
 const upgrade=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:entry.server.address().port,path:'/w/ai/ws',headers:{host:'example.ts.net',origin:'https://evil.example','tailscale-user-login':'a@example.com',connection:'Upgrade',upgrade:'websocket'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end();});assert.equal(upgrade,403);
});
test('CLI does not replace another Tailscale service or accept unknown settings',()=>{
 assert.deepEqual(argumentsFor(['--home','/tmp/example','--user','a@example.com','--user','b@example.com','--enable']),{home:'/tmp/example',user:['a@example.com','b@example.com'],enable:true});
 assert.throws(()=>argumentsFor(['--model','anything']),/Unknown/);
 validateServeStatus({},'https://example.ts.net',4173);
 validateServeStatus({TCP:{443:{HTTPS:true}},Web:{'example.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:4173'}}}}},'https://example.ts.net',4173);
 assert.throws(()=>validateServeStatus({Web:{'example.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:9999'}}}}},'https://example.ts.net',4173),/another service/);
 assert.throws(()=>validateServeStatus({AllowFunnel:{'example.ts.net:443':true}},'https://example.ts.net',4173),/Funnel/);
});

test('update ownership follows a configured state directory',async t=>{
 const f=await fixture(t);f.raw.stateDir='custom-state';await f.load();
 await mkdir(path.join(f.root,'custom-state'));await writeFile(path.join(f.root,'custom-state/host.lock'),JSON.stringify({pid:process.pid}));
 await assert.rejects(requireStopped(f.root),/host is running/);
});

test('a failed Serve setup preserves deployment and can be retried',async t=>{
 const f=await fixture(t),bin=path.join(f.root,'tailscale-fixture'),marker=path.join(f.root,'first-serve-attempt');
 await writeFile(bin,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='status'){console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'example.ts.net.',UserID:1},User:{1:{LoginName:'a@example.com'}}}));}else if(args[1]==='status'){console.log('{}');}else if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'retained');process.exitCode=1;}\n`,{mode:0o700});
 const file=path.join(f.root,'deployment.json'),before=await readFile(file,'utf8'),options={'tailscale-bin':bin,enable:true};
 await assert.rejects(tailscale(f.root,options),/failed/);assert.equal(await readFile(file,'utf8'),before);
 await tailscale(f.root,options);const after=JSON.parse(await readFile(file,'utf8'));assert.equal(after.origin,'https://example.ts.net');assert.deepEqual(after.access.users,['a@example.com']);
});

test('portable readiness only accepts known optional optimizer diagnostics on the verified app build',async()=>{
 const {gatewayTransportReady}=await import('../../../source/apps/native-codex-web/src/official-readiness.mjs');
 const v={ok:false,gateway:{kind:'official'},officialIpc:{ready:true,listeners:['codex_desktop:connect-app-host']},officialBundle:{version:'26.928.20755',build:'12246'},checks:Object.fromEntries(['officialBundle','officialIpc','officialAppServer','officialElectronModule','officialNotification','officialTray'].map(k=>[k,true])),compatibility:{status:'degraded',unavailableCount:0,abnormalCount:1,abnormalPoints:[{id:'static.cache.main.native-pet.prewarm',issues:[{type:'unsupported',reason:'Cached locator did not resolve'}]}]}};
 assert.equal(gatewayTransportReady(v),false);assert.equal(gatewayTransportReady(v,{portable:true}),true);
 const cold=structuredClone(v);cold.compatibility.abnormalPoints[0].issues[0].reason='Expected 1 candidates but found 0';
 assert.equal(gatewayTransportReady(cold),false);assert.equal(gatewayTransportReady(cold,{portable:true}),true);
 cold.compatibility.abnormalPoints[0].issues[0].reason='Expected 1 candidates but found 2';assert.equal(gatewayTransportReady(cold,{portable:true}),false);
 cold.compatibility.abnormalPoints[0].issues[0]={type:'ambiguous',reason:'Expected 1 candidates but found 0'};assert.equal(gatewayTransportReady(cold,{portable:true}),false);
 const bad=structuredClone(v);bad.checks.officialAppServer=false;assert.equal(gatewayTransportReady(bad,{portable:true}),false);
 bad.checks.officialAppServer=true;bad.compatibility.abnormalPoints[0].id='static.required.rpc';assert.equal(gatewayTransportReady(bad,{portable:true}),false);
 bad.compatibility=v.compatibility;bad.officialBundle.version='future';assert.equal(gatewayTransportReady(bad,{portable:true}),false);
});

test('CVM preparation produces private credentials and a loopback tunnel without contacting the cloud',async t=>{
 const f=await fixture(t),{cvm,cvmCaddyfile}=await import('../../../scripts/portable/cvm.mjs');
 const hash='$2a$14$Zkx19XLiW6VYouLHR5NmfOFU0z2GTNmpkT/5qqR7hx4IjWJPDhjvG',hashFile=path.join(f.root,'password.hash');await writeFile(hashFile,hash,{mode:0o600});
 assert.throws(()=>cvmCaddyfile({origin:'http://codex.example.com',user:'owner',passwordHash:hash,proxyKey:'a'.repeat(64),remotePort:24173}),/HTTPS/);
 const value=await cvm(f.root,{url:'https://codex.example.com',user:['owner'],'ssh-host':'owner@my-cvm','password-hash-file':hashFile});
 assert.equal(value.cloudModified,false);assert.equal((await readFile(value.backup,'utf8')).includes('"mode":"loopback"'),true);
 const c=readDeploymentConfig(path.join(f.root,'deployment.json'));assert.equal(c.access.mode,'cvm-proxy');
 const {stat}=await import('node:fs/promises');assert.equal((await stat(c.access.proxyKeyFile)).mode&0o777,0o600);
 const caddy=await readFile(path.join(value.bundle,'Caddyfile'),'utf8');assert(caddy.includes('basic_auth'));assert(caddy.includes('header_up -Authorization'));
 const tunnel=await readFile(value.tunnel,'utf8');assert(tunnel.includes('127.0.0.1:24173:127.0.0.1:4173'));assert(!tunnel.includes('StrictHostKeyChecking=no'));
 const before=await readFile(c.file,'utf8');await assert.rejects(cvm(f.root,{url:c.origin,user:['owner'],'ssh-host':'-oProxyCommand=bad','password-hash-file':hashFile}),/SSH/);assert.equal(await readFile(c.file,'utf8'),before);
});

test('CVM entry requires proxy proof, scopes capability identity, strips credentials and proxies WebSockets',async t=>{
 const f=await fixture(t),key='a'.repeat(64),keyFile=path.join(f.root,'proxy.key');await writeFile(keyFile,key,{mode:0o600});
 const front=http.createServer((req,res)=>res.end(JSON.stringify(req.headers)));front.on('upgrade',(_req,socket)=>{socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');});
 await new Promise(resolve=>front.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>front.close(resolve)));
 const config={...f.config,origin:'https://codex.example.com',access:{mode:'cvm-proxy',users:['owner','other'],proxyKeyFile:keyFile},frontPort:front.address().port};
 const entry=await createPortableEntry(config);await new Promise(resolve=>entry.server.listen(0,'127.0.0.1',resolve));t.after(()=>entry.close());
 const request=(url,options={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:entry.server.address().port,path:url,method:options.method||'GET',headers:{host:'codex.example.com',origin:config.origin,'x-better-codex-proxy':key,'x-better-codex-user':'owner',...options.headers}},res=>{let body='';res.on('data',data=>body+=data);res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(body)}));});req.on('error',reject);req.end(options.body);});
 assert.equal((await request('/',{headers:{'x-better-codex-proxy':'wrong'}})).status,401);
 assert.equal((await request('/',{headers:{'x-better-codex-user':'outsider'}})).status,401);
 assert.equal((await request('/',{headers:{origin:'https://attacker.example'}})).status,403);
 const context=await request('/api/context',{method:'POST',body:JSON.stringify({workspace:'ai'})});assert.equal(context.status,200);
 const auth={'x-better-codex-capability':context.value.token,authorization:'Basic fixture'};
 assert.equal((await request('/api/w/ai/plugins',{headers:auth})).status,200);
 assert.equal((await request('/api/w/ai/plugins',{headers:{...auth,'x-better-codex-user':'other'}})).status,401);
 assert.equal((await request('/api/w/zyy/plugins',{headers:auth})).status,401);
 const proxy=await request('/w/ai/api/request',{headers:auth});assert.equal(proxy.value.authorization,undefined);assert.equal(proxy.value['x-better-codex-proxy'],undefined);assert.equal(proxy.value['x-better-codex-capability'],undefined);
 const status=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:entry.server.address().port,path:'/w/ai/ws',headers:{host:'codex.example.com',origin:config.origin,'x-better-codex-proxy':key,'x-better-codex-user':'owner',connection:'Upgrade',upgrade:'websocket'}},res=>{res.resume();resolve(res.statusCode)});req.on('upgrade',(res,socket)=>{socket.destroy();resolve(res.statusCode)});req.on('error',reject);req.end();});assert.equal(status,101);
});
