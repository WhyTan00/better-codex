import {createRequire} from 'node:module';
import {runtimeProfile} from './runtime-profile.mjs';

export const runtimeRequire=createRequire(runtimeProfile.portable?runtimeProfile.dependencyPackage:(process.env.DSH_OPENCODEX_PACKAGE||runtimeProfile.hostPackage));
export const WebSocket=runtimeRequire('ws');
export const WebSocketServer=WebSocket.WebSocketServer;
export function appHostCodec(){
 const hostRequire=createRequire(runtimeProfile.hostPackage);
 return hostRequire(runtimeProfile.codecPath||'./web-shell/codex-app-host-message-codec.js');
}
export async function appHostProtocol(){return import(runtimeProfile.capnwebModule||runtimeRequire.resolve('capnweb'));}
