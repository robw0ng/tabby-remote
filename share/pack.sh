#!/usr/bin/env bash
# Builds the zip to share with a coworker: dist/tabby-remote-<version>.zip, holding INSTALL.md (for their agent),
# README.md (for them) and the tabby-remote/ plugin folder with its production dependencies.
# Run from the repo root: bash share/pack.sh
set -euo pipefail
version=$(node -p "require('./package.json').version")
root=dist/package
out="$root/tabby-remote"
rm -rf dist
mkdir -p "$out"
cp share/INSTALL.md share/README.md "$root/"
cp -r index.js ws.js web package.json package-lock.json "$out/"
(cd "$out" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
rm "$out/package-lock.json"
# A coworker needs no link to the private repo, and the dependencies' own docs are not needed to run them.
node share/strip-package.mjs "$out/package.json"
find "$out/node_modules" -type f \( -iname 'README*' -o -iname 'CHANGELOG*' -o -name '*.map' \) -delete
(cd "$root" && zip -qr "../tabby-remote-$version.zip" INSTALL.md README.md tabby-remote)
echo "dist/tabby-remote-$version.zip"
