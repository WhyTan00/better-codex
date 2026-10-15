// Import-map prefix substitutions do not recursively apply exact mappings.
// Every module directory must resolve each shared patched module to one URL.
export function retargetOfficialInitial(map,previous,current){
 if(!/^\/official-patched-v[0-9]+\/assets\/app-initial-[^/]+\.js$/.test(previous)||!/^\/official-patched-v[0-9]+\/assets\/app-initial-[^/]+\.js$/.test(current))throw Error('Invalid official SDK target');
 const result=structuredClone(map),imports=result.imports??={},priorName=previous.split('/').at(-1);let changed=0;
 for(const [specifier,target]of Object.entries(imports))if(target===previous){imports[specifier]=current;changed++;}
 if(!changed)throw Error('Pinned official initial aliases missing');
 // Existing immutable chunks still import their ORIGINAL specifiers. Rename
 // the destination only, and add the new physical name as another alias.
 imports['/official-patched-v8/assets/'+priorName]=current;
 imports['/official-patched-v8/assets/'+current.split('/').at(-1)]=current;
 return normalizeOfficialImportMap({...result,imports});
}
export function retargetOfficialPrimary(map,previous,current){
 if(!/^\/official-patched-v[0-9]+\/assets\/app-primary-[^/]+\.js$/.test(previous)||!/^\/official-patched-v[0-9]+\/assets\/app-primary-[^/]+\.js$/.test(current))throw Error('Invalid official composer target');
 const result=structuredClone(map),imports=result.imports??={};let changed=0;
 for(const[specifier,target]of Object.entries(imports))if(target===previous){imports[specifier]=current;changed++;}
 if(!changed)throw Error('Pinned official composer aliases missing');
 imports['/official-patched-v8/assets/'+previous.split('/').at(-1)]=current;
 imports['/official-patched-v8/assets/'+current.split('/').at(-1)]=current;
 return normalizeOfficialImportMap({...result,imports});
}
export function normalizeOfficialImportMap(map){
 const imports=map.imports??{},prefixes=new Set(),targets=new Map();
 for(const [key,value]of Object.entries(imports)){
  const match=key.match(/^(\/official-patched-v[0-9]+\/assets\/)(.*)$/);if(!match)continue;
  prefixes.add(match[1]);if(!match[2])continue;
  if(!targets.has(match[2])||match[1]==='/official-patched-v8/assets/')targets.set(match[2],value);
  const destination=typeof value==='string'&&value.match(/^(\/official-patched-v[0-9]+\/assets\/)/);if(destination)prefixes.add(destination[1]);
 }
 // Vite resolves CSS preload URLs with import.meta.resolve, before making
 // ordinary link requests. Bind the shipped core styles explicitly as well.
 for(const name of ['app-initial-5b0a474bff5e.css','app-primary-7fe7c6486695.css'])targets.set(name,'/official-patched-v8/assets/'+name);
 // A newly mapped entry changes the base of its relative imports. Exact
 // shared-module aliases alone do not cover the unchanged runtime/chunks.
 // Keep explicit directory overrides and supply the original asset directory
 // for each newly discovered patched directory before adding exact aliases.
 for(const prefix of prefixes){
  if(prefix!=='/official-patched-v8/assets/'&&!Object.hasOwn(imports,prefix))imports[prefix]='/official-patched-v8/assets/';
  for(const [name,target]of targets)imports[prefix+name]=target;
 }
 return {...map,imports};
}

export function assertOfficialModuleIdentity(map){
 const normalized=normalizeOfficialImportMap(structuredClone(map)),imports=map.imports??{};
 const resolve=url=>{
  if(Object.hasOwn(imports,url))return imports[url];
  const prefix=Object.keys(imports).filter(key=>key.endsWith('/')&&url.startsWith(key)).sort((a,b)=>b.length-a.length)[0];
  return prefix?imports[prefix]+url.slice(prefix.length):url;
 };
 const conflicts=[];
 for(const [source,target]of Object.entries(normalized.imports))if(/\/app-(?:primary|initial)-[^/]+\.js$/.test(source)&&resolve(source)!==target)conflicts.push({source,resolved:resolve(source),expected:target});
 if(conflicts.length){const error=Error('Official module identity splits across import-map aliases');error.code='module_identity';error.conflicts=conflicts;throw error;}
 return true;
}
