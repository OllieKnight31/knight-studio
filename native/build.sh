#!/usr/bin/env bash
# Builds the knightcap native capture binary as a universal binary, so one copy of
# the app runs on both Apple-silicon and Intel Macs.
#   build.sh          release (-O, whole-module) — slow compile, ship this
#   build.sh --fast   debug (-Onone), this Mac's architecture only — quick iteration
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DIR/bin"
OPT=(-O -whole-module-optimization)
ARCHS=(arm64 x86_64)
if [[ "${1:-}" == "--fast" ]]; then OPT=(-Onone); ARCHS=("$(uname -m)"); fi

SLICES=()
for ARCH in "${ARCHS[@]}"; do
  # The Info.plist is linked INTO the binary. macOS needs a bundle identity on the
  # capture engine to persist its privacy grants; without it every recording re-prompts.
  swiftc "${OPT[@]}" \
    -target "$ARCH-apple-macosx15.0" \
    -framework ScreenCaptureKit -framework AVFoundation -framework Cocoa -framework CoreMedia \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$DIR/Info.plist" \
    "$DIR/src/Log.swift" "$DIR/src/EventTracker.swift" "$DIR/src/Recorder.swift" \
    "$DIR/src/ListCommand.swift" "$DIR/src/main.swift" \
    -o "$DIR/bin/knightcap-$ARCH"
  SLICES+=("$DIR/bin/knightcap-$ARCH")
done
lipo -create "${SLICES[@]}" -output "$DIR/bin/knightcap"
rm -f "${SLICES[@]}"
echo "built -> $DIR/bin/knightcap ($(lipo -archs "$DIR/bin/knightcap"))"
