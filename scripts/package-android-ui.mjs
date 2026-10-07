import {patchThreadServiceTier,patchThreadServiceTierRestore,patchNativeReasoningEfforts,patchNewChatDraftModelReset} from '../source/apps/native-codex-web/src/official-model-settings.mjs';
import {patchParallelTurnMetadata,patchFullAccessTurnDirectories,patchSameAttemptSubmissionConfig} from '../source/apps/native-codex-web/src/official-submission-readiness.mjs';
import {patchPostAckEmptyQueue} from '../source/apps/native-codex-web/src/official-post-ack-queue.mjs';
import {patchImagePreview} from '../source/apps/native-codex-web/src/official-image-preview.mjs';
import {normalizeOfficialImportMap} from '../source/apps/native-codex-web/src/official-import-map.mjs';
import {patchCachedLoadingLogo} from '../source/apps/native-codex-web/src/official-startup-shell.mjs';
// Build a credential-free, local-first renderer bundle from the existing UI.
// No page/session/API response is copied; lazy resources keep their HTTPS URLs.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {androidScrollableNavigation,androidFreshHistory,androidOptimisticSend,androidDiagnostics,androidSubagentSummary,androidPromptHandoff,androidPromptRendererAsset} from './android-ui-transform.mjs';
import {previewNavigation,previewChrome} from './preview-ui-transform.mjs';
import {patchWorktreePrecheck} from '../source/apps/native-codex-web/src/official-worktree-precheck.mjs';
import {patchHistoryEdit} from '../source/apps/native-codex-web/src/official-history-edit.mjs';
import {patchThreadModelSettings} from '../source/apps/native-codex-web/src/official-model-settings.mjs';
import {patchAppCatalogDemandInitial,patchAppCatalogDemandPrimary,patchAppCatalogDemandThread,appCatalogThreadAsset} from '../source/apps/native-codex-web/src/official-app-catalog-demand.mjs';
import {patchViewportPresentation} from '../source/apps/native-codex-web/src/official-viewport-presentation.mjs';
import {patchSubmissionReadiness} from '../source/apps/native-codex-web/src/official-submission-readiness.mjs';
import {patchImageAttachments} from '../source/apps/native-codex-web/src/official-image-attachments.mjs';
import {nativeUIRelease} from '../source/apps/native-codex-web/src/native-ui-release.mjs';
import {historyAssetPrefix, followUpAssetPrefix, historyClientAsset, followUpClientAsset,
  patchInitialHistoryBudget, patchFollowUpControls, filePreviewClientAsset, patchFilePreviewChrome} from '../source/apps/native-codex-web/src/official-history-assets.mjs';
import {pruneSupersededAndroidModules,uiModuleDependencies,assertUiDependencyClosure} from './android-ui-resource-closure.mjs';
import {validateAndroidUiRelease} from './validate-android-ui.mjs';

