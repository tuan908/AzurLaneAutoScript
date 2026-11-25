#!/usr/bin/env bash
set -euo pipefail

if (( $# > 1 )); then
    printf 'Usage: %s [Windows installation path under /mnt]\n' "$0" >&2
    exit 2
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
source_root="$(pwd -P)"
target="$(realpath -e -- "${1:-/mnt/d/alas-modernize}")"
if [[ "$target/" == "$source_root/"* || ! -f "$target/gui.py" ]]; then
    printf 'Choose a separate ALAS installation as the target.\n' >&2
    exit 2
fi

(
    cd dashboard
    bun install --frozen-lockfile
    bun run build
)
test -f dashboard/dist/index.html

backup="$(mktemp -d -- "${target}-before-sync-XXXXXXXX")"
trap 'rmdir -- "$backup" 2>/dev/null || printf "Backed up replaced files to %s\n" "$backup"' EXIT

# Git's tracked file list excludes local profiles, logs, the toolkit and checkout metadata.
# shortcut: leave files deleted from the source on the target, until the install has a sync manifest.
{
    git ls-files -z -- ':!dashboard/dist'
    find dashboard/dist -type f -print0
} | rsync --recursive --from0 --files-from=- --checksum --ignore-missing-args \
    --backup --backup-dir="$backup" --delay-updates -- ./ "$target/"

printf 'Synced ALAS and the dashboard build to %s\n' "$target"
