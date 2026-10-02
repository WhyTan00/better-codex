// 插件只提供项目数据快照或本地页面；工作台不复制项目的可编辑数据。
(()=>{
 const scope=window.__DSH_SCOPE__;if(!scope)return;
 const request=window.fetch.bind(window);let capability=null,definitions=null,panel=null,current=null,sequence=0;
 const node=(tag,text)=>{const value=document.createElement(tag);if(text!=null)value.textContent=String(text);return value;};
 async function api(route,options={}){
  if(!capability){const response=await request('/api/context',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspace:scope.id}),cache:'no-store'});if(!response.ok)throw Error('请重新连接工作台');capability=(await response.json()).token;}
  const response=await request('/api/w/'+scope.id+'/plugins'+route,{...options,headers:{...options.headers,authorization:'Bearer '+capability},cache:'no-store'});
  if(response.status===401)capability=null;const result=await response.json();if(!response.ok)throw Error(result.error||'插件暂不可用');return result;
 }
 async function list(){if(!definitions){definitions=(await api('')).data;window.dispatchEvent(new CustomEvent('dsh:plugin-definitions',{detail:definitions}));}return definitions;}
 function dismiss(){sequence++;panel?.remove();panel=null;current=null;delete document.documentElement.dataset.dshPlugin;}
 function close(){if(history.state?.dshPluginPage)history.back();else dismiss();}
 function render(host,data){
  host.replaceChildren();
  if(data.kind==='frame'){
   const target=new URL(data.url,location.origin);if(target.origin!==location.origin||!target.pathname.startsWith('/plugins/'+scope.id+'/'+current+'/'))throw Error('插件页面地址无效');
   const frame=node('iframe');frame.title=data.label;frame.className='dsh-video-frame';frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.src=target.href;host.append(frame);return;
  }
  const snapshot=data.snapshot||{};if(snapshot.summary)host.append(node('p',snapshot.summary));
  for(const group of Array.isArray(snapshot.sections)?snapshot.sections:[]){
   const section=node('section');section.className='dsh-plugin-section';section.append(node('h2',group.title||''));if(group.text)section.append(node('p',group.text));
   if(Array.isArray(group.items)){const list=node('ul');for(const value of group.items){const item=node('li');if(typeof value==='string')item.textContent=value;else{item.append(node('strong',value.title||''));if(value.detail)item.append(node('p',value.detail));if(value.value!=null)item.append(node('span',value.value));}list.append(item);}section.append(list);}host.append(section);
  }
  if(snapshot.updatedAt)host.append(node('small','来源时间 '+new Date(snapshot.updatedAt).toLocaleString()));
 }
 async function open(id,{restore=false}={}){
  const plugin=(await list()).find(value=>value.id===id);if(!plugin)return;
  dismiss();current=id;const selected=++sequence;document.documentElement.dataset.dshPlugin=id;
  if(!restore){history.pushState({...history.state,dshPluginPage:id},'',location.href);}
  panel=node('main');panel.id='dsh-native-plugin';panel.className='dsh-native-plugin';panel.setAttribute('aria-label',plugin.label);
  const header=node('header'),back=node('button','‹ 返回会话'),refresh=node('button','刷新'),status=node('p','正在加载…'),body=node('div');
  back.type=refresh.type='button';back.className=refresh.className='dsh-plugin-button';back.onclick=close;status.setAttribute('role','status');header.append(back,node('h1',plugin.label),refresh);body.className='dsh-plugin-body';body.append(status);const content=node('div');body.append(content);panel.append(header,body);document.body.append(panel);
  const load=async()=>{refresh.disabled=true;try{const data=await api('/'+id);if(sequence!==selected)return;render(content,data);status.textContent='';}catch(error){if(sequence===selected)status.textContent=error.message;}finally{refresh.disabled=false;}};
  refresh.onclick=load;await load();
 }
 window.__DSH_NATIVE_WORKBENCH__={list,open,close,preload:async()=>{},canReload:()=>!current,localCacheStatus:async()=>({scope:scope.id,preloading:false,items:[]}),get current(){return current;}};
 addEventListener('popstate',event=>{const id=event.state?.dshPluginPage;if(id)open(id,{restore:true}).catch(dismiss);else dismiss();});
 addEventListener('dsh:authentication-required',()=>{capability=null;definitions=null;dismiss();});
 document.addEventListener('click',event=>{if(current&&event.target.closest?.('[data-app-action-sidebar-thread-row]'))dismiss();},true);
})();
