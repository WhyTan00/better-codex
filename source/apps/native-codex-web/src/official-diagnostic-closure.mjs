// The early loader owns the logger; a later scope cannot replace its guarded
// singleton. Validate both frozen entry paths, not just the lazy scope source.
export function extractClientDiagnostics(source){
 const text=String(source??''),at=text.indexOf("KEY='client-diagnostics-v2'");
 if(at<0)return null;
 const start=text.lastIndexOf('(()=>{',at),end=text.indexOf('\n})();',at);
 if(start<0||end<=start)throw Error('Client diagnostic entry is incomplete');
 return text.slice(start,end+6);
}
export function assertClientDiagnosticClosure(loader,scope){
 const early=extractClientDiagnostics(loader),late=extractClientDiagnostics(scope);
 if(early===null&&late===null)return;
 if(early===null||late===null||early!==late)throw Error('Early loader and lazy scope diagnostic implementations differ');
}
