'use strict'
/**
 * Local transcription for Knight Studio clips.
 *
 * Drives scripts/transcribe.py (faster-whisper, CPU/int8) out of process so a
 * long transcription never blocks the main process, and caches the result as
 * <clipDir>/transcript.json so the editor only pays for it once per clip.
 *
 * Nothing leaves the machine: ffmpeg pulls one audio track out of screen.mov,
 * Whisper runs locally, the JSON lands next to the recording.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const TRANSCRIPT_FILE = 'transcript.json'
const DEFAULT_MODEL = 'small'
const DEFAULT_LANGUAGE = 'auto'
const CHECK_TIMEOUT_MS = 30000

/** Python interpreters worth trying, best first. */
function pythonCandidates () {
  // /usr/bin/python3 is only a placeholder on a Mac without Apple's developer tools:
  // running it makes macOS pop up an "install the command line developer tools"
  // window. So the system Python (and a bare PATH lookup, which can land on it) is
  // only tried when those tools are actually installed.
  const devTools = fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/python3') ||
    fs.existsSync('/Applications/Xcode.app/Contents/Developer/usr/bin/python3')
  return [
    process.env.KNIGHT_STUDIO_PYTHON,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/opt/homebrew/opt/python@3.14/bin/python3.14',
    devTools && '/usr/bin/python3',
    devTools && 'python3' // last resort: whatever PATH resolves to
  ].filter(Boolean)
}

/** Where scripts/transcribe.py lives, in dev and inside a packaged app. */
function scriptPath () {
  const candidates = [
    process.env.KNIGHT_STUDIO_TRANSCRIBE_SCRIPT,
    path.join(__dirname, '..', '..', 'scripts', 'transcribe.py'),
    process.resourcesPath && path.join(process.resourcesPath, 'scripts', 'transcribe.py'),
    process.resourcesPath && path.join(process.resourcesPath, 'transcribe.py'),
    process.resourcesPath && path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'transcribe.py')
  ].filter(Boolean)
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* keep looking */ }
  }
  return candidates[1]
}

function transcriptPath (clipDir) {
  return path.join(clipDir, TRANSCRIPT_FILE)
}

function readManifest (clipDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(clipDir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Absolute stream indices of the clip's audio tracks.
 *
 * Stream 0 is always the video. The recorder writes system audio first and the
 * microphone second, so the mapping falls straight out of the manifest flags:
 * both enabled -> system 1, mic 2; only one enabled -> that one is 1.
 */
function audioTracks (manifest) {
  const out = { system: null, mic: null }
  // Stream 0 is the video, so audio stream n is absolute stream n + 1. Recordings
  // state their own track order; trusting a fixed order here once had the transcriber
  // listening to system audio and finding no speech in a take full of it.
  const order = manifest && manifest.audioOrder
  if (Array.isArray(order) && order.length) {
    order.forEach((kind, i) => {
      if (kind === 'microphone') out.mic = i + 1
      else if (kind === 'system') out.system = i + 1
    })
    return out
  }
  const audio = (manifest && manifest.audio) || {}
  let next = 1
  if (audio.system) out.system = next++
  if (audio.microphone) out.mic = next
  return out
}

/** The microphone carries the voiceover, so prefer it; fall back to system audio. */
function preferredTrack (manifest) {
  const t = audioTracks(manifest)
  return t.mic != null ? t.mic : t.system
}

// --------------------------------------------------------------------------
// running the python side
// --------------------------------------------------------------------------

/**
 * Spawns the CLI and parses its JSON-lines stdout.
 * Resolves with the last `done` payload; rejects on `error` or a bad exit.
 */
function runScript (python, args, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err)
      return
    }

    let stdoutBuf = ''
    let stderrTail = ''
    let done = null
    let failure = null
    let settled = false

    const onAbort = () => { try { child.kill('SIGTERM') } catch { /* already gone */ } }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort) }
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }

    const handleLine = (line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed[0] !== '{') return
      let msg
      try { msg = JSON.parse(trimmed) } catch { return }
      if (msg.event === 'progress' && typeof msg.pct === 'number') {
        if (onProgress) { try { onProgress(msg.pct) } catch { /* UI callback must not kill the job */ } }
      } else if (msg.event === 'done' || msg.event === 'ok') {
        done = msg
      } else if (msg.event === 'error') {
        failure = new Error(msg.message || 'transcription failed')
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdoutBuf += chunk
      let nl
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        handleLine(stdoutBuf.slice(0, nl))
        stdoutBuf = stdoutBuf.slice(nl + 1)
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      stderrTail = (stderrTail + chunk).slice(-4000)
    })

    child.on('error', err => settle(reject, err))
    child.on('close', code => {
      if (stdoutBuf) handleLine(stdoutBuf)
      if (failure) return settle(reject, failure)
      if (code === 0 && done) return settle(resolve, done)
      if (code === 0) return settle(reject, new Error('transcriber produced no result'))
      settle(reject, new Error(
        `transcriber exited ${code}${stderrTail ? `\n${stderrTail.slice(-1500)}` : ''}`
      ))
    })
  })
}

