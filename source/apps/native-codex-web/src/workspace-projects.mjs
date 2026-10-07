import path from 'node:path';
import {realpathSync} from 'node:fs';

export const PROJECT_STATE_KEYS=new Set(['local-projects','selected-project','project-order','electron-saved-workspace-roots','electron-workspace-root-labels']);

// These values belong to the scoped state store. Reading them must not build
// the renderer bootstrap or wait for unrelated Native/model/account reads.
export function readWorkspaceGlobalState(ws,saved={},key){
 const globals={pending_worktrees:[],...workspaceProjects(ws,saved).globals};
 if(Array.isArray(saved.pending_worktrees))globals.pending_worktrees=saved.pending_worktrees;
 if(key)return PROJECT_STATE_KEYS.has(key)?globals[key]:saved[key]??globals[key];
 return globals;
}

// Bindings describe sidebar folders only. The workspace remains the access
// boundary; neither a saved browser project nor a symlink may expand it.
export function workspaceProjects(ws,saved={}){
 const base=realpathSync(ws.root),inside=value=>{
  if(typeof value!=='string'||!path.isAbsolute(value))return null;
  try{const root=realpathSync(value);return root===base||root.startsWith(base+path.sep)?root:null;}catch{return null;}
 };
 const bindings=ws.projectBindings??[];
 if(!Array.isArray(bindings)||bindings.length>64)throw Error('Invalid workspace project bindings');
 const projects={},seenRoots=new Set(),add=(id,name,roots)=>{
  projects[id]={id,name,rootPaths:roots,createdAt:0,updatedAt:0};roots.forEach(root=>seenRoots.add(root));
 };
 for(const binding of bindings){
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(binding.id)||typeof binding.name!=='string'||!binding.name.trim()||binding.name.length>120||typeof binding.root!=='string'||path.isAbsolute(binding.root))throw Error('Invalid workspace project binding');
  const root=inside(path.resolve(base,binding.root)),id=`dsh-${ws.id}-${binding.id}`;
  if(!root||root===base||seenRoots.has(root)||Object.hasOwn(projects,id))throw Error('Workspace project binding is outside scope or duplicated');
  add(id,binding.name,[root]);
 }
 const fallbackId=`dsh-${ws.id}`;
 add(fallbackId,ws.id.toUpperCase(),[base]);
 // Retain legitimate user-created local folders; configured bindings win over
 // a stale single-project snapshot, including writes from an older client.
 for(const [id,p]of Object.entries(saved['local-projects']??{})){
  if(!/^[a-zA-Z0-9-]{1,128}$/.test(id)||Object.hasOwn(projects,id)||!p||typeof p.name!=='string'||!Array.isArray(p.rootPaths)||!p.rootPaths.length)continue;
  const roots=p.rootPaths.map(inside);
  if(roots.some(root=>!root||seenRoots.has(root)))continue;
  add(id,p.name.slice(0,120),[...new Set(roots)]);
 }
 const order=[...new Set([...(Array.isArray(saved['project-order'])?saved['project-order']:[]),...Object.keys(projects)])].filter(id=>Object.hasOwn(projects,id));
 const selected=saved['selected-project'],selection=selected===null?null:selected?.type==='local'&&Object.hasOwn(projects,selected.projectId)?{type:'local',projectId:selected.projectId}:{type:'local',projectId:fallbackId};
 const roots=[...seenRoots],labels=Object.fromEntries(Object.values(projects).flatMap(p=>p.rootPaths.map(root=>[root,p.name])));
 return {
  globals:{'local-projects':projects,'selected-project':selection,'project-order':order,'electron-saved-workspace-roots':roots,'electron-workspace-root-labels':labels},
  workspaceRoots:roots,
  workspaceRootOptions:{canonicalPathByRoot:Object.fromEntries(roots.map(root=>[root,root])),roots,labels}
 };
}