// Parse real ESM imports/exports, including minified named imports. The Node
// parser never evaluates renderer code. Preserve the existing CLI entrypoint.
if(typeof vm.SourceTextModule!=='function'){
  if(process.execArgv.includes('--experimental-vm-modules'))throw Error('Node static module parser is unavailable with its required flag');
  const child=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit'});
  if(child.error)throw child.error;
  process.exit(child.status??1);
}

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args=process.argv.slice(2);
const option=(name, fallback)=>{const at=args.indexOf(name);return at<0?fallback:args[at+1];};
const destination=path.resolve(option('--out', root+'/release-artifacts/android-ui'));
const upstream=option('--upstream',null);if(!upstream)throw Error('Supply --upstream from your own deployment.json native.webOrigin');
if(new URL(upstream).hostname!=='127.0.0.1')throw Error('Use the existing local renderer upstream');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const ui=await nativeUIRelease(upstream);
// Give the Android-specific renderer its own content-derived namespace.
const transform=await readFile(new URL('./android-ui-transform.mjs',import.meta.url));
const previewTransform=await readFile(new URL('./preview-ui-transform.mjs',import.meta.url));
const sourceVersion=ui.manifest.version;
const sourceShell=ui.files.get(ui.manifest.shell);
const originalImportMap=sourceShell.match(/<script type="importmap"[^>]*>(.*?)<\/script>/s)?.[1];
if(!originalImportMap)throw Error('Missing native import map');
const originalMapHash=createHash('sha256').update(originalImportMap).digest('base64');
const packager=await readFile(fileURLToPath(import.meta.url));
const androidVersion=digest(Buffer.concat([Buffer.from(sourceVersion),transform,previewTransform,packager])).slice(0,16);
const oldPrefix='/dsh-native-assets/'+ui.manifest.version+'/',newPrefix='/dsh-native-assets/'+androidVersion+'/';
ui.files=new Map([...ui.files].map(([url,body])=>[url.replace(oldPrefix,newPrefix),String(body).replaceAll(sourceVersion,androidVersion)]));
ui.manifest=JSON.parse(JSON.stringify(ui.manifest).replaceAll(sourceVersion,androidVersion));
ui.manifest.version=androidVersion;
// Renaming content-addressed URLs changes the import-map bytes and its CSP hash.
let androidShell=ui.files.get(ui.manifest.shell);
const sourcePrimary=ui.manifest.primary||followUpAssetPrefix+followUpClientAsset;
const androidPrimaryPrefix='/official-patched-v1168/assets/';
const androidInitialPrefix='/official-patched-v1168/assets/';
const sourceThread=ui.manifest.thread;
const androidThread=androidInitialPrefix+appCatalogThreadAsset;
const sourceInitialPrefix=ui.manifest.initial.slice(0,-historyClientAsset.length);
const androidPrimary=androidPrimaryPrefix+followUpClientAsset,androidInitial=androidInitialPrefix+historyClientAsset;
const currentMap=JSON.parse(androidShell.match(/<script type="importmap"[^>]*>(.*?)<\/script>/s)[1]);
for(const key of Object.keys(currentMap.imports)){if(currentMap.imports[key]===sourcePrimary||currentMap.imports[key]===followUpAssetPrefix+followUpClientAsset)currentMap.imports[key]=androidPrimary;if((currentMap.imports[key]===historyAssetPrefix+historyClientAsset||currentMap.imports[key]===ui.manifest.initial))currentMap.imports[key]=androidInitial;}
for(const key of Object.keys(currentMap.imports))if(sourceThread&&currentMap.imports[key]===sourceThread)currentMap.imports[key]=androidThread;
currentMap.imports['/official-patched-v8/assets/'+appCatalogThreadAsset]=androidThread;
currentMap.imports[androidThread]=androidThread;
// Relative imports from the new initial keep the same patched dependencies.
for(const [key,value] of Object.entries(currentMap.imports))if(key.startsWith(sourceInitialPrefix))currentMap.imports[androidInitialPrefix+key.slice(sourceInitialPrefix.length)]=value;
currentMap.imports[historyAssetPrefix+historyClientAsset]=androidInitial;
currentMap.imports[followUpAssetPrefix+followUpClientAsset]=androidPrimary;
currentMap.imports[sourcePrimary]=androidPrimary;
currentMap.imports[androidInitial]=androidInitial;
currentMap.imports[androidPrimaryPrefix+followUpClientAsset]=androidPrimary;
currentMap.imports[androidPrimaryPrefix+androidPromptRendererAsset]=newPrefix+'turn.js';
currentMap.imports[androidPrimaryPrefix]='/official-patched-v8/assets/';
currentMap.imports[androidInitialPrefix+followUpClientAsset]=androidPrimary;
currentMap.imports[androidInitialPrefix+androidPromptRendererAsset]=newPrefix+'turn.js';
currentMap.imports[androidInitialPrefix]='/official-patched-v8/assets/';
androidShell=androidShell.replace(/(<script type="importmap"[^>]*>).*?(<\/script>)/s,(_m,a,b)=>a+JSON.stringify(normalizeOfficialImportMap(currentMap))+b).replaceAll('href="'+sourcePrimary+'"','href="'+androidPrimary+'"').replaceAll('href="'+historyAssetPrefix+historyClientAsset+'"','href="'+androidInitial+'"').replaceAll('href="'+ui.manifest.initial+'"','href="'+androidInitial+'"');
ui.manifest.startupAssets=ui.manifest.startupAssets.map(url=>url===sourcePrimary?androidPrimary:(url===historyAssetPrefix+historyClientAsset||url===ui.manifest.initial)?androidInitial:url);
if(sourceThread)ui.files.delete(sourceThread);ui.manifest.thread=androidThread;
ui.files.delete(ui.manifest.initial);ui.files.delete(sourcePrimary);ui.manifest.initial=androidInitial;ui.manifest.primary=androidPrimary;
const androidMap=androidShell.match(/<script type="importmap"[^>]*>(.*?)<\/script>/s)?.[1];
const androidMapHash=createHash('sha256').update(androidMap).digest('base64');
if(!androidShell.includes('sha256-'+originalMapHash))throw Error('Import-map CSP contract changed');
androidShell=androidShell.replaceAll('sha256-'+originalMapHash,'sha256-'+androidMapHash);
ui.files.set(ui.manifest.shell,androidShell);
const loaderBody=ui.files.get(ui.manifest.loader);
const boot='  await script(release.scope);';
if(!loaderBody.includes(boot))throw Error('Android boot ordering changed');
ui.files.set(ui.manifest.loader,loaderBody.replace(boot,'  window.__DSH_NOTIFICATION_FINAL_GATE__=true;\n  const androidStartup=await window.__DSH_ANDROID_STARTUP__;if(androidStartup?.reload){location.reload();return;}\n'+boot));
const native=/^\/dsh-native-assets\/[a-f0-9]{16}\/(?:scope|runtime|pwa|loader|turn)\.(?:js|css)$/;
const official=/^\/official-patched-v[0-9]+\/assets\/[a-zA-Z0-9_.-]+\.(?:js|mjs|css|woff2?|ttf|png|svg|jpg|jpeg|webp)$/;
const allowed=url=>native.test(url)||official.test(url)||url===ui.manifest.shell;
const types={js:'text/javascript',mjs:'text/javascript',css:'text/css',html:'text/html',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',png:'image/png',svg:'image/svg+xml',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'};
const html=ui.files.get(ui.manifest.shell);
if(!html||/scopeToken=|__DSH_SCOPE__/.test(html))throw Error('Shell is not credential-free');
const importMap=JSON.parse(html.match(/<script type="importmap"[^>]*>(.*?)<\/script>/s)?.[1]||'{}').imports||{};
// The shell imports the official turn through this exact mapping. Patch the
// resolved module; adding a patched copy at the original URL never executes it.
const promptTarget=importMap['/official-patched-v8/assets/'+androidPromptRendererAsset];
if(promptTarget!==newPrefix+'turn.js'||!ui.files.has(promptTarget))throw Error('Official prompt import mapping changed');
ui.files.set(promptTarget,androidPromptHandoff(ui.files.get(promptTarget)));

