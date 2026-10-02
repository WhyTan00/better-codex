// Keep one same-workspace renderer alive across list/conversation navigation.
export function conversationPath(value, origin, scope){
 try {const u=new URL(value,origin);if(u.origin!==origin||u.searchParams.get('workspace')!==scope)return null;
  if(/^\/local\/[0-9a-f-]{36}$/i.test(u.pathname))return u.pathname;
  if(u.pathname==='/'&&u.searchParams.get('view')==='chat')return '/';
 } catch {} return null;
}
export function createConversationShell(scope,onList){
 const origin=location.origin,listUrl='/?workspace='+scope,main=document.querySelector('main');
 let frame=null,panel=null,label=null,ready=false,current=null,visible=false,scrollY=0,openingAt=0;
 const urlFor=path=>path+'?workspace='+scope+(path==='/'?'&view=chat':'');
 history.replaceState({...history.state,dshListPage:true},'',listUrl);
 function showList(){visible=false;main.hidden=false;if(panel)panel.hidden=true;document.body.classList.remove('conversation-open');document.title='会话 · Codex';window.scrollTo(0,scrollY);frame?.contentWindow?.postMessage({type:'dsh-shell-hidden',scope},origin);onList?.();}
 function ensure(){if(frame)return;panel=document.createElement('section');panel.className='conversation-panel';panel.setAttribute('aria-label','会话');
  const bar=document.createElement('div');bar.className='conversation-bar';const back=document.createElement('button');back.type='button';back.textContent='‹ 会话列表';back.onclick=()=>history.back();label=document.createElement('span');label.setAttribute('role','status');bar.append(back,label);
  frame=document.createElement('iframe');frame.title='Codex 会话';frame.setAttribute('allow','clipboard-read; clipboard-write');panel.append(bar,frame);document.body.append(panel);
 }
 function open(path,push=true){ensure();if(!visible)scrollY=window.scrollY;visible=true;main.hidden=true;panel.hidden=false;document.body.classList.add('conversation-open');document.title='会话 · Codex';openingAt=Date.now();label.textContent='正在打开会话…';
  if(push)history.pushState({dshShellChat:true,path},'',urlFor(path));
  if(ready){frame.contentWindow.postMessage({type:'dsh-shell-open',scope,path,at:openingAt},origin);if(current===path)label.textContent='';}
  else if(current!==path){frame.src=urlFor(path)+'&dshEmbedded=1';}
  current=path;
 }
 addEventListener('message',e=>{if(!frame||e.source!==frame.contentWindow||e.origin!==origin||e.data?.scope!==scope)return;const m=e.data;
  if(m.type==='dsh-shell-list'){if(visible)history.back();return;}
  if(m.type==='dsh-shell-ready'){ready=true;if(visible)label.textContent='';return;}
  if(m.type==='dsh-shell-route'&&(/^\/local\/[0-9a-f-]{36}$/i.test(m.path)||m.path==='/')){ready=true;current=m.path;if(visible){label.textContent='';history.replaceState({dshShellChat:true,path:current},'',urlFor(current));}}
 });
 addEventListener('popstate',()=>{if(history.state?.dshShellChat)open(history.state.path,false);else showList();});
 return {open(value){const path=conversationPath(value,origin,scope);if(path===null)return false;open(path);return true;}};
}
