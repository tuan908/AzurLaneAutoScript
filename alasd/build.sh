#!/usr/bin/env bash
# Build alasd for Windows (alasd/bin/alasd.exe) and for this machine (alasd/bin/alasd).
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
go=$(command -v go || echo "$HOME/.local/go/bin/go")
mkdir -p bin
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 "$go" build -trimpath -ldflags="-s -w" -o bin/alasd.exe ./cmd/alasd
CGO_ENABLED=0 "$go" build -trimpath -ldflags="-s -w" -o bin/alasd ./cmd/alasd
