#!/usr/bin/env bash
# Build alas_native for this machine and for Windows, into the ALAS root:
#   alas_native.abi3.so (Linux) and alas_native.pyd (Windows), both gitignored.
# Needs Rust with the x86_64-pc-windows-gnu target, maturin and zig (Windows cross build).
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export PATH="$HOME/.local/zig:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
out="$(mktemp -d)"
trap 'rm -rf -- "$out"' EXIT
maturin build --quiet --release -i ../.venv/bin/python -o "$out/linux"
maturin build --quiet --release --target x86_64-pc-windows-gnu --zig -o "$out/windows"
python3 - "$out" .. <<'PY'
import glob, os, shutil, sys, zipfile
out, root = sys.argv[1:]
for wheel, member, target in [
    (glob.glob(f"{out}/linux/*.whl")[0], "alas_native/alas_native.abi3.so", "alas_native.abi3.so"),
    (glob.glob(f"{out}/windows/*.whl")[0], "alas_native/alas_native.pyd", "alas_native.pyd"),
]:
    with zipfile.ZipFile(wheel) as z, z.open(member) as src, open(os.path.join(root, target), "wb") as dst:
        shutil.copyfileobj(src, dst)
    print("built", target)
PY
