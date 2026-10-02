import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {EventEmitter} from 'node:events';
import {fail} from './registry.mjs';
export const CODEX=['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','/Applications/ChatGPT.app/Contents/Resources/codex'].find(existsSync)??'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
export class Native extends EventEmitter {
  constructor(ws,{binary=CODEX}={}) { super(); this.ws=ws;this.binary=binary;this.pending=new Map();this.seq=0;this.state='notStarted'; }
  async start() {
    if(this.ready)return this.ready;
    this.ready=(async()=>{
      this.state='starting';
      // Native CLI owns authentication. Never inspect or copy its credential store.
      this.child=spawn(this.binary,['app-server','--listen','stdio://'],{cwd:this.ws.root,stdio:['pipe','pipe','pipe'],env:{...process.env,PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}});
      this.child.stderr.on('data',()=>{}); // Upstream diagnostics can contain private paths; do not persist raw logs.
      this.child.once('error',()=>this.died('spawnFailed'));
      this.child.once('exit',(code,signal)=>this.died(`exit:${code}:${signal}`));
      this.child.stdin.on('error',()=>this.died('pipeFailed'));
      this.lines=createInterface({input:this.child.stdout});
      this.lines.on('line',line=>{let msg;try{msg=JSON.parse(line);}catch{return this.died('invalidProtocol');}
        if(msg.method){ this.emit(msg.id===undefined?'notification':'request',msg);return; }
        const p=this.pending.get(msg.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(msg.id);
        msg.error?p.reject(fail(502,`原生协议错误: ${msg.error.message}`)):p.resolve(msg.result);
      });
      this.initialization=await this.rpc('initialize',{clientInfo:{name:'dsh_native_codex_web',title:'Private Codex Workbench',version:'1.0.0'},capabilities:{experimentalApi:true}});
      this.send({method:'initialized',params:{}});this.state='ready';return this;
    })(); return this.ready;
  }
  send(msg) { if(!this.child?.stdin?.writable)throw fail(503,'原生宿主已中断');this.child.stdin.write(JSON.stringify(msg)+'\n'); }
  rpc(method,params={}) {
    const id=++this.seq;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(fail(504,'确认未收到，正在核对；不会自动重发'));},30000);
      this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  died(reason) { if(this.state==='interrupted')return;this.state='interrupted'; for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(fail(503,'原生宿主已中断；请核对会话，不会自动重放'));}this.pending.clear();this.emit('interrupted',{reason}); }
  async close() {this.child?.stdin.end(); if(this.child?.exitCode==null) { const child=this.child;const timer=setTimeout(()=>child.kill('SIGTERM'),2000);timer.unref(); } }
}
