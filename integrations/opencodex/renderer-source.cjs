// SPDX-License-Identifier: AGPL-3.0-only
// HTTP renderer 单独固定；原生宿主继续使用已安装应用的对应版本。
// The renderer pin is an HTTP-only input. Official main, native addons and
// database migration ownership keep using the provider's current runtime.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function createRendererBundleProvider({ getOfficialBundle, env = process.env }) {
  const values = [env.DSH_WEB_RENDERER_DIR, env.DSH_WEB_RENDERER_MANIFEST,
    env.DSH_WEB_RENDERER_MANIFEST_SHA256];
  if (values.every(value => !value)) return getOfficialBundle;
  if (values.some(value => !value)) throw Error('Incomplete renderer source pin');
  const [directory, manifestPath, expectedSha] = values;
  const bytes = fs.readFileSync(manifestPath);
  if (digest(bytes) !== expectedSha) throw Error('Renderer manifest changed');
  const manifest = JSON.parse(bytes);
  const root = path.resolve(directory);
  if (manifest.schema !== 1 || root !== path.resolve(manifest.webviewDir)
      || fs.realpathSync(root) !== root || !manifest.files
      || !manifest.files['index.html']) throw Error('Invalid renderer source manifest');
  const expected = new Set(Object.keys(manifest.files));
  function visit(directoryPath) {
    const directoryStat = fs.lstatSync(directoryPath);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || (directoryStat.mode & 0o222)) throw Error('Renderer directory is not frozen');
    for (const entry of fs.readdirSync(directoryPath)) {
      const file = path.join(directoryPath, entry);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw Error('Renderer source contains a symlink');
      if (stat.isDirectory()) { visit(file); continue; }
      const name = path.relative(root, file).split(path.sep).join('/');
      const accepted = manifest.files[name];
      if (!stat.isFile() || !expected.delete(name) || (stat.mode & 0o222)
          || stat.size !== accepted.bytes || digest(fs.readFileSync(file)) !== accepted.sha256) {
        throw Error('Renderer source changed: ' + name);
      }
    }
  }
  visit(root);
  if (expected.size) throw Error('Renderer source is incomplete');
  const renderer = Object.freeze({ webviewDir: root, version: manifest.version,
    build: manifest.build });
  return () => renderer;
}

module.exports = { createRendererBundleProvider };
