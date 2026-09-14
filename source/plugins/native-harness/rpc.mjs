import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// Exactly one child for the lifetime of this BETTER_CODEX plugin, independent of browsers.
export class NativeRpc extends EventEmitter {
  constructor({bin='/Applications/${BETTER_CODEX_APP_BIN}/Contents/Resources/codex', cwd='${BETTER_CODEX_WORKSPACE}', timeout=45000}={}) {
    super(); this.generation=randomUUID(); this.pending=new Map(); this.next=0; this.timeout=timeout; this.alive=true;
    this.child=spawn(bin,['-c','model="provider-default"','-c','model_reasoning_effort="high"','-c','service_tier="default"','app-server','--listen','stdio://'],{cwd,env:{...process.env,HOME:'${BETTER_CODEX_HOME}',CODEX_HOME:'${BETTER_CODEX_HOME}/.codex'},stdio:['pipe','pipe','pipe']});
    // Native owns its authentication. Never read, copy or log credential files.
    this.child.stderr.on('data',()=>{});
    createInterface({input:this.child.stdout}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}
      if(m.method){this.emit('message',m);return} const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);
      m.error?p.reject(Object.assign(new Error(m.error.message||'native_rpc_error'),{code:'native_rpc_error'})):p.resolve(m.result);
    });
    const close=()=>{if(!this.alive)return;this.alive=false;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Object.assign(new Error('宿主已中断；请求结果需核对'),{code:'ack_unknown'}))}this.pending.clear();this.emit('closed')};
    this.child.on('error',close);this.child.on('exit',close);
    this.ready=this.request('initialize',{clientInfo:{name:'betterCodex_native_web',title:'BETTER_CODEX 原生工作台',version:'1.0.0'},capabilities:{experimentalApi:true}}).then(r=>{this.write({method:'initialized',params:{}});return r});
    this.ready.catch(()=>{});
  }
  write(m){if(!this.alive)throw Object.assign(new Error('native_host_unavailable'),{code:'host_unavailable'});this.child.stdin.write(JSON.stringify(m)+'\n')}
  request(method,params={}){const id=++this.next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(new Error('确认超时；请核对状态，勿重复发送'),{code:'ack_unknown'}))},this.timeout);this.pending.set(id,{resolve,reject,timer});try{this.write({id,method,params})}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e)}})}
  respond(id,result){this.write({id,result})}
  close(){this.child.kill('SIGTERM')}
}
