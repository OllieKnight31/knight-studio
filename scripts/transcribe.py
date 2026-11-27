#!/usr/bin/env python3
"""
Ainable Studio — local transcription backend.

Extracts a single audio track out of a clip's screen.mov with ffmpeg, runs it
through faster-whisper (CTranslate2, CPU/int8) with word-level timestamps and
writes a JSON transcript.

Usage:
    python3 scripts/transcribe.py --input <screen.mov> --track <n> --out <words.json>
                                  [--model small] [--language auto]

--track is the *absolute* ffmpeg stream index inside screen.mov (0 is the video
track). The recorder writes system audio first, then the microphone, so with
both enabled: 1 = system, 2 = microphone. It also accepts "auto" (default),
"mic" or "system", which are resolved from the clip's manifest.json — "auto"
prefers the microphone, because that is the voiceover.

Machine-readable progress is printed to stdout as JSON lines:
    {"event": "progress", "pct": 0.42}
    {"event": "done", "out": "/path/to/words.json"}
    {"event": "error", "message": "..."}
Everything human-facing (model loading, warnings, ffmpeg noise) goes to stderr,
so stdout stays parseable by the Electron main process.

Whisper settings mirror the `transcript` skill (~/.claude/skills/transcript):
faster-whisper, beam_size 5, VAD filter with a 500 ms minimum silence,
hallucination_silence_threshold 0.5 and no_speech_threshold 0.6 — plus extra
guards below for the repeated-hallucination failure mode, which screen
recordings (long silences, keyboard clatter) trigger constantly.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# Keep third-party libraries quiet on stdout.
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

SAMPLE_RATE = 16000

# Where ffmpeg / ffprobe usually live on this machine, in preference order.
BIN_DIRS = [
    os.path.join(os.path.expanduser("~"), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
]

# Phrases Whisper emits over silence or non-speech noise (subtitle-corpus
# residue). Dropped when the segment also looks like it holds no real speech.
FILLER_PHRASES = {
    "you", "thank you", "thank you.", "thanks", "thanks.", "bye", "bye.",
    "thank you for watching", "thank you for watching.", "thanks for watching",
    "thanks for watching!", "thanks for watching.", "please subscribe",
    "subscribe", "okay", "ok", "yeah", "hmm", "mm", "mhm", "uh", "um",
    "the end", "the end.", "silence", "[silence]", "music", "[music]",
    "applause", "[applause]", "background music", "outro music",
    "subtitles by the amara.org community", "amara.org",
    "transcription by castingwords", "www.mooji.org",
}


# --------------------------------------------------------------------------- #
# stdout protocol
# --------------------------------------------------------------------------- #

def emit(payload: dict) -> None:
    """Write one JSON line to stdout and flush it immediately."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    sys.stderr.write(f"[transcribe] {msg}\n")
    sys.stderr.flush()


class TranscribeError(Exception):
    """Anything we can report cleanly as {"event":"error"}."""


# --------------------------------------------------------------------------- #
# binaries
# --------------------------------------------------------------------------- #

def find_bin(name: str) -> str:
    for d in BIN_DIRS:
        candidate = os.path.join(d, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which(name)
    if found:
        return found
    raise TranscribeError(
        f"{name} not found. Install it (brew install ffmpeg) or put it in ~/.local/bin."
    )


def run_bin(args: list[str], timeout: float) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, check=False
        )
    except subprocess.TimeoutExpired as exc:
        raise TranscribeError(f"{Path(args[0]).name} timed out after {timeout:.0f}s") from exc


# --------------------------------------------------------------------------- #
# audio track selection + extraction
# --------------------------------------------------------------------------- #

def probe_streams(src: Path) -> list[dict]:
    ffprobe = find_bin("ffprobe")
    proc = run_bin(
        [ffprobe, "-v", "error", "-print_format", "json", "-show_streams", str(src)],
        timeout=120,
    )
    if proc.returncode != 0:
        raise TranscribeError(f"ffprobe failed on {src.name}: {proc.stderr.strip()[-500:]}")
    try:
        return json.loads(proc.stdout).get("streams", [])
    except json.JSONDecodeError as exc:
        raise TranscribeError(f"could not parse ffprobe output for {src.name}") from exc


