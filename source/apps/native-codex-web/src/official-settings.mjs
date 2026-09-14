import {fail} from './registry.mjs';

// The renderer's follow-up preference is a UI setting, not a model/runtime
// policy. Both AppHost and the legacy fetch path use this one scoped store.
export function createOfficialSettings({RpcTarget,state,persist}) {
 const subscribers=new Map();
 const values=async scope=>({followUpQueueMode:'steer',...(await state(scope)).settings});
 const read=async(scope,key)=>{const value=(await values(scope))[key];return {effective:value,configured:(await state(scope)).settings[key]};};
 async function write(scope,key,value){
  if(typeof key!=='string'||['__proto__','prototype','constructor'].includes(key))throw fail(400,'无效设置');
  if(key==='followUpQueueMode'){
   if(!['queue','steer'].includes(value))throw fail(400,'请选择引导或排队');
  }else if(!/^(theme|locale|font|sidebar|composer)/i.test(key))throw fail(403,'宿主设置不在本轮修改范围');
  const s=await state(scope),old=s.settings[key];s.settings[key]=value;
  try{await persist(scope);}catch(error){if(old===undefined)delete s.settings[key];else s.settings[key]=old;throw error;}
  const next=await read(scope,key);
  for(const callback of subscribers.get(scope+':'+key)||[])Promise.resolve().then(()=>callback(next)).catch(()=>{});
 }
 class Subscription extends RpcTarget {
  constructor(dispose){super();this.release=dispose;}
  dispose(){this.release();}
  unsubscribe(){this.release();}
  [Symbol.dispose](){this.release();}
 }
 class Settings extends RpcTarget {
  constructor(scope){super();this.scope=scope;this.releases=new Set();}
  async readAll(){return {values:await values(this.scope),configuredValues:{...(await state(this.scope)).settings}};}
  read(key){return read(this.scope,key);}
  write(key,value){return write(this.scope,key,value);}
  async subscribe(key,callback){
   if(typeof key!=='string'||typeof callback!=='function')throw fail(400,'无效设置订阅');
   const id=this.scope+':'+key,set=subscribers.get(id)||new Set();subscribers.set(id,set);set.add(callback);
   const release=()=>{set.delete(callback);if(!set.size)subscribers.delete(id);this.releases.delete(release);};this.releases.add(release);
   try{await callback(await read(this.scope,key));}catch(error){release();throw error;}
   return new Subscription(release);
  }
  close(){for(const release of this.releases)release();}
 }
 return {forScope:scope=>new Settings(scope),read,write,values};
}
