#!/usr/bin/env bash
set -euo pipefail

port="${2:-22267}"
if (( $# > 2 )) || [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 )); then
    printf 'Usage: %s [Windows installation path under /mnt] [control port]\n' "$0" >&2
    exit 2
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
source_root="$(pwd -P)"
target="$(realpath -e -- "${1:-/mnt/d/alas-modernize}")"
if [[ "$target/" == "$source_root/"* || ! -f "$target/alas.py" ]]; then
    printf 'Choose a separate ALAS installation as the target.\n' >&2
    exit 2
fi
if [[ ! -f "$target/toolkit/python.exe" ]]; then
    printf 'Install the Windows toolkit in %s before syncing.\n' "$target" >&2
    exit 2
fi

mkdir -p -- "$target/log"
exec 9>"$target/log/.sync-from-wsl.lock"
if ! flock -n 9; then
    printf 'A sync is already running for %s.\n' "$target" >&2
    exit 1
fi

(
    cd dashboard
    bun install --frozen-lockfile
    bun run build
)
test -f dashboard/dist/index.html
alasd/build.sh
test -f alasd/bin/alasd.exe

target_windows="$(wslpath -w "$target")"
session="$(mktemp -d)"
restore_file="$session/restore.json"
restore_windows="$(wslpath -w "$restore_file")"
backup=

control() {
    "$target/toolkit/python.exe" - "$1" "$target_windows" "$port" "$restore_windows" \
        < deploy/Windows/sync-control.py
}

finish() {
    local result=$?
    trap - EXIT
    # Restore workers even if rsync failed after stopping the server.
    if [[ -f "$restore_file" ]] && ! control resume; then
        printf 'Control restart needs attention. Saved worker state is in %s.\n' "$session" >&2
        result=1
    else
        rm -f -- "$restore_file"
        rmdir -- "$session"
    fi
    if [[ -n "$backup" ]] && ! rmdir -- "$backup" 2>/dev/null; then
        printf 'Backed up replaced files to %s\n' "$backup"
    fi
    exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

backup="$(mktemp -d -- "${target}-before-sync-XXXXXXXX")"
control stop

# Git's tracked file list excludes local profiles, logs, the toolkit and checkout metadata.
# shortcut: leave files deleted from the source on the target, until the install has a sync manifest.
{
    git ls-files -z -- ':!dashboard/dist'
    find dashboard/dist -type f -print0
    printf 'alasd/bin/alasd.exe\0'
} | rsync --recursive --from0 --files-from=- --checksum --ignore-missing-args \
    --backup --backup-dir="$backup" --delay-updates -- ./ "$target/"

printf 'Synced ALAS, the dashboard build and alasd.exe to %s\n' "$target"
