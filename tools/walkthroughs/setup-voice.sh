#!/bin/sh
# One-time setup for the Kokoro voice used by the walkthrough videos.
# A neural text-to-speech model (Apache 2.0) that runs locally: no key, no account, no cost.
# Needs `uv` (https://docs.astral.sh/uv/) and about 400 MB of disk.
set -e
DIR="${KOKORO_DIR:-$HOME/.cache/eod-walkthrough-voice}"
mkdir -p "$DIR" && cd "$DIR"
[ -d venv ] || uv venv --python 3.12 venv
uv pip install --python venv/bin/python -q kokoro-onnx soundfile
for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  [ -s "$f" ] || curl -L --progress-bar -o "$f" "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$f"
done
echo "Kokoro voice ready in $DIR, now run: node tools/walkthroughs/build.js"
