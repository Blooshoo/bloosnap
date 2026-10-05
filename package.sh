#!/usr/bin/env bash
# Zip the extension files (no spec/docs/dev files) for sideloading or store upload.
set -euo pipefail
cd "$(dirname "$0")"
v=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
mkdir -p dist
out="dist/bloosnap-$v.zip"
rm -f "$out"
zip -r "$out" manifest.json background.js db.js editor.html editor.js pdf.js emoji-data.js icons
echo "$out"
