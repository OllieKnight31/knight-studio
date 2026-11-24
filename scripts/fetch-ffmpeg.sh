#!/bin/bash
# Builds vendor/bin/ffmpeg: one universal binary (Apple silicon + Intel) from the
# ffmpeg-static project's prebuilt binaries. It is too large for git, so a fresh
# checkout runs this once after `npm install`. Safe to run again: it does nothing
# when the binary is already there (pass --force to rebuild it).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -x vendor/bin/ffmpeg ] && [ "${1:-}" != "--force" ]; then
  echo "vendor/bin/ffmpeg already present ($(lipo -archs vendor/bin/ffmpeg))"
  exit 0
fi

LOCAL="node_modules/ffmpeg-static/ffmpeg"
[ -f "$LOCAL" ] || { echo "no $LOCAL: run 'npm install' first" >&2; exit 1; }

TAG="$(node -p "require('./node_modules/ffmpeg-static/package.json')['ffmpeg-static']['binary-release-tag']")"
# npm installs the binary for this Mac's own processor; download the other one.
HAVE="$(lipo -archs "$LOCAL")"
case "$HAVE" in
  arm64)  OTHER="x64" ;;
  x86_64) OTHER="arm64" ;;
  *) echo "unexpected architecture in $LOCAL: $HAVE" >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/other.gz" "https://github.com/eugeneware/ffmpeg-static/releases/download/$TAG/ffmpeg-darwin-$OTHER.gz"
gunzip "$TMP/other.gz"
mkdir -p vendor/bin
lipo -create "$LOCAL" "$TMP/other" -output vendor/bin/ffmpeg
chmod +x vendor/bin/ffmpeg
echo "built vendor/bin/ffmpeg ($(lipo -archs vendor/bin/ffmpeg))"
