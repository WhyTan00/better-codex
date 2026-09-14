import {mkdir,open,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {SharedNative} from './shared-native.mjs';
import {Journal} from './journal.mjs';import {Hub} from './hub.mjs';import {Attachments} from './attachments.mjs';import {Plugins} from './plugins.mjs';import{createServer}from'./server.mjs';
const state=process.env.NATIVE_WEB_STATE||'${BETTER_CODEX_HOME}/.better-codex/native-web';
await mkdir(state,{recursive:true,mode:0o700});const lock=path.join(state,'owner.lock');
try{const old=Number(await readFile(lock,'utf8'));try{process.kill(old,0);throw new Error('已有权威宿主持有运行目录');}catch(e){if(e.code!=='ESRCH')throw e;await unlink(lock);}}catch(e){if(e.code!=='ENOENT')throw e;}
const fd=await open(lock,'wx',0o600);await fd.writeFile(String(process.pid));await fd.close();
const journal=new Journal(state),hub=new Hub({journal,nativeFactory:ws=>new SharedNative({name:'betterCodex_legacy_ui_'+ws.id})}),plugins=new Plugins({legacyOrigin:process.env.NATIVE_WEB_LEGACY_ORIGIN||'http://127.0.0.1:3081'});await plugins.start();
const port=Number(process.env.NATIVE_WEB_PORT||3091);const server=createServer({hub,journal,plugins,attachments:new Attachments(path.join(state,'attachments')),port});server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({service:'native-codex-web',port,pid:process.pid,generation:hub.generation})));
let closing=false;async function close(){if(closing)return;closing=true;server.close();await hub.close();await plugins.close();journal.close();await unlink(lock);setTimeout(()=>process.exit(0),1500).unref();}process.on('SIGINT',close);process.on('SIGTERM',close);
