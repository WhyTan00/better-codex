// ChatGPT cloud profile enrichment is optional to this Native-owned workbench.
// Keep all identity queries and the original Native auth/control gates.
export function patchNativeLocalProfileGate(source){
 const before='if(b||_&&!v){let e;return t[2]===Symbol.for(`react.memo_cache_sentinel`)?(e=(0,p6.jsx)(t6,{debugName:`CodexStatsigProvider.async.identity`})';
 const after='if((b||_&&!v)&&typeof globalThis.__DSH_LOCAL_APP_HOST__!==`function`){let e;return t[2]===Symbol.for(`react.memo_cache_sentinel`)?(e=(0,p6.jsx)(t6,{debugName:`CodexStatsigProvider.async.identity`})';
 if(source.split(after).length===2)return source;if(source.split(before).length!==2)throw Error('Optional profile gate ABI changed');return source.replace(before,after);
}

// Cloud feature enrichment cannot hide a Native-owned local reading page.
// UCo's auth/login checks and all settled entitlement states keep their order.
export function patchNativeLocalReadGate(source){
 const a=source.indexOf('function UCo('),b=source.indexOf('var WCo=',a);
 if(a<0||b<=a)throw Error('Native reading gate ABI changed');
 const before='t.status===`loading`?null:';
 const after='t.status===`loading`?(typeof globalThis.__DSH_LOCAL_APP_HOST__===`function`&&(globalThis.location?.pathname===`/`||/^\\/local\\/[0-9a-f-]{36}$/i.test(globalThis.location?.pathname??``))?`app`:null):';
 const gate=source.slice(a,b);if(gate.split(after).length===2)return source;
 if(gate.split(before).length!==2)throw Error('Native reading gate ABI changed');
 return source.slice(0,a)+gate.replace(before,after)+source.slice(b);
}
