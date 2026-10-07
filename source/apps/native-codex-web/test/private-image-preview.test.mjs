import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {patchImagePreview} from '../src/official-image-preview.mjs';
const initial=await readFile(process.env.DSH_IMAGE_INITIAL||new URL('../../../image-before.js',import.meta.url),'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return readFile(new URL('../../../runtime/pro-remediation-and-media-send-20261003/pwa-initial-before.js',import.meta.url),'utf8');}),preview=await readFile(process.env.DSH_IMAGE_NAVIGATION||new URL('../public/native-preview-navigation.js',import.meta.url),'utf8');
if(process.env.DSH_IMAGE_SCOPE)assert((await readFile(process.env.DSH_IMAGE_SCOPE,'utf8')).includes(preview.trim()));
const finalInitial=process.env.DSH_IMAGE_FINAL?await readFile(process.env.DSH_IMAGE_FINAL,'utf8'):patchImagePreview(initial);assert.equal(patchImagePreview(finalInitial),finalInitial,'the final generated module must already contain the complete image patch');
const address='https://workbench.example.test/android/design-reviews/agenda-menu-20261003/option-1.png',location={origin:'https://workbench.example.test',href:'https://workbench.example.test/local/11111111-1111-4111-a111-111111111111?workspace=ai',pathname:'/local/11111111-1111-4111-a111-111111111111',search:'?workspace=ai'};
function gate(scope='ai'){
 const window={__DSH_SCOPE__:{id:scope}},context={window,navigator:{userAgent:'fixture'},document:{documentElement:{dataset:{}},addEventListener(){}},location,URL,addEventListener(){}};vm.runInNewContext(preview,context);return window.__DSH_PRIVATE_IMAGE__;
}
const extract=(source,name)=>{const start=source.indexOf('function '+name+'('),end=source.indexOf('function ',start+12);assert(start>=0&&end>start);return source.slice(start,end);};
function safety(source,privateImage){const calls=[],context={__DSH_PRIVATE_IMAGE__:privateImage,URL,m5i:()=>({domain:'other.test'}),wsa:new Set(['openai.com','chatgpt.com','chat.com']),Ssa:{c:()=>[]},Mb:options=>{calls.push(options);return{isLoading:false};},HQi:()=>{throw Error('unavailable cloud URL safety API');}};vm.runInNewContext(extract(source,'ysa')+extract(source,'bsa'),context);return{value:context.bsa(address,true),calls};}
test('actual markdown image safety returns the scoped original without calling the absent cloud API',()=>{
 const privateImage=gate(),old=safety(initial,privateImage);assert.equal(old.value.safeUrl,undefined);assert.equal(old.calls[0].enabled,true);
 const patched=finalInitial,value=safety(patched,privateImage);assert.equal(value.value.safeUrl,address);assert.equal(value.calls[0].enabled,false);
 const eligibility=patched.match(/z=vsa\(O,([\s\S]*?)\),ee=P==null/)[1];assert.equal(vm.runInNewContext(eligibility,{__DSH_PRIVATE_IMAGE__:privateImage,O:address,v:null,_:false,P:null,N:true,D:true,R:false,fsa:()=>true}),true);
 assert.equal(vm.runInNewContext(eligibility,{__DSH_PRIVATE_IMAGE__:privateImage,O:address,v:null,_:true,P:null,N:true,D:true,R:false,fsa:()=>true}),false);
});
test('image trust retains exact origin, workspace and protected resource families',()=>{
 const privateImage=gate();assert(privateImage(address));assert(privateImage('/__dsh_deliverables/ai/original.png'));
 for(const url of ['https://other.test/android/design-reviews/x.png','https://user@workbench.example.test/android/design-reviews/x.png','/__dsh_deliverables/zyy/original.png','/android/another-site/x.png','/android/design-reviews/x.html'])assert.equal(privateImage(url),false,url);
 assert.equal(gate('zyy')(address),false);
});
test('non-inline official image dialogs escape the conversation panel portal',()=>{
 const source=patchImagePreview(initial);assert(source.includes('zoomControlsPlacement:ee=`bottom`}){if(!w){g=!1;P=void 0;}'));
 assert.equal(patchImagePreview(source),source);
});
function localResolver(scope='ai',token='fixture-scope'){
 const window={__DSH_SCOPE__:{id:scope,token}},context={window,navigator:{userAgent:'fixture'},document:{documentElement:{dataset:{}},addEventListener(){}},location,URL,addEventListener(){}};
 vm.runInNewContext(preview,context);return window.__DSH_LOCAL_IMAGE_URL__;
}
test('actual generated-image file URL uses the protected HTTP resolver instead of the desktop-only app protocol',()=>{
 const file='/workspace/fixture/design original #1.png',localImage=localResolver(),context={__DSH_LOCAL_IMAGE_URL__:localImage,DIr:'app://fs',EIr:e=>'/@fs'+encodeURI(e)};
 vm.runInNewContext(extract(initial,'wIr'),context);assert.equal(new URL(context.wIr(file)).protocol,'app:');
 vm.runInNewContext(extract(finalInitial,'wIr'),context);const value=new URL(context.wIr(file));assert.equal(value.protocol,'https:');assert.equal(value.origin,location.origin);assert.equal(decodeURIComponent(value.pathname),'/w/ai/api/app-fs/@fs/'+file);assert.equal(value.searchParams.get('scopeToken'),'fixture-scope');
});
test('actual viewed-image loader avoids a second base64 body over the ordered WebSocket',async()=>{
 let reads=0;const localImage=localResolver(),context={__DSH_LOCAL_IMAGE_URL__:localImage,YLr:async()=>{reads++;return{mimeType:'image/png',base64:'fixture'};}};
 vm.runInNewContext('async '+extract(initial,'nz'),context);assert.equal(await context.nz('/workspace/fixture/viewed.png','local',{}),'data:image/png;base64,fixture');assert.equal(reads,1);
 vm.runInNewContext('async '+extract(finalInitial,'nz'),context);const value=await context.nz('/workspace/fixture/viewed.png','local',{});assert.equal(new URL(value).pathname,'/w/ai/api/app-fs/@fs//workspace/fixture/viewed.png');assert.equal(reads,1);
 assert.equal(await context.nz('/remote/viewed.png','ssh-host',{}),'data:image/png;base64,fixture');assert.equal(reads,2,'remote host continues through its original owner');
});
test('local image resolver preserves path bytes and rejects non-image protocols and unavailable credentials',()=>{
 const resolve=localResolver(),path='/workspace/fixture/a ?#% 图.png',url=new URL(resolve(path));assert.equal(decodeURIComponent(url.pathname.slice('/w/ai/api/app-fs/@fs/'.length)),path);
 assert.equal(new URL(resolve('app://fs/@fs'+encodeURIComponent(path).replaceAll('%2F','/'))).pathname,url.pathname);
 for(const value of ['https://other.test/a.png','//other.test/a.png','data:image/png;base64,AA==','/workspace/fixture/a.html','/workspace/fixture/a\0.png','C:\\AI\\a.png'])assert.equal(resolve(value),null);
 assert.equal(resolve(path,'ssh-host'),null);assert.equal(localResolver('ai',null)(path),null);assert.equal(localResolver('unknown')(path),null);
});
test('actual Native savedPath producer and generated-image preview hook consume the protected URL',async()=>{
 const primary=await readFile(process.env.DSH_IMAGE_PRIMARY||new URL('../../../runtime/fast-restore-delivery-v2-20261004/android-ui/files/official-patched-v1132/assets/app-primary-6cd7b8b3f5e3.js',import.meta.url),'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return readFile(new URL('../../../runtime/pro-remediation-and-media-send-20261003/android-ui/files/official-patched-v1152/assets/app-primary-6cd7b8b3f5e3.js',import.meta.url),'utf8');});
 let bodyReads=0;const path='/workspace/fixture/.codex/generated_images/11111111-1111-4111-a111-111111111111/exec-native.png',context={__DSH_LOCAL_IMAGE_URL__:localResolver(),DIr:'app://fs',EIr:e=>'/@fs'+encodeURI(e),b_:e=>e.startsWith('/'),g_:e=>e,dTt:e=>e,K8t:/^(?:data:image\/|https?:\/\/|file:\/\/|app:\/\/|\/@fs)/i,rGn:{c:()=>[]},iGn:{useState:()=>[null,()=>{}],useEffect:fn=>fn()},Cx:()=>({}),rw:()=> 'local',lm:Symbol(),Mp:id=>({kind:'local',id}),eh:()=>false,qie:()=>({dataUrl:null,src:null,refetch:()=>{}}),kw:e=>e.startsWith('/')?e:null,lx:async()=>{bodyReads++;return null;}};
 vm.runInNewContext(extract(finalInitial,'G8t').split('var K8t')[0]+extract(finalInitial,'W8t')+extract(finalInitial,'wIr'),context);context.mIe=context.wIr;vm.runInNewContext(extract(primary,'nGn').split('var rGn')[0],context);
 const item=context.W8t({type:'imageGeneration',savedPath:path,result:'original-base64'});assert.equal(item.src,path,'Native savedPath wins over its base64 fallback');
 const value=context.nGn({src:item.src,conversationId:'11111111-1111-4111-a111-111111111111',shouldLoadFileDataUrl:false});assert.equal(new URL(value.previewSrc).protocol,'https:');assert.equal(value.downloadSrc,value.previewSrc);assert.equal(bodyReads,0);
});
