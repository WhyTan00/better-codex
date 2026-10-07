export function patchImagePreview(source){
 const patches=[
 ['function ysa(e){if(e==null)return!1;try{','function ysa(e){if(e==null)return!1;if(globalThis.__DSH_PRIVATE_IMAGE__?.(e))return!0;try{'],
 ['z=vsa(O,v!=null&&!v.isLoading&&v.authMethod===`chatgpt`&&!_&&P==null&&N&&D&&!R&&fsa(O))','z=vsa(O,((globalThis.__DSH_PRIVATE_IMAGE__?.(O)&&!_)||v!=null&&!v.isLoading&&v.authMethod===`chatgpt`&&!_)&&P==null&&N&&D&&!R&&fsa(O))'],
 ['zoomControlsPlacement:ee=`bottom`}){','zoomControlsPlacement:ee=`bottom`}){if(!w){g=!1;P=void 0;}'],
 ['function wIr(e){return`${DIr}${EIr(e)}`}','function wIr(e){return globalThis.__DSH_LOCAL_IMAGE_URL__?.(e,`local`)??`${DIr}${EIr(e)}`}'],
 ['async function nz(e,t,n,r){let i=await YLr(e,t,n,r);return i==null?null:`data:${i.mimeType};base64,${i.base64}`}','async function nz(e,t,n,r){const dshUrl=globalThis.__DSH_LOCAL_IMAGE_URL__?.(e,t);if(dshUrl)return dshUrl;let i=await YLr(e,t,n,r);return i==null?null:`data:${i.mimeType};base64,${i.base64}`}']
 ];for(const [a,b]of patches){if(source.includes(b)||a==='zoomControlsPlacement:ee=`bottom`}){'&&source.includes('zoomControlsPlacement:ee=`bottom`}){window.__DSH_USE_PREVIEW_LAYER__?.(vJ,a,o);if(!w){g=!1;P=void 0;}'))continue;if(source.split(a).length!==2)throw Error('Pinned image preview contract changed: '+a);source=source.replace(a,b);}return source;
}
