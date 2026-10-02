const $=id=>document.getElementById(id),params=new URLSearchParams(location.search),scope=params.get('workspace')||'ai';
const element=(tag,text)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;return node;};
$('chat').href='/?workspace='+encodeURIComponent(scope);
$('workspace').onchange=()=>location.assign('/projects?workspace='+encodeURIComponent($('workspace').value));
try{
 const response=await fetch('/dsh-scope-session?workspace='+encodeURIComponent(scope),{cache:'no-store'});if(!response.ok)throw Error('工作区不可访问');const session=await response.json();
 $('workspace').replaceChildren(...session.workspaces.map(ws=>{const option=element('option',ws.label);option.value=ws.id;return option;}));$('workspace').value=scope;
 const r=await fetch('/w/'+scope+'/api/projects',{headers:{'x-dsh-scope':session.token},cache:'no-store'});if(!r.ok)throw Error('项目暂不可读');const {projects}=await r.json();
 const render=()=>{$('projects').replaceChildren();for(const project of projects.filter(p=>p.name.toLowerCase().includes($('search').value.toLowerCase()))){const button=element('button',project.name);button.type='button';button.onclick=()=>{$('detail').replaceChildren(element('h2',project.name),element('p',project.root),element('p','在会话的工作台菜单打开此工作区启用的插件。项目内容由各插件的来源系统维护。'));};$('projects').append(button);}};
 $('search').oninput=render;render();$('status').textContent=session.label+' · '+projects.length+' 个项目';
 if(!projects.length)$('detail').replaceChildren(element('p','此工作区尚未配置项目。可以直接开始会话，或在部署配置的 projectBindings 中添加项目目录。'));
}catch(error){$('status').textContent=error.message;}
