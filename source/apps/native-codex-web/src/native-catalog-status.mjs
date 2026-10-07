// thread/list is persisted metadata; runtime status must come from a live
// Native head for entries that could still be executing. Never read bodies.
export async function reconcileCatalogStatus(boundary,scope,threads,{previous=()=>null}={}) {
 const result=[...threads];let next=0,loaded=null;
 // Persisted thread/list status does not prove that Native still has a runtime.
 // One metadata-only membership snapshot prevents optional history from
 // repeatedly selecting unloaded threads. A failed snapshot changes nothing.
 if(typeof boundary.loadedIds==='function')try{loaded=await boundary.loadedIds();}catch{}
 const worker=async()=>{while(next<threads.length){const index=next++,thread=threads[index];
  if(loaded&&!loaded.has(thread.id)){result[index]={...thread,status:{type:'notLoaded'},statusVerified:true};continue;}
  if(thread.status?.type!=='active'&&previous(thread.id)?.status?.type!=='active')continue;
  try{const head=(await boundary.call(scope,{method:'thread/read',params:{threadId:thread.id,includeTurns:false}})).thread;
   if(head?.id!==thread.id||!head.status)throw Error('unverified head');result[index]={...thread,status:head.status,statusVerified:true};
  }catch{const prior=previous(thread.id);if(prior?.status?.type==='active')result[index]={...thread,status:prior.status,statusVerified:false};else result[index]={...thread,statusVerified:false};}
 }};
 await Promise.all(Array.from({length:Math.min(3,threads.length)},worker));return result;
}
