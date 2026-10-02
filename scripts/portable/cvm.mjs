import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,copyFile} from 'node:fs/promises';
import {requireStopped} from './setup.mjs';
import {readDeploymentConfig} from '../../source/apps/native-codex-web/src/deployment-config.mjs';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function cvmCaddyfile({origin,user,passwordHash,proxyKey,remotePort}){
 const url=new URL(origin);
 if(url.protocol!=='https:'||url.origin!==origin||!/^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(url.hostname)||url.port)throw Error('CVM URL must be an HTTPS domain without a path or custom port');
 if(!/^[a-zA-Z0-9_@.-]{1,128}$/.test(user)||!/^\$2[aby]\$(?:0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/.test(passwordHash)||!/^[a-f0-9]{64}$/.test(proxyKey))throw Error('Invalid CVM authentication settings');
 if(!Number.isSafeInteger(remotePort)||remotePort<1024||remotePort>65535)throw Error('Invalid CVM tunnel port');
 return `${url.hostname} {
  basic_auth {
    ${user} ${passwordHash}
  }
  reverse_proxy 127.0.0.1:${remotePort} {
    header_up Host ${url.host}
    header_up X-Better-Codex-Proxy ${proxyKey}
    header_up X-Better-Codex-User {http.auth.user.id}
    header_up -Authorization
    header_up -Tailscale-User-Login
    header_up -X-Dsh-Authenticated
  }
}
`;
}
export async function cvm(home,options){
 await requireStopped(home);
 if(!options.url||options.user?.length!==1||!options['ssh-host']||!options['password-hash-file'])throw Error('cvm requires --url, one --user, --ssh-host and --password-hash-file');
 const ssh=options['ssh-host'];if(!/^[a-zA-Z0-9][a-zA-Z0-9@._-]{0,253}$/.test(ssh))throw Error('Use an SSH config alias or user@host');
 const file=path.join(home,'deployment.json'),before=await readFile(file,'utf8'),raw=JSON.parse(before),config=readDeploymentConfig(file),origin=options.url,user=options.user[0],remotePort=Number(options['remote-port']||24173);
 const passwordHash=(await readFile(path.resolve(options['password-hash-file']),'utf8')).trim(),proxyKey=randomBytes(32).toString('hex');
 const caddy=cvmCaddyfile({origin,user,passwordHash,proxyKey,remotePort});
 const bundle=path.join(home,'cvm-'+randomUUID());await mkdir(bundle,{mode:0o700});
 const key=path.join(bundle,'proxy.key');await writeFile(key,proxyKey+'\n',{mode:0o600,flag:'wx'});
 await writeFile(path.join(bundle,'Caddyfile'),caddy,{mode:0o600,flag:'wx'});
 const tunnel=path.join(bundle,'tunnel.sh');await writeFile(tunnel,'#!/bin/sh\nexec ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R '+quote('127.0.0.1:'+remotePort+':127.0.0.1:'+config.port)+' '+quote(ssh)+'\n',{mode:0o700,flag:'wx'});
 await writeFile(path.join(bundle,'README.txt'),`Private deployment bundle. Do not commit it or share it publicly.\n\n1. Point ${new URL(origin).hostname} at your CVM and install Caddy 2.8 or newer.\n2. Copy this Caddyfile to the CVM with scp. Review and validate it before installing.\n   Use a dedicated CVM, or merge only this site into your existing Caddy configuration.\n   Keep the file readable only by root and the Caddy service account.\n3. Allow HTTPS 443 (and HTTP 80 for automatic TLS), plus SSH only as needed.\n   The reverse SSH port ${remotePort} must remain loopback; do not enable GatewayPorts.\n4. On the Mac, start Better Codex and run ${tunnel} in another terminal.\n5. Open ${origin}/?workspace=ai&view=chat&nativeList=1 and sign in as ${user}.\n\nCVM terminates TLS and authenticates every HTTP/WebSocket request.\nNative execution, plugins and rebuildable sync cache remain on your Mac.\nMac sleep or tunnel loss makes the site unavailable; no second writer takes over.\nStop the tunnel with Ctrl-C. Restore the saved deployment backup while the Mac host\nis stopped to return to the earlier local/Tailscale mode.\n`,{mode:0o600,flag:'wx'});
 raw.origin=origin;raw.access={mode:'cvm-proxy',users:[user],proxyKeyFile:key};
 const proposed=file+'.next-'+randomUUID();await writeFile(proposed,JSON.stringify(raw,null,2)+'\n',{mode:0o600,flag:'wx'});readDeploymentConfig(proposed);
 // Check ownership immediately before commit. No SSH, DNS or cloud service changes.
 await requireStopped(home);if(await readFile(file,'utf8')!==before)throw Error('Deployment changed while preparing CVM settings');
 const backup=file+'.before-cvm-'+randomUUID();await copyFile(file,backup);await rename(proposed,file);
 const result={configured:true,cloudModified:false,url:origin,bundle,tunnel,backup,next:'Install the reviewed Caddy site on your CVM, then start the Mac host and tunnel.'};console.log(JSON.stringify(result,null,2));return result;
}
