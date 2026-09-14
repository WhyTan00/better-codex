// Hop-by-hop headers belong to one connection, not the next proxy hop.
export function endToEndHeaders(headers){
 const hop=new Set(['connection','keep-alive','transfer-encoding','te','trailer','upgrade','proxy-authenticate','proxy-authorization']);
 for(const value of String(headers.connection||'').split(','))if(value.trim())hop.add(value.trim().toLowerCase());
 return Object.fromEntries(Object.entries(headers).filter(([key])=>!hop.has(key.toLowerCase())));
}
