#!/bin/bash
# Installs the packaged app into /Applications, signed with the local identity.
#
# The signature matters: macOS ties screen-recording, camera, microphone and
# accessibility grants to the app's designated requirement, which for this
# identity is "identifier + certificate leaf". Signing every rebuild with the
# same identity and the same identifiers means the permissions you granted once
# keep working, instead of macOS treating each build as a brand-new app.
set -euo pipefail

IDENTITY="${KS_IDENTITY:-Knight Studio Code Signing}"
SRC="release/mac-universal/Ainable Studio.app"
DEST="/Applications/Ainable Studio.app"

[ -d "$SRC" ] || { echo "no build at $SRC — run 'npm run dist' first" >&2; exit 1; }
# Note: the identity is self-signed, so `find-identity -v` (valid only) will not
# list it — macOS reports CSSMERR_TP_NOT_TRUSTED. codesign signs with it happily,
# and TCC only cares that the leaf certificate is the same one as last time.
#
# No such identity on this Mac (the normal case on a fresh machine): fall back to
# ad-hoc signing rather than stopping. The app installs and runs; the only cost is
# that macOS asks for the four permissions again after each rebuild. Run
# `bash build/make-identity.sh` once to avoid that.
if ! security find-identity -p codesigning | grep -q "$IDENTITY"; then
  echo "note: signing identity '$IDENTITY' not found, using ad-hoc signing instead."
  echo "      (optional) run 'bash build/make-identity.sh' once so permissions survive rebuilds."
  IDENTITY="-"
fi

bash "$(dirname "${BASH_SOURCE[0]}")/sign-app.sh" "$SRC" "$IDENTITY"

echo "→ installing to $DEST"
pkill -f "Ainable Studio.app/Contents/MacOS/Ainable Studio" 2>/dev/null || true
sleep 1
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

echo "→ designated requirement (this is what TCC remembers):"
codesign -d -r- "$DEST" 2>&1 | tail -1
