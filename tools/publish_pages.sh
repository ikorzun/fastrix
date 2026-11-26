#!/usr/bin/env bash
# Publish a play build (no Bridge) to the gh-pages branch -> https://ikorzun.github.io/fastrix/
# Usage: tools/publish_pages.sh /mnt/project-files/shooter_builds/shooter_arena_vNN.html vNN
set -euo pipefail
SRC=$1; VER=${2:-new}; ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); W=$TMP/wt
python3 -I "$ROOT/tools/build.py" --no-bridge "$SRC" "$TMP/out"
rm -f "$TMP/out/playgama-bridge-config.json"; touch "$TMP/out/.nojekyll"
git -C "$ROOT" fetch -q origin +refs/heads/gh-pages:refs/remotes/origin/gh-pages
git -C "$ROOT" worktree add -q "$W" origin/gh-pages --detach
find "$W" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$TMP/out/." "$W/"
git -C "$W" add -A
git -C "$W" commit -q -m "Play build $VER for testers (no Bridge)" || echo "nothing changed"
git -C "$W" push -q origin HEAD:gh-pages
git -C "$ROOT" worktree remove --force "$W"; rm -rf "$TMP"
echo "published $VER -> https://ikorzun.github.io/fastrix/"
