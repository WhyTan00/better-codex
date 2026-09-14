function combineStatuses(parts) {
 const statuses=parts.map(part=>part?.status);if(statuses.every(status=>status==='unavailable'))return 'unavailable';if(statuses.includes('unavailable'))return 'partial';if(statuses.includes('stale'))return 'stale';return 'ok';
}
function unavailable(schema,reason='adapter_not_configured'){return {schema,status:'unavailable',generatedAt:new Date().toISOString(),reason};}
export async function execute(modules={}){
 const entries=[['activeInvesting','portfolio','better-codex-workbench.invest-portfolio.v2'],['quant','quant','better-codex-workbench.invest-quant.v2'],['agenda','agenda','better-codex-workbench.mentor-agenda.v1']];
 const values=await Promise.all(entries.map(async([,key,schema])=>{const loader=modules[key];if(typeof loader!=='function')return unavailable(schema);try{return await loader();}catch(error){return {...unavailable(schema,'module_read_failed'),message:String(error?.message||error).slice(0,240)};}}));
 const [portfolio,quant,agenda]=values;return {schema:'better-codex-workbench.snapshot.v2',status:combineStatuses(values),generatedAt:new Date().toISOString(),modules:{activeInvesting:portfolio,quant,agenda},boundaries:{readOnly:true,credentialsIncluded:false,commandsIncluded:false,tradeActionsIncluded:false,liveTradingEnabled:false}};
}
