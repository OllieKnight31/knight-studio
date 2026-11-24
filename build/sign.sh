#!/usr/bin/env bash
# Signs the built app, inside-out.
#
# Prefers the stable self-signed identity created by build/make-identity.sh. That
# matters for more than tidiness: macOS pins privacy grants to the app's designated
# requirement. Signed with a fixed certificate the requirement is
#   identifier "com.knightstudio.app" and certificate leaf = H"…"
# which does not change when the code does — so Camera, Microphone, Screen Recording
# and Accessibility stay granted across rebuilds. Ad-hoc signing pins to the code
# hash instead, and every rebuild would silently revoke them.
set -euo pipefail

APP="${1:-release/mac-universal/Knight Studio.app}"
ID="com.knightstudio.app"
CERT="Knight Studio Code Signing"
[[ -d "$APP" ]] || { echo "no app bundle at $APP" >&2; exit 1; }

if security find-certificate -c "$CERT" >/dev/null 2>&1; then
  SIGNER="$CERT"
  echo "signing with stable identity: $CERT"
else
  SIGNER="-"
  echo "no stable identity found — falling back to ad-hoc (run build/make-identity.sh)"
fi

sign() { codesign --force --sign "$SIGNER" --timestamp=none "$@" >/dev/null 2>&1 || true; }

# Nested code first: signing the outer bundle seals whatever is inside it.
find "$APP/Contents/Frameworks" -name "*.dylib" -type f 2>/dev/null | while read -r f; do sign "$f"; done
find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.framework" -type d 2>/dev/null | while read -r f; do sign "$f"; done
find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.app" -type d 2>/dev/null | while read -r h; do sign "$h"; done

# The capture engine is spawned as a child process and needs its own signature. It
# keeps the identifier "knightcap", matching the Info.plist linked into the binary:
# that pair gives macOS a durable identity to record its camera and microphone grants
# against, instead of the bare unidentified binary it used to be. It must NOT claim the
# app's bundle identifier — macOS then reads it as a conflicting second copy of the app
# and refuses screen capture entirely.
if [[ -f "$APP/Contents/Resources/knightcap" ]]; then
  codesign --force --sign "$SIGNER" --timestamp=none \
    --identifier knightcap "$APP/Contents/Resources/knightcap" >/dev/null 2>&1 || true
fi

codesign --force --sign "$SIGNER" --timestamp=none --identifier "$ID" "$APP"

echo "signed:"
codesign -dv "$APP" 2>&1 | grep -E "Identifier|flags|Authority" | sed 's/^/  /'
echo "designated requirement (what macOS pins permissions to):"
codesign -d -r- "$APP" 2>&1 | grep designated | sed 's/^/  /'
