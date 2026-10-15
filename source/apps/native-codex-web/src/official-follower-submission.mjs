// Forwarding a prepared request crosses the opaque attempt-context boundary.
// The real stream owner must capture its own fresh head/config; a sender's
// serialized DTO is never an ownership or permission grant.
export function patchFollowerSubmissionHead(source){
 const before='case`thread-follower-start-turn`:{let n=await e.startTurn(t.params.conversationId,t.params.turnStart);return{method:t.method,result:{result:n}}}';
 const after='case`thread-follower-start-turn`:{const p=t.params,operation=p.turnStart,run=async head=>{if(head)dshBindAttemptConfig(operation.context,e,head,operation.request.cwd??e.getConversation(p.conversationId)?.cwd,p.conversationId,operation.request.clientUserMessageId,null);let n=await e.startTurn(p.conversationId,operation);return{method:t.method,result:{result:n}}};return typeof e.dshWithFollowerSubmissionHead===`function`?e.dshWithFollowerSubmissionHead(p.conversationId,operation.request.clientUserMessageId,run):run(null)}';
 if(source.includes(after)){if(source.split(after).length!==2)throw Error('Repeated forwarded submission contract');return source;}
 if(source.split(before).length!==2||source.split('function dshBindAttemptConfig(').length!==2)throw Error('Pinned forwarded submission contract changed');
 return source.replace(before,after);
}

// This is the same live submission's fresh Native requirement DTO, shared
// through the scoped queue client. Keep each original jan() policy consumer.
export function patchSameSubmissionRequirements(source){
 const edits=[
  ['()=>n.sendRequest(`configRequirements/read`,void 0,{priority:`critical`,timeoutMs:Zx})','()=>n.dshReadSubmissionRequirements?n.dshReadSubmissionRequirements(e.threadId,{priority:`critical`,timeoutMs:Zx}):n.sendRequest(`configRequirements/read`,void 0,{priority:`critical`,timeoutMs:Zx})'],
  ['()=>e.sendRequest(`configRequirements/read`,void 0,{priority:`critical`,timeoutMs:Zx})','()=>e.requestClient?.dshReadSubmissionRequirements?e.requestClient.dshReadSubmissionRequirements(t,{priority:`critical`,timeoutMs:Zx}):e.sendRequest(`configRequirements/read`,void 0,{priority:`critical`,timeoutMs:Zx})']
 ];
 if(edits.every(([,after])=>source.split(after).length===2))return source;
 for(const [before]of edits)if(source.split(before).length!==2)throw Error('Pinned same-submission requirements contract changed or incomplete');
 for(const [before,after]of edits)source=source.replace(before,after);
 return source;
}

// A follower's local RequestClient never sends the owner's Native command.
// Observe its actual AppHost call and accepted response at the origin instead.
export function patchFollowerSubmissionDiagnostics(source){
 const before='let i=await this.ipcBridge.request(t,n,{targetClientId:e.ownerClientId,timeoutMs:r?.timeoutMs});if(i.resultType===`error`)throw Error(i.error);return i.result';
 const after='const dshFollower=globalThis.__DSH_CLIENT_LOG__?.beginFollowerSubmission?.(t,n,e.ownerClientId);let i;try{i=await this.ipcBridge.request(t,n,{targetClientId:e.ownerClientId,timeoutMs:r?.timeoutMs});if(i.resultType===`error`)throw Error(i.error);globalThis.__DSH_CLIENT_LOG__?.finishFollowerSubmission?.(dshFollower,i);return i.result}catch(error){globalThis.__DSH_CLIENT_LOG__?.failFollowerSubmission?.(dshFollower,error);throw error}';
 if(source.split(after).length===2)return source;
 if(source.split(before).length!==2)throw Error('Pinned follower origin receipt contract changed');
 return source.replace(before,after);
}
