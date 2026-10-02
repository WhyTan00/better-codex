import os from 'node:os';import http from 'node:http';import https from 'node:https';import net from 'node:net';import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';import assert from 'node:assert/strict';
import {cvmCaddyfile} from './portable/cvm.mjs';
import {createPortableEntry} from '../source/apps/native-codex-web/src/portable-entry.mjs';
const E=await fs.mkdtemp(path.join(os.tmpdir(),'better-codex-cvm-')),binary=process.env.CADDY_BIN||'caddy',report={realCaddy:true,https:true,cloudModified:false,checks:[]},check=(name,fn)=>{fn();report.checks.push(name)};
let front,entry,caddy;
try{
 const key='c'.repeat(64),password='cvm-integration-fixture-only',keyFile=path.join(E,'fixture-proxy.key');await fs.writeFile(keyFile,key,{mode:0o600});
 const hash=execFileSync(binary,['hash-password'],{input:password+'\n',encoding:'utf8'}).trim();
 front=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({headers:req.headers,path:req.url}));});
 front.on('upgrade',(_req,socket)=>{socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nstream-from-native-fixture');});
 await new Promise(r=>front.listen(0,'127.0.0.1',r));
 const config={origin:'https://codex.example.com',access:{mode:'cvm-proxy',users:['owner'],proxyKeyFile:keyFile},frontPort:front.address().port,relayPort:front.address().port,workspaces:{ai:{id:'ai',label:'Fixture'}}};
 const plugins={workspace(id){if(id!=='ai')throw Object.assign(Error('missing'),{code:403});return config.workspaces.ai},list(){return [{id:'fixture'}]},async close(){}};
 entry=await createPortableEntry(config,{plugins});await new Promise(r=>entry.server.listen(0,'127.0.0.1',r));
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=codex.example.com','-addext','subjectAltName=DNS:codex.example.com','-keyout',path.join(E,'tls.key'),'-out',path.join(E,'tls.crt')],{stdio:'ignore'});
 await fs.chmod(path.join(E,'tls.key'),0o600);
 const production=cvmCaddyfile({origin:config.origin,user:'owner',passwordHash:hash,proxyKey:key,remotePort:entry.server.address().port});
 await fs.writeFile(path.join(E,'production-shape.Caddyfile'),production,{mode:0o600});
 execFileSync(binary,['adapt','--config',path.join(E,'production-shape.Caddyfile'),'--adapter','caddyfile','--validate'],{stdio:['ignore','ignore','pipe']});
 const candidate='{\n admin off\n auto_https off\n}\n'+production.replace('codex.example.com {',`https://codex.example.com:${port} {\n bind 127.0.0.1\n tls ${path.join(E,'tls.crt')} ${path.join(E,'tls.key')}`);
 await fs.writeFile(path.join(E,'Caddyfile'),candidate,{mode:0o600});
 const logs=await fs.open(path.join(E,'caddy.log'),'w',0o600);caddy=spawn(binary,['run','--config',path.join(E,'Caddyfile'),'--adapter','caddyfile'],{stdio:['ignore',logs.fd,logs.fd],env:{...process.env,XDG_DATA_HOME:path.join(E,'caddy-data'),XDG_CONFIG_HOME:path.join(E,'caddy-config')}});await logs.close();
 const ca=await fs.readFile(path.join(E,'tls.crt')),auth='Basic '+Buffer.from('owner:'+password).toString('base64');
 const request=(url,options={})=>new Promise((resolve,reject)=>{const req=https.request({hostname:'127.0.0.1',servername:'codex.example.com',port,ca,path:url,method:options.method||'GET',headers:{host:'codex.example.com:'+port,origin:config.origin,authorization:auth,...options.headers}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,text,headers:res.headers}));});req.on('error',reject);req.end(options.body);});
 for(let i=0;i<50;i++){try{await request('/');break}catch(error){if(i===49)throw error;await new Promise(r=>setTimeout(r,100));}}
 const anon=await request('/',{headers:{authorization:''}});check('anonymous HTTPS denied',()=>assert.equal(anon.status,401));
 const forged=await request('/',{headers:{authorization:'','x-better-codex-proxy':key,'x-better-codex-user':'owner'}});check('forged incoming identity denied',()=>assert.equal(forged.status,401));
 const root=await request('/');check('authenticated HTTPS front response',()=>assert.equal(root.status,200));const headers=JSON.parse(root.text).headers;check('basic credentials and proxy proof stripped from Native',()=>{assert.equal(headers.authorization,undefined);assert.equal(headers['x-better-codex-proxy'],undefined)});
 const context=await request('/api/context',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspace:'ai'})});check('workspace context after Basic login',()=>assert.equal(context.status,200));
 const token=JSON.parse(context.text).token,plugin=await request('/api/w/ai/plugins',{headers:{'x-better-codex-capability':token}});check('plugin capability coexists with Basic authentication',()=>{assert.equal(plugin.status,200);assert.equal(JSON.parse(plugin.text).data[0].id,'fixture')});
 const cross=await request('/api/context',{method:'POST',headers:{origin:'https://evil.example'},body:JSON.stringify({workspace:'ai'})});check('cross-origin write denied',()=>assert.equal(cross.status,403));
 const sync=await request('/sync/v1/w/ai/snapshot');check('sync read traverses HTTPS entry',()=>assert.equal(sync.status,200));
 const stream=await new Promise((resolve,reject)=>{const req=https.request({hostname:'127.0.0.1',servername:'codex.example.com',port,ca,path:'/w/ai/ws',headers:{host:'codex.example.com:'+port,origin:config.origin,authorization:auth,connection:'Upgrade',upgrade:'websocket'}},res=>{res.resume();reject(Error('WS rejected '+res.statusCode))});req.on('upgrade',(res,socket,head)=>{let value=head.toString();socket.on('data',b=>value+=b);socket.on('end',()=>{socket.destroy();resolve({status:res.statusCode,value})});socket.on('error',reject)});req.on('error',reject);req.end();});
 check('authenticated TLS WebSocket streams upstream bytes',()=>{assert.equal(stream.status,101);assert.equal(stream.value,'stream-from-native-fixture')});report.result='passed';
}catch(error){report.result='failed';report.error={name:error.name,message:error.message};process.exitCode=1;}finally{
 if(caddy&&caddy.exitCode===null){const done=once(caddy,'exit');caddy.kill('SIGTERM');await done;}if(entry)await entry.close();if(front)await new Promise(r=>front.close(r));report.testServicesStopped=true;
 console.log(JSON.stringify(report));await fs.rm(E,{recursive:true,force:true});
}
