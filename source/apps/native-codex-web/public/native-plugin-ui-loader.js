// Independently published plugin UI; mounted controllers retain their implementation.
(()=>{
 const scope=window.__DSH_SCOPE__;if(scope?.id!=='ai')return;
 const ids=new Set(['agenda','portfolio','quant']),loaded=new Map(),pending=new Map(),staged=new Map(),checked=new Map();
 const path=(id,version)=>'/dsh-plugin-ui/ai/'+id+'/'+version+'.js';
 function valid(value,id){return value?.schemaVersion===1&&value.workspace==='ai'&&value.id===id&&value.hostApiVersion===1&&/^[a-f0-9]{64}$/.test(value.sha256||'')&&value.url===path(id,value.sha256)&&Number.isSafeInteger(value.bytes)&&value.bytes>0&&value.bytes<=2*1024*1024;}
 const key=id=>'dsh-plugin-ui-manifest:ai:'+id;const sri=hex=>'sha256-'+btoa(String.fromCharCode(...hex.match(/../g).map(v=>parseInt(v,16))));
 for(const id of ids)try{const value=JSON.parse(window.localStorage?.getItem(key(id))||'null');if(valid(value,id))staged.set(id,value);}catch{}
 async function ensure(id,{isCurrent=()=>true}={}){
  if(!ids.has(id)||!isCurrent())return false;if(pending.has(id))return pending.get(id);
  const operation=(async()=>{
   let manifest=staged.get(id),controller=new AbortController(),timer;
   if(!manifest||Date.now()-(checked.get(id)||0)>30000){timer=setTimeout(()=>controller.abort(),5000);
    try{const response=await window.fetch('/dsh-plugin-ui/ai/'+id+'/manifest.json',{cache:'no-store',redirect:'manual',signal:controller.signal});if(response.ok&&!response.redirected){const value=await response.json();if(valid(value,id)){manifest=value;staged.set(id,value);checked.set(id,Date.now());try{window.localStorage?.setItem(key(id),JSON.stringify(value));}catch{}}}}
    catch{}finally{clearTimeout(timer);}
   }
   if(!valid(manifest,id)||!isCurrent()||window.__DSH_NATIVE_WORKBENCH__?.current)return false;if(loaded.get(id)===manifest.sha256)return true;
   return new Promise(resolve=>{const node=document.createElement('script');node.src=manifest.url;node.integrity=sri(manifest.sha256);node.async=true;let finished=false;
    const finish=ok=>{if(finished)return;finished=true;clearTimeout(timeout);node.onload=node.onerror=null;if(!ok)node.remove();else loaded.set(id,manifest.sha256);resolve(ok);};
    const timeout=setTimeout(()=>finish(false),5000);node.onload=()=>finish(true);node.onerror=()=>finish(false);document.head.append(node);
   });
  })().finally(()=>{if(pending.get(id)===operation)pending.delete(id);});pending.set(id,operation);return operation;
 }
 window.__DSH_PLUGIN_UI__={hostApiVersion:1,ensure,valid,getVersion:id=>loaded.get(id)||null};
 const prepare=()=>{if(document.visibilityState!=='visible'||navigator.onLine===false)return;for(const id of ids)if(staged.get(id)?.sha256!==loaded.get(id)||Date.now()-(checked.get(id)||0)>30000)ensure(id).catch(()=>{});};
 addEventListener('dsh:session-ready',prepare);addEventListener('dsh:plugin-definitions',prepare);addEventListener('online',prepare);addEventListener('dsh:plugin-idle',prepare);document.addEventListener?.('visibilitychange',prepare);
})();
