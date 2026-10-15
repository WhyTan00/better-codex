import {patchPostAckEmptyQueue} from './official-post-ack-queue.mjs';
import {pdfPreviewAssets,pdfSupportAsset,patchPdfPreview} from './official-pdf-preview.mjs';
import {patchImagePreview} from './official-image-preview.mjs';
import {normalizeOfficialImportMap} from './official-import-map.mjs';
import {portableConfig,runtimeProfile} from './runtime-profile.mjs';
import {patchDraftReceipt,patchPersistedDraftKind} from './official-draft-receipt.mjs';
import {patchCommittedHistoryHydration} from './official-committed-history.mjs';
import {readFile} from 'node:fs/promises';
import {patchCompletedTurnEntryReuse} from './official-completed-turn-entries.mjs';
import {createHash} from 'node:crypto';
import {scopeRuntimeAssets} from './official-assets.mjs';
import {historyAssetPrefix,historyClientAsset,patchInitialHistoryBudget,filePreviewClientAsset,followUpClientAsset,patchFollowUpControls,patchNativeModulePreloads} from './official-history-assets.mjs';
import {patchWorktreePrecheck} from './official-worktree-precheck.mjs';
import {patchHistoryEdit} from './official-history-edit.mjs';
import {patchThreadModelSettings,patchNativeReasoningEfforts,patchNewChatDraftModelReset,patchThreadServiceTier,patchThreadServiceTierRestore} from './official-model-settings.mjs';
import {patchAppCatalogDemandInitial,patchAppCatalogDemandPrimary,patchAppCatalogDemandThread,appCatalogThreadAsset} from './official-app-catalog-demand.mjs';
import {patchSubmissionReadiness,patchParallelTurnMetadata,patchFullAccessTurnDirectories,patchSameAttemptSubmissionConfig} from './official-submission-readiness.mjs';
import {turnCollapseAsset,patchTurnCompletionCollapse} from './official-turn-collapse.mjs';
import {patchRoutePresentation} from './official-route-presentation.mjs';
import {patchViewportPresentation} from './official-viewport-presentation.mjs';
import {patchWebSendTarget,patchWebSubmissionClock} from './official-send-target.mjs';
import {patchImageAttachments} from './official-image-attachments.mjs';
import {frozenNativeUI} from './frozen-native-ui.mjs';
import {patchLocalStartupShell,patchCachedLoadingLogo} from './official-startup-shell.mjs';
export const submissionReadinessAssetPrefix='/official-patched-v1157/assets/';
const followUpAssetPrefix=submissionReadinessAssetPrefix;
export const scopeSources=['client-diagnostics.js','native-theme-color.js','native-android-ui.js','native-startup-preview.js','page-navigation-diagnostics.js','native-navigation.js','native-preview-navigation.js','native-status-recovery.js','native-local-cache.js','native-reading-position.js','native-queue-client.js','native-sidebar-page.js',...(portableConfig?['portable-workbench-plugins.js']:runtimeProfile.uiSources),'native-pwa-preferences.js','mobile-focus.js','client-performance.js','embedded-conversation.js','official-scope-bootstrap.js'];
const auxiliaryStyles=['/codex-window-controls-overlay.css','/codex-smart-model-router-settings.css','/codex-smart-scheduling-summary.css','/codex-workspace-root-picker.css'];
export async function nativeUIRelease(upstream){
 const accepted=await frozenNativeUI();if(accepted)return accepted;
 const [htmlResponse,runtimeResponse,...sources]=await Promise.all([fetch(upstream+'/'),fetch(upstream+'/opencodex-runtime-bootstrap.js'),...scopeSources.map(name=>readFile(new URL('../public/'+name,import.meta.url),'utf8')),readFile(new URL('../public/official-pwa.js',import.meta.url),'utf8'),readFile(new URL('../public/official-pwa.css',import.meta.url),'utf8'),readFile(new URL('../public/native-loader.js',import.meta.url),'utf8')]);
 if(!htmlResponse.ok||!runtimeResponse.ok)throw Error('原生应用壳尚未就绪');const html=await htmlResponse.text(),runtime=scopeRuntimeAssets(await runtimeResponse.text());
 const styles=await Promise.all(auxiliaryStyles.map(async path=>{const r=await fetch(upstream+path);if(!r.ok||!r.headers.get('content-type')?.includes('text/css'))throw Error('原生辅助样式尚未就绪');return r.text();}));
 const worker=await readFile(new URL('../public/official-service-worker.js',import.meta.url),'utf8');
 const turnResponse=await fetch(upstream+'/official-patched-v8/assets/'+turnCollapseAsset);if(!turnResponse.ok)throw Error('官方回合模块尚未就绪');const turnModule=patchTurnCompletionCollapse(await turnResponse.text());
 const initialResponse=await fetch(upstream+'/official-patched-v8/assets/'+historyClientAsset);if(!initialResponse.ok)throw Error('官方初始模块尚未就绪');const initialBaseModule=patchParallelTurnMetadata(patchThreadServiceTierRestore(patchThreadServiceTier(patchCachedLoadingLogo(patchNewChatDraftModelReset(patchNativeReasoningEfforts(patchDraftReceipt(patchRoutePresentation(patchAppCatalogDemandInitial(patchSubmissionReadiness(patchThreadModelSettings(patchHistoryEdit(patchWorktreePrecheck(patchInitialHistoryBudget(patchImagePreview(await initialResponse.text()),{compactFilePreview:true}))))))))))))));
 const initialModule=patchPostAckEmptyQueue(patchSameAttemptSubmissionConfig(patchFullAccessTurnDirectories(patchCommittedHistoryHydration(initialBaseModule))));
 const primaryResponse=await fetch(upstream+'/official-patched-v8/assets/'+followUpClientAsset);if(!primaryResponse.ok)throw Error('官方发送模块尚未就绪');const primaryModule=patchWebSubmissionClock(patchPersistedDraftKind(patchAppCatalogDemandPrimary(patchImageAttachments(patchWebSendTarget(patchFollowUpControls(await primaryResponse.text()))))));
 const threadResponse=await fetch(upstream+'/official-patched-v8/assets/'+appCatalogThreadAsset);if(!threadResponse.ok)throw Error('官方会话模块尚未就绪');const threadModule=patchViewportPresentation(patchAppCatalogDemandThread(await threadResponse.text()));
 const entriesAsset='local-conversation-thread-turn-entries-b0fcb4b67b17.js',entriesResponse=await fetch(upstream+'/official-patched-v8/assets/'+entriesAsset);if(!entriesResponse.ok)throw Error('官方回合展示模块尚未就绪');const entriesModule=patchCompletedTurnEntryReuse(await entriesResponse.text());
 const pdfSupport=await pdfSupportAsset(),pdfModules=await Promise.all(pdfPreviewAssets.map(async name=>{const r=await fetch(upstream+'/official-patched-v8/assets/'+name);if(!r.ok)throw Error('官方PDF模块尚未就绪');return [name,patchPdfPreview((await r.text()).replaceAll('./','/official-patched-v8/assets/'),pdfSupport.name)];}));
 // Immutable URLs identify bytes, while original import specifiers stay stable.
 // Reusing a patched URL after changing its body leaves installed workers with
 // an old dependent chunk importing an SDK absent from the new generation.
 const modulePath=(name,body)=>submissionReadinessAssetPrefix+name.replace(/-[a-f0-9]+\.js$/, '-'+createHash('sha256').update(body).digest('hex').slice(0,12)+'.js');
 const initialPath=modulePath(historyClientAsset,initialModule),primaryPath=modulePath(followUpClientAsset,primaryModule),threadPath=modulePath(appCatalogThreadAsset,threadModule),entriesPath=modulePath(entriesAsset,entriesModule);
 const version=createHash('sha256').update(JSON.stringify([html,runtime,sources,styles,worker,historyAssetPrefix,filePreviewClientAsset,followUpAssetPrefix,submissionReadinessAssetPrefix,turnModule,initialModule,primaryModule,threadModule,entriesModule,pdfSupport,pdfModules,'host-metadata-precheck-v1','local-startup-shell-v1','module-singleton-aliases-v1'])).digest('hex').slice(0,16),base='/dsh-native-assets/'+version+'/';
 const entry=html.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];if(!entry)throw Error('原生入口契约已改变');
 const startupAssets=[...new Set([entry,base+'turn.js',...[...html.matchAll(/<link\b[^>]*href="(\/official-patched-v[0-9]+\/assets\/[^"?]+\.css)"/g)].map(m=>m[1]),initialPath,primaryPath,...['app-main-d8f7791751c1.js','authed-route-99252ed1daca.js','home-composer-route-eb5ed4bda9e1.js','thread-app-shell-chrome-38678cbd5490.js','zh-CN-5bff6daefa6d.js','app-primary-7fe7c6486695.css'].map(name=>'/official-patched-v8/assets/'+name)])];
 const manifest={schemaVersion:1,version,base,scope:base+'scope.js',runtime:base+'runtime.js',pwa:base+'pwa.js',css:base+'pwa.css',loader:base+'loader.js',shell:base+'shell.html',initial:initialPath,primary:primaryPath,thread:threadPath,entry,startupAssets};
 const loader=sources.at(-1).replace('__DSH_NATIVE_RELEASE__',JSON.stringify(manifest)).replace('/* __DSH_EARLY_DIAGNOSTICS__ */',sources[0]).replace('/* __DSH_EARLY_THEME__ */',sources[scopeSources.indexOf('native-theme-color.js')]),css=[sources.at(-2),...styles].join('\n'),pwa=sources.at(-3),scope=sources.slice(0,scopeSources.length).join('\n');
 let shell=patchLocalStartupShell(patchNativeModulePreloads(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*(?:modulepreload|codex-web-config\.js|opencodex-runtime-bootstrap\.js)[^>]*>/gi,'').replace(/<meta\b[^>]*name="(?:viewport|theme-color|color-scheme)"[^>]*>/gi,''));
 shell=shell.replace(/<link\b[^>]*>/gi,tag=>auxiliaryStyles.some(path=>tag.includes('href="'+path+'"'))?'':tag);
 const imports={[submissionReadinessAssetPrefix+pdfSupport.name]:submissionReadinessAssetPrefix+pdfSupport.name};for(const [name,body] of pdfModules)imports['/official-patched-v8/assets/'+name]=modulePath(name,body);for(const v of [8,1004,1005,1006,1007,1008,1009,1010,1011,1012,1013,1014,1023,1024,1026,1027,1028,1029,1030,1031,1033,1034,1032,1035,1036,1037,1038,1039,1040,1041,1103,1151,1153,1155,1157]){const p='/official-patched-v'+v+'/assets/';imports[p+entriesAsset]=entriesPath;imports[p+appCatalogThreadAsset]=threadPath;imports[p+turnCollapseAsset]=base+'turn.js';imports[p+historyClientAsset]=initialPath;imports[p+filePreviewClientAsset]=historyAssetPrefix+filePreviewClientAsset;imports[p+followUpClientAsset]=primaryPath;if(v!==8)imports[p]='/official-patched-v8/assets/';}for(const v of [1146,1175,1176])imports['/official-patched-v'+v+'/assets/'+entriesAsset]=entriesPath;const importMap=JSON.stringify(normalizeOfficialImportMap({imports})),mapHash=createHash('sha256').update(importMap).digest('base64');shell=shell.replace('script-src &#39;self&#39;','script-src &#39;self&#39; &#39;sha256-'+mapHash+'&#39;');
 shell=shell.replace(/(<html[^>]*class=")([^"]*)(")/i,(_,a,b,c)=>a+b.replace(/\belectron-(?:light|dark)\b/g,'')+c);
 // Register the official cascade order before any eager component stylesheet.
 // First appearance fixes layer priority; a later declaration cannot move it.
 shell=shell.replace('<head>',`<head><style data-dsh-native-layer-order="1">@layer theme, base, components, utilities;</style><script type="importmap" data-dsh-native-import-map="1">${importMap}</script>${manifest.startupAssets.filter(src=>src.endsWith('.js')).map(src=>`<link rel="modulepreload" href="${src}">`).join('')}<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><meta name="color-scheme" content="light dark"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000">${[manifest.scope,manifest.runtime,manifest.pwa].map(src=>`<link rel="preload" as="script" href="${src}">`).join('')}<link rel="stylesheet" href="/official-patched-v8/assets/app-primary-7fe7c6486695.css"><link id="codex-web-window-controls-overlay-styles" rel="stylesheet" href="${manifest.css}">`).replace('</body>',`<script src="${manifest.loader}"></script></body>`);
 // No scope token, authentication cookie or cached conversation in this shell.
 if(/scopeToken=|__DSH_SCOPE__/.test(shell))throw Error('应用壳不能含连接凭据');
 return {manifest,files:new Map([[submissionReadinessAssetPrefix+pdfSupport.name,pdfSupport.body],...pdfModules.map(([name,body])=>[modulePath(name,body),body]),[entriesPath,entriesModule],[threadPath,threadModule],[primaryPath,primaryModule],[initialPath,initialModule],[base+'turn.js',turnModule],[manifest.scope,scope],[manifest.runtime,runtime],[manifest.pwa,pwa],[manifest.css,css],[manifest.loader,loader],[manifest.shell,shell]])};
}
