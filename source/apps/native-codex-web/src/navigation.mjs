// PWA/SSO document entry is not a cross-origin API call. Both proxy layers
// use the same narrow list; API writes and subresource requests stay blocked.
export function isWorkspaceNavigation(req){
 if(req.method!=='GET')return false;
 const mode=req.headers['sec-fetch-mode'],dest=req.headers['sec-fetch-dest'];
 // Installed launchers and SSO handoffs can omit both Fetch Metadata and
 // Accept. Only known GET document routes below receive this compatibility.
 const accept=req.headers.accept||'';
 const legacyDocument=!mode&&!dest&&(!accept||accept==='*/*'||/\btext\/html\b/i.test(accept));
 if(!(mode==='navigate'&&(!dest||dest==='document'||dest==='empty'))&&!legacyDocument)return false;
 let path;try{path=new URL(req.url,'http://localhost').pathname;}catch{return false;}
 return /^(?:\/|\/conversations\/?|\/ui\/(?:official|legacy)\/?|\/official\/?|\/workbench\/?|\/projects\/?|\/video-workbench\/?|\/workspaces\/(?:ai|zyy)\/?|\/local\/[0-9a-f-]{36}|\/w\/(?:ai|zyy)\/api\/local-file\/[A-Za-z0-9_-]{32}\/[^/]+)$/i.test(path);
}

let denialWindow=0,denialCount=0;
export function navigationDenial(req,layer){
 if(Date.now()-denialWindow>60000){denialWindow=Date.now();denialCount=0;}if(++denialCount>30)return;
 let pathname='';try{pathname=new URL(req.url,'http://localhost').pathname;}catch{}
 const category=pathname==='/'?'home':pathname.startsWith('/ui/')?'ui':pathname.startsWith('/workspaces/')?'workspace':pathname.startsWith('/local/')?'conversation':pathname.includes('/api/')?'api':'other';
 const known=(v,values)=>values.includes(v)?v:v?'other':'missing';
 // No URL query, file path, cookies, IP, user-agent or raw Origin enters logs.
 console.warn(JSON.stringify({event:'navigation-denied',layer,category,method:known(req.method,['GET','HEAD','POST']),site:known(req.headers['sec-fetch-site'],['cross-site','same-site','same-origin','none']),mode:known(req.headers['sec-fetch-mode'],['navigate','cors','no-cors','same-origin']),dest:known(req.headers['sec-fetch-dest'],['document','empty','iframe','script']),origin:req.headers.origin==='null'?'opaque':req.headers.origin?'present':'missing'}));
}
