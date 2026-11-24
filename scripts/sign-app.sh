#!/bin/bash
# Signs a built Knight Studio.app, inside-out, with whatever identity it is given.
#
#   sign-app.sh <path to .app> <identity> [--hardened]
#
#   identity "-"                        ad-hoc: runs anywhere, no Apple account needed
#   identity "Knight Studio Code Signing"   the local self-signed identity (your own Mac)
#   identity "Developer ID Application: …"  Apple-issued, for copies other people download
#
# --hardened turns on the hardened runtime and the entitlements Apple's notary
# service requires. Only meaningful with a Developer ID.
set -euo pipefail

APP="$1"
IDENTITY="$2"
HARDENED="${3:-}"
APP_ID="com.knightstudio.app"
HELPER_ID="knightcap"          # must NOT be the app's id — see native/Info.plist
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTITLEMENTS="$ROOT/build/entitlements.mac.plist"

[ -d "$APP" ] || { echo "no app at $APP" >&2; exit 1; }

OPTS=(--force --timestamp=none)
if [ "$HARDENED" = "--hardened" ]; then
  OPTS=(--force --timestamp --options runtime --entitlements "$ENTITLEMENTS")
fi

sign() { codesign "${OPTS[@]}" --sign "$IDENTITY" "$@"; }

echo "→ signing helpers"
sign -i "$HELPER_ID" "$APP/Contents/Resources/knightcap"
# The bundled ffmpeg and speech engine are separate programs and need their own seal.
for bin in "$APP/Contents/Resources/bin/"*; do
  [ -f "$bin" ] && sign "$bin"
done

# Everything Electron ships with, deepest first, so the outer signature seals a
# tree that is already valid.
find "$APP/Contents/Frameworks" -type f \( -name "*.dylib" -o -perm +111 \) -not -path "*.framework/Versions/*/Resources/*" 2>/dev/null |
  while IFS= read -r f; do
    file "$f" | grep -q "Mach-O" && sign "$f" 2>/dev/null || true
  done
find "$APP/Contents/Frameworks" -maxdepth 1 -type d \( -name "*.app" -o -name "*.framework" \) -print0 2>/dev/null |
  while IFS= read -r -d '' item; do
    sign "$item" 2>/dev/null || true
  done

echo "→ signing app"
sign -i "$APP_ID" "$APP"
codesign --verify --deep --strict "$APP" && echo "  signature verifies"
