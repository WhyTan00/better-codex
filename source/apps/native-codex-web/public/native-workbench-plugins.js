// Scoped native surfaces for the existing Cordis workbench plugins.
// Domain snapshots still come from those plugins; this file only presents them.
(()=>{
 const scope=window.__BETTER_CODEX_SCOPE__;if(!scope)return;
 const request=window.fetch.bind(window),root=document.documentElement,renderers=new Map();let token=null,tokenRequest=null,definitions=null,definitionRequest=null,panel=null,sequence=0,current=null,view=null,preloading=false,authEpoch=0,authLocked=false;
 const snapshots=new Map(),pending=new Map(),refreshMs=60000;let lastDefinitionsCheck=0;
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=String(text);if(cls)n.className=cls;return n;};
 const number=(value,digits=0)=>Number.isFinite(Number(value))&&value!=null?Number(value).toLocaleString('zh-CN',{maximumFractionDigits:digits}):'—';
 const tone=value=>value!=null&&Number.isFinite(Number(value))?(Number(value)>0?'betterCodex-pnl-up':Number(value)<0?'betterCodex-pnl-down':''):'';
 const signed=value=>value!=null&&Number(value)>0?'+'+number(value,2):number(value,2);
 const money=value=>number(value,2),time=value=>value?new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'待更新';
 async function stored(key){try{const cache=window.__BETTER_CODEX_NATIVE_CACHE__;if(!cache||await cache.meta('auth-locked'))return null;return await cache.meta(key);}catch{return null;}}
 function save(key,value){return window.__BETTER_CODEX_NATIVE_CACHE__?.saveMeta(key,value).catch(()=>{});}
 function loginError(){const error=Error('登录已过期，请重新登录后查看');error.login=true;token=null;window.dispatchEvent(new Event('betterCodex:authentication-required'));return error;}
 async function api(path){if(!token){if(!tokenRequest)tokenRequest=(async()=>{const response=await request('/api/context',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspace:scope.id}),cache:'no-store',redirect:'manual'});if(response.status===401||response.type==='opaqueredirect')throw loginError();if(!response.ok)throw Error('工作台连接暂不可用');return (await response.json()).token;})().finally(()=>{tokenRequest=null;});token=await tokenRequest;}
  const response=await request('/api/w/'+scope.id+'/plugins'+path,{headers:{authorization:'Bearer '+token},cache:'no-store',redirect:'manual'});if(response.status===401||response.type==='opaqueredirect')throw loginError();if(!response.ok)throw Error('暂时无法更新，已保留上次内容');return response.json();
 }
 function fetchDefinitions(){if(!definitionRequest)definitionRequest=api('').then(result=>{definitions=result.data;lastDefinitionsCheck=Date.now();save('plugin-definitions',definitions);return definitions;}).finally(()=>{definitionRequest=null;});return definitionRequest;}
 async function resource(path,options={}){if(!token)await api('');const response=await request('/api/w/'+scope.id+'/'+path,{...options,headers:{...options.headers,authorization:'Bearer '+token},cache:'no-store',redirect:'manual'});if(response.status===401||response.type==='opaqueredirect')throw loginError();let data;try{data=await response.json();}catch{throw Error('书架连接暂不可用');}if(!response.ok)throw Object.assign(Error(response.status===409?'这份稿件已有新的保存版本，请先重新读取并合并':typeof data.error==='string'?data.error:'书架暂不可用'),{code:response.status});return data;}
 async function list(){if(definitions)return definitions;const cached=await stored('plugin-definitions');if(Array.isArray(cached)){definitions=cached;if(navigator.onLine)fetchDefinitions().catch(()=>{});return cached;}return fetchDefinitions();}
 async function cachedSnapshot(id){if(authLocked)return null;const memory=snapshots.get(id);if(memory&&Date.now()-memory.checkedAt<refreshMs)return memory;const saved=await stored('plugin-snapshot:v2:'+id);const legacy=saved?null:await stored('plugin:'+id);const entry=saved?.data?saved:legacy?{data:legacy,checkedAt:0}:memory;if(entry&&(!memory||entry.checkedAt>memory.checkedAt))snapshots.set(id,entry);return snapshots.get(id)||null;}
 async function fetchSnapshot(id,{force=false}={}){if(pending.has(id))return pending.get(id);const cached=await cachedSnapshot(id);if(!force&&cached&&Date.now()-cached.checkedAt<refreshMs)return cached;
  if(!navigator.onLine)throw Error(cached?'当前离线，正在显示本机缓存':'当前离线，尚无此页面的缓存');
  if(pending.has(id))return pending.get(id);const epoch=authEpoch;const operation=api('/'+encodeURIComponent(id)).then(data=>{if(epoch!==authEpoch)throw Object.assign(Error('登录状态已改变，请重新登录后查看'),{login:true});const entry={data,checkedAt:Date.now()};snapshots.set(id,entry);save('plugin-snapshot:v2:'+id,entry);return entry;}).finally(()=>pending.delete(id));pending.set(id,operation);return operation;
 }
 async function preload(){if(preloading||document.visibilityState!=='visible'||!navigator.onLine)return;preloading=true;try{const plugins=await list();for(const plugin of plugins){if(document.visibilityState!=='visible'||!navigator.onLine)break;try{if(plugin.id==='secondary'&&scope.id==='secondary')await window.__BETTER_CODEX_FICTION__?.preload(resource);else await fetchSnapshot(plugin.id);}catch(e){if(e.login)break;}}}catch{}finally{preloading=false;}}
 function section(parent,title){const s=el('section',null,'betterCodex-plugin-section');s.append(el('h2',title));parent.append(s);return s;}
 function text(parent,value,cls){if(value)parent.append(el('p',value,cls));}
 function stats(parent,values){const dl=el('dl',null,'betterCodex-plugin-stats');for(const [label,value,change]of values){const group=el('div');group.append(el('dt',label),el('dd',value,tone(change)));dl.append(group);}parent.append(dl);}
 function rows(parent,entries){const list=el('div',null,'betterCodex-plugin-rows');for(const [title,detail,value,change]of entries){const row=el('div',null,'betterCodex-plugin-row'),left=el('div');left.append(el('div',title));if(detail)left.append(el('small',detail));row.append(left);if(value!=null)row.append(el('span',value,'betterCodex-plugin-value '+tone(change)));list.append(row);}if(!entries.length)text(list,'暂无条目','betterCodex-plugin-muted');parent.append(list);}
 function hints(parent,values){for(const v of values||[])text(parent,typeof v==='string'?v:v.title||v.summary||v.detail||v.message,'betterCodex-plugin-muted');}
 renderers.set('portfolio',(body,s)=>{
  stats(body,[['总市值（元）',money(s.totals?.marketValueCny)],['当日盈亏（元）',signed(s.totals?.dailyPnlCny),s.totals?.dailyPnlCny],['累计盈亏（元）',signed(s.totals?.unrealizedPnlCny),s.totals?.unrealizedPnlCny]]);
  const holdings=section(body,'持仓');rows(holdings,(s.positions||[]).map(p=>[p.name||p.symbol,[p.symbol,'现价 '+money(p.currentPrice),p.currency,p.priceStale?'行情待更新':null].filter(Boolean).join(' · '),'当日 '+signed(p.dailyPnl)+(p.dailyPct!=null?' · '+signed(p.dailyPct)+'%':''),p.dailyPnl]));
  if(s.attention?.length)rows(section(body,'需要关注'),s.attention.map(p=>[p.name||p.symbol,p.priceStale?'行情待更新':p.alert?'存在提醒':'关注持仓',p.dailyPct!=null?signed(p.dailyPct)+'%':null,p.dailyPct]));
  if(s.physicalGold?.summary){const gold=section(body,'实物黄金');text(gold,s.physicalGold.summary);text(gold,s.physicalGold.actionContext,'betterCodex-plugin-muted');}
 });
 renderers.set('quant',(body,s)=>{
  stats(body,[['Paper 运行',number(s.paper?.runningCount)],['执行策略',number(s.okx?.executing_strategies?.length)],['研究候选',number(s.selection?.candidateCount)]]);
  const paper=section(body,'Paper 策略');rows(paper,(s.paper?.strategies||[]).map(p=>[p.name||p.strategyName||p.strategy_id||p.id||'策略',p.status||p.state||'',p.pnl!=null?money(p.pnl):p.cumulativeRealizedPnl!=null?'已实现 '+signed(p.cumulativeRealizedPnl):null,p.pnl??p.cumulativeRealizedPnl]));
  rows(section(body,'现有执行'),(s.okx?.executing_strategies||[]).map(p=>[p.name||p.strategy_name||p.strategy_id||p.id||'策略',p.environment||p.mode||p.status||'',p.pnl!=null?money(p.pnl):p.cumulativeRealizedPnl!=null?'已实现 '+signed(p.cumulativeRealizedPnl):null,p.pnl??p.cumulativeRealizedPnl]));
  const research=section(body,'研究与准入');text(research,s.activationGate?.globalDecision);hints(research,s.portfolioGate?.dominantBlockers);rows(research,(s.selection?.topCandidates||[]).map(p=>[p.name||p.strategy_id||p.id||'研究候选',p.status||p.reason||'',null]));
 });
 renderers.set('agenda',(body,s)=>{
  const focus=section(body,'今天 · '+(s.date||''));text(focus,s.focus?.title,'betterCodex-plugin-focus');text(focus,s.focus?.judgment,'betterCodex-plugin-muted');
  rows(section(body,'今日安排'),(s.manualTasks?.today||[]).map(t=>[t.title,[t.time,t.priority].filter(Boolean).join(' · '),t.status==='done'?'已完成':'待办']));
  rows(section(body,'项目重点'),(s.actions?.today||[]).map(t=>[t.title||t.summary,t.projectName||t.project_id||t.kind||'',({waiting_human_input:'待补充',waiting_human_review:'待审阅',waiting_human_decision:'待决定',agent_running:'进行中'})[t.state]||t.statusLabel||t.status||null]));
  rows(section(body,'后续安排'),(s.manualTasks?.upcoming||[]).map(t=>[t.title,[t.date,t.time].filter(Boolean).join(' '),null]));
  hints(section(body,'需要你判断'),s.assistant?.keyDecisions);hints(body,s.assistant?.suggestions);
 });
 renderers.set('cockpit',(body,s)=>{
  stats(body,[['项目',number(s.summary?.projectCount)],['运行任务',number(s.summary?.runningJobs)],['提醒',number(s.summary?.alertCount)]]);
  for(const item of s.sections||[]){const group=section(body,item.title||item.label||item.id);text(group,item.subtitle||item.summary?.text||item.description);if(item.metrics)stats(group,(Array.isArray(item.metrics)?item.metrics:[]).map(m=>[m.label==='Active'?'活跃项目':m.label,m.displayValue??m.value,m.tone==='positive'?1:m.tone==='negative'?-1:null]));rows(group,(item.items||item.rows||[]).map(v=>typeof v==='string'?[v,null,null]:[v.title||v.label||v.summary||v.id,v.subtitle&&!['provide_input','review','do'].includes(v.subtitle)?v.subtitle:null,Array.isArray(v.meta)?v.meta.filter(Boolean).join(' · '):null]));}
  hints(section(body,'提醒'),s.alerts);
 });

 function mountVideo(v){
  if(scope.id!=='ai')throw Error('视频工作台仅属于 AI 工作区');
  const owner=panel,frame=document.createElement('iframe');frame.className='betterCodex-video-frame';frame.title='视频工作台';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-downloads allow-modals');
  owner.dataset.videoFrame='1';let alive=true,ready=false,dirty=false,observer=null,settle;
  const loaded=new Promise(resolve=>{settle=resolve;});
  const message=text=>{if(alive)v.status.textContent=text;};
  const child=()=>{try{return frame.contentDocument;}catch{return null;}};
  const busy=()=>/正在保存|再次点保存会查询/.test(child()?.getElementById('save-status')?.textContent||'');
  const leaveReady=()=>{if(busy()){message('请先确认审片反馈保存结果');return false;}if(!dirty)return true;message('还有未保存的审片反馈。');const discard=document.createElement('button');discard.type='button';discard.className='betterCodex-plugin-button';discard.textContent='放弃修改';discard.onclick=()=>{if(busy())return;dirty=false;message('');close();};v.status.append(discard);return false;};
  frame.onload=()=>{if(!alive)return;const doc=child();if(!doc?.getElementById('back-app')){message('视频页面连接暂不可用，请重新打开');settle();return;}
   const back=doc.getElementById('back-app');back.onclick=event=>{event.preventDefault();close();};
   const header=doc.querySelector('.topbar');if(header)header.hidden=true;
   doc.getElementById('review-form')?.addEventListener('input',()=>{dirty=true;});
   observer=new MutationObserver(()=>{if(doc.getElementById('save-status')?.textContent?.startsWith('已保存'))dirty=false;});observer.observe(doc.getElementById('save-status'),{subtree:true,childList:true,characterData:true});
   doc.addEventListener('focusin',()=>window.__BETTER_CODEX_ANDROID_INPUT__?.refresh(),true);doc.addEventListener('focusout',()=>window.__BETTER_CODEX_ANDROID_INPUT__?.refresh(),true);
   const download=doc.getElementById('download');if(download){download.removeAttribute('target');download.setAttribute('download','');download.addEventListener('click',event=>{if(window.__BETTER_CODEX_ANDROID_DOWNLOAD__){event.preventDefault();window.__BETTER_CODEX_ANDROID_DOWNLOAD__.open(download.href);}});}
   ready=true;message('');settle();
  };
  frame.onerror=()=>{message('视频页面连接暂不可用，请重新打开');settle();};
  frame.src='/video-workbench?workspace=ai&embedded=1';v.content.replaceChildren(frame);
  return {async refresh(){if(!ready)return loaded;if(!dirty&&!busy()){message('');child()?.getElementById('refresh')?.click();}},back(){const doc=child();if(doc?.getElementById('asset-dialog')?.open){if(!leaveReady())return true;doc.getElementById('close-detail')?.click();return true;}return false;},canReload:()=>!dirty&&!busy(),canLeave:leaveReady,destroy(){alive=false;observer?.disconnect();for(const media of child()?.querySelectorAll('video,audio')||[])media.pause();frame.remove();settle();delete owner.dataset.videoFrame;window.__BETTER_CODEX_ANDROID_INPUT__?.refresh();}};
 }
 function selection(){for(const button of document.querySelectorAll('[data-betterCodex-plugin-link]')){if(button.dataset.betterCodexPluginLink===current)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}}
 function canLeave(){return !view?.controller||view.controller.canLeave();}
 function dismiss(){view?.controller?.destroy();sequence++;current=null;view=null;panel?.remove();panel=null;delete root.dataset.betterCodexPlugin;selection();window.__BETTER_CODEX_NATIVE_SIDEBAR__?.show(false);}
 function close(){if(view?.controller?.back())return;if(!canLeave())return;if(history.state?.betterCodexPluginPage){history.back();}else dismiss();}
 function linkTarget(data){const target=new URL(data.url);if(target.protocol!=='https:'||target.username||target.password)throw Error('书架入口地址无效');return target.href;}
 function render(v,entry){if(v!==view)return;const data=entry.data,serialized=JSON.stringify(data);if(v.id==='video'){v.data=data;if(!v.controller)v.controller=mountVideo(v);return;}if(v.id==='secondary'){v.data=data;if(!v.controller){if(!window.__BETTER_CODEX_FICTION__)throw Error('书架界面需要更新，请检查界面更新后重开');v.controller=window.__BETTER_CODEX_FICTION__.mount(v.content,{request:resource,body:v.body,status:v.status});}return;}if(v.serialized===serialized)return;const scroll=v.body.scrollTop;v.content.replaceChildren();v.serialized=serialized;v.data=data;
  // The destination obtains its own content key through the existing SSO session.
  // A normal click goes straight there; restoring browser history never redirects again.
  if(data.kind==='link'){if(!v.restore){v.status.textContent='正在打开…';location.assign(linkTarget(data));return;}text(v.content,data.description);const a=el('a',data.label,'betterCodex-plugin-button');a.href=linkTarget(data);v.content.append(a);return;}
  const snapshot=data.snapshot||{};text(v.content,(snapshot.status==='stale'?'部分来源待更新 · ':'')+'来源时间 '+time(snapshot.asOf||snapshot.generatedAt),'betterCodex-plugin-muted');const renderer=renderers.get(data.kind);if(renderer)renderer(v.content,snapshot);else text(v.content,'此插件尚未提供原生视图');v.body.scrollTop=scroll;
 }
 async function refreshCurrent({force=false}={}){const v=view;if(!v||v.loading)return;v.loading=true;v.refresh.disabled=true;v.refresh.textContent='刷新中…';v.status.dataset.state='loading';v.status.textContent=v.data?'已显示本机内容，正在检查更新…':'正在加载…';
  try{const entry=['secondary','video'].includes(v.id)?{data:{kind:v.id}}:await fetchSnapshot(v.id,{force});if(v!==view)return;render(v,entry);if(v.controller){await v.controller.refresh({force});return;}v.status.dataset.state='ready';v.status.textContent='已检查 '+time(entry.checkedAt)+' · 自动更新已开启';}
  catch(e){if(v!==view)return;if(e.login){v.controller?.destroy();v.controller=null;v.content.replaceChildren();v.data=null;v.serialized=null;}v.status.dataset.state='error';v.status.textContent=e.message||'暂时无法更新，已保留上次内容';}
  finally{v.loading=false;if(v===view){v.refresh.disabled=false;v.refresh.textContent='刷新';}}
 }
 async function open(id,{restore=false}={}){const available=await list(),plugin=available.find(p=>p.id===id);if(!plugin)return;if(current===id&&view){await refreshCurrent({force:true});return;}
  if(!canLeave())return;view?.controller?.destroy();const cached=await cachedSnapshot(id);if(!restore&&!['secondary','video'].includes(id)&&cached?.data.kind==='link'){location.assign(linkTarget(cached.data));return;}
  if(!restore&&history.state?.betterCodexPluginPage!==id){const next={...history.state,betterCodexPluginPage:id};history[current?'replaceState':'pushState'](next,'',location.href);}
  const turn=++sequence;current=id;window.__BETTER_CODEX_NATIVE_SIDEBAR__?.openWorkbench?.();root.dataset.betterCodexPlugin=id;selection();panel?.remove();panel=el('main',null,'betterCodex-native-plugin');panel.id='betterCodex-native-plugin';panel.setAttribute('aria-label',plugin.label);
  const header=el('header'),back=el('button','‹ 返回会话','betterCodex-plugin-button'),refresh=el('button','刷新','betterCodex-plugin-button');back.type=refresh.type='button';back.onclick=close;refresh.onclick=()=>refreshCurrent({force:true});header.append(back,el('h1',plugin.label),refresh);
  const body=el('div',null,'betterCodex-plugin-body'),status=el('p','正在加载…','betterCodex-plugin-load-status'),content=el('div');status.setAttribute('role','status');body.append(status,content);panel.append(header,body);document.body.append(panel);if(root.dataset.betterCodexTouch!=='1'){const sidebar=document.querySelector('.app-shell-left-panel');const width=sidebar?.getBoundingClientRect().width||0;panel.style.left=Math.min(width,innerWidth/2)+'px';}
  const v=view={id,turn,body,content,status,refresh,restore,data:null,serialized:null,loading:false};if(v!==view)return;if(cached){render(v,cached);status.textContent='本机缓存 · 正在检查更新…';}await refreshCurrent({force:true});
 }

 async function localCacheStatus(){
  if(authLocked||await window.__BETTER_CODEX_NATIVE_CACHE__?.meta('auth-locked'))throw Error('请先登录后查看本机缓存');
  const savedDefinitions=await stored('plugin-definitions'),items=[];
  for(const plugin of Array.isArray(savedDefinitions)?savedDefinitions:definitions||[]){
   if(plugin.id==='secondary'){
    if(scope.id==='secondary'){const value=await window.__BETTER_CODEX_FICTION__?.localCacheState?.();items.push({id:plugin.id,name:plugin.name||plugin.title||'书架',kind:'cipher',cached:!!value?.cached,prepared:!!value?.prepared,loading:!!value?.loading,checkedAt:value?.preparedAt||0});}
    continue;
   }
   const saved=await stored('plugin-snapshot:v2:'+plugin.id),legacy=saved?null:await stored('plugin:'+plugin.id);
   items.push({id:plugin.id,name:plugin.name||plugin.title||plugin.id,kind:plugin.id==='video'?'entry':'snapshot',cached:!!(saved?.data||legacy),loading:pending.has(plugin.id),checkedAt:saved?.checkedAt||0});
  }
  return {scope:scope.id,preloading,items};
 }
 window.__BETTER_CODEX_NATIVE_WORKBENCH__={localCacheStatus,list,open,close,preload,refresh:refreshCurrent,register:(id,render)=>renderers.set(id,render),canReload:()=>view?.controller?.canReload?.()!==false,get current(){return current;}};
 document.addEventListener('click',event=>{if(current&&event.target.closest?.('[data-app-action-sidebar-thread-row]')){if(!canLeave()){event.preventDefault();event.stopImmediatePropagation();return;}view?.controller?.destroy();sequence++;current=null;view=null;panel?.remove();panel=null;delete root.dataset.betterCodexPlugin;selection();}},true);
 addEventListener('popstate',event=>{const id=event.state?.betterCodexPluginPage;if(current&&id!==current&&!canLeave()){history.pushState({...history.state,betterCodexPluginPage:current},'',location.href);return;}if(id)open(id,{restore:true}).catch(()=>dismiss());else if(current)dismiss();});
 addEventListener('online',()=>{refreshCurrent({force:true});preload();});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){refreshCurrent();preload();}});
 addEventListener('betterCodex:authentication-required',()=>{authEpoch++;authLocked=true;token=null;definitions=null;snapshots.clear();if(view){view.controller?.destroy();view.controller=null;view.content.replaceChildren();view.data=null;view.serialized=null;view.status.dataset.state='error';view.status.textContent='登录已过期，请重新登录后查看';}});
 addEventListener('betterCodex:session-ready',()=>{authLocked=false;});
 setTimeout(preload,1800);
 setInterval(()=>{if(document.visibilityState!=='visible'||!navigator.onLine)return;if(view)refreshCurrent();else preload();if(Date.now()-lastDefinitionsCheck>300000)fetchDefinitions().catch(()=>{});},refreshMs);
})();
