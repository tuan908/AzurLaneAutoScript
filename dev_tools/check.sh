#!/usr/bin/env bash
# Every check of the code this fork owns, in one command (doc/governance ADR 0004).
# CI runs it too (.github/workflows/check.yml). Exit code 0 means all passed.
#
#   dev_tools/check.sh            all checks
#   dev_tools/check.sh go py ui   only some groups
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/go/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"

[[ $# -eq 0 ]] && groups=(go py ui)

step() { printf '\n== %s\n' "$*"; }

for group in "${groups[@]}"; do
    case "$group" in
    go)
        step "alasd: gofmt, vet (Linux and Windows), tests with the race detector"
        (
            cd alasd
            unformatted=$(gofmt -l .)
            if [[ -n "$unformatted" ]]; then
                printf 'Run gofmt -w on:\n%s\n' "$unformatted" >&2
                exit 1
            fi
            go vet ./...
            GOOS=windows go vet ./...
            go test -race -count=1 ./...
        )
        ;;
    py)
        step "Python: ruff on owned code, tests"
        uvx ruff@0.17.6 check .
        # tests/island*: need the screenshot collection, which is not in the repository
        uv run pytest -q -p no:cacheprovider tests/control tests/ocr tests/device tests/os \
            tests/shop_event tests/equipment tests/meowfficer tests/testing tests/dev_tools
        ;;
    ui)
        step "dashboard: types, lint, format, unit and architecture tests"
        (
            cd dashboard
            bun install --frozen-lockfile >/dev/null
            bun run check
            bun run test
        )
        ;;
    *)
        printf 'Unknown group %s (go, py, ui)\n' "$group" >&2
        exit 2
        ;;
    esac
done
step "All checks passed"
