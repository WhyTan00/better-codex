#!/usr/bin/env python3
"""Package corresponding source from the pinned public tarball and installed patches."""
import argparse
import gzip
import hashlib
import io
import json
import tarfile
from pathlib import Path, PurePosixPath

PATCHES = {
    'gateway/runtime/http/static-assets.cjs': 'modifiedStaticAssetsSha256',
    'gateway/runtime/http/renderer-source.cjs': 'patchSha256',
    'gateway/runner/platform/macos.cjs': 'modifiedMacRunnerSha256',
    'gateway/runner/platform/runner-integrity.cjs': 'runnerPatchSha256',
}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--home', type=Path, required=True)
    p.add_argument('--upstream-archive', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    repo = Path(__file__).resolve().parent.parent
    pins = json.loads((repo/'dependencies.lock.json').read_text())['opencodex']
    config = json.loads((args.home/'deployment.json').read_text())
    host = Path(config['native']['hostPackage']).parent
    receipt = json.loads((host/'better-codex-source.json').read_text())
    assert receipt['upstream'] == pins, 'Installed source does not match this release'
    assert sha(args.upstream_archive.read_bytes()) == pins['sha256'], 'Upstream checksum mismatch'
    files = {}
    with tarfile.open(args.upstream_archive, 'r:gz') as source:
        for entry in source:
            if entry.isdir():
                continue
            parts = PurePosixPath(entry.name).parts
            assert len(parts) > 1 and all(v not in ('', '.', '..', '/') for v in parts), 'Unsafe source path'
            assert entry.isfile(), 'Unexpected non-file in pinned source'
            files['/'.join(parts[1:])] = (source.extractfile(entry).read(), entry.mode & 0o777)
    for name, key in PATCHES.items():
        data = (host/name).read_bytes()
        assert sha(data) == receipt[key], 'Installed modification differs: '+name
        files[name] = (data, 0o644)
    files['BETTER_CODEX_SOURCE.json'] = ((json.dumps({
        'upstream': pins,
        'license': 'AGPL-3.0-only',
        'modifiedFiles': {name: sha(files[name][0]) for name in PATCHES},
        'modifications': 'https://github.com/TonyandWei/better-codex/tree/v0.2.0-beta.9/integrations/opencodex',
    }, indent=2)+'\n').encode(), 0o644)
    files['BETTER_CODEX_BUILD.md'] = (b'''# Corresponding source

This archive contains the complete pinned OpenCodex source with Better Codex's
renderer selection and local Mac runner modifications already applied.
License: AGPL-3.0-only; see LICENSE and BETTER_CODEX_SOURCE.json.
It includes no official application resources, accounts or generated runtime.

With Node.js 24 and pnpm 10.32.1 available:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:gateway
```

Use Better Codex's installer for the separately acquired official resources,
deployment configuration and runtime entry. Exact build modifications are in
scripts/portable/setup.mjs in the Better Codex v0.2.0-beta.9 source.
''', 0o644)
    with args.output.open('xb') as output, gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as gz, tarfile.open(fileobj=gz, mode='w') as archive:
        for name, (data, mode) in sorted(files.items()):
            entry = tarfile.TarInfo('opencodex-2.1.0-better-codex-source/'+name)
            entry.size, entry.mode, entry.mtime = len(data), mode, 0
            archive.addfile(entry, io.BytesIO(data))
    print(json.dumps({'files': len(files), 'bytes': args.output.stat().st_size, 'sha256': sha(args.output.read_bytes())}))

if __name__ == '__main__':
    main()
