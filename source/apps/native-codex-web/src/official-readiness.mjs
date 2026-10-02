import http from 'node:http';

// Same upper bound as the existing Caddy active-health request, not a command
// timeout. This is invoked only by a health request; there is no polling loop.
const HEALTH_BUDGET_MS=2000,MAX_STATUS_BYTES=256*1024;
const nativeReady=native=>native.state==='ready'&&!native.closed&&native.socket?.readyState===1;
// These four upstream optimizations are not providers of the portable front's
// RPC, notification or worktree services. Accept only the observed app build
// and exact unsupported-locator diagnostics; retain all other health gates.
const portableOptionalPoints=new Set(['static.cache.main.macos-push-registration','static.cache.main.native-pet.prewarm','static.cache.main.native-pet.restore','static.cache.main.worktree-shell-environment']);
// Upstream uses the first message while discovering a new bundle and the
// second when restoring the same unsupported locator from its local cache.
const portableOptionalReasons=new Set(['Expected 1 candidates but found 0','Cached locator did not resolve']);
export function gatewayTransportReady(value,{portable=false}={}){
 const ipc=value?.officialIpc;
 if(value?.gateway?.kind!=='official'||ipc?.ready!==true||!Array.isArray(ipc.listeners)||!ipc.listeners.includes('codex_desktop:connect-app-host'))return false;
 if(value.ok===true)return true;
 if(!portable||value.officialBundle?.version!=='26.928.20755'||String(value.officialBundle?.build)!=='12246')return false;
 if(!['officialBundle','officialIpc','officialAppServer','officialElectronModule','officialNotification','officialTray'].every(key=>value.checks?.[key]===true))return false;
 const c=value.compatibility;
 return c?.unavailableCount===0&&c.status==='degraded'&&Array.isArray(c.abnormalPoints)&&c.abnormalPoints.length>0&&c.abnormalPoints.length===c.abnormalCount&&c.abnormalPoints.every(p=>portableOptionalPoints.has(p.id)&&p.issues?.length>0&&p.issues.every(i=>i.type==='unsupported'&&portableOptionalReasons.has(i.reason)));
}

export function officialReady({native,upstream,signal,portable=false}){
 if(!nativeReady(native)||signal?.aborted)return Promise.resolve(false);
 const socket=native.socket,generation=native.generation;
 return new Promise(resolve=>{
  let request,response,settled=false,size=0;const chunks=[];
  const finish=ready=>{
   if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
   // Covers timeout, downstream cancellation, truncated/error responses, and
   // a non-ready result without leaving a remote body or socket outstanding.
   response?.destroy();request?.destroy();
   resolve(ready&&nativeReady(native)&&native.socket===socket&&native.generation===generation);
  };
  const cancel=()=>finish(false),timer=setTimeout(cancel,HEALTH_BUDGET_MS);timer.unref?.();
  signal?.addEventListener('abort',cancel,{once:true});
  try{
   request=http.get(new URL('/api/health',upstream),{headers:{accept:'application/json'}},res=>{
    response=res;
    res.on('error',cancel);res.on('aborted',cancel);
    res.on('close',()=>{if(!res.complete)cancel();});
    if(res.statusCode!==200){finish(false);return;}
    res.on('data',chunk=>{size+=chunk.length;if(size>MAX_STATUS_BYTES){finish(false);return;}chunks.push(chunk);});
    res.on('end',()=>{
     try{
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      finish(res.complete&&gatewayTransportReady(value,{portable}));
     }catch{finish(false);}
    });
   });
   request.on('error',cancel);
  }catch{finish(false);}
 });
}
