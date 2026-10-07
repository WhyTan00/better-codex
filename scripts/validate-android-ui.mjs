import {assertOfficialModuleIdentity} from '../source/apps/native-codex-web/src/official-import-map.mjs';
// 按 Android APK 的 UiReleaseStore 合同校验清单及其本地资源。
// 这个脚本只读输入目录，不会修改清单、资源或发布目录。
import {readFile, realpath, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const VERSION = /^[a-f0-9]{16}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NATIVE = /^\/dsh-native-assets\/[a-f0-9]{16}\/(?:scope|runtime|pwa|loader|turn)\.(?:js|css)$/;
const OFFICIAL = /^\/official-patched-v[0-9]+\/assets\/[A-Za-z0-9_.-]+\.(?:js|mjs|css|woff2?|ttf|png|svg|jpg|jpeg|webp)$/;

export const ANDROID_UI_CONTRACT = Object.freeze({
  schemaVersion: 1,
  maxFiles: 600,
  maxFileBytes: 24 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
});

export class AndroidUiContractError extends Error {
  constructor(issues, details = {}) {
    const first = issues[0]?.message || 'unknown contract violation';
    super(`Android UI release contract failed: ${first}`);
    this.name = 'AndroidUiContractError';
    this.issues = issues;
    this.details = details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function addIssue(issues, code, message, fields = {}) {
  issues.push({code, message, ...fields});
}

function expectedUrl(version, assetPath) {
  return `/android/ui/${version}/files${assetPath}`;
}

function allowedPath(assetPath, version) {
  return assetPath === `/dsh-native-assets/${version}/shell.html`
    || NATIVE.test(assetPath)
    || OFFICIAL.test(assetPath);
}

function validAppVersionCode(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

/**
 * 只解析 JSON 合同，先把 URL/路径等结构问题全部报出，再允许读取本地文件。
 * 这样旧版本 URL 即使同时缺文件，也会以 APK 会拒绝的原因优先暴露。
 */
export function parseAndroidUiManifest(raw, {appVersionCode} = {}) {
  const issues = [];
  if (!isRecord(raw)) {
    throw new AndroidUiContractError([{code: 'manifest_type', message: 'manifest must be a JSON object'}]);
  }

  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== ANDROID_UI_CONTRACT.schemaVersion) {
    addIssue(issues, 'schema_version', `schemaVersion must be ${ANDROID_UI_CONTRACT.schemaVersion}`, {
      actual: schemaVersion,
    });
  }

  const version = stringValue(raw.version);
  if (!VERSION.test(version)) {
    addIssue(issues, 'version', 'version must be exactly 16 lowercase hexadecimal characters', {actual: raw.version});
  }

  const shell = stringValue(raw.shell);
  const expectedShell = `/dsh-native-assets/${version}/shell.html`;
  if (shell !== expectedShell) {
    addIssue(issues, 'shell_identity', 'shell must be the versioned native shell path', {
      actual: shell,
      expected: expectedShell,
    });
  }

  // UiReleaseStore.optInt("minAppVersionCode", 1) defaults a missing field to
  // one; preserve that compatibility while keeping an explicit value strict.
  const minAppVersionCode = raw.minAppVersionCode === undefined ? 1 : raw.minAppVersionCode;
  if (!validAppVersionCode(minAppVersionCode)) {
    addIssue(issues, 'min_app_version_code', 'minAppVersionCode must be a positive integer', {
      actual: minAppVersionCode,
    });
  } else if (appVersionCode !== undefined) {
    if (!validAppVersionCode(appVersionCode)) {
      addIssue(issues, 'app_version_code', 'appVersionCode must be a positive integer', {actual: appVersionCode});
    } else if (appVersionCode < minAppVersionCode) {
      addIssue(issues, 'app_too_old', 'appVersionCode is below manifest.minAppVersionCode', {
        actual: appVersionCode,
        expected: minAppVersionCode,
      });
    }
  }

  const files = raw.files;
  if (!Array.isArray(files)) {
    addIssue(issues, 'files_type', 'files must be an array');
  } else {
    if (files.length < 1 || files.length > ANDROID_UI_CONTRACT.maxFiles) {
      addIssue(issues, 'file_count', `files must contain 1..${ANDROID_UI_CONTRACT.maxFiles} entries`, {
        actual: files.length,
      });
    }
  }

  const entries = [];
  const paths = new Set();
  let totalBytes = 0;
  let totalTooLargeReported = false;
  if (Array.isArray(files)) {
    files.forEach((rawEntry, index) => {
      const label = `files[${index}]`;
      if (!isRecord(rawEntry)) {
        addIssue(issues, 'file_entry_type', `${label} must be an object`, {entry: label});
        return;
      }

      const assetPath = stringValue(rawEntry.path);
      const url = stringValue(rawEntry.url);
      const sha256 = stringValue(rawEntry.sha256);
      const mime = stringValue(rawEntry.mime).toLowerCase();
      const bytes = rawEntry.bytes;

      if (!allowedPath(assetPath, version)) {
        addIssue(issues, 'path', `${label}.path is outside the APK allowlist`, {
          entry: label,
          actual: assetPath,
        });
      }
      const expected = expectedUrl(version, assetPath);
      if (url !== expected) {
        addIssue(issues, 'url', `${label}.url must use manifest.version and exact path`, {
          entry: label,
          actual: url,
          expected,
        });
      }
      if (!SHA256.test(sha256)) {
        addIssue(issues, 'sha256', `${label}.sha256 must be 64 lowercase hexadecimal characters`, {
          entry: label,
          actual: rawEntry.sha256,
        });
      }
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > ANDROID_UI_CONTRACT.maxFileBytes) {
        addIssue(issues, 'file_bytes', `${label}.bytes is outside the APK size contract`, {
          entry: label,
          actual: bytes,
        });
      } else {
        totalBytes += bytes;
        if (totalBytes > ANDROID_UI_CONTRACT.maxTotalBytes && !totalTooLargeReported) {
          addIssue(issues, 'total_bytes', 'declared file bytes exceed the APK total size contract', {
            actual: totalBytes,
            expected: ANDROID_UI_CONTRACT.maxTotalBytes,
          });
          totalTooLargeReported = true;
        }
      }
      if (!mime) {
        addIssue(issues, 'mime', `${label}.mime must be non-empty`, {entry: label});
      } else if (assetPath === shell) {
        if (!mime.includes('html')) {
          addIssue(issues, 'shell_type', `${label}.mime must contain html for the shell`, {
            entry: label,
            actual: mime,
          });
        }
      } else if (mime.includes('html') || mime.includes('json')) {
        addIssue(issues, 'dependency_type', `${label}.mime cannot contain html or json for a dependency`, {
          entry: label,
          actual: mime,
        });
      }
      if (paths.has(assetPath)) {
        addIssue(issues, 'duplicate_path', `${label}.path is duplicated`, {entry: label, actual: assetPath});
      } else {
        paths.add(assetPath);
      }
      entries.push({path: assetPath, url, sha256, bytes, mime});
    });
  }

  if (!entries.some(entry => entry.path === shell)) {
    addIssue(issues, 'shell_missing', 'files must contain the manifest shell entry', {expected: shell});
  }

  if (issues.length) {
    throw new AndroidUiContractError(issues, {
      phase: 'manifest',
      version,
      shell,
      fileCount: Array.isArray(files) ? files.length : 0,
      totalBytes,
    });
  }
  return {schemaVersion, version, minAppVersionCode, shell, entries, totalBytes};
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalDirectory(directory, issues) {
  try {
    const resolved = await realpath(directory);
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      addIssue(issues, 'files_root_type', 'files root must be a directory', {actual: directory});
      return null;
    }
    return resolved;
  } catch (error) {
    addIssue(issues, 'files_root_missing', 'files root is not readable', {
      actual: directory,
      reason: error.code || error.message,
    });
    return null;
  }
}

/**
 * 校验 manifest 文件、每个声明资源的真实字节数/哈希，以及 shell 的无凭据约束。
 * `filesRoot` 对应 APK `files/` 目录；每个 manifest path 去掉首 `/` 后拼接。
 */
export async function validateAndroidUiRelease({manifestPath, filesRoot, appVersionCode} = {}) {
  if (!manifestPath || !filesRoot) {
    throw new TypeError('manifestPath and filesRoot are required');
  }

  let raw;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new AndroidUiContractError([{
      code: 'manifest_read',
      message: 'manifest JSON could not be read',
      reason: error.code || error.message,
    }], {phase: 'manifest'});
  }
  const manifest = parseAndroidUiManifest(raw, {appVersionCode});

  const issues = [];
  const root = await canonicalDirectory(filesRoot, issues);
  if (!root) throw new AndroidUiContractError(issues, {phase: 'files', version: manifest.version});

  for (const entry of manifest.entries) {
    const relative = entry.path.slice(1);
    const candidate = path.resolve(root, relative);
    if (!isInside(candidate, root)) {
      addIssue(issues, 'file_path_escape', 'declared file resolves outside files root', {
        path: entry.path,
      });
      continue;
    }

    let file;
    try {
      file = await realpath(candidate);
    } catch (error) {
      addIssue(issues, 'missing_file', 'declared file is missing', {
        path: entry.path,
        reason: error.code || error.message,
      });
      continue;
    }
    if (!isInside(file, root)) {
      addIssue(issues, 'file_path_escape', 'declared file resolves outside files root', {path: entry.path});
      continue;
    }

    let info;
    try {
      info = await stat(file);
    } catch (error) {
      addIssue(issues, 'file_read', 'declared file could not be inspected', {
        path: entry.path,
        reason: error.code || error.message,
      });
      continue;
    }
    if (!info.isFile()) {
      addIssue(issues, 'file_type', 'declared resource is not a regular file', {path: entry.path});
      continue;
    }
    if (info.size !== entry.bytes) {
      addIssue(issues, 'file_bytes', 'local file byte count does not match manifest', {
        path: entry.path,
        actual: info.size,
        expected: entry.bytes,
      });
      continue;
    }

    let bytes;
    try {
      bytes = await readFile(file);
    } catch (error) {
      addIssue(issues, 'file_read', 'declared file could not be read', {
        path: entry.path,
        reason: error.code || error.message,
      });
      continue;
    }
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== entry.bytes) {
      addIssue(issues, 'file_bytes', 'local file bytes changed while reading', {
        path: entry.path,
        actual: bytes.length,
        expected: entry.bytes,
      });
    }
    if (actualSha256 !== entry.sha256) {
      addIssue(issues, 'file_sha256', 'local file SHA-256 does not match manifest', {
        path: entry.path,
        actual: actualSha256,
        expected: entry.sha256,
      });
    }
    if (entry.path === manifest.shell) {
      const shell = bytes.toString('utf8');
      const importMap = shell.match(/<script type="importmap"[^>]*>(.*?)<\/script>/s)?.[1];
      if (!importMap && manifest.entries.some(file=>OFFICIAL.test(file.path))) addIssue(issues,'import_map_missing','official shell requires its module import map',{path:entry.path});
      if (importMap) {
        const expected="sha256-"+createHash('sha256').update(importMap).digest('base64');
        const csp=shell.match(/<meta\b[^>]*http-equiv=["\']Content-Security-Policy["\'][^>]*>/i)?.[0]||'';
        const policy=(csp.match(/\bcontent=(["'])(.*?)\1/i)?.[2]||'').replaceAll('&#39;',"'").replaceAll('&quot;','"');
        const scriptDirective=policy.split(';').map(x=>x.trim()).find(x=>/^script-src(?:\s|$)/i.test(x))||'';
        if(!scriptDirective.split(/\s+/).includes("'"+expected+"'"))addIssue(issues,'import_map_csp','official import map must be authorized by its exact CSP hash',{path:entry.path});
        try { assertOfficialModuleIdentity(JSON.parse(importMap)); }
        catch (error) { addIssue(issues, 'module_identity', error.message, {path: entry.path, conflicts: error.conflicts}); }
      }
      if (shell.includes('scopeToken=') || shell.includes('__DSH_SCOPE__')) {
        addIssue(issues, 'shell_credential', 'shell contains a credential or scope placeholder', {
          path: entry.path,
        });
      }
    }
  }

  if (issues.length) {
    throw new AndroidUiContractError(issues, {
      phase: 'files',
      version: manifest.version,
      shell: manifest.shell,
      fileCount: manifest.entries.length,
      totalBytes: manifest.totalBytes,
    });
  }

  return {
    ok: true,
    version: manifest.version,
    minAppVersionCode: manifest.minAppVersionCode,
    shell: manifest.shell,
    files: manifest.entries.length,
    bytes: manifest.totalBytes,
    verifiedFiles: manifest.entries.length,
  };
}

function parseCli(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--manifest' || argument === '--files-root' || argument === '--app-version-code') {
      const value = argv[++i];
      if (!value) throw new TypeError(`${argument} requires a value`);
      if (argument === '--manifest') options.manifestPath = value;
      if (argument === '--files-root') options.filesRoot = value;
      if (argument === '--app-version-code') {
        options.appVersionCode = Number(value);
        if (!validAppVersionCode(options.appVersionCode)) throw new TypeError('--app-version-code must be a positive integer');
      }
    } else if (argument === '--help' || argument === '-h') {
      console.log('Usage: node scripts/validate-android-ui.mjs --manifest PATH --files-root PATH [--app-version-code N]');
      return null;
    } else {
      throw new TypeError(`unknown argument: ${argument}`);
    }
  }
  if (!options.manifestPath || !options.filesRoot) {
    throw new TypeError('--manifest and --files-root are required');
  }
  return options;
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (!options) return;
    console.log(JSON.stringify(await validateAndroidUiRelease(options)));
  } catch (error) {
    const output = error instanceof AndroidUiContractError
      ? {ok: false, error: error.name, issues: error.issues, details: error.details}
      : {ok: false, error: error.name || 'Error', message: error.message};
    console.error(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
