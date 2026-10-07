// Android owns its current manifest, not historical server assets. Drop only
// module bodies superseded by an exact final import-map alias. Old URLs remain
// valid on the server for already-open clients.
import vm from 'node:vm';
export function resolveUiModule(specifier,parent,imports){
 if(!specifier.startsWith('.')&&!specifier.startsWith('/'))return null;
 const url=new URL(specifier,'https://workbench.example.test'+parent);
 if(url.origin!=='https://workbench.example.test'||url.search||url.hash)return null;
 if(Object.hasOwn(imports,url.pathname))return imports[url.pathname];
 for(const key of Object.keys(imports).filter(k=>k.endsWith('/')).sort((a,b)=>b.length-a.length))if(url.pathname.startsWith(key))return imports[key]+url.pathname.slice(key.length);
 return url.pathname;
}
export function pruneSupersededAndroidModules({files,shell,roots=[]}){
 if(typeof vm.SourceTextModule!=='function')throw Error('Resource closure requires --experimental-vm-modules');
 const html=String(files.get(shell)),raw=html.match(/<script type="importmap"[^>]*>(.*?)<\/script>/s)?.[1];
 if(!raw)throw Error('Missing final shell import map');
 const imports=JSON.parse(raw).imports;
 const core=/^\/official-patched-v\d+\/assets\/(?:app-initial-cadb12d4a15e|app-primary-6cd7b8b3f5e3|local-conversation-thread-40db5af470f5)\.js$/;
 const removed=[];
 for(const [url,bytes]of files){
  const target=imports[url];
  if(!core.test(url)||!target||target===url)continue;
  if(!files.has(target))throw Error('Missing replacement module: '+target);
  if(roots.includes(url))throw Error('Superseded module is still a direct startup root: '+url);
  removed.push({path:url,replacement:target,bytes:Buffer.byteLength(bytes)});
 }
 const discarded=new Set(removed.map(row=>row.path)),result=new Map([...files].filter(([url])=>!discarded.has(url))),edges=[];
 for(const [url,bytes]of result){
  const body=String(bytes);
  if(/\.(?:m?js)$/.test(url)){
   const staticDeps=new vm.SourceTextModule(body,{identifier:url}).dependencySpecifiers;
   const dynamicDeps=[...body.matchAll(/\bimport\(\s*(["'`])([^"'`$]+)\1\s*\)/g)].map(m=>m[2]);
   // Vite's mapDeps arrays contain preloads for dynamically imported chunks;
   // these are resolved with the same import map by the renderer's loader.
   const vite=body.match(/const __vite__mapDeps=.*?m\.f=\[(.*?)\]\)\)\)/s)?.[1];
   const preloadDeps=vite?[...vite.matchAll(/["']([^"']+)["']/g)].map(m=>m[1]):[];
   for(const [kind,deps]of [['static',staticDeps],['dynamic',dynamicDeps],['vite-preload',preloadDeps]])for(const specifier of deps){
    const target=resolveUiModule(specifier,url,imports);if(!target)continue;
    if(discarded.has(target))throw Error('Dangling '+kind+' dependency: '+url+' -> '+target);
    if(removed.some(row=>new URL(specifier,'https://workbench.example.test'+url).pathname===row.path)){
     if(!result.has(target))throw Error('Replacement dependency is outside the package: '+target);
     edges.push({parent:url,kind,specifier,target});
    }
   }
   // Import maps do not rewrite fetch()/worker URLs. Refuse those rather than
   // infer that a module-shaped string is always an ESM import.
   for(const row of removed){
    for(const m of body.matchAll(/(?:fetch|Worker|SharedWorker|importScripts)\(\s*(["'`])([^"'`]+)\1/g))if(new URL(m[2],'https://workbench.example.test'+url).pathname===row.path)throw Error('Direct resource use prevents pruning: '+row.path);
   }
  }
  if(url===shell)for(const m of body.matchAll(/(?:src|href)=["']([^"']+)["']/g))if(discarded.has(m[1]))throw Error('Shell directly loads superseded module: '+m[1]);
 }
 return{files:result,report:{removed,removedBytes:removed.reduce((n,row)=>n+row.bytes,0),beforeFiles:files.size,afterFiles:result.size,remappedEdges:edges,serverAssetsModified:false}};
}
