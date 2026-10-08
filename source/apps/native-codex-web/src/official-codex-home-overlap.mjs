// Start the same SDK host-path query alongside a prepared head.
// It remains a one-attempt read, not a persisted execution authority.
const edits=[
  {
    "component": "sdk",
    "from": "function IMs(e,t){return{",
    "to": "const dshHomeQueryAttempts=new WeakMap();\nfunction dshHomeQueryIdentity(){try{return globalThis.__DSH_EXECUTION_CONFIG_IDENTITY__?.()??globalThis.window?.__DSH_EXECUTION_CONFIG_IDENTITY__?.()}catch{return null}}\nfunction dshHomeQueryCurrent(entry){const now=dshHomeQueryIdentity();return !!entry.identity&&!!now&&!entry.manager.disposed&&entry.manager.getHostId()===`local`&&['scope','frontEpoch','nativeGeneration','transportGeneration','connectionId','resumeId'].every(key=>now[key]===entry.identity[key])}\nfunction dshWarmCodexHomeQuery(scope,manager,request){\n try{const message=request?.message,id=request?.conversationId,conversation=manager.getConversation?.(id),identity=dshHomeQueryIdentity();\n if(manager.getHostId()!==`local`||manager.disposed||!conversation||!identity||!message||typeof message!==`object`||typeof message.id!==`string`||request.editPosition!=null||['queue','queue-only'].includes(request.queueModeOverride)||request.options?.executionHostId&&request.options.executionHostId!==`local`||conversation.threadRuntimeStatus?.type===`active`||typeof scope.query?.getOrFetch!==`function`)return null;\n if(dshHomeQueryAttempts.has(message))return null;\n const entry={scope,manager,message,messageId:message.id,threadId:id,identity:structuredClone(identity),work:null};\n // Start the exact query Hls normally reads; this is read-only host metadata,\n // not an execution decision or a new durable cache/authority.\n entry.work=Promise.resolve().then(()=>globalThis.__DSH_READ_CODEX_HOME__?globalThis.__DSH_READ_CODEX_HOME__(`local`,()=>scope.query.getOrFetch(ED,{hostId:`local`})):scope.query.getOrFetch(ED,{hostId:`local`})).then(value=>({value}),error=>({error}));\n dshHomeQueryAttempts.set(message,entry);\n return()=>{if(dshHomeQueryAttempts.get(message)===entry)dshHomeQueryAttempts.delete(message)};\n }catch{return null}\n}\nfunction dshTakeCodexHomeQuery(scope,manager,message,threadId,hostId,messageId){\n try{const entry=message&&dshHomeQueryAttempts.get(message),head=manager.dshSubmissionHead?.(threadId);\n if(!entry||entry.scope!==scope||entry.manager!==manager||entry.message!==message||entry.threadId!==threadId||entry.messageId!==messageId||hostId!==`local`||!dshHomeQueryCurrent(entry)||head?.threadId!==threadId||!head.isCurrent())return null;\n dshHomeQueryAttempts.delete(message);\n return async()=>{const result=await entry.work;if(!dshHomeQueryCurrent(entry)||!head.isCurrent())throw Error(`发送准备连接已变化，消息尚未发送；草稿已保留`);if(`error`in result)throw result.error;return result.value};\n }catch{return null}\n}\nfunction IMs(e,t){const dshPreparation={"
  },
  {
    "component": "sdk",
    "from": "getQueueMode:async e=>(t.getConversation(e.conversationId),await sO(Bv.followUpQueueMode)===`queue`?`queue`:`send-now`)}}var LMs",
    "to": "getQueueMode:async e=>(t.getConversation(e.conversationId),await sO(Bv.followUpQueueMode)===`queue`?`queue`:`send-now`)};Object.defineProperty(dshPreparation.prepare,`dshWarmCodexHomeQuery`,{value:request=>dshWarmCodexHomeQuery(e,t,request)});return dshPreparation}var LMs"
  },
  {
    "component": "sdk",
    "from": "x||await Vls(e,{conversationId:a,cwd:o,hostId:r});",
    "to": "x||await Vls(e,{conversationId:a,cwd:o,hostId:r,dshCodexHome:dshTakeCodexHomeQuery(e,n,p,a,r,m??p?.id)});"
  },
  {
    "component": "sdk",
    "from": "async function Vls(e,{conversationId:t,cwd:n,hostId:r}){let i;try{i=await Hls(e,{conversationId:t,cwd:n,hostId:r})}",
    "to": "async function Vls(e,{conversationId:t,cwd:n,hostId:r,dshCodexHome}){let i;try{i=await Hls(e,{conversationId:t,cwd:n,hostId:r,dshCodexHome})}"
  },
  {
    "component": "sdk",
    "from": "async function Hls(e,{conversationId:t,cwd:n,hostId:r}){let i=await(globalThis.__DSH_READ_CODEX_HOME__?",
    "to": "async function Hls(e,{conversationId:t,cwd:n,hostId:r,dshCodexHome}){let i=await(dshCodexHome?dshCodexHome():globalThis.__DSH_READ_CODEX_HOME__?"
  }
];
export function patchCodexHomeOverlap(source){for(const {from,to}of edits){if(source.includes(to)){if(source.split(to).length!==2)throw Error('Duplicate host query anchor');continue;}if(source.split(from).length!==2)throw Error('Pinned host query ABI changed');source=source.replace(from,to);}return source;}
