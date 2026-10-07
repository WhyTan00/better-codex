// Device opt-in and explicit updates; never infer permission or reload a live page.
(()=>{
 const scope=window.__DSH_SCOPE__;if(!scope)return;
 const fetcher=window.fetch.bind(window),base='/sync/v1/w/'+scope.id+'/';let registration=null,dialog=null,latest=null,available=false,previousFocus=null,previousInert=false,quotaCleanup=null,androidUpdateCleanup=null,cacheStatusCleanup=null,notificationCleanup=null;
 const node=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
 const button=(text,action)=>{const n=node('button',text);n.type='button';n.onclick=action;return n;};
 const deviceKey=()=>{const key=window.__DSH_DEVICE_SETTINGS__?.getDeviceKey();if(!key)throw Error('设备设置未就绪，请更新并重新打开应用');return key;};
 async function api(name,body,recipient=scope.id){const r=await fetcher('/sync/v1/w/'+recipient+'/'+name,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store',redirect:'manual'});if(r.status===401||r.type==='opaqueredirect')throw Error('请重新登录后再试');const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'暂时无法连接，请稍后再试');return data;}
 async function check(){try{const r=await fetcher('/dsh-native-release.json',{cache:'no-store',redirect:'manual'});if(!r.ok)throw Error();latest=await r.json();available=latest.version!==window.__DSH_UI_RELEASE__?.version||!!registration?.waiting;window.dispatchEvent(new CustomEvent('dsh:update-available',{detail:{available}}));return latest;}catch{throw Error('无法检查新版，请确认网络与登录状态');}}
 function prepare(worker,type){return new Promise((resolve,reject)=>{if(!worker)return reject(Error('更新尚未就绪，请稍后再试'));const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(Error('新版资源尚未准备好，请稍后再试'));},20000);channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();if(e.data?.ready)resolve(e.data);else reject(Error('新版资源下载失败，请稍后再试'));};worker.postMessage({type},[channel.port2]);});}
 async function installUpdate(){if(!registration&&'serviceWorker'in navigator)registration=await navigator.serviceWorker.getRegistration('/');if(!registration)throw Error('更新服务尚未就绪');await registration.update();if(registration.installing){const installing=registration.installing;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{installing.removeEventListener('statechange',changed);reject(Error('新版仍在下载，请稍后再试'));},20000);function changed(){if(!['installed','activated','redundant'].includes(installing.state))return;clearTimeout(timer);installing.removeEventListener('statechange',changed);if(installing.state==='redundant')reject(Error('新版下载未完成，请重试'));else resolve();}installing.addEventListener('statechange',changed);changed();});}const result=await prepare(registration.waiting||registration.active,'PREPARE_NATIVE_CACHE');if(latest&&result.version!==latest.version)throw Error('新版仍在同步，请稍后再试');if(registration.waiting){const worker=registration.waiting;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{navigator.serviceWorker.removeEventListener('controllerchange',done);reject(Error('切换新版超时，请重新打开应用'));},12000);function done(){clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',done);resolve();}navigator.serviceWorker.addEventListener('controllerchange',done);worker.postMessage({type:'ACTIVATE_UPDATE'});});}location.reload();}
 function quotaSection(container){
  const heading=node('h3','账户额度'),body=node('div'),status=node('small','正在读取官方额度…');body.className='dsh-quota';container.append(heading,node('small','只读显示；此页面打开时每分钟自动更新。'),body,status);
  let snapshot=null,pending=false,closed=false,lastError=null;
  const duration=mins=>mins===10080?'每周':mins>=1440?(mins/1440)+' 天':mins>=60?(mins/60)+' 小时':mins+' 分钟';
  function render(value,cached){if(closed)return;snapshot=value;body.replaceChildren();for(const bucket of value.data.buckets||[]){body.append(node('p',bucket.name+(bucket.plan?' · '+bucket.plan.toUpperCase():'')));for(const window of [bucket.primary,bucket.secondary]){if(!window||!Number.isFinite(window.usedPercent))continue;const remaining=Math.max(0,Math.min(100,100-window.usedPercent)),line=node('div',duration(window.windowDurationMins)+'额度剩余 '+remaining+'%'),meter=node('progress');meter.max=100;meter.value=remaining;meter.setAttribute('aria-label',line.textContent);body.append(line,meter);if(Number.isFinite(window.resetsAt))body.append(node('small',new Date(window.resetsAt*1000).toLocaleString('zh-CN')+' 重置'));}if(bucket.credits?.unlimited)body.append(node('div','额外额度：不限量'));else if(bucket.credits?.balance!=null)body.append(node('div','额外额度余额：'+bucket.credits.balance));}
   if(Number.isFinite(value.data.resetsAvailable))body.append(node('p','可用额度重置：'+value.data.resetsAvailable+' 次'));
   if(!value.data.buckets?.length)body.append(node('p','官方暂未返回额度明细'));
   status.textContent=(cached?'缓存 · 最近读取 ':'已更新 · ')+new Date(value.checkedAt).toLocaleString('zh-CN')+(cached&&lastError?'；'+lastError:'');
  }
  async function load(){if(closed||pending||document.visibilityState==='hidden')return;pending=true;try{const read=window.__DSH_READ_ACCOUNT_LIMITS__;if(!read)throw Error('账户连接尚未就绪，连接后会自动更新');const value=await read();lastError=null;render(value,false);}catch(error){lastError=error.message||'额度暂时不可用';if(!closed)status.textContent=(snapshot?'缓存 · 最近读取 '+new Date(snapshot.checkedAt).toLocaleString('zh-CN')+'；':'')+lastError;}finally{pending=false;}}
  const changed=event=>{if(!closed&&document.visibilityState!=='hidden'&&event.detail?.data)render(event.detail,false);},resume=()=>{if(!snapshot||Date.now()-snapshot.checkedAt>=60000)load();};
  const timer=setInterval(load,60000);document.addEventListener('visibilitychange',resume);addEventListener('online',resume);addEventListener('dsh:quota-updated',changed);addEventListener('dsh:quota-invalidated',load);addEventListener('dsh:session-ready',resume);
  const cached=window.__DSH_NATIVE_CACHE__?.meta('account-quota-v1');Promise.resolve(cached).then(value=>{if(value&&!snapshot)render(value,true);}).catch(()=>{});load();
  return ()=>{closed=true;clearInterval(timer);document.removeEventListener('visibilitychange',resume);removeEventListener('online',resume);removeEventListener('dsh:quota-updated',changed);removeEventListener('dsh:quota-invalidated',load);removeEventListener('dsh:session-ready',resume);};
 }
 function setWorkerRecipient(reg,recipient){return new Promise((resolve,reject)=>{const worker=reg?.active;if(!worker)return reject(Error('请先更新应用并重新打开，再开启通知'));const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(Error('请先更新应用并重新打开，再开启通知'));},4000);channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();e.data?.recipient===recipient?resolve():reject(Error('通知归属未保存，请重试'));};worker.postMessage({type:'SET_NOTIFICATION_RECIPIENT',recipient},[channel.port2]);});}
 async function notificationSection(container){
  const ownerLabel=node('h3','这台设备的使用者'),select=node('select'),save=button('保存使用者',()=>{}),ownerInfo=node('p','正在读取设备归属…');select.setAttribute('aria-label','这台设备的使用者');for(const [value,label] of [['','请选择'],...(scope.workspaces?.map(({id,label})=>[id,label])||[['ai','Workspace']])]){const option=node('option',label);option.value=value;select.append(option);}select.disabled=save.disabled=true;container.append(ownerLabel,select,save,ownerInfo,node('small','临时切换工作区不会改变通知归属。更换使用者后需要重新开启通知。'));
  const info=node('p','正在检查通知状态…'),toggle=button('开启完成通知',()=>{}),test=button('发送测试通知',()=>{}),receipt=node('p','');toggle.disabled=test.disabled=true;container.append(node('h3','会话完成通知'),info,node('small','锁屏只显示完成提醒，不显示对话正文。'),node('br'),toggle,test,receipt);
  const supported='serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;
  let state=null,config=null,confirmOwner=null,busy=false;
  const name=id=>scope.workspaces?.find(ws=>ws.id===id)?.label||('Workspace');
  function paint(){const recipient=state?.recipient||'';select.value=recipient;select.disabled=false;save.disabled=true;save.textContent='保存使用者';confirmOwner=null;ownerInfo.textContent=recipient?'此设备属于 '+name(recipient)+'；只接收 '+recipient.toUpperCase()+' 工作区的完成提醒。':'请先选择设备使用者，再开启通知。';toggle.textContent=state?.enabled?'关闭完成通知':'开启完成通知';toggle.disabled=!recipient||(!state?.enabled&&!supported);test.disabled=!state?.enabled||!supported;info.textContent=!recipient?'尚未选择通知归属':!supported?'此浏览器暂不支持后台通知':Notification.permission==='denied'?'通知被浏览器阻止，请在站点设置中允许':state.enabled?'已开启 '+recipient.toUpperCase()+' 工作区的完成通知':'尚未开启完成通知';if(state?.lastReceivedAt)receipt.textContent='设备最近确认收到：'+new Date(state.lastReceivedAt).toLocaleString('zh-CN');}
  async function refresh(){state=await api('push-status',{deviceKey:deviceKey()});if(state.recipient)window.__DSH_DEVICE_SETTINGS__?.setOwner(state.recipient);paint();return state;}
  select.addEventListener('change',()=>{confirmOwner=null;save.textContent='保存使用者';save.disabled=!select.value||select.value===state?.recipient;});
  save.onclick=async()=>{const recipient=select.value;if(busy||!['ai','zyy'].includes(recipient)||recipient===state?.recipient)return;if(state?.recipient&&confirmOwner!==recipient){confirmOwner=recipient;ownerInfo.textContent='确认改为 '+name(recipient)+'？本机现有通知将关闭。';save.textContent='确认切换并关闭通知';return;}busy=true;save.disabled=select.disabled=true;try{await api('push-device-owner',{deviceKey:deviceKey(),recipient});window.__DSH_DEVICE_SETTINGS__?.setOwner(recipient);if(supported){const reg=registration||await navigator.serviceWorker.getRegistration('/');if(reg)await setWorkerRecipient(reg,recipient).catch(()=>{});}await refresh();}catch(error){ownerInfo.textContent=error.message;save.disabled=false;select.disabled=false;}finally{busy=false;}};
  try{config=await api('push-config');if(!config.available)throw Error('通知服务尚未就绪');await refresh();}catch(error){ownerInfo.textContent=error.message;info.textContent='通知设置暂时无法读取';return;}
  toggle.onclick=async()=>{if(busy||!state?.recipient)return;busy=true;toggle.disabled=select.disabled=save.disabled=true;const recipient=state.recipient;try{if(state.enabled){await api('push-disable',{deviceKey:deviceKey()},recipient);}else{if(registration?.waiting)throw Error('请先更新应用并重新打开，再开启通知');if(Notification.permission==='denied')throw Error('请先在浏览器的站点设置中允许通知');const permission=await Notification.requestPermission();if(permission!=='granted')throw Error('尚未允许通知，未开启');const reg=registration||await navigator.serviceWorker.ready;await setWorkerRecipient(reg,recipient);let subscription=await reg.pushManager.getSubscription();if(!subscription){const raw=atob(config.publicKey.replace(/-/g,'+').replace(/_/g,'/'));subscription=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(raw,c=>c.charCodeAt(0))});}await api('push-subscribe',{deviceKey:deviceKey(),recipient,subscription:subscription.toJSON()},recipient);}await refresh();}catch(error){info.textContent=error.message;}finally{busy=false;toggle.disabled=!state?.recipient||(!state?.enabled&&!supported);select.disabled=false;}};
  test.onclick=async()=>{if(busy||!state?.enabled)return;test.disabled=true;const recipient=state.recipient;try{const result=await api('push-test',{deviceKey:deviceKey()},recipient);receipt.textContent='测试通知已排队，正在等待本机接收回执…';let tries=0;const poll=async()=>{if(dialog!==container||++tries>10){if(dialog===container)receipt.textContent='尚未收到本机回执，请检查系统通知权限和网络后再试';test.disabled=false;return;}try{const status=await api('push-status',{deviceKey:deviceKey()},recipient);if(status.lastReceivedJob===result.jobId){receipt.textContent='本机已确认收到测试通知';test.disabled=false;return;}if(status.lastFailure){receipt.textContent='通知发送失败：'+status.lastFailure;test.disabled=false;return;}}catch{}setTimeout(poll,2000);};setTimeout(poll,2000);}catch(error){receipt.textContent=error.message;test.disabled=false;}};
 }
 function androidNotificationSection(container,android){
  const section=node('section'),select=node('select'),save=button('保存使用者',()=>{}),ownerInfo=node('p','正在读取设备归属…'),toggle=button('开启完成提醒',()=>{}),info=node('p');
  section.className='dsh-device-owner';select.setAttribute('aria-label','设备使用者');ownerInfo.setAttribute('role','status');info.setAttribute('role','status');
  for(const [value,label]of [['','请选择'],...(scope.workspaces?.map(({id,label})=>[id,label])||[['ai','Workspace']])]){const option=node('option',label);option.value=value;select.append(option);}
  section.append(node('h3','设备使用者'),select,save,ownerInfo,node('small','此 App 只接收所选使用者工作区的完成提醒。临时切换工作区不会改变归属。更换使用者会关闭旧提醒与后台同步。'),node('h3','任务完成提醒'),toggle,info);
  container.append(section);select.disabled=save.disabled=toggle.disabled=true;
  let state=null,busy=false,reading=false,closed=false,confirmed=null,supported=false,edited=false,settingsEpoch=0;
  const ownerName=id=>scope.workspaces?.find(ws=>ws.id===id)?.label||('Workspace');
  function paint(){if(closed)return;select.disabled=!supported||busy;select.value=state?.owner||'';save.disabled=true;save.textContent='保存使用者';confirmed=null;edited=false;toggle.disabled=!supported||busy||!state?.owner;toggle.textContent=state?.enabled?'关闭完成提醒':'开启完成提醒';
   if(!supported){ownerInfo.textContent='请更新至 App 1.0.8 或更新版本，再设置使用者。';info.textContent='在下方“应用与后台”检查应用更新。';return;}
   ownerInfo.textContent=state.owner?'已绑定 '+ownerName(state.owner)+'；提醒固定归属 '+state.owner.toUpperCase()+'。':'请明确选择这台设备的使用者。';
   info.textContent=!state.owner?'选择后再开启完成提醒。':!state.enabled?'完成提醒已关闭；开启后将在后台同步 '+state.owner.toUpperCase()+' 工作区。':!state.systemAllowed?'提醒开关已开启，但系统尚未允许通知；请在“应用与后台”打开系统通知设置。':state.syncRunning&&state.syncScope===state.owner?'已开启 '+state.owner.toUpperCase()+' 完成提醒；后台同步运行中。':'完成提醒已开启，后台同步尚未确认运行；可在“应用与后台”查看。';
  }
  async function refresh(){if(closed||busy||reading||edited||document.visibilityState==='hidden')return;reading=true;const epoch=settingsEpoch;try{const value=await android.status();if(closed||busy||edited||epoch!==settingsEpoch)return;supported=value.notificationOwnerSupported===true&&typeof android.setDeviceOwner==='function'&&typeof android.setCompletionNotifications==='function';state=value.notificationSettings||null;if(supported&&!state)throw Error('设备归属尚未读取，请稍后重试');paint();}catch(error){if(!closed)ownerInfo.textContent=error.message||'设备归属暂不可读';}finally{reading=false;}}
  select.onchange=()=>{edited=select.value!==state?.owner;confirmed=null;save.textContent='保存使用者';save.disabled=busy||!select.value||select.value===state?.owner;toggle.disabled=edited||!state?.owner;};
  save.onclick=async()=>{const owner=select.value;if(busy||!supported||!['ai','zyy'].includes(owner)||owner===state?.owner)return;if(state?.owner&&confirmed!==owner){confirmed=owner;ownerInfo.textContent='确认更换为 '+ownerName(owner)+'？将关闭原提醒与后台同步。';save.textContent='确认更换使用者';return;}busy=true;settingsEpoch++;select.disabled=save.disabled=toggle.disabled=true;try{state=await android.setDeviceOwner(owner);paint();}catch(error){ownerInfo.textContent=error.message||'使用者未保存，请重试';}finally{busy=false;if(!closed){select.disabled=!supported;save.disabled=!select.value||select.value===state?.owner;toggle.disabled=!supported||edited||!state?.owner;}}};
  toggle.onclick=async()=>{if(busy||edited||!supported||!state?.owner)return;busy=true;settingsEpoch++;select.disabled=save.disabled=toggle.disabled=true;try{state=await android.setCompletionNotifications(!state.enabled);paint();}catch(error){info.textContent=error.message||'提醒设置未完成，请重试';}finally{busy=false;if(!closed){select.disabled=!supported;toggle.disabled=!state?.owner;}}};
  const focus=()=>refresh(),timer=setInterval(()=>{if(!closed)refresh();},3000);addEventListener('focus',focus);refresh();
  return()=>{closed=true;clearInterval(timer);removeEventListener('focus',focus);};
 }

 function androidUpdateSection(container,android){
  const status=node('p','正在检查界面版本…'),versions=node('small'),help=node('small');status.setAttribute('role','status');
  let closed=false,busy=false,manifest=null,lastCheck=0;
  const current=window.__DSH_UI_RELEASE__?.version;
  async function refresh(manual=false){
   if(closed||busy)return;busy=true;checkButton.disabled=true;if(manual)status.textContent='正在检查界面版本…';
   try{
    if(manual||!manifest||Date.now()-lastCheck>30000){const response=await fetcher('/android/ui-release.json',{cache:'no-store',redirect:'manual'});if(response.status===401||response.status===303||response.type==='opaqueredirect')throw Error('登录已过期，请重新登录后检查更新');if(!response.ok)throw Error('版本检查未完成，请检查网络后重试');const value=await response.json();if(!/^[a-f0-9]{16}$/.test(value.version||''))throw Error('未取得有效界面版本，请稍后重试');manifest=value;lastCheck=Date.now();}
    const native=await android.status();if(closed)return;
    const saved=native.uiReleaseVersion;
    versions.textContent='当前 '+(current?.slice(0,8)||'未知')+' · 已下载 '+(saved?.slice(0,8)||'未知')+' · 最新 '+manifest.version.slice(0,8);
    if(current===manifest.version){status.textContent='当前已是最新界面';help.textContent='无需重复更新。';}
    else if(saved===manifest.version){status.textContent='新版已下载完成，重新打开 App 后生效';help.textContent='从最近任务划掉 App，再重新打开；只刷新页面不会切换版本。';}
    else{status.textContent='发现新版，尚未确认下载完成';help.textContent='进入“应用与后台”点“检查界面更新”，然后关闭该窗口回到这里查看结果。下载中或更新失败时，旧按钮可能没有提示。';}
   }catch(error){if(!closed){status.textContent=error.message||'检查未完成，请重试';help.textContent='未确认更新成功。';}}
   finally{busy=false;if(!closed)checkButton.disabled=false;}
  }
  const checkButton=button('检查界面状态',()=>refresh(true));
  container.append(node('h3','界面更新'),status,versions,node('br'),help,node('br'),checkButton);
  const onFocus=()=>refresh();addEventListener('focus',onFocus);
  const timer=setInterval(()=>{if(document.visibilityState==='visible')refresh();},3000);refresh(true);
  return()=>{closed=true;clearInterval(timer);removeEventListener('focus',onFocus);};
 }

 function cacheStatusSection(container){
  const section=node('section'),heading=node('h3','本机缓存'),intro=node('small','这台设备 · '+scope.id.toUpperCase()+' 工作区'),status=node('p','正在读取本机缓存…'),activity=node('p'),metrics=node('div'),storageLimit=node('p'),progressLabel=node('p'),progress=node('progress'),stamp=node('small'),nativeStatus=node('p');
  storageLimit.className='dsh-cache-note';
  section.className='dsh-cache-status';metrics.className='dsh-cache-metrics';status.setAttribute('role','status');activity.className='dsh-cache-activity';progress.max=1;progress.value=0;progress.setAttribute('aria-label','预载范围内已缓存的会话首屏');nativeStatus.className='dsh-cache-note';
  const refreshButton=button('刷新统计',()=>load()),details=node('details'),summary=node('summary','查看会话缓存'),filter=node('select'),list=node('div'),more=button('显示更多会话',()=>{limit+=30;paintRows();});filter.setAttribute('aria-label','缓存会话范围');
  for(const [value,label]of [['pinned','置顶会话'],['all','预载范围全部'],['pending','首屏未齐']]){const option=node('option',label);option.value=value;filter.append(option);}
  details.className='dsh-cache-details';list.className='dsh-cache-list';details.append(summary,filter,list,more);
  const pluginDetails=node('details'),pluginSummary=node('summary','插件与书架缓存'),pluginList=node('div');pluginDetails.className='dsh-cache-details';pluginList.className='dsh-cache-list';pluginDetails.append(pluginSummary,pluginList);
  const help=node('small','首屏已存的会话可直接从本机打开。未变化的内容不重复预载；更早历史和附件按需读取。');help.className='dsh-cache-note';
  section.append(heading,intro,status,metrics,storageLimit,progressLabel,progress,activity,nativeStatus,stamp,node('br'),refreshButton,details,pluginDetails,help);container.append(section);
  let snapshot=null,plugins=null,native=null,closed=false,locked=false,busy=false,lastRead=0,readTurn=0,limit=30,filterChosen=false,rows=new Map();
  const when=value=>value?new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'暂无确认时间';
  const bytes=value=>{if(value<1024)return Math.round(value)+' B';if(value<1048576)return (value/1024).toFixed(1)+' KB';if(value<1073741824)return (value/1048576).toFixed(1)+' MB';return (value/1073741824).toFixed(2)+' GB';};
  function metric(label,value){const box=node('div');box.append(node('strong',value),node('small',label));return box;}
  function live(){return window.__DSH_NATIVE_CACHE__?.localCacheActivity?.()||snapshot?.activity||{};}
  function rowState(row,state){
   if(state.currentThread===row.id&&state.busy)return state.stage==='head'?'正在缓存首屏':'正在补齐近期历史';
   if(state.preparing?.includes(row.id))return '正在准备显示';
   if(row.headChecked===false)return '首屏状态待核对';
   if(row.headReady&&row.localNewer)return '首屏已存 · 新内容待同步';
   if(row.renderReady)return '首屏已存 · 当前页面已载入';
   if(row.headReady&&state.prepareFailures?.some(error=>error.id===row.id))return '首屏已存 · 显示准备未完成';
   if(row.headReady)return '首屏已存 · 可直接打开';
   if(state.failures?.some(error=>error.id===row.id))return '预载未完成 · 等待重试';
   if(state.queued?.includes(row.id))return row.stored?'已存部分历史 · 等待补齐':'等待预载';
   return row.stored?'已存部分历史 · 首屏未齐':'尚未缓存首屏';
  }
  function paintRows(){
   if(!snapshot||closed)return;const state=live();let shown=snapshot.targets.filter(row=>filter.value==='pinned'?row.pinned:filter.value==='pending'?!row.headReady:true);
   summary.textContent='查看会话缓存（'+snapshot.targets.length+'）';const wanted=new Set(shown.slice(0,limit).map(row=>row.id));
   for(const [id,parts]of rows)if(!wanted.has(id)){parts.root.remove();rows.delete(id);}
   list.querySelector('[data-empty]')?.remove();
   for(const row of shown.slice(0,limit)){
    let parts=rows.get(row.id);if(!parts){const root=node('article'),title=node('strong'),stateLine=node('p'),info=node('small'),time=node('small');root.className='dsh-cache-row';root.append(title,stateLine,info,time);parts={root,title,stateLine,info,time};rows.set(row.id,parts);}
    parts.title.textContent=(row.pinned?'置顶 · ':'')+row.title;
    parts.stateLine.textContent=rowState(row,state);parts.root.dataset.ready=row.headReady?'true':'false';
    parts.info.textContent='已存 '+row.turns+' 个回合 · '+bytes(row.bytes)+' 内容记录';
    parts.time.textContent=row.confirmedAt?'历史最近确认 '+when(row.confirmedAt):'尚无首屏确认时间';list.append(parts.root);
   }
   if(!shown.length){const empty=node('p',filter.value==='pending'?'预载范围内的首屏都已存好':filter.value==='pinned'?'当前没有置顶会话':'暂时没有可统计的会话');empty.dataset.empty='1';list.append(empty);}
   more.hidden=shown.length<=limit;more.textContent='显示更多（还有 '+Math.max(0,shown.length-limit)+' 个）';
  }
  function paintActivity(){
   if(closed||!snapshot)return;const state=live(),title=id=>snapshot.targets.find(row=>row.id===id)?.title||'会话';
   const reasons={hidden:'App 不在前台，页面预载暂停',offline:'设备离线，等待网络恢复',host_offline:'宿主暂未连接，等待恢复',save_data:'省流量模式下暂停预载',foreground:'优先加载当前会话',interaction:'等待当前操作结束',visible:'当前会话由前台加载',backoff:'等待下一轮预载'};
   if(state.busy)activity.textContent='正在预载：'+title(state.currentThread)+' · '+(state.stage==='head'?'首屏':'近期历史');
   else if(state.preparing?.length)activity.textContent='正在准备显示：'+title(state.preparing[0]);
   else if(state.pending||state.prepareQueued)activity.textContent=(reasons[state.reason]||(!state.nativeReady?'等待会话界面就绪':'正在安排预载'))+(state.pending?' · 待缓存 '+state.pending+' 个':'')+(state.prepareQueued?' · 待准备显示 '+state.prepareQueued+' 个':'');
   else activity.textContent=state.prepareFailures?.length?'历史缓存队列已处理完；'+state.prepareFailures.length+' 个会话的显示准备未完成，进入会话时会继续读取。':'当前预载队列已处理完；发现新内容后会继续更新。';
   paintRows();
  }
  function paintPlugins(){
   pluginList.replaceChildren();if(!plugins){pluginList.append(node('p','插件本机状态暂不可用'));return;}
   const names={portfolio:'持仓',quant:'量化',agenda:'今日安排',cockpit:'工作台',video:'视频',fiction:'书架'};
   for(const plugin of plugins.items||[]){const row=node('article');row.className='dsh-cache-row';row.append(node('strong',names[plugin.id]||plugin.name));let text;
    if(plugin.loading)text='正在加载';else if(!plugin.cached)text='尚无本机缓存';else if(plugin.kind==='cipher')text=plugin.prepared?'加密书架已存 · 已准备显示':'加密书架已存';else if(plugin.kind==='entry')text='入口信息已存 · 视频内容按需加载';else text='本机快照已存';
    row.append(node('p',text));if(plugin.checkedAt)row.append(node('small',(plugin.kind==='cipher'?'最近准备 ':'最近保存 ')+when(plugin.checkedAt)));pluginList.append(row);
   }
   if(!plugins.items?.length)pluginList.append(node('p','本机尚未保存插件目录'));
  }
  function paintNative(){
   if(!window.__DSH_ANDROID_BRIDGE__){nativeStatus.textContent='统计来自当前浏览器的本机缓存。';return;}
   if(!native){nativeStatus.textContent='系统后台同步状态暂不可用；下方统计仍来自本机。';return;}
   if(native.scope!==scope.id){nativeStatus.textContent='设备工作区正在切换，等待本机同步状态更新。';return;}
   const base=native.enabled?(native.running?'系统后台同步已开启':'系统后台同步已开启，服务暂未运行'):'系统后台同步未开启';
   const currentGeneration=native.generation&&native.generation!=='uninitialized'&&native.generation===snapshot.androidImportedGeneration;
   nativeStatus.textContent=base+(currentGeneration&&Number.isSafeInteger(native.recordCursor)?(snapshot.androidImportedCursor>=native.recordCursor?' · 已接入当前本机同步数据':' · 正在接入后台已下载的数据'):'');
  }
  async function load(){
   if(closed||locked||busy||document.visibilityState==='hidden')return;busy=true;refreshButton.disabled=true;status.textContent=snapshot?'正在更新本机统计…':'正在读取本机缓存…';
   try{
    const cache=window.__DSH_NATIVE_CACHE__;if(!cache?.inspectLocalCache)throw Error('本机缓存尚未就绪，请稍后刷新');
    const turn=++readTurn,current=()=>!closed&&!locked&&turn===readTurn;
    // These optional readers must not hold the primary local statistics open.
    Promise.resolve().then(()=>window.__DSH_NATIVE_WORKBENCH__?.localCacheStatus?.()).then(value=>{if(current()){plugins=value;paintPlugins();}}).catch(()=>{if(current()){plugins=null;paintPlugins();}});
    Promise.resolve().then(()=>window.__DSH_ANDROID_BRIDGE__?.status?.()).then(value=>{if(current()){native=value;if(snapshot)paintNative();}}).catch(()=>{if(current()){native=null;if(snapshot)paintNative();}});
    const value=await cache.inspectLocalCache();if(!current())return;snapshot=value;lastRead=Date.now();
    if(!filterChosen){filter.value=snapshot.targets.some(row=>row.pinned)?'pinned':'all';filterChosen=true;}
    const unchecked=snapshot.targets.filter(row=>row.headChecked===false).length;
    metrics.replaceChildren(metric('已存历史会话',String(snapshot.historyThreadCount)),metric('本地内容记录约',bytes(snapshot.bytes)),metric(unchecked?'已确认首屏':'首屏已存',snapshot.headReady+' / '+snapshot.targets.length));
    const policy=snapshot.storagePolicy;storageLimit.textContent=policy?'展示缓存上限 '+bytes(policy.configuredBudgetBytes)+(policy.effectiveBudgetBytes<policy.configuredBudgetBytes?' · 按系统配额可用 '+bytes(policy.effectiveBudgetBytes):'')+(window.__DSH_ANDROID_BRIDGE__?' · 手机保存的历史正文单独持久保存':''):'缓存上限暂未取得';
    progress.max=Math.max(1,snapshot.targets.length);progress.value=snapshot.headReady;progressLabel.textContent='预载范围：置顶、运行中与最近 '+snapshot.recentLimit+' 个会话';
    status.textContent='当前界面可读取的本机历史；内容大小不含安装包、界面文件和后台尚未接入的数据。'+(unchecked?' 还有 '+unchecked+' 个会话的首屏状态待核对。':'');stamp.textContent='统计时间 '+when(snapshot.at)+' · 状态自动更新';paintActivity();paintPlugins();paintNative();
   }catch(error){if(!closed)status.textContent=(snapshot?'保留上次统计 · ':'')+(error.message||'本机统计暂时不可用，请重试');}
   finally{busy=false;if(!closed)refreshButton.disabled=false;}
  }
  filter.onchange=()=>{filterChosen=true;limit=30;paintRows();};
  const onNative=event=>{if(event.detail?.scope===scope.id&&event.detail.status){native=event.detail.status;if(snapshot)paintNative();}};
  const onLocked=()=>{locked=true;readTurn++;snapshot=null;plugins=null;native=null;rows.clear();metrics.replaceChildren();list.replaceChildren();pluginList.replaceChildren();activity.textContent=stamp.textContent=nativeStatus.textContent=progressLabel.textContent='';progress.value=0;status.textContent='请先登录后查看本机缓存';};
  const onSession=()=>{locked=false;load();};
  addEventListener('dsh:authentication-required',onLocked);addEventListener('dsh:session-ready',onSession);
  addEventListener('dsh:android-status',onNative);
  const timer=setInterval(()=>{if(document.visibilityState==='hidden')return;paintActivity();if(Date.now()-lastRead>=15000)load();},2000);load();
  return()=>{closed=true;clearInterval(timer);removeEventListener('dsh:android-status',onNative);removeEventListener('dsh:authentication-required',onLocked);removeEventListener('dsh:session-ready',onSession);};
 }
 function dismiss(){notificationCleanup?.();notificationCleanup=null;cacheStatusCleanup?.();cacheStatusCleanup=null;quotaCleanup?.();quotaCleanup=null;androidUpdateCleanup?.();androidUpdateCleanup=null;dialog?.remove();dialog=null;const app=document.getElementById('root');if(app)app.inert=previousInert;if(previousFocus?.isConnected)previousFocus.focus();}
 function close(){const ownsEntry=!!history.state?.dshPreferences;dismiss();if(ownsEntry)history.back();}
 async function open(options={}){if(dialog){dialog.querySelector('button')?.focus();return;}previousFocus=document.activeElement;const app=document.getElementById('root');previousInert=!!app?.inert;if(app)app.inert=true;history.pushState({...history.state,dshPreferences:true},'',location.href);dialog=node('div');dialog.className='dsh-preferences';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','设置');dialog.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close();}});
  const title=node('h2','设置'),done=button('完成',close);const heading=node('div');heading.className='dsh-preferences-header';heading.append(title,done);dialog.append(heading);
  const themeLabel=node('label','外观主题 '),themeSelect=node('select'),themeStatus=node('p');themeSelect.setAttribute('aria-label','外观主题');themeStatus.setAttribute('role','status');
  for(const [value,label]of [['system','跟随系统'],['light','浅色'],['dark','深色']]){const option=node('option',label);option.value=value;themeSelect.append(option);}
  themeSelect.value=window.__DSH_THEME_COLOR__?.getMode()||'system';themeStatus.textContent='跟随系统时，会随手机的深色模式自动切换。';
  themeSelect.onchange=()=>{try{window.__DSH_THEME_COLOR__.setMode(themeSelect.value);themeStatus.textContent='已保存：'+themeSelect.selectedOptions[0].textContent;}catch{themeStatus.textContent='主题设置未能保存，请重试';}};themeLabel.append(themeSelect);dialog.append(node('h3','外观'),themeLabel,themeStatus);
  const android=window.__DSH_ANDROID_BRIDGE__||window.__DSH_ANDROID_APP__;
  if(android&&typeof android.openSettings==='function')notificationCleanup=androidNotificationSection(dialog,android);
  cacheStatusCleanup=cacheStatusSection(dialog);
  if(android&&typeof android.openSettings==='function'){
   const info=node('p','后台同步、完成提醒和应用更新由此设备管理。');
   const appOptions=button('应用与后台',async()=>{try{await android.openSettings();}catch(error){info.textContent=error.message||'暂时无法打开，请重新打开应用';}});
   dialog.append(node('h3','此设备'),info,appOptions);androidUpdateCleanup=androidUpdateSection(dialog,android);
  }else{
  const version=node('p','正在检查版本…'),versionCode=node('small','当前版本 '+(window.__DSH_UI_RELEASE__?.version?.slice(0,8)||'未知')),update=button('检查更新',async()=>{update.disabled=true;try{await check();if(available){version.textContent='正在准备新版，准备好后会重新打开';await installUpdate();}else version.textContent='当前已是最新版';}catch(e){version.textContent=e.message;}finally{update.disabled=false;}});dialog.append(node('h3','应用更新'),version,versionCode,node('br'),update);
  notificationSection(dialog);
  check().then(()=>{if(!dialog)return;version.textContent=available?'有新版可用':'当前已是最新版';update.textContent=available?'更新并重新打开':'检查更新';if(options.update&&available)update.click();}).catch(e=>{version.textContent=e.message;});
  }
  if(window.__DSH_SCOPE__?.portable){
   const links=node('p'),license=node('a','项目源码与第三方许可'),hostSource=node('a','OpenCodex 完整修改源码');
   license.href='https://github.com/WhyTan00/better-codex/blob/main/THIRD_PARTY_NOTICES.md';
   hostSource.href='https://github.com/WhyTan00/better-codex/releases/download/v0.2.0-beta.1/opencodex-2.1.0-better-codex-source.tar.gz';
   for(const link of [license,hostSource]){link.target='_blank';link.rel='noopener noreferrer';}
   links.append(license,node('br'),hostSource);dialog.append(node('h3','开源组件'),links);
  }
  quotaCleanup=quotaSection(dialog);const content=node('div');content.className='dsh-preferences-body';content.tabIndex=0;content.setAttribute('role','region');content.setAttribute('aria-label','设置内容');while(heading.nextSibling)content.append(heading.nextSibling);dialog.append(content);document.body.append(dialog);done.focus({preventScroll:true});

 }
 addEventListener('popstate',()=>{if(dialog)dismiss();});
 window.__DSH_PWA_PREFERENCES__={open,ready(r){registration=r;if(window.__DSH_ANDROID_APP__)return;check().catch(()=>{});r.addEventListener('updatefound',()=>{r.installing?.addEventListener('statechange',()=>check().catch(()=>{}));});},check};
})();
