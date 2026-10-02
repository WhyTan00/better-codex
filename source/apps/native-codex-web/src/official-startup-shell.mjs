// The official renderer owns #root. Its inherited static logo is unnecessary
// in an installed local shell and flashes before the cached sidebar mounts.
export function patchLocalStartupShell(html) {
 const start=html.indexOf('<div id="root">');
 if(start<0)throw Error('本地启动壳 root 契约已改变');
 const openEnd=start+'<div id="root">'.length;
 const tags=/<\/?div\b[^>]*>/g;tags.lastIndex=openEnd;let depth=1,end=-1,tag;
 while((tag=tags.exec(html))){depth+=tag[0].startsWith('</')?-1:1;if(depth===0){end=tag.index;break;}}
 if(end<0)throw Error('本地启动壳 root 结构不完整');
 const content=html.slice(openEnd,end);
 if(!content.trim())return html;
 if(!/^\s*<div class="startup-loader" aria-hidden="true">/.test(content)||!content.includes('startup-loader__logo')||!content.includes('startup-loader__overlay'))throw Error('本地启动壳内容契约已改变');
 return html.slice(0,openEnd)+html.slice(end);
}

// Suppress only the initial cached handover. Later loading states and a first
// installation still use the official indicator.
export function patchCachedLoadingLogo(source){
 const before='c=i===void 0||i,[l,u]=(0,tEa.useState)(!1)',after='c=(i===void 0||i)&&window.__DSH_CACHE_FIRST_PAINT__!==true,[l,u]=(0,tEa.useState)(!1)';
 if(source.includes(after))return source;
 if(source.split(before).length!==2)throw Error('Cached loading logo contract changed');
 return source.replace(before,after);
}
