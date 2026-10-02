import {readDeploymentConfig} from './deployment-config.mjs';

export const portableConfig=process.env.WORKBENCH_CONFIG?readDeploymentConfig(process.env.WORKBENCH_CONFIG):null;
let legacy;
if(!portableConfig){
 try{legacy=(await import('./private-deployment.mjs')).default;}
 catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;throw Error('Set WORKBENCH_CONFIG to your local deployment file');}
}
export const runtimeProfile=portableConfig?Object.freeze({
 portable:true,runtime:portableConfig.stateDir,origin:portableConfig.origin,
 codexHome:portableConfig.native.codexHome,hostPackage:portableConfig.native.hostPackage,
 dependencyPackage:portableConfig.dependencyPackage,codecPath:portableConfig.native.codecPath,
 nativeUrl:portableConfig.native.rpcUrl,upstream:portableConfig.native.webOrigin,
 syncConfig:null,
}):legacy;
