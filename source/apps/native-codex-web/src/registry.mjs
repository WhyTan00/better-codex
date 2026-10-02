// Each installation has one workspace authority; the private deployment keeps
// using its existing shared registry. Public installations require a config.
import {portableConfig,runtimeProfile} from './runtime-profile.mjs';
import {createPortableRegistry} from './portable-registry.mjs';
const policy=portableConfig?createPortableRegistry(portableConfig):await import(runtimeProfile.registryModule);
export const {WORKSPACES,workspace,belongs,fail,validateId,publicThread,registeredSite}=policy;
export const SCOPES=Object.freeze(Object.keys(WORKSPACES));
