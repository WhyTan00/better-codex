import {spawnIsolatedNative} from './isolated-native-process.mjs';
import {createInterface} from 'node:readline';
import {mkdtemp,appendFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {CODEX} from '../../src/native.mjs';
export const binary=CODEX;
export const fixtureTurnIds=['33333333-3333-4333-a333-333333333333','44444444-4444-4444-a444-444444444444'];
// No credential is copied and no turn/start is ever dispatched. All history
// below is synthetic test data inside a temporary Native home.
export async function nativeLegacyFixture(t,{cwd}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-history-migration-test-'));
 const env={PATH:'/opt/homebrew/bin:/usr/bin:/bin',TMPDIR:os.tmpdir(),CODEX_HOME:dir},calls=[];let live;
 async function open(){
  const isolated=spawnIsolatedNative(binary,['app-server','--listen','stdio://'],{cwd:dir,env,stdio:['pipe','pipe','pipe']}),child=isolated.child;child.stderr.on('data',()=>{});
  const lines=createInterface({input:child.stdout}),waiting=new Map();let seq=0;
  lines.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}const p=waiting.get(m.id);if(!p)return;clearTimeout(p.timer);waiting.delete(m.id);if(m.error)p.reject(Object.assign(Error(m.error.message),{rpcCode:m.error.code,code:400}));else p.resolve(m.result);});
  child.on('exit',()=>{for(const p of waiting.values()){clearTimeout(p.timer);p.reject(Error('isolated Native exited'));}waiting.clear();});
  const rpc=(method,params={})=>{calls.push({method,params:structuredClone(params)});return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{waiting.delete(id);reject(Error(method+' fixture deadline'));},10000);waiting.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});};
  const initialization=await rpc('initialize',{clientInfo:{name:'dsh_history_migration_test',version:'1.0.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  return {rpc,close:isolated.close,initialization};
 }
 t.after(async()=>{await live?.close();await rm(dir,{recursive:true,force:true});});
 live=await open();const started=await live.rpc('thread/start',{cwd:cwd||dir,historyMode:'legacy',ephemeral:false,approvalPolicy:'never',sandbox:'read-only'}),threadId=started.thread.id;
 await live.rpc('thread/inject_items',{threadId,items:[{type:'message',role:'user',content:[{type:'input_text',text:'fixture materialization'}]}]});
 const file=(await live.rpc('thread/read',{threadId,includeTurns:false})).thread.path;await live.close();live=null;
 let at=Date.now()-60000;const records=[];
 for(const [index,turnId]of fixtureTurnIds.entries())for(const [type,payload]of [
  ['event_msg',{type:'task_started',turn_id:turnId,root_turn_id:turnId,started_at:at,model_context_window:258400,collaboration_mode_kind:'default'}],
  ['event_msg',{type:'user_message',message:'fixture edit message '+index,images:[],local_images:[],text_elements:[]}],
  ['response_item',{type:'message',id:'user-'+index,role:'user',content:[{type:'input_text',text:'fixture edit message '+index}]}],
  ['response_item',{type:'message',id:'assistant-'+index,role:'assistant',phase:'final',content:[{type:'output_text',text:'fixture final answer '+index}]}],
  ['event_msg',{type:'agent_message',message:'fixture final answer '+index,phase:'final',memory_citation:null}],
  ['event_msg',{type:'task_complete',turn_id:turnId,last_agent_message:'fixture final answer '+index,started_at:at,completed_at:at+400,duration_ms:400,time_to_first_token_ms:100}],
 ])records.push({timestamp:new Date(at+=100).toISOString(),type,payload});
 await appendFile(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n');live=await open();await live.rpc('thread/resume',{threadId,excludeTurns:true});
 return {dir,threadId,calls,get native(){return live;},close:async()=>{await live?.close();live=null;},reopen:async()=>{live=await open();return live;},modelTurnsStarted:()=>calls.filter(c=>c.method==='turn/start').length};
}
