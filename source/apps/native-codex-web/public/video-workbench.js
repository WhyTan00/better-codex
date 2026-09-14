/* Professional video desk. No GPU control, task submission, or model configuration. */
(()=>{'use strict';
 const $=id=>document.getElementById(id),params=new URLSearchParams(location.search),scope=params.get('workspace')||'ai';
 if(scope!=='ai'){$('list-status').textContent='视频工作台仅属于 AI 工作区';return;}
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=String(text);if(cls)n.className=cls;return n;};
 const svg=(name,attrs={})=>{const n=document.createElementNS('http://www.w3.org/2000/svg',name);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;};
 const round=(v,d=0)=>typeof v==='number'&&Number.isFinite(v)?v.toLocaleString('zh-CN',{maximumFractionDigits:d}):'—';
 const when=s=>s?new Date(s).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'未采集';
 const bytes=n=>n>1024**3?round(n/1024**3,2)+' GB':round(n/1024**2,1)+' MB';
 const clock=s=>typeof s==='number'&&Number.isFinite(s)?String(Math.floor(s/60)).padStart(2,'0')+':'+String(Math.floor(s%60)).padStart(2,'0'):'—';
 const labels={UNREVIEWED:'未人工审核',PASS:'素材通过',SALVAGE:'部分可用',FAIL:'不通过',HOLD:'待判断',REPAIR:'需要修复',REDESIGN:'重新设计',DO_NOT_USE:'禁止使用',HARD_STOP_ROUTE:'路线级问题',WORKPRINT:'整片样片',EXPORT_UNVERIFIED:'母版导出 · 待验收',EXPORTED_NOT_QUALITY_APPROVED:'完整成片导出 · 待验收',TECHNICAL_PREVIEW:'原生技术预览',GENERATED:'已生成',H3:'H3',REMOTION:'Remotion',HYBRID:'Hybrid',UNKNOWN:'未分类'};
 const badge=(value,cls='')=>el('span',labels[value]||value,'badge '+(cls||(['PASS','SALVAGE'].includes(value)?'good':['FAIL','DO_NOT_USE','HARD_STOP_ROUTE'].includes(value)?'bad':['REPAIR','REDESIGN'].includes(value)?'warn':'')));
 let activeGroup=null,compareSequence=0;
 let token=null,tokenPromise=null,catalog=null,tab='material',loading=false,listSequence=0,detailSequence=0,selected=null,pendingFeedback=null,telemetryBusy=false,lastGpu=null,toastTimer=null,nextOffset=null,renderSignature='';
 const tickets=new Map(),drafts=new Map(),posterTasks=[];let postersRunning=0;
 const observer='IntersectionObserver'in window?new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){observer.unobserve(e.target);posterTasks.push(e.target);pumpPosters();}},{rootMargin:'160px'}):null;
 const toast=text=>{$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);};
 async function session(){if(token)return token;if(!tokenPromise)tokenPromise=fetch('/api/context',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspace:scope}),cache:'no-store',redirect:'manual'}).then(async r=>{if(!r.ok)throw Error('工作台登录或连接已失效，请返回 APP 重新打开');return (await r.json()).token;}).then(v=>token=v).finally(()=>tokenPromise=null);return tokenPromise;}
 async function api(endpoint,{method='GET',body=null,renew=true}={}){
  const credential=await session(),r=await fetch('/api/w/ai/video-workbench/'+endpoint,{method,headers:{authorization:'Bearer '+credential,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store',redirect:'manual'});
  if(r.status===401&&renew&&method==='GET'){token=null;return api(endpoint,{method,body,renew:false});}
  let value;try{value=await r.json();}catch{throw Error('连接已中断或需要重新登录，当前内容已保留');}
  if(!r.ok){const error=Error(value.error||'请求未完成');error.status=r.status;throw error;}return value;
 }
 async function ticket(item){const key=item.id+':'+item.revision,old=tickets.get(key);if(old&&old.expiresAt>Date.now()+60000)return old;const t=await api('assets/'+item.id+'/ticket',{method:'POST'});if(t.revision!==item.revision)throw Error('素材已变化，请刷新后打开');tickets.set(key,t);return t;}
 function pumpPosters(){while(postersRunning<3&&posterTasks.length){const target=posterTasks.shift();if(!target.isConnected)continue;postersRunning++;const item=target._item;ticket(item).then(t=>new Promise(resolve=>{if(!target.isConnected){resolve();return;}const img=el('img');img.alt=item.title+'的预览帧';img.decoding='async';img.onload=()=>{target.querySelector('.poster-empty')?.remove();target.prepend(img);resolve();};img.onerror=resolve;img.src=t.posterUrl;setTimeout(resolve,25000);})).catch(()=>{}).finally(()=>{postersRunning--;pumpPosters();});}}
 function makeCard(item){const card=el('button',null,'asset-card');card.type='button';card.setAttribute('aria-label','查看 '+item.title);const thumb=el('div',null,'thumbnail');thumb._item=item;thumb.append(el('span','▱','poster-empty'),el('span','▶','play'),el('span',labels[item.lane]||item.lane,'lane'),el('span',item.durationSeconds!=null?clock(item.durationSeconds):bytes(item.bytes),'duration'));
  const body=el('div',null,'card-body');body.append(el('h3',item.title),el('p',item.productionTitle,'card-project'));if(item.versionCount){body.append(el('p',item.versionCount+' 个制作版本 · '+item.fileCount+' 个输出文件','version-count'));if(item.groupingConfidence==='unresolved')body.append(el('p','归属待确认 · 暂独立保留','small muted'));}const bottom=el('div',null,'card-bottom');bottom.append(badge(item.humanVerdict!=='UNREVIEWED'?item.humanVerdict:['workprint','export'].includes(item.category)?item.status:'UNREVIEWED'),el('span',when(item.latestGeneratedAt||item.generatedAt||item.updatedAt),'card-date'));body.append(bottom);card.append(thumb,body);card.onclick=()=>openDetail(item);if(observer)observer.observe(thumb);else{posterTasks.push(thumb);setTimeout(pumpPosters,0);}return card;}
 function chooseProduction(id){$('production').value=id;const u=new URL(location.href);u.searchParams.set('production',id);history.replaceState(history.state,'',u);renderSignature='';loadCatalog();}
 function updateOptions(productions){
  const select=$('production'),old=select.value;
  const valid=id=>productions.some(p=>p.id===id);
  const selected=(valid(old)?old:valid(params.get('production'))?params.get('production'):'')||(productions.find(p=>p.id==='sun-jingtian')||productions[0])?.id||'';
  select.replaceChildren();for(const p of productions)select.add(new Option(p.title+' · '+p.count,p.id));select.value=selected;
  const nav=$('production-nav');nav.replaceChildren();
  for(const p of productions){const button=el('button',null,'production-chip');button.type='button';button.setAttribute('aria-current',String(p.id===selected));button.append(el('strong',p.title),el('small',p.count+' 个输出文件'));button.onclick=()=>chooseProduction(p.id);nav.append(button);}
  return old!==selected;
 }

 function renderJobs(jobs){const holder=$('jobs');holder.replaceChildren();for(const j of jobs||[]){const row=el('div',null,'job'),info=el('div');info.append(el('div',j.title,'job-title'),el('p',when(j.updatedAt)+(j.fresh?' · 近期状态记录':' · 历史记录，非实时进程证明'),'job-meta'));row.append(info,el('div',j.status,'job-status'));holder.append(row);}if(!jobs?.length)holder.append(el('p','还没有可读取的生产状态文件。','small muted'));}
 async function loadCatalog({append=false,silent=false}={}){
  const sequence=++listSequence;if(!silent){loading=true;$('list-status').textContent=append?'正在加载更多…':'正在读取项目生成产物…';}
  const query=new URLSearchParams({production:$('production').value,lane:$('lane').value,review:$('review').value,search:$('search').value,
   view:$('view-mode').value,sort:$('sort-order').value,category:tab==='films'?'films':'materials',kind:tab==='films'?'':$('material-kind').value,includeDiagnostics:$('experiments').checked?'1':'0',limit:'24',offset:append?String(nextOffset||0):'0'});
  try{const data=await api('catalog?'+query);if(sequence!==listSequence)return;catalog=data;nextOffset=data.nextOffset;if(updateOptions(data.productions)&&data.productions.length){loadCatalog({silent});return;}$('count-material').textContent=round(data.groupCounts?.material??data.counts.material);$('count-films').textContent=round(data.groupCounts?.films??data.counts.export);$('list-status').textContent=data.view==='groups'?`${round(data.total)} 个片段组 · 匹配 ${round(data.matchedFiles)} 个文件`:`${round(data.total)} 个文件 · 未聚合视图`;
   const signature=JSON.stringify(data.items.map(x=>[x.id,x.revision,x.humanVerdict,x.versionCount,x.fileCount]));if(append||signature!==renderSignature){if(!append){observer?.disconnect();$('grid').replaceChildren();posterTasks.length=0;}for(const item of data.items)$('grid').append(makeCard(item));renderSignature=append?'':signature;}
   $('empty').hidden=data.total>0;$('load-more').hidden=nextOffset===null;$('source-stamp').textContent='来源：VideoWorkbench · 最近扫描 '+when(data.sourceAsOf);renderJobs(data.jobs);
  }catch(e){if(sequence===listSequence)$('list-status').textContent=e.message;}finally{if(sequence===listSequence){loading=false;$('refresh').disabled=false;$('load-more').disabled=false;}}
 }
 function setTab(value){tab=value;for(const b of document.querySelectorAll('[data-tab]')){b.classList.toggle('active',b.dataset.tab===value);if(b.dataset.tab===value)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
  $('library').hidden=value==='monitor';$('monitor').hidden=value!=='monitor';$('film-note').hidden=value!=='films';$('experiments-label').hidden=value!=='material';if(value==='monitor')loadGpu();else{renderSignature='';loadCatalog();}const u=new URL(location.href);u.searchParams.set('tab',value);history.replaceState(history.state,'',u);}
 function metric(label,value,foot){const n=el('div',null,'telemetry-card');n.append(el('p',label,'metric-label'),el('div',value,'metric-value'),el('p',foot,'metric-foot'));return n;}
 function drawChart(history){const area=$('chart');area.replaceChildren();if(!history.length){area.append(el('p','尚无有效采样。连接恢复后显示真实使用率。','small muted'));return;}const graph=svg('svg',{viewBox:'0 0 580 170',role:'img','aria-label':'本次打开期间 GPU 实际使用率曲线'});
  for(const y of [0,50,100]){const py=140-y*1.2;graph.append(svg('line',{x1:33,y1:py,x2:575,y2:py,class:'gridline'}));const t=svg('text',{x:0,y:py+4});t.textContent=y+'%';graph.append(t);}
  const first=Date.parse(history[0].at),last=Date.parse(history.at(-1).at),span=Math.max(last-first,10000);let points=[],previous=null;
  const flush=()=>{if(points.length)graph.append(svg('polyline',{points:points.join(' '),class:'trace'}));points=[];};
  for(const h of history){if(h.usagePct==null){flush();continue;}const t=Date.parse(h.at),x=35+(t-first)/span*530,y=140-Math.max(0,Math.min(100,h.usagePct))*1.2;if(previous!==null&&t-previous>45000)flush();points.push(x+','+y);graph.append(svg('circle',{cx:x,cy:y,r:2.5,class:'dot'}));previous=t;}flush();
  for(const [x,s]of [[33,history[0].at],[450,history.at(-1).at]]){const t=svg('text',{x,y:164});t.textContent=new Date(s).toLocaleTimeString('zh-CN',{hour12:false});graph.append(t);}area.append(graph);$('history-label').textContent=history.length+' 个有效采样点';}
 function renderGpu(data){lastGpu=data;const live=data.status==='live',m=live?data:data.lastGood||data,tag=live?'实时采样':data.status==='stale'?'历史采样 · 已过期':'监控暂不可达';$('gpu-signal').className='signal '+(live?'live':data.status==='stale'?'stale':'');$('gpu-mini-name').textContent=m.gpuName||'RX 9070 XT';$('gpu-mini-status').textContent=tag+' · '+when(m.observedAt);$('gpu-mini-value').replaceChildren(document.createTextNode(round(m.usagePct,1)+(m.usagePct!=null?'%':'')),el('small',live?'GPU 使用率':'非实时值'));
  $('telemetry-status').textContent=tag+' · '+when(m.observedAt)+(data.refreshing?' · 正在取新值':'');$('telemetry-cards').replaceChildren(
   metric('GPU 使用率',round(m.usagePct,1)+(m.usagePct!=null?'%':''),live?'ADLX 实测，不等于采样进度':'缺失不以 0% 替代'),
   metric('显存占用',round(m.vramUsedMiB!=null?m.vramUsedMiB/1024:null,2)+(m.vramUsedMiB!=null?' GiB':''),m.vramTotalBytes!=null?'总量 '+round(m.vramTotalBytes/1024**3,1)+' GiB':'显存总量未返回'),
   metric('GPU 温度',round(m.temperatureC,1)+(m.temperatureC!=null?' °C':''),'热点 '+round(m.hotspotC,1)+(m.hotspotC!=null?' °C':'')),
   metric('整卡功耗',round(m.powerW,1)+(m.powerW!=null?' W':''),'频率 '+round(m.clockMHz)+' MHz · 风扇 '+round(m.fanRPM)+' RPM'));
  $('queues').replaceChildren();for(const q of data.queues||[]){const row=el('div',null,'queue-row'),name=el('div');name.append(el('strong','ComfyUI · '+q.port),el('small',q.available?'实时队列读取':'当前无法读取，不等于空闲'));row.append(name,el('div',q.available?round(q.running)+' 运行 / '+round(q.pending)+' 排队':'—','queue-count'));$('queues').append(row);}drawChart(data.history||[]);}
 async function loadGpu(){if(telemetryBusy||document.visibilityState==='hidden')return;telemetryBusy=true;try{renderGpu(await api('telemetry'));}catch{if(lastGpu)renderGpu({...lastGpu,status:'stale',lastGood:lastGpu.lastGood||lastGpu,queues:[]});else $('gpu-mini-status').textContent='监控连接失败 · 未推断空闲';}finally{telemetryBusy=false;}}
 function meta(label,value,code=false){const r=el('div',null,'meta-row');r.append(el('span',label),el(code?'code':'span',value??'未记录'));return r;}
 function preserveDraft(){if(!selected)return;drafts.set(selected.id+':'+selected.revision,{verdict:$('verdict').value,note:$('review-note').value,start:$('start-time').value,end:$('end-time').value});}
 function renderFeedback(d){const box=$('last-feedback');box.replaceChildren();if(!d.feedback){box.append(el('p','这个版本还没有人工审片记录。'));return;}box.append(badge(d.feedback.verdict),el('p',d.feedback.note||'已记录审核结论。'),el('small',when(d.feedback.createdAt)+(d.feedback.currentVersion?' · 当前视频版本':' · 旧版本反馈，不自动沿用')));}
 async function openDetail(item,{restore=false}={}){
  preserveDraft();const seq=++detailSequence;++compareSequence;activeGroup=null;$('version-list').replaceChildren();$('version-note').textContent='正在读取片段血缘…';$('comparison').replaceChildren();$('prompt-evidence').replaceChildren();$('rendition-select').replaceChildren();$('compare-version').replaceChildren();selected=item;pendingFeedback=null;$('asset-kicker').textContent=(labels[item.lane]||item.lane)+' / '+item.productionTitle;$('asset-title').textContent=item.title;$('player-status').hidden=false;$('player-status').textContent='正在读取视频…';$('player').pause();$('player').removeAttribute('src');$('player').load();$('download').hidden=true;$('asset-description').replaceChildren();$('asset-metadata').replaceChildren();$('last-feedback').textContent='正在读取版本与反馈…';$('save-review').disabled=true;$('save-status').textContent='';
  const draft=drafts.get(item.id+':'+item.revision);$('verdict').value=draft?.verdict||'PASS';$('review-note').value=draft?.note||'';$('start-time').value=draft?.start||'';$('end-time').value=draft?.end||'';
  if(!$('asset-dialog').open)$('asset-dialog').showModal();if(!restore){const u=new URL(location.href);u.searchParams.set('asset',item.id);history.pushState({...history.state,videoAsset:item.id},'',u);}
  const media=ticket(item).then(t=>{if(seq!==detailSequence)return;$('player').src=t.videoUrl;$('download').href=t.downloadUrl;$('download').hidden=false;}).catch(e=>{if(seq===detailSequence){$('player-status').textContent=e.message;}});
  try{const d=await api('assets/'+item.id);if(seq!==detailSequence)return;selected=d;const badges=el('div',null,'badges');badges.append(badge(d.status,'accent'),badge(d.humanVerdict));$('asset-description').append(badges,el('p',d.intention||d.dialogue||d.sourceNote));if(d.quality==='NATIVE_PREVIEW')$('asset-description').append(el('p','这是原生技术预览。画质终审仍以 raw PNG / PNG 重建母版为准。'));if(d.probeError)$('asset-description').append(el('p','媒体元数据暂不可读，尚未证明此文件完整可播放。'));
   const v=d.video,a=d.audio;$('asset-metadata').append(meta('时长',round(d.durationSeconds,3)+' 秒'),meta('画面',v?`${v.width} × ${v.height} · ${v.r_frame_rate} fps · ${v.codec_name}`:'未读取'),meta('声音',a?`${a.codec_name} · ${a.sample_rate} Hz · ${a.channels} 声道`:'无音轨或元数据未读取'),meta('文件大小',bytes(d.bytes)),meta('生成时间',when(d.generatedAt)+(d.timeSource==='file_mtime_fallback'?'（文件时间回退）':'')),meta('输出文件时间',when(d.updatedAt)+'（文件修改时间）'),meta('技术状态',d.technicalStatus),meta('素材编号',d.takeId||d.id,true),meta('归档位置',d.canonicalPath||d.relativePath,true),meta('元数据文件',d.metadataPath,true),meta('画面分镜',d.visualShotTitle||d.groupTitle),meta('原剧情用途',d.storyUsage?.title),meta('本版台词',(d.storyUsage?.dialogue||[]).join(' / ')),meta('剧本／制作分支',d.storyRevision),meta('相对来源',d.relativePath,true),meta('SHA-256',d.mediaSha256,true));renderFeedback(d);renderLineage(d);$('save-review').disabled=false;api('groups/'+d.groupId).then(g=>{if(seq===detailSequence){activeGroup=g;renderVersions();}}).catch(e=>{if(seq===detailSequence)$('version-note').textContent=e.message;});
  }catch(e){if(seq===detailSequence)$('last-feedback').textContent=e.message;}await media;
 }
 function versionTime(v){return when(v.generatedAt)+(v.timeSource==='file_mtime_fallback'?' · 文件时间（回退）':' · 生成记录');}
 function switchAsset(file){const u=new URL(location.href);u.searchParams.set('asset',file.id);history.replaceState({...history.state,videoAsset:file.id},'',u);openDetail(file,{restore:true});}
 function renderVersions(){
  const g=activeGroup,d=selected;if(!g||!d)return;
  $('version-heading').textContent=g.versionCount+' 个制作版本 · '+g.fileCount+' 个文件';
  $('version-note').textContent=(g.visualGrouping?'按同一视觉分镜 / 构图聚合；不同台词、声线和剧情用途保留在版本里（'+g.storyUsageCount+' 种用途），不再各自拆卡。':g.groupingConfidence==='unresolved'?'缺少可靠分组依据，暂时独立保留。':g.groupingConfidence==='confirmed'?'按显式片段标识 / 修复关系聚合。':'按作品内的分镜族及实际源素材关系聚合；分支、画幅和修复版本不再拆成作品。')+' 最新不等于最佳；审核只属于选中的文件。';
  const versions=[...g.versions];if($('version-order').value==='newest')versions.reverse();$('version-list').replaceChildren();
  for(const v of versions){const b=el('button',null,'version-card');b.type='button';b.setAttribute('aria-current',String(d.versionId===v.id));b.append(el('strong','版本 '+v.ordinal),el('span',v.label,'version-label'),el('small',versionTime(v)),el('small',v.files.length+' 个输出 · '+(v.promptStatus==='available'?'有 Prompt 快照':'Prompt 未留存')));if(v.dialogues?.length)b.append(el('small','台词：'+v.dialogues.join(' / ').slice(0,180),'version-dialogue'));if(v.storyUsages?.length)b.append(el('small','用途：'+v.storyUsages.map(u=>u.title||u.shot_id).join(' / ').slice(0,120),'version-usage'));b.onclick=()=>switchAsset(v.files.find(f=>f.id===v.representativeId)||v.files[0]);$('version-list').append(b);}
  const current=g.versions.find(v=>v.id===d.versionId);$('rendition-select').replaceChildren();for(const file of current?.files||[]){$('rendition-select').add(new Option((file.rendition||'视频')+' · '+when(file.updatedAt)+' · '+file.fileName,file.id));}$('rendition-select').value=d.id;
  $('compare-version').replaceChildren(new Option('不比较，仅查看当前版本',''));for(const v of g.versions){if(v.id===d.versionId)continue;$('compare-version').add(new Option('第 '+v.ordinal+' 次 · '+v.label,v.representativeId));}$('compare-version').value=d.comparison?.beforeAssetId||'';
 }
 function renderLineage(d){
  const l=d.lineage||{};$('recorded-change').textContent=l.changeNote?'当时记录的修改说明：'+l.changeNote:'未留存人工修改说明；下面只展示快照中可核实的差异，不补造修改原因。';
  const holder=$('prompt-evidence');holder.replaceChildren();
  if(!l.prompts?.length)holder.append(el('p','未找到与此 take 关联的 Prompt 快照；不会拿当前计划倒填历史。','small muted'));
  for(const p of l.prompts||[]){const row=el('section',null,'prompt-block');row.append(el('h4',p.name),el('p',(p.binding==='submitted_history'?'来自实际提交的 ComfyUI history':p.binding==='hash_verified'?'记录哈希已核对':p.binding==='snapshot_hash_unverified'?'哈希未核对通过，不视为精确执行凭证':'取自该 take 的本地快照；无独立执行哈希保证')+(p.truncated?' · 长文本已截取':''),'small muted'),el('pre',p.text),el('p','来源：'+p.source,'source-path'),el('p','SHA-256：'+p.sha256,'source-path'));holder.append(row);}
  if(l.parameters){const section=el('details'),sum=el('summary','本版本生成参数');section.append(sum);for(const[k,v]of Object.entries(l.parameters))section.append(meta(k,String(v)));holder.append(section);}
  if(l.references?.length){const section=el('details');section.append(el('summary','本版本参考输入 Refer'));for(const r of l.references)section.append(meta(r.slot||r.role||'参考',r.name+' · '+(r.status||'已留存')+(r.sha256?' · SHA '+r.sha256:'')));holder.append(section);}else holder.append(el('p','参考输入未留存或此剪辑版本无新增参考；不倒填历史。','small muted'));
  if(d.metadataCompleteness)holder.append(el('p','元数据完整性：'+Object.entries(d.metadataCompleteness).map(([k,v])=>k+'='+v).join(' · '),'small muted'));
  renderComparison(d.comparison);
 }
 function renderComparison(c){
  const box=$('comparison');box.replaceChildren();if(!c){box.append(el('p','首个记录或未选择比较基线。可展开查看该版本的 Prompt。','small muted'));return;}
  box.append(el('p',c.summary,'comparison-summary'));
  if(c.sameGeneration)box.append(el('p','当前比较的是同一次生成的两个输出文件，不是重新生成。','small muted'));
  if(c.parameters?.length){const list=el('div',null,'parameter-diff');for(const p of c.parameters){const row=el('div',null,'parameter-row');row.append(el('strong',p.key),el('span',String(p.before??'未记录')+' → '+String(p.after??'未记录')));list.append(row);}box.append(list);}
  if(c.referencesChanged){const names=a=>(a||[]).map(x=>x.slot+': '+x.name).join('；')||'未记录';box.append(el('p','参考输入变化：'+names(c.beforeReferences)+' → '+names(c.afterReferences),'small'));}
  if(c.prompt?.changed){box.append(el('p','Prompt 差异：− 为基线内容，+ 为当前内容；共同前后文折叠。','small muted'));const area=el('div',null,'prompt-diff');if(c.prompt.prefix){const t=el('details');t.append(el('summary','相同前文'),el('pre',c.prompt.prefix));area.append(t);}if(c.prompt.removed)area.append(el('pre','− '+c.prompt.removed,'diff-removed'));if(c.prompt.added)area.append(el('pre','+ '+c.prompt.added,'diff-added'));if(c.prompt.suffix){const t=el('details');t.append(el('summary','相同后文'),el('pre',c.prompt.suffix));area.append(t);}box.append(area);}
 }
 $('version-order').onchange=renderVersions;
 $('rendition-select').onchange=()=>{const f=activeGroup?.versions.flatMap(v=>v.files).find(f=>f.id===$('rendition-select').value);if(f)switchAsset(f);};
 $('compare-version').onchange=async()=>{const other=$('compare-version').value,d=selected,seq=++compareSequence;if(!other){renderComparison(null);return;}const box=$('comparison');box.textContent='正在比较版本快照…';try{const c=await api('assets/'+d.id+'/compare?with='+encodeURIComponent(other));if(seq===compareSequence&&selected?.id===d.id)renderComparison(c);}catch(e){if(seq===compareSequence)box.textContent=e.message;}};
 function closeDetail(fromHistory=false){preserveDraft();++detailSequence;selected=null;$('player').pause();$('player').removeAttribute('src');$('player').load();$('asset-dialog').close();if(!fromHistory&&history.state?.videoAsset)history.back();}
 $('close-detail').onclick=()=>closeDetail();$('asset-dialog').addEventListener('cancel',e=>{e.preventDefault();closeDetail();});
 $('player').addEventListener('loadedmetadata',()=>{$('player-status').hidden=true;});$('player').addEventListener('error',()=>{if($('player').getAttribute('src')){$('player-status').hidden=false;$('player-status').textContent='视频加载失败，可重新打开或下载原文件。';}});
 $('player').addEventListener('timeupdate',()=>{const t=$('player').currentTime;$('player-time').textContent=clock(t)+'.'+String(Math.floor((t%1)*1000)).padStart(3,'0');});
 $('capture-start').onclick=()=>{$('start-time').value=$('player').currentTime.toFixed(3);preserveDraft();};$('capture-end').onclick=()=>{$('end-time').value=$('player').currentTime.toFixed(3);preserveDraft();};
 $('review-form').addEventListener('input',()=>{pendingFeedback=null;preserveDraft();});
 $('review-form').onsubmit=async event=>{event.preventDefault();if(!selected?.mediaSha256)return;const d=selected,verdict=$('verdict').value,note=$('review-note').value.trim();
  if(!['PASS','HOLD'].includes(verdict)&&!note){$('save-status').textContent='请补充具体问题或可用区间说明。';return;}
  if(verdict==='SALVAGE'&&(!$('start-time').value||!$('end-time').value)){$('save-status').textContent='部分可用需要明确起点和终点。';return;}
  if(verdict==='HARD_STOP_ROUTE'&&!confirm('保存路线级问题，交导演处理未来计划；不会直接停止当前 GPU 任务。继续吗？'))return;
  if(!pendingFeedback)pendingFeedback={requestId:crypto.randomUUID(),assetId:d.id,revision:d.revision,mediaSha256:d.mediaSha256,previousFeedbackId:d.feedback?.id||null,verdict,note,startSeconds:$('start-time').value,endSeconds:$('end-time').value};
  const req=pendingFeedback;$('save-review').disabled=true;$('save-status').textContent='正在保存到项目…';
  try{const saved=await api('feedback',{method:'POST',body:req});pendingFeedback=null;drafts.delete(d.id+':'+d.revision);if(selected?.id===d.id){const f=saved.feedback;selected={...selected,humanVerdict:f.verdict,feedback:{id:f.feedback_id,verdict:f.verdict,note:f.note,createdAt:f.created_at,timeRange:f.time_range,currentVersion:true}};renderFeedback(selected);$('save-status').textContent='已保存，导演可读取这条版本绑定反馈。';}toast('审片反馈已保存');loadCatalog({silent:true});}
  catch(e){$('save-status').textContent=e.message+(e.status?'':'；再次点保存会查询/复用同一请求，不重复创建。');if(e.status===409){pendingFeedback=null;try{const fresh=await api('assets/'+d.id);if(selected?.id===d.id){selected=fresh;renderFeedback(fresh);}}catch{}}}finally{if(selected?.id===d.id)$('save-review').disabled=false;}
 };
 for(const b of document.querySelectorAll('[data-tab]'))b.onclick=()=>setTab(b.dataset.tab);$('gpu-peek').onclick=()=>setTab('monitor');
 $('refresh').onclick=()=>{$('refresh').disabled=true;loadCatalog();loadGpu();};for(const id of ['production','lane','review','experiments','view-mode','sort-order','material-kind'])$(id).onchange=()=>{renderSignature='';loadCatalog();};let debounce;$('search').oninput=()=>{clearTimeout(debounce);debounce=setTimeout(()=>{renderSignature='';loadCatalog();},280);};
 $('load-more').onclick=()=>{$('load-more').disabled=true;loadCatalog({append:true});};
 $('back-app').onclick=event=>{if(document.referrer&&new URL(document.referrer).origin===location.origin&&history.length>1){event.preventDefault();history.back();}};
 addEventListener('popstate',()=>{if($('asset-dialog').open&&!new URL(location.href).searchParams.get('asset'))closeDetail(true);});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){loadGpu();if(!loading)loadCatalog({silent:true});}});addEventListener('online',()=>{loadCatalog({silent:true});loadGpu();});
 let tick=0;setInterval(()=>{if(document.visibilityState!=='visible'||!navigator.onLine)return;loadGpu();if(++tick%3===0&&!loading&&!$('asset-dialog').open){if($('grid').children.length<=24)loadCatalog({silent:true});else $('list-status').textContent='正在浏览已加载页面；点顶部刷新获取最新素材，不打断当前浏览位置。';}},10000);
 if(['material','films','monitor'].includes(params.get('tab')))tab=params.get('tab');
 setTab(tab);if(tab==='monitor')loadCatalog({silent:true});loadGpu();
 const deep=params.get('asset');if(deep)api('assets/'+deep).then(d=>openDetail(d,{restore:true})).catch(e=>toast(e.message));
})();
