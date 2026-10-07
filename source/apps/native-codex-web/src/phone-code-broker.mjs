import {mkdir,readFile,writeFile,rename,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomInt,randomUUID,timingSafeEqual,createHash} from 'node:crypto';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const secret=()=>randomBytes(32).toString('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const loopback=value=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(value);
const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
async function body(req){let size=0;const chunks=[];for await(const part of req){size+=part.length;if(size>8192)throw fail(413,'phone_code_request_too_large');chunks.push(part);}try{const value=JSON.parse(Buffer.concat(chunks));if(!value||Array.isArray(value)||typeof value!=='object')throw Error();return value;}catch{throw fail(400,'phone_code_invalid_json');}}
async function privateJSON(file,value){const next=file+'.'+randomUUID()+'.tmp';await writeFile(next,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});await rename(next,file);}
async function readPrivate(file){try{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('phone_code_private_file_required');return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
const states=new Set(['found','no_match','ambiguous','permission_denied','disabled','query_unavailable','system_restricted','clock_skew']);

/** Only pairing credentials persist. Requests and encrypted results are short-lived RAM data. */
export class PhoneCodeBroker {
 constructor({root,now=Date.now,pollMs=20000}={}){this.root=root;this.now=now;this.pollMs=pollMs;this.pairing=null;this.pending=null;this.waiter=null;this.lastSeen=0;this.closed=false;}
 async start(){
  await mkdir(this.root,{recursive:true,mode:0o700});const stat=await lstat(this.root);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('phone_code_private_directory_required');
  this.admin=await readPrivate(path.join(this.root,'admin.json'));
  if(!this.admin){this.admin={schema:1,token:secret()};await writeFile(path.join(this.root,'admin.json'),JSON.stringify(this.admin)+'\n',{flag:'wx',mode:0o600});}
  if(!/^[a-f0-9]{64}$/.test(this.admin.token))throw Error('phone_code_invalid_admin');
  this.device=await readPrivate(path.join(this.root,'device.json'));
  if(this.device&&(!/^[a-f0-9]{64}$/.test(this.device.token)||!/^[a-f0-9]{64}$/.test(this.device.encryptionKey)||this.device.scope!=='ai'))throw Error('phone_code_invalid_device');
  return this;
 }
 expire(){const now=this.now();if(this.pairing&&this.pairing.expiresAt<=now)this.pairing=null;if(this.pending&&this.pending.expiresAt+30000<=now)this.pending=null;}
 status(){this.expire();return {paired:!!this.device,device:this.device?{name:this.device.name,pairedAt:this.device.pairedAt}:null,online:this.lastSeen>0&&this.now()-this.lastSeen<60000,lastSeen:this.lastSeen||null,pending:this.pending?{id:this.pending.id,service:this.pending.service,expiresAt:this.pending.expiresAt,state:this.pending.result?'ready':this.pending.expiresAt<=this.now()?'expired':'waiting'}:null};}
 createPair(){this.expire();if(this.pending)throw fail(409,'phone_code_request_in_progress');this.pairing={code:String(randomInt(10000000,100000000)),expiresAt:this.now()+300000,attempts:5};return {code:this.pairing.code,expiresAt:this.pairing.expiresAt,replaceExisting:!!this.device};}
 async pair(value){
  if(this.bindingWrite)throw fail(409,'phone_code_binding_in_progress');
  this.expire();const pairing=this.pairing;
  if(!pairing)throw fail(410,'phone_code_pairing_expired');
  if(!equal(value.code,pairing.code)){if(--pairing.attempts<=0)this.pairing=null;throw fail(401,'phone_code_pairing_rejected');}
  const name=typeof value.name==='string'?value.name.trim():'';if(name.length<1||name.length>60||/[\x00-\x1f\x7f]/.test(name))throw fail(400,'phone_code_invalid_device_name');
  // Consume before asynchronous persistence, so two claims cannot pair concurrently.
  this.pairing=null;const device={schema:1,scope:'ai',id:randomUUID(),name,token:secret(),encryptionKey:secret(),pairedAt:this.now()};
  this.bindingWrite=(async()=>{await privateJSON(path.join(this.root,'device.json'),device);this.device=device;this.lastSeen=0;this.wake();})();
  try{await this.bindingWrite;return device;}finally{this.bindingWrite=null;}
 }
 async bind(value,token){
  // The caller already passed the private SSO and AI workspace boundary.
  // Persist the installation proof on the phone before this request, allowing
  // the same phone to recover a lost HTTP response without replacing a device.
  if(!/^[a-f0-9]{64}$/.test(value.installationSecret||''))throw fail(400,'phone_code_invalid_installation');
  const name=typeof value.name==='string'?value.name.trim():'';
  if(name.length<1||name.length>60||/[\x00-\x1f\x7f]/.test(name))throw fail(400,'phone_code_invalid_device_name');
  const bindingHash=createHash('sha256').update(value.installationSecret).digest('hex');
  if(this.bindingWrite)await this.bindingWrite;
  if(this.device){
   if(equal(bindingHash,this.device.bindingHash))return this.device;
   if(equal(token,this.device.token)){
    const device={...this.device,bindingHash};
    this.bindingWrite=(async()=>{await privateJSON(path.join(this.root,'device.json'),device);this.device=device;})();
    try{await this.bindingWrite;return device;}finally{this.bindingWrite=null;}
   }
   throw fail(409,'phone_code_other_phone_bound');
  }
  const device={schema:1,scope:'ai',id:randomUUID(),name,token:secret(),encryptionKey:secret(),bindingHash,pairedAt:this.now()};
  this.bindingWrite=(async()=>{await privateJSON(path.join(this.root,'device.json'),device);this.device=device;this.pairing=null;this.lastSeen=0;this.wake();})();
  try{await this.bindingWrite;return device;}finally{this.bindingWrite=null;}
 }
 authenticateDevice(token){if(!this.device||!equal(token,this.device.token))throw fail(401,'phone_code_device_rejected');this.lastSeen=this.now();}
 request(value){
  this.expire();if(!this.device)throw fail(409,'phone_code_pair_first');if(!this.status().online)throw fail(503,'phone_code_phone_offline');if(this.pending)throw fail(409,'phone_code_request_in_progress');
  const service=typeof value.service==='string'?value.service.trim():'',sender=value.sender==null?'':String(value.sender).trim();
  if(service.length<2||service.length>80||!/[\p{L}\p{N}]/u.test(service)||/[\x00-\x1f\x7f]/.test(service)||sender.length>48||/[\x00-\x1f\x7f]/.test(sender))throw fail(400,'phone_code_invalid_filter');
  const now=this.now(),after=value.after??now-180000,waitSeconds=value.waitSeconds??60;
  if(!Number.isSafeInteger(after)||after<now-300000||after>now+5000||!Number.isInteger(waitSeconds)||waitSeconds<5||waitSeconds>120)throw fail(400,'phone_code_invalid_time_window');
  this.pending={id:randomUUID(),service,sender,after,createdAt:now,expiresAt:now+waitSeconds*1000,readToken:secret(),result:null};this.wake();return {id:this.pending.id,readToken:this.pending.readToken,expiresAt:this.pending.expiresAt};
 }
 next(){this.expire();const p=this.pending;return p&&!p.result&&p.expiresAt>this.now()?{schema:1,id:p.id,service:p.service,sender:p.sender,after:p.after,createdAt:p.createdAt,expiresAt:p.expiresAt}:null;}
 wake(){const resolve=this.waiter;if(resolve){this.waiter=null;resolve();}}
 async poll(signal){
  if(!this.next()&&!this.closed){await new Promise(resolve=>{this.wake();let timer;const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);if(this.waiter===done)this.waiter=null;resolve();};this.waiter=done;timer=setTimeout(done,this.pollMs);signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();});}
  return {request:this.next(),serverTime:this.now()};
 }
 respond(value){
  this.expire();const p=this.pending;if(!p||p.id!==value.id)throw fail(410,'phone_code_request_gone');if(p.expiresAt<=this.now())throw fail(410,'phone_code_request_expired');
  if(!states.has(value.status)||typeof value.iv!=='string'||! /^[A-Za-z0-9+/]{16}$/.test(value.iv)||typeof value.ciphertext!=='string'||value.ciphertext.length<24||value.ciphertext.length>4096||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext))throw fail(400,'phone_code_invalid_response');
  const result={status:value.status,iv:value.iv,ciphertext:value.ciphertext};
  if(p.result){if(JSON.stringify(p.result)!==JSON.stringify(result))throw fail(409,'phone_code_already_answered');return {accepted:true};}
  p.result=result;return {accepted:true};
 }
 result(value){this.expire();const p=this.pending;if(!p||p.id!==value.id||!equal(value.readToken,p.readToken))throw fail(410,'phone_code_request_gone');if(p.result){this.pending=null;return {state:'ready',id:p.id,service:p.service,after:p.after,createdAt:p.createdAt,...p.result};}if(p.expiresAt<=this.now()){this.pending=null;return {state:'expired',status:'no_response'};}return {state:'waiting',expiresAt:p.expiresAt};}
 cancel(value){const p=this.pending;if(p&&p.id===value.id&&equal(value.readToken,p.readToken)){this.pending=null;this.wake();}return {cancelled:true};}
 async revoke(){if(this.bindingWrite)throw fail(409,'phone_code_binding_in_progress');this.device=null;this.pending=null;this.pairing=null;this.lastSeen=0;await privateJSON(path.join(this.root,'device.json'),null);this.wake();return {revoked:true};}
 async local(req,res,route){
  const localHost=/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host??'');
  if(!localHost||!loopback(req.socket.remoteAddress)||req.headers.origin||req.headers['sec-fetch-site']||!equal(req.headers['x-phone-code-admin'],this.admin.token))throw fail(403,'phone_code_local_access_required');
  if(req.method!=='POST')throw fail(405,'phone_code_post_required');const value=await body(req);let result;
  if(route==='status')result=this.status();else if(route==='pair')result=this.createPair();else if(route==='request')result=this.request(value);else if(route==='result')result=this.result(value);else if(route==='cancel')result=this.cancel(value);else if(route==='revoke')result=await this.revoke();else throw fail(404,'phone_code_unknown_operation');send(res,200,result);
 }
 async phone(req,res,route){
  if(req.method!=='POST')throw fail(405,'phone_code_post_required');const value=await body(req);
  if(route==='bind')return send(res,200,await this.bind(value,req.headers['x-phone-code-device']));
  if(route==='pair')return send(res,200,await this.pair(value));
  this.authenticateDevice(req.headers['x-phone-code-device']);
  if(route==='state')return send(res,200,{active:!!this.pending&&this.pending.id===value.id&&!this.pending.result&&this.pending.expiresAt>this.now()});
  if(route==='poll'){const controller=new AbortController();const cancel=()=>controller.abort();res.once('close',cancel);try{const result=await this.poll(controller.signal);if(!res.destroyed)send(res,200,result);}finally{res.off('close',cancel);}return;}
  if(route==='respond')return send(res,200,this.respond(value));throw fail(404,'phone_code_unknown_operation');
 }
 close(){this.closed=true;this.pending=null;this.pairing=null;this.wake();}
}