// --------------------------------------------------------------------------
// availability
// --------------------------------------------------------------------------

let envCache = null

/**
 * Probes each candidate interpreter until one can import faster_whisper and
 * find ffmpeg/ffprobe. Result is memoised for the life of the process.
 *
 * @returns {Promise<{ok: boolean, python: string|null, script: string,
 *                     fasterWhisper?: string, ffmpeg?: string, reason?: string}>}
 */
async function checkEnvironment ({ force = false } = {}) {
  if (envCache && !force) return envCache

  const script = scriptPath()
  const reasons = []
  const seen = new Set()
  // KNIGHT_STUDIO_STT=builtin skips the Python search, to test what a fresh Mac gets.
  const pythons = (process.env.KNIGHT_STUDIO_STT === 'builtin' || !fs.existsSync(script)) ? [] : pythonCandidates()
  for (const python of pythons) {
    if (seen.has(python)) continue
    seen.add(python)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), CHECK_TIMEOUT_MS)
    try {
      const info = await runScript(python, [script, '--check'], { signal: ac.signal })
      envCache = {
        ok: true,
        python,
        script,
        engine: 'faster-whisper',
        fasterWhisper: info.fasterWhisper,
        pythonVersion: info.python,
        ffmpeg: info.ffmpeg
      }
      return envCache
    } catch (err) {
      reasons.push(`${python}: ${String(err.message || err).split('\n')[0]}`)
    } finally {
      clearTimeout(timer)
    }
  }

  // No Python transcriber on this Mac — the normal case for a downloaded copy of the
  // app. The built-in engine takes over.
  const whisper = require('./whisper')
  if (whisper.available()) {
    envCache = { ok: true, engine: 'whisper.cpp', python: null, script }
    return envCache
  }

  envCache = {
    ok: false,
    python: null,
    script,
    reason: `no speech-to-text engine found.\n${reasons.join('\n')}`
  }
  return envCache
}

/**
 * Cheap yes/no for the UI, so the Transcribe button can be disabled up front
 * instead of failing at click time.
 * @returns {Promise<boolean>}
 */
async function isAvailable () {
  const env = await checkEnvironment()
  return env.ok
}

// --------------------------------------------------------------------------
// transcription
// --------------------------------------------------------------------------

/** The cached transcript for a clip, or null when there isn't one. */
function readTranscript (clipDir) {
  try {
    const raw = fs.readFileSync(transcriptPath(clipDir), 'utf8')
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : null
  } catch {
    return null
  }
}

const inFlight = new Map()

/**
 * Transcribes a clip's voiceover and caches it to <clipDir>/transcript.json.
 *
 * @param {object}   opts
 * @param {string}   opts.clipDir     clip folder holding screen.mov + manifest.json
 * @param {string}  [opts.model]      faster-whisper model (default 'small')
 * @param {string}  [opts.language]   language code, or 'auto' (default)
 * @param {number}  [opts.track]      override the audio stream index
 * @param {boolean} [opts.force]      re-run even when a cached transcript exists
 * @param {(pct:number)=>void} [opts.onProgress]  0..1
 * @param {AbortSignal} [opts.signal] cancels the run
 * @returns {Promise<object>} the parsed transcript
 */