function canonical(specifier, parent){
  if(!specifier.startsWith('.')&&!specifier.startsWith('/'))return null;
  let target=new URL(specifier,'https://workbench.example.test'+parent);
  if(target.origin!=='https://workbench.example.test'||target.search||target.hash)return null;
  let result=target.pathname;
  if(importMap[result])result=importMap[result];
  else for(const prefix of Object.keys(importMap).filter(x=>x.endsWith('/')).sort((a,b)=>b.length-a.length)){
    if(result.startsWith(prefix)){result=importMap[prefix]+result.slice(prefix.length);break;}
  }
  return allowed(result)?result:null;
}
async function fetchStatic(url){
  if(ui.files.has(url))return Buffer.from(ui.files.get(url));
  const initial=url===androidInitial;
  const preview=url===historyAssetPrefix+filePreviewClientAsset;
  const primary=url===androidPrimary;
  if(url===androidThread){const response=await fetch(upstream+'/official-patched-v8/assets/'+appCatalogThreadAsset,{redirect:'error'});if(!response.ok)throw Error('Thread resource unavailable');return Buffer.from(patchViewportPresentation(patchAppCatalogDemandThread(await response.text())));}
  const source=preview?'/official-patched-v8/assets/'+filePreviewClientAsset:initial?'/official-patched-v8/assets/'+historyClientAsset:primary?'/official-patched-v8/assets/'+followUpClientAsset:url;
  const response=await fetch(upstream+source,{redirect:'error'});
  const type=response.headers.get('content-type')||'';
  if(!response.ok||/html|json/.test(type))throw Error('Static resource unavailable: '+url);
  const body=Buffer.from(await response.arrayBuffer());
  if(body.length>24*1024*1024)throw Error('Resource too large: '+url);
  const dshFinalInitial=source=>[patchNativeReasoningEfforts,patchNewChatDraftModelReset,patchThreadServiceTier,patchThreadServiceTierRestore,patchParallelTurnMetadata,patchFullAccessTurnDirectories,patchSameAttemptSubmissionConfig,patchPostAckEmptyQueue].reduce((text,patch)=>patch(text),source);
  return preview?Buffer.from(previewChrome(patchFilePreviewChrome(body.toString()))):initial?Buffer.from(dshFinalInitial(patchCachedLoadingLogo(androidDiagnostics(androidFreshHistory(previewNavigation(patchAppCatalogDemandInitial(patchSubmissionReadiness(patchThreadModelSettings(patchHistoryEdit(patchWorktreePrecheck(patchInitialHistoryBudget(patchImagePreview(body.toString()),{compactFilePreview:true})))))))),'initial')))):primary?Buffer.from(patchAppCatalogDemandPrimary(patchImageAttachments(androidDiagnostics(androidSubagentSummary(androidOptimisticSend(androidScrollableNavigation(patchFollowUpControls(body.toString())))),'primary')))):body;
}
const queue=[...new Set([...ui.files.keys(),...ui.manifest.startupAssets])];
let files=new Map();
for(let i=0;i<queue.length;){
  const batch=queue.slice(i,i+4);
  i+=batch.length;
  for(const [url,bytes]of await Promise.all(batch.map(async url=>{
    if(!allowed(url))throw Error('Unexpected resource path: '+url);
    return [url,await fetchStatic(url)];
  }))){
    files.set(url,bytes);
    if(/\.(?:js|mjs|css|html)$/.test(url)){
      const source=bytes.toString();
      const dependencies=[];
      if(/\.(?:js|mjs)$/.test(url)){
        dependencies.push(...uiModuleDependencies(source,url).map(edge=>edge.specifier));
      }
      if(url.endsWith('.css'))for(const m of source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g))dependencies.push(m[1]);
      for(const dependency of dependencies){const target=canonical(dependency,url);if(target&&!queue.includes(target))queue.push(target);}
    }
  }
  if(queue.length>600)throw Error('Startup dependency graph unexpectedly large');
}
const closure=pruneSupersededAndroidModules({files,shell:ui.manifest.shell,roots:ui.manifest.startupAssets});files=closure.files;
const requiredStartupClosure=assertUiDependencyClosure({files,shell:ui.manifest.shell});
const total=[...files.values()].reduce((n,v)=>n+v.length,0);
if(total>100*1024*1024)throw Error('Startup bundle exceeds 100 MiB');
await mkdir(destination,{recursive:true,mode:0o700});
const manifest={schemaVersion:1,version:ui.manifest.version,minAppVersionCode:Number(option('--min-app-version-code','1')),
  shell:ui.manifest.shell,createdAt:new Date().toISOString(),files:[]};
for(const [url,bytes]of [...files.entries()].sort(([a],[b])=>a.localeCompare(b))){
  const target=path.join(destination,'files',url.slice(1));
  await mkdir(path.dirname(target),{recursive:true,mode:0o700});
  await writeFile(target,bytes,{mode:0o600});
  manifest.files.push({path:url,url:'/android/ui/'+manifest.version+'/files'+url,
    sha256:digest(bytes),bytes:bytes.length,mime:types[url.split('.').at(-1)]});
}
await writeFile(path.join(destination,'ui-release.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
await writeFile(path.join(destination,'source-release.json'),JSON.stringify(ui.manifest,null,2)+'\n',{mode:0o600});
// 在生成器结束处复用 APK 解析合同，防止只替换 URL 或漏拷贝文件的清单进入发布链。
const validation=await validateAndroidUiRelease({manifestPath:path.join(destination,'ui-release.json'),filesRoot:path.join(destination,'files')});
console.log(JSON.stringify({destination,version:manifest.version,files:files.size,bytes:total,manifestSha256:digest(Buffer.from(JSON.stringify(manifest,null,2)+'\n')),contract:validation,resourceClosure:{...closure.report,...requiredStartupClosure}}));
