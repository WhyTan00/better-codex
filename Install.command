#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
./install.sh "$@"
exec "${BETTER_CODEX_HOME:-$HOME/.better-codex}/start"
