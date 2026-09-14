import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {workspace} from './registry.mjs';

// One writer per scope; replace the complete snapshot atomically. An unreadable
// or corrupt snapshot is an error, never an excuse to overwrite user state.
export class OfficialState {
 constructor(root){this.root=root;this.values=new Map();this.loading=new Map();this.writes=new Map();}
 async read(scope){
  workspace(scope);if(this.values.has(scope))return this.values.get(scope);
  if(!this.loading.has(scope))this.loading.set(scope,(async()=>{
   let value={atoms:{},globals:{},settings:{}};
   try{value={...value,...JSON.parse(await readFile(path.join(this.root,scope+'.json'),'utf8'))};}catch(e){if(e.code!=='ENOENT')throw e;}
   value.settings={localeOverride:'zh-CN',...value.settings};this.values.set(scope,value);return value;
  })().finally(()=>this.loading.delete(scope)));
  return this.loading.get(scope);
 }
 async persist(scope){
  const previous=this.writes.get(scope)||Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{
   const file=path.join(this.root,scope+'.json'),tmp=file+'.'+randomUUID()+'.tmp';
   await writeFile(tmp,JSON.stringify(await this.read(scope)),{mode:0o600,flag:'wx'});await rename(tmp,file);
  });this.writes.set(scope,next);try{await next;}finally{if(this.writes.get(scope)===next)this.writes.delete(scope);}
 }
 async flush(){await Promise.all(this.writes.values());}
}
