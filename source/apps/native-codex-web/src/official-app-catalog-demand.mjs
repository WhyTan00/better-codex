// Display catalogues are optional read models. Mounting a chat must not fetch
// the marketplace; consumers request it when a selector or mention needs it.
// Keep query keys, account checks, mutations and pagination in the official hook.
const replaceOnce=(source,before,after)=>{
 if(source.includes(after))return source;
 if(source.split(before).length!==2)throw Error('App catalogue demand contract changed');
 return source.replace(before,after);
};
export function patchAppCatalogDemandInitial(source){
 return replaceOnce(source,'function GPs(){return Iyi(),null}','function GPs(){return null}');
}
export function patchAppCatalogDemandPrimary(source){
 const before='function pCr(e){let t=(0,bCr.c)(29),{composerController:n,hostId:r,pluginHostId:i,roots:a,shouldLoadPlugins:o}=e,s=i===void 0?r:i,c=r===`durable`?z_:r,l;t[0]===c?l=t[1]:(l={hostId:c},t[0]=c,t[1]=l);let{data:u}=aw(l),d;t[2]===c?d=t[3]:(d={hostId:c},t[2]=c,t[3]=d);let f=zIe(d),p=uv(),m=dH(n,hCr,`document`),h=dH(n,mCr),g=o||m,{isLoading:_,skills:v}=wC(a,r),y;';
 const after='function dshHasAppMentions(e){let t=!1;return e.view.state.doc.descendants(e=>(e.type.name===`appMention`||e.type.name===`skillMention`&&typeof e.attrs.path===`string`&&e.attrs.path.startsWith(`app://`))?(t=!0,!1):!0),t}function pCr(e){let t=(0,bCr.c)(29),{composerController:n,hostId:r,pluginHostId:i,roots:a,shouldLoadPlugins:o}=e,s=i===void 0?r:i,c=r===`durable`?z_:r,m=dH(n,hCr,`document`),h=dH(n,mCr),dshAppMention=dH(n,dshHasAppMentions,`document`),dshCatalogDemand=!!(o||m||dshAppMention),l;t[0]===c?l=t[1]:(l={hostId:c},t[0]=c,t[1]=l);let{data:u}=aw({...l,enabled:dshCatalogDemand}),d;t[2]===c?d=t[3]:(d={hostId:c},t[2]=c,t[3]=d);let f=zIe({...d,enabled:dshCatalogDemand}),p=uv(),g=o||m,{isLoading:_,skills:v}=wC(a,r),y;';
 return replaceOnce(source,before,after);
}

export const appCatalogThreadAsset='local-conversation-thread-40db5af470f5.js';
// Inspect only typed message/input envelopes, never recursive tool payloads or
// arbitrary text. MCP names/icons use app metadata even when widgets are off.
export function dshTurnNeedsAppCatalog(turn){
 const reference=input=>input!=null&&(
  input.type==='appMention'||
  (input.type==='mention'||input.type==='skill'||input.type==='skillMention')&&typeof input.path==='string'&&input.path.startsWith('app://')||
  input.type==='app'||input.type==='appReference'
 );
 if(!turn)return false;
 if((turn.params?.input??[]).some(reference))return true;
 return (turn.items??[]).some(item=>item.type==='mcpToolCall'||item.type==='mcp-tool-call'||
  reference(item)||item.type==='userMessage'&&(item.content??[]).some(reference));
}
export function patchAppCatalogDemandThread(source){
 // GO sees history summaries; IE owns the hydrated turn (including paginated
 // history updates). Keep the hook unconditional there and gate its query.
 const marker='let le=ce,G=oe??z,K;';
 const replacement='let le=ce,{data:dshTurnApps=ZO}=Hc({hostId:m,enabled:dshTurnNeedsAppCatalog(le)});M=dshTurnApps;let G=oe??z,K;';
 let result=replaceOnce(source,'Ae=Hu(e),{data:je=ZO}=Hc({hostId:n}),Me=', 'Ae=Hu(e),je=ZO,Me=');
 result=replaceOnce(result,marker,replacement);
 const helper=dshTurnNeedsAppCatalog.toString();
 if(!result.includes(helper)){
  if(result.includes('function dshTurnNeedsAppCatalog('))throw Error('App catalogue demand helper contract changed');
  result=replaceOnce(result,'function GO(',helper+'\nfunction GO(');
 }
 return result;
}
