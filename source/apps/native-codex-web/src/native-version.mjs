// The native server's originator name is configurable. Its first UA product
// still carries the server version; the trailing client version is unrelated.
export function nativeVersion(initialization){return initialization?.userAgent?.match(/^[^/]+\/(\d+\.\d+\.\d+(?:-[\w.]+)?)(?=\s|$)/)?.[1]||null;}
