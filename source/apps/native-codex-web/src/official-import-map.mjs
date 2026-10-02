// Import-map prefix substitutions do not recursively apply exact mappings.
// Every module directory must resolve each shared patched module to one URL.
export function normalizeOfficialImportMap(map){
 const imports=map.imports??{},prefixes=new Set(),targets=new Map();
 for(const [key,value]of Object.entries(imports)){
  const match=key.match(/^(\/official-patched-v[0-9]+\/assets\/)(.*)$/);if(!match)continue;
  prefixes.add(match[1]);if(!match[2])continue;
  if(!targets.has(match[2])||match[1]==='/official-patched-v8/assets/')targets.set(match[2],value);
  const destination=typeof value==='string'&&value.match(/^(\/official-patched-v[0-9]+\/assets\/)/);if(destination)prefixes.add(destination[1]);
 }
 for(const prefix of prefixes)for(const [name,target]of targets)imports[prefix+name]=target;
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