async function transcribeClip ({
  clipDir,
  model = DEFAULT_MODEL,
  language = DEFAULT_LANGUAGE,
  track,
  force = false,
  onProgress,
  signal
} = {}) {
  if (!clipDir) throw new Error('transcribeClip: clipDir is required')

  if (!force) {
    const cached = readTranscript(clipDir)
    if (cached) {
      if (onProgress) { try { onProgress(1) } catch { /* ignore */ } }
      return cached
    }
  }

  // One run per clip: a second caller just waits on the first.
  const key = `${clipDir}::${model}::${language}`
  if (inFlight.has(key)) return inFlight.get(key)

  const job = (async () => {
    const source = path.join(clipDir, 'screen.mov')
    if (!fs.existsSync(source)) throw new Error(`recording not found: ${source}`)

    const manifest = readManifest(clipDir)
    if (manifest && manifest.audio && !manifest.audio.microphone && !manifest.audio.system) {
      throw new Error('this clip was recorded without audio — nothing to transcribe')
    }

    const env = await checkEnvironment()
    if (!env.ok) throw new Error(env.reason || 'transcription is unavailable')

    // Manifest wins; without one, let the script pick from the file itself.
    const chosen = track != null ? track : preferredTrack(manifest)
    const out = transcriptPath(clipDir)

    const args = [
      env.script,
      '--input', source,
      '--track', String(chosen == null ? 'auto' : chosen),
      '--out', out,
      '--model', model,
      '--language', language || DEFAULT_LANGUAGE
    ]

    if (env.engine === 'whisper.cpp') {
      const transcript = await require('./whisper').transcribe({
        source, track: chosen, model, language: language || DEFAULT_LANGUAGE, onProgress, signal
      })
      const tmp = `${out}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(transcript, null, 2))
      fs.renameSync(tmp, out)
      return transcript
    }

    await runScript(env.python, args, { onProgress, signal })

    const result = readTranscript(clipDir)
    if (!result) throw new Error(`transcriber reported success but ${out} is unreadable`)
    return result
  })()

  inFlight.set(key, job)
  try {
    return await job
  } finally {
    inFlight.delete(key)
  }
}

/** Deletes a clip's cached transcript. Returns true when one was removed. */
function clearTranscript (clipDir) {
  try {
    fs.unlinkSync(transcriptPath(clipDir))
    return true
  } catch {
    return false
  }
}

/**
 * Rough estimate of how much of a clip's audio is loud enough to be speech.
 *
 * Whisper will happily grind for many minutes on a track that is nothing but fan
 * noise and room tone, decoding and rejecting hallucinations the whole way. A cheap
 * ffmpeg pass up front lets an obviously speechless recording skip straight past it.
 *
 * @returns {Promise<number>} fraction of the track above the speech threshold, 0..1
 */
async function speechFraction (clipDir) {
  try {
    const manifest = readManifest(clipDir)
    const duration = manifest?.duration
    if (!duration || duration <= 0) return 1        // unknown: assume speech, let the timeout guard
    const idx = preferredTrack(manifest)            // absolute stream index
    if (idx == null) return 0
    const src = path.join(clipDir, 'screen.mov')
    if (!fs.existsSync(src)) return 0

    const { tool } = require('./export')
    // silencedetect reports on stderr and still exits 0, so capture stderr directly
    // rather than relying on a helper that only surfaces it on failure.
    const stderr = await new Promise(resolve => {
      const child = spawn(tool('ffmpeg'), [
        '-hide_banner', '-nostats', '-i', src, '-map', `0:${idx}`,
        '-af', 'silencedetect=noise=-25dB:d=0.35', '-f', 'null', '-'
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      let out = ''
      child.stderr.on('data', d => { out += d })
      child.on('error', () => resolve(''))
      child.on('close', () => resolve(out))
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} resolve(out) }, 20000)
    })

    let silent = 0
    for (const m of stderr.matchAll(/silence_duration:\s*([0-9.]+)/g)) silent += Number(m[1]) || 0
    if (!silent) return 1
    return Math.max(0, Math.min(1, (duration - silent) / duration))
  } catch {
    return 1
  }
}

module.exports = {
  speechFraction,
  transcribeClip,
  readTranscript,
  clearTranscript,
  isAvailable,
  checkEnvironment,
  transcriptPath,
  audioTracks,
  preferredTrack,
  scriptPath,
  TRANSCRIPT_FILE
}