def read_manifest(src: Path) -> dict:
    """The clip manifest sits next to screen.mov."""
    path = src.parent / "manifest.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def manifest_track(manifest: dict, want: str) -> int | None:
    """
    Map manifest audio flags onto absolute stream indices.

    The recorder writes system audio first, then the microphone, and stream 0 is
    always the video — so with both enabled system is 1 and the mic is 2; with
    only one enabled it is 1.
    """
    audio = (manifest or {}).get("audio") or {}
    has_sys = bool(audio.get("system"))
    has_mic = bool(audio.get("microphone"))
    idx = 1
    system_idx = None
    mic_idx = None
    if has_sys:
        system_idx = idx
        idx += 1
    if has_mic:
        mic_idx = idx
    if want == "system":
        return system_idx
    if want == "mic":
        return mic_idx
    # auto: the microphone is the voiceover, so prefer it.
    return mic_idx if mic_idx is not None else system_idx


def resolve_track(src: Path, requested: str, streams: list[dict]) -> int:
    audio_indices = [
        int(s["index"]) for s in streams if s.get("codec_type") == "audio"
    ]
    if not audio_indices:
        raise TranscribeError(f"{src.name} has no audio tracks — nothing to transcribe")

    want = (requested or "auto").strip().lower()
    if want in ("auto", "mic", "microphone", "system"):
        key = "system" if want == "system" else ("mic" if want in ("mic", "microphone") else "auto")
        track = manifest_track(read_manifest(src), key)
        if track is None or track not in audio_indices:
            # No manifest, or it disagrees with the file: fall back to the file.
            # "auto"/"mic" want the last audio track (the mic is written last).
            track = audio_indices[0] if key == "system" else audio_indices[-1]
        return track

    try:
        track = int(want)
    except ValueError as exc:
        raise TranscribeError(
            f"--track must be a stream index or auto/mic/system, got {requested!r}"
        ) from exc

    if track not in audio_indices:
        raise TranscribeError(
            f"stream {track} is not an audio track in {src.name}; "
            f"audio streams are {audio_indices}"
        )
    return track


def extract_audio(src: Path, track: int, dest: Path) -> None:
    """Decode one audio stream to 16 kHz mono 16-bit PCM wav."""
    ffmpeg = find_bin("ffmpeg")
    args = [
        ffmpeg, "-y", "-nostdin", "-v", "error",
        "-i", str(src),
        "-map", f"0:{track}",
        "-vn", "-sn", "-dn",
        "-ac", "1",
        "-ar", str(SAMPLE_RATE),
        "-c:a", "pcm_s16le",
        "-f", "wav",
        str(dest),
    ]
    proc = run_bin(args, timeout=1800)
    if proc.returncode != 0:
        raise TranscribeError(
            f"ffmpeg could not extract stream {track}: {proc.stderr.strip()[-500:]}"
        )
    if not dest.exists() or dest.stat().st_size <= 44:  # 44 = bare wav header
        raise TranscribeError(f"extracted audio for stream {track} is empty")


# --------------------------------------------------------------------------- #
# hallucination guards
# --------------------------------------------------------------------------- #

_NORMALISE = re.compile(r"[^\w\s]+", re.UNICODE)
_WS = re.compile(r"\s+")


def normalise(text: str) -> str:
    return _WS.sub(" ", _NORMALISE.sub("", text.lower())).strip()


# Compare fillers in the same normalised space as segment text.
FILLER_NORMALISED = {normalise(p) for p in FILLER_PHRASES}
FILLER_NORMALISED.discard("")


