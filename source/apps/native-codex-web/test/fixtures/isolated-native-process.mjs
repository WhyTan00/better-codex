import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const groupMembers=group=>execFileSync('/bin/ps',['-axo','pid=,pgid=,ppid=,uid=,state=,comm='],{encoding:'utf8'}).split('\n').map(line=>line.trim().split(/\s+/)).filter(parts=>Number(parts[1])===group).map(parts=>({pid:Number(parts[0]),pgid:Number(parts[1]),ppid:Number(parts[2]),uid:Number(parts[3]),state:parts[4],name:parts.slice(5).join(' ').split('/').at(-1)}));
const exited=members=>members.every(member=>member.state==='Z'||member.state?.startsWith('Z'));
export function fixtureGroupHasWriters(group,{stdioClosed=false}={}){
 try{process.kill(-group,0);return true;}catch(error){
  if(error.code==='ESRCH')return false;
  if(error.code==='EPERM'){
   // Darwin returns EPERM for a group containing only already-exited zombies.
   // Check this exact group's kernel metadata; a live/unknown member still fails.
   const members=groupMembers(group);
   if(!members.length)return false;
   if(exited(members))return !stdioClosed;
   error.message+=' fixtureGroup='+group+' members='+JSON.stringify(members);
  }throw error;
 }
}

// A Native fixture may spawn git/plugin helpers. Waiting for only the parent
// "exit" event does not end those writers. Every fixture owns a separate group.
export function spawnIsolatedNative(command,args,options){
 const child=spawn(command,args,{...options,detached:true});
 const group=child.pid;let closed=false,closing;
 const closeEvent=new Promise(resolve=>child.once('close',()=>{closed=true;resolve();}));
 const alive=()=>fixtureGroupHasWriters(group,{stdioClosed:closed});
 const signal=value=>{try{process.kill(-group,value);}catch(error){if(error.code!=='ESRCH'&&!(error.code==='EPERM'&&exited(groupMembers(group))))throw error;}};
 const stop=()=>closing??=(async()=>{
  if(!Number.isSafeInteger(group)||group<=0||group===process.pid)throw Error('Fixture process group was not isolated');
  child.stdin?.end();const started=Date.now();let term=false,kill=false;
  while(alive()){
   const elapsed=Date.now()-started;
   if(!term&&(closed||elapsed>=500)){signal('SIGTERM');term=true;}
   if(!kill&&elapsed>=2000){signal('SIGKILL');kill=true;}
   if(elapsed>=3000)throw Error('Isolated Native writers did not stop; fixture directory retained');
   await delay(10);
  }
  await closeEvent;
  return {pid:group,writersStopped:!alive(),stdioClosed:closed};
 })();
 return {child,close:stop};
}
