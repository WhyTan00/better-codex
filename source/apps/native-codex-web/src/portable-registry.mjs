import path from 'node:path';
import {realpath} from 'node:fs/promises';

export function createPortableRegistry(config){
 const WORKSPACES=config.workspaces;
 function fail(code,message){return Object.assign(new Error(message),{code});}
 function workspace(id){if(!Object.hasOwn(WORKSPACES,id))throw fail(403,'Workspace is not available');return WORKSPACES[id];}
 async function belongs(cwd,ws){
  if(typeof cwd!=='string'||!path.isAbsolute(cwd))return false;
  try{const actual=await realpath(cwd),root=await realpath(ws.root);return actual===root||actual.startsWith(root+path.sep);}catch{return false;}
 }
 function validateId(id){if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))throw fail(404,'Thread is not available');return id;}
 function publicThread(thread){const {path:_,turns:__,...rest}=thread;return rest;}
 function registeredSite(id){if(!['workbench','better-codex','dsh-workbench'].includes(id))throw fail(503,'Application entry is not configured');return {id,label:'Workbench',url:config.origin,status:'local',accessModel:config.access.mode};}
 return {WORKSPACES,workspace,belongs,fail,validateId,publicThread,registeredSite};
}
