"""Kokoro voice for the walkthrough videos, a neural voice that runs on this machine.

Reads jobs from stdin as JSON lines {"text": ..., "out": ...} and writes one WAV each, so
the model is loaded once for a whole build. Prints "ok <out>" per job.

  python kokoro_tts.py <model.onnx> <voices.bin> <voice> [speed]
"""
import json
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

model, voices, voice = sys.argv[1], sys.argv[2], sys.argv[3]
speed = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
lang = "en-gb" if voice[0] == "b" else "en-us"      # voice ids starting b… are British
kokoro = Kokoro(model, voices)
print("ready", flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    job = json.loads(line)
    samples, rate = kokoro.create(job["text"], voice=voice, speed=speed, lang=lang)
    sf.write(job["out"], samples, rate)
    print("ok " + job["out"], flush=True)
