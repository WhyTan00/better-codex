// Reuse the current attempt's authenticated scope-global config DTO once.
// It is not a persisted cache or an execution/permission authority.
const edits=[
  {
    "from": "const dshAttemptConfigs=new WeakMap();",
    "to": "const dshAttemptConfigs=new WeakMap();const dshUsedHeadConfigs=new WeakSet();"
  },
  {
    "from": " try{const path=dshCanonicalAttemptCwd(cwd);if(!context||!config||path==null",
    "to": " try{const path=dshCanonicalAttemptCwd(cwd);if(!context||path==null"
  },
  {
    "from": " const token=Object.freeze({});context.dshAttemptConfig=token;dshAttemptConfigs.set(token,{context,manager,requests:manager.requestClient,head,cwd:path,threadId,messageId,includeLayers:!1,config:Object.freeze({personality:config.personality,model_personality:config.model_personality})});}catch{}",
    "to": " let configRead=null,headSnapshot=null;\n if(config==null){\n  const snapshot=head.configReadSnapshot,projection=snapshot?.reply?.configProjection;\n  if(!snapshot||dshUsedHeadConfigs.has(snapshot)||typeof snapshot.isCurrent!==`function`||!snapshot.isCurrent()||projection?.protocol!==`dsh-scope-global-config-v1`||projection.hostId!==`local`||projection.cwdMode!==`scope-global`||projection.includeLayers!==!1||projection.scope!==snapshot.identity?.scope||projection.frontEpoch!==snapshot.identity?.frontEpoch||projection.nativeGeneration!==snapshot.identity?.nativeGeneration||!snapshot.reply?.config)return;\n  configRead=structuredClone(snapshot.reply);config=FC(configRead.config);headSnapshot=snapshot;dshUsedHeadConfigs.add(snapshot);\n }\n const freezeData=value=>{if(value&&typeof value===`object`){for(const nested of Object.values(value))freezeData(nested);Object.freeze(value);}return value;};\n const token=Object.freeze({});context.dshAttemptConfig=token;dshAttemptConfigs.set(token,{context,manager,requests:manager.requestClient,head,headSnapshot,configRead:freezeData(configRead),cwd:path,threadId,messageId,includeLayers:!1,config:freezeData(structuredClone(config))});}catch{}"
  },
  {
    "from": "saved.head.isCurrent()&&typeof manager.settings?.readExperimentPersonality===`function`",
    "to": "saved.head.isCurrent()&&(!saved.headSnapshot||saved.head.configReadSnapshot===saved.headSnapshot&&saved.headSnapshot.isCurrent())&&typeof manager.settings?.readExperimentPersonality===`function`"
  }
];
export function patchSameAttemptHeadConfig(source){
 for(const {from,to}of edits){if(source.includes(to)){if(source.split(to).length!==2)throw Error('Repeated attempt-config anchor');continue;}if(source.split(from).length!==2)throw Error('Pinned attempt-config source contract changed');source=source.replace(from,to);}
 return source;
}
