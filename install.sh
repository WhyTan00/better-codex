#!/bin/sh
set -eu
# Runtime tools stay in the user's Better Codex directory; no sudo or launch agent.
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
[ "$(uname -s)" = Darwin ] || { echo 'This installer currently supports macOS.' >&2; exit 1; }
base=${BETTER_CODEX_HOME:-"$HOME/.better-codex"}
mkdir -p "$base/tools" "$base/downloads"
chmod 700 "$base" "$base/tools" "$base/downloads"
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)'; then
  node_bin=$(command -v node)
else
  case "$(uname -m)" in
    arm64) arch=arm64; digest=fee91aa5febeda47ef9f6c0afd2f2bcd3dacb0e656c29de0b5274e0ea1ca3565 ;;
    x86_64) arch=x64; digest=0c065ffa4e53b1a172ab9cd8ca08ae141b187aca8a07403c6856a7b8d0024804 ;;
    *) echo 'Unsupported Mac architecture.' >&2; exit 1 ;;
  esac
  name=node-v24.3.0-darwin-$arch
  archive="$base/downloads/$name.tar.gz"
  if [ ! -f "$archive" ]; then
    curl --fail --location --proto '=https' --connect-timeout 20 --max-time 900 "https://nodejs.org/dist/v24.3.0/$name.tar.gz" -o "$archive.part"
    [ "$(shasum -a 256 "$archive.part" | cut -d ' ' -f 1)" = "$digest" ] || { echo 'Node download checksum mismatch.' >&2; exit 1; }
    mv "$archive.part" "$archive"
  fi
  [ "$(shasum -a 256 "$archive" | cut -d ' ' -f 1)" = "$digest" ] || { echo 'Node archive checksum mismatch.' >&2; exit 1; }
  if [ ! -d "$base/tools/$name" ]; then tar -xzf "$archive" -C "$base/tools"; fi
  node_bin="$base/tools/$name/bin/node"
fi
PATH="$(dirname "$node_bin"):$PATH"; export PATH
exec "$node_bin" scripts/better-codex.mjs setup --home "$base" "$@"
