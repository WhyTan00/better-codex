// Metadata only, bounded to control requests. No URLs, headers, tokens or bodies retained.
import {performance} from 'node:perf_hooks';
import {ConnectionDiagnostics} from './connection-diagnostics.mjs';
// Keep low-volume control evidence separate from noisy RPC/status rotations.
// Same bounded async writer, at most 12 MiB including the two archives.
export function createControlPathLog(file){return new ConnectionDiagnostics({file,maxBytes:4*1024*1024,maxArchives:2});}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createControlPathTiming({component,emit,now=()=>performance.now(),wall=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 let timer=null,activeUntil=0,last=0,lastLogged=-Infinity,closed=false;
 const safe=value=>{try{emit(value);}catch{}};
 function tick(){timer=null;if(closed)return;const t=now(),lag=Math.max(0,Math.round(t-last-1000));last=t;
  if(lag>=250&&t-lastLogged>=10000){lastLogged=t;safe({component,stage:'failed',reason:'event_loop_delay',timerLagMs:lag});}
  if(t<activeUntil){timer=setTimer(tick,1000);timer?.unref?.();}
 }
 return {
  observe(req,res){
   if(closed||req.method!=='GET'||!/^\/dsh-scope-session\?/.test(req.url||''))return;
   const scope=new URL(req.url,'http://localhost').searchParams.get('workspace');
   const traceId=req.headers['x-dsh-diagnostic-trace'];if(scope!=='ai'||!uuid.test(traceId||''))return;
   const started=now(),receivedAtMs=wall();activeUntil=started+30000;
   if(!timer){last=started;timer=setTimer(tick,1000);timer?.unref?.();}
   const context={component,scope,traceId,method:'GET',routeClass:'scope_session',reason:'control_timing',receivedAtMs};
   for(const [header,key]of [['x-dsh-edge-at','edgeReceivedAtMs'],['x-dsh-edge-forward-at','edgeForwardAtMs'],['x-dsh-proxy-at','proxyReceivedAtMs']]){
    const raw=req.headers[header];if(typeof raw==='string'&&/^\d{13}$/.test(raw)){const n=Number(raw);if(Math.abs(n-receivedAtMs)<86400000)context[key]=n;}
   }
   // Overwrite caller-provided proxy timestamp. Diagnostic only; never auth input.
   if(component==='proxy'){req.headers['x-dsh-proxy-at']=String(receivedAtMs);context.proxyReceivedAtMs=receivedAtMs;}
   let done=false;const finish=()=>{if(done)return;done=true;res.off('finish',finish);res.off('close',finish);
    const durationMs=Math.max(0,Math.round(now()-started)),failed=!res.writableFinished||res.statusCode>=400;
    if(failed||durationMs>=1000||(parseInt(traceId.slice(-2),16)&15)===0)safe({...context,stage:failed?'failed':'committed',statusCode:res.statusCode,durationMs});
   };res.once('finish',finish);res.once('close',finish);
   // Received is needed even when the response never completes; one bounded record per control call.
   safe({...context,stage:'received'});
  },
  close(){closed=true;if(timer)clearTimer(timer);timer=null;}
 };
}
