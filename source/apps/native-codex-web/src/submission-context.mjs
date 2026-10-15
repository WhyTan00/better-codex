import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

export const SUBMISSION_CONTEXT_PROTOCOL='dsh-submission-context-v1';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const conflict=()=>Object.assign(Error('会话设置已变化，消息尚未发送；输入已保留，请重新发送'),{code:409});

// A preparation receipt is not execution authority. Its exact inputs are
// rechecked inside the existing Journal/writer lane before a new Native write.
// Stateless receipts avoid a second queue or growing per-thread server cache.
export class SubmissionContexts {
 constructor({read,identity}){this.read=read;this.identity=identity;this.secret=randomBytes(32);}
 digest(value){return createHmac('sha256',this.secret).update(JSON.stringify(canonical(value))).digest('base64url');}
 async issue(scope,threadId){
  const identity=this.identity(),value=await this.read(scope,threadId);
  if(identity!==this.identity())throw conflict();
  const payload={scope,threadId,identity,digest:this.digest(value)},body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {...value,protocol:SUBMISSION_CONTEXT_PROTOCOL,token:body+'.'+this.digest(body)};
 }
 async verify(scope,threadId,token){
  if(typeof token!=='string'||token.length>2048)throw conflict();
  const [body,signature,...extra]=token.split('.'),expected=this.digest(body);
  if(extra.length||!signature||!/^[A-Za-z0-9_-]{43}$/.test(signature)||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw conflict();
  let payload;try{payload=JSON.parse(Buffer.from(body,'base64url'));}catch{throw conflict();}
  const identity=this.identity();
  if(payload.scope!==scope||payload.threadId!==threadId||payload.identity!==identity)throw conflict();
  const value=await this.read(scope,threadId);
  if(identity!==this.identity()||payload.digest!==this.digest(value))throw conflict();
 }
}