def has_internal_loop(text: str, limit: int = 4) -> bool:
    """True when one token repeats `limit`+ times back to back inside a segment."""
    tokens = normalise(text).split()
    if len(tokens) < limit:
        return False
    run = 1
    for a, b in zip(tokens, tokens[1:]):
        run = run + 1 if a == b else 1
        if run >= limit:
            return True
    # Also catch a short phrase looping, e.g. "so yeah so yeah so yeah so yeah".
    for size in (2, 3, 4):
        if len(tokens) >= size * 4:
            chunks = [
                " ".join(tokens[i:i + size])
                for i in range(0, len(tokens) - size + 1, size)
            ]
            for i in range(len(chunks) - 3):
                if chunks[i] and len(set(chunks[i:i + 4])) == 1:
                    return True
    return False


def looks_hallucinated(seg, text: str, recent: list[str]) -> str | None:
    """Return a reason string when the segment should be dropped, else None."""
    norm = normalise(text)
    if not norm:
        return "empty"

    no_speech = float(getattr(seg, "no_speech_prob", 0.0) or 0.0)
    avg_logprob = float(getattr(seg, "avg_logprob", 0.0) or 0.0)
    compression = float(getattr(seg, "compression_ratio", 0.0) or 0.0)

    if no_speech > 0.85 and avg_logprob < -0.4:
        return "no-speech"
    if compression > 2.4:
        return "compression"
    if avg_logprob < -1.2:
        return "low-confidence"
    if has_internal_loop(text):
        return "internal-loop"
    if recent and norm == recent[-1]:
        return "repeat"
    if len(recent) >= 2 and norm in recent[-3:] and len(norm) < 40:
        return "repeat"
    if norm in FILLER_NORMALISED and (no_speech > 0.4 or (seg.end - seg.start) > 2.5):
        return "filler"
    return None


# --------------------------------------------------------------------------- #
# transcription
# --------------------------------------------------------------------------- #

def transcribe(wav: Path, model_size: str, language: str | None) -> dict:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise TranscribeError(
            "faster-whisper is not installed for this Python. "
            "Install with: python3 -m pip install faster-whisper"
        ) from exc

    log(f"loading model {model_size} (cpu/int8)")
    started = time.time()
    try:
        # ctranslate2 has no Metal backend; int8 on CPU is the fast path on
        # Apple Silicon and is what the transcript skill settles on too.
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
    except Exception as exc:  # noqa: BLE001 — surfaced to the caller as JSON
        raise TranscribeError(f"could not load model {model_size!r}: {exc}") from exc
    log(f"model ready in {time.time() - started:.1f}s")

    segments_gen, info = model.transcribe(
        str(wav),
        beam_size=5,
        language=language,
        task="transcribe",
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        hallucination_silence_threshold=0.5,
        no_speech_threshold=0.6,
        # The single biggest anti-loop lever: never feed the previous window's
        # text back in as a prompt, so one bad guess cannot snowball.
        condition_on_previous_text=False,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
    )

    duration = float(getattr(info, "duration", 0.0) or 0.0)
    log(
        f"language={info.language} ({info.language_probability:.0%}) "
        f"duration={duration:.2f}s vad_duration={getattr(info, 'duration_after_vad', duration):.2f}s"
    )

    segments: list[dict] = []
    words: list[dict] = []
    recent: list[str] = []
    dropped = 0
    consecutive_dropped = 0
    last_pct = 0.0

    # Hard ceiling so a pathological loop can never spin forever: real speech
    # tops out well under 3 segments/second of audio.
    max_segments = int(max(200, duration * 3 + 200))

    for seg in segments_gen:
        text = (seg.text or "").strip()
        reason = looks_hallucinated(seg, text, recent)
        if reason:
            dropped += 1
            consecutive_dropped += 1
            log(f"dropped [{seg.start:.2f}-{seg.end:.2f}] ({reason}): {text[:80]!r}")
            if consecutive_dropped >= 25:
                log("too many consecutive hallucinated segments — stopping early")
                break
        else:
            consecutive_dropped = 0
            recent.append(normalise(text))
            recent = recent[-5:]
            segments.append(
                {"start": round(seg.start, 3), "end": round(seg.end, 3), "text": text}
            )
            for w in (seg.words or []):
                token = (w.word or "").strip()
                if not token:
                    continue
                words.append(
                    {
                        "start": round(float(w.start), 3),
                        "end": round(float(w.end), 3),
                        "word": token,
                        "probability": round(float(getattr(w, "probability", 0.0) or 0.0), 4),
                    }
                )

        if duration > 0:
            pct = min(0.99, max(0.0, seg.end / duration))
            if pct - last_pct >= 0.01:
                last_pct = pct
                emit({"event": "progress", "pct": round(pct, 4)})

        if len(segments) + dropped >= max_segments:
            log("segment ceiling reached — stopping early")
            break

    log(f"kept {len(segments)} segments, dropped {dropped}, {len(words)} words")

    return {
        "language": info.language,
        "languageProbability": round(float(info.language_probability), 4),
        "duration": round(duration, 3),
        "segments": segments,
        "words": words,
        "text": " ".join(s["text"] for s in segments).strip(),
        "speech": bool(segments),
        "droppedSegments": dropped,
    }


