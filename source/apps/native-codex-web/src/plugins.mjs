import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {fail,registeredSite} from './registry.mjs';

// Adapt a host's existing native plugins. The public shell does not recreate
// domain calculations or start another model/runtime.
const legacyWorkbench={name:'native-existing-workbench-adapter',inject:['nativeWorkbench'],apply(ctx,config){
 ctx.effect(()=>ctx.nativeWorkbench.register({id:'video',workspace:'ai',label:'Video workbench',description:'Project media and review status',readOnly:false,async load(){return {kind:'link',label:'Video workbench',description:'Project-owned media and review data',url:new URL('/video-workbench?workspace=ai',registeredSite().url).href};}}));
 const definitions=[['portfolio','Portfolio','Project-owned portfolio summary','/modules/portfolio'],['quant','Research','Research and simulation summary','/modules/quant'],['agenda','Agenda','Project tasks and reminders','/modules/agenda'],['cockpit','Overview','Workspace overview and signals','/cockpit']];
 for(const [id,label,description,route]of definitions)ctx.effect(()=>ctx.nativeWorkbench.register({id,workspace:'ai',label,description,readOnly:true,async load(){const response=await fetch(config.origin+'/api/better-codex-workbench'+route,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw fail(503,label+' is unavailable');return {kind:id,snapshot:await response.json()};}}));
}};

export class Plugins {
 constructor({legacyOrigin='http://127.0.0.1:3081'}={}){this.legacyOrigin=legacyOrigin;this.instances=new Map();this.contexts=[];}
 async start(){const packagePath=process.env.BETTER_CODEX_NATIVE_PACKAGE || '${BETTER_CODEX_HOME}/.better-codex/native-runtime/package.json';const req=createRequire(realpathSync(packagePath));const {Context}=await import(req.resolve('@native-ai/cordis'));
  const ws='ai',ctx=new Context();ctx.provide('nativeWorkbench',{register:entry=>{if(entry.workspace!==ws)throw fail(403,'plugin workspace mismatch');const key=ws+':'+entry.id;this.instances.set(key,entry);return()=>this.instances.delete(key);}});ctx.plugin(legacyWorkbench,{origin:this.legacyOrigin});this.contexts.push(ctx);await new Promise(resolve=>setImmediate(resolve));
 }
 list(ws){return[...this.instances.values()].filter(p=>p.workspace===ws.id&&ws.plugins.includes(p.id)).map(({load,...p})=>p);}
 async load(ws,id){if(!ws.plugins.includes(id))throw fail(404,'plugin is not enabled in this workspace');const p=this.instances.get(ws.id+':'+id);if(!p)throw fail(503,'plugin is not ready');return p.load();}
 async close(){await Promise.all(this.contexts.map(c=>c.fiber.dispose()));}
}
