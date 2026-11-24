#!/bin/bash
# Builds the copy of Knight Studio that other people download.
#
#   npm run package
#
# Produces release/Knight-Studio-<version>-mac-universal.zip containing the app and a
# short install note.
#
# Two levels of polish, depending on what is available:
#
#   No Apple Developer account (default)
#     The app is ad-hoc signed. It runs on any Mac on macOS 15 or later, Apple
#     silicon or Intel, but macOS will not open it on a double-click the first time: the
#     person has to approve it once in System Settings → Privacy & Security →
#     "Open Anyway". The install note walks them through it.
#
#   With an Apple Developer account
#     KS_DEVELOPER_ID="Developer ID Application: Your Name (TEAMID)"
#     KS_NOTARY_PROFILE="a profile saved with: xcrun notarytool store-credentials"
#     The app is signed with the hardened runtime, sent to Apple's notary service
#     and stapled. It then opens on a double-click like any other Mac app, and
#     keeps its permissions across updates.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION="$(node -p "require('./package.json').version")"
APP="release/mac-universal/Knight Studio.app"
STAGE="release/Knight Studio"
ZIP="release/Knight-Studio-$VERSION-mac-universal.zip"

npm run dist

if [ -n "${KS_DEVELOPER_ID:-}" ]; then
  echo "→ signing with $KS_DEVELOPER_ID (hardened runtime)"
  bash scripts/sign-app.sh "$APP" "$KS_DEVELOPER_ID" --hardened
else
  echo "→ no KS_DEVELOPER_ID set — ad-hoc signing"
  bash scripts/sign-app.sh "$APP" "-"
fi

if [ -n "${KS_DEVELOPER_ID:-}" ] && [ -n "${KS_NOTARY_PROFILE:-}" ]; then
  echo "→ notarising (this takes a few minutes)"
  rm -f release/notarise.zip
  ditto -c -k --keepParent "$APP" release/notarise.zip
  xcrun notarytool submit release/notarise.zip --keychain-profile "$KS_NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f release/notarise.zip
  NOTE="docs/INSTALL-notarised.txt"
else
  NOTE="docs/INSTALL.txt"
fi

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
cp "$NOTE" "$STAGE/How to install.txt"
ditto -c -k --keepParent "$STAGE" "$ZIP"
rm -rf "$STAGE"

# The small file the app's updater reads. Put it and the zip somewhere public, set
# "knight.updateFeed" in package.json to this file's address, and every copy built
# after that will offer new versions by itself.
SHA="$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
BASE="${KS_UPDATE_BASE:-https://REPLACE-WITH-WHERE-THE-ZIP-IS-HOSTED}"
cat > release/latest.json <<JSON
{
  "version": "$VERSION",
  "url": "$BASE/$(basename "$ZIP")",
  "sha256": "$SHA",
  "notes": "${KS_UPDATE_NOTES:-}"
}
JSON

echo
echo "built: $ZIP ($(du -h "$ZIP" | cut -f1))"
[ -f build/drive-client.json ] || echo "note: no build/drive-client.json — Google Drive will ask each person for their own Google client."