def write_json(path: Path, payload: dict) -> None:
    """Write atomically so a reader never sees a half-written transcript."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".transcript-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="transcribe.py",
        description="Transcribe one audio track of a Ainable Studio clip.",
    )
    p.add_argument("--input", "-i", help="Path to screen.mov")
    p.add_argument(
        "--track", "-t", default="auto",
        help="Absolute audio stream index, or auto|mic|system (default: auto = mic)",
    )
    p.add_argument("--out", "-o", help="Destination JSON file")
    p.add_argument(
        "--model", "-m", default="small",
        help="faster-whisper model: tiny|base|small|medium|large-v3 (default: small)",
    )
    p.add_argument(
        "--language", "-l", default="auto",
        help="Language code (en, de, ...) or 'auto' to detect (default: auto)",
    )
    p.add_argument(
        "--check", action="store_true",
        help="Verify faster-whisper and ffmpeg are usable, then exit",
    )
    return p


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)

    if args.check:
        try:
            import faster_whisper
            find_bin("ffmpeg")
            find_bin("ffprobe")
        except Exception as exc:  # noqa: BLE001
            emit({"event": "error", "message": str(exc)})
            return 1
        emit({
            "event": "ok",
            "fasterWhisper": getattr(faster_whisper, "__version__", "unknown"),
            "python": sys.version.split()[0],
            "ffmpeg": find_bin("ffmpeg"),
        })
        return 0

    tmpdir = None
    try:
        if not args.input or not args.out:
            raise TranscribeError("--input and --out are required")
        src = Path(args.input).expanduser()
        if not src.is_file():
            raise TranscribeError(f"input not found: {src}")

        out = Path(args.out).expanduser()
        language = None if (args.language or "auto").lower() in ("auto", "", "none") else args.language

        emit({"event": "progress", "pct": 0.0})

        streams = probe_streams(src)
        track = resolve_track(src, args.track, streams)
        log(f"using audio stream {track} of {src.name}")

        tmpdir = tempfile.mkdtemp(prefix="knight-transcribe-")
        wav = Path(tmpdir) / f"track{track}.wav"
        extract_audio(src, track, wav)
        emit({"event": "progress", "pct": 0.03})

        result = transcribe(wav, args.model, language)
        result.update({
            "source": str(src),
            "track": track,
            "model": args.model,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })

        write_json(out, result)
        emit({"event": "progress", "pct": 1.0})
        emit({"event": "done", "out": str(out)})
        return 0

    except TranscribeError as exc:
        emit({"event": "error", "message": str(exc)})
        return 1
    except KeyboardInterrupt:
        emit({"event": "error", "message": "interrupted"})
        return 130
    except Exception as exc:  # noqa: BLE001 — never crash with a raw traceback on stdout
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit({"event": "error", "message": f"{type(exc).__name__}: {exc}"})
        return 1
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
