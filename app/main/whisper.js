'use strict'
/**
 * Built-in speech-to-text.
 *
 * The app ships its own copy of whisper.cpp, so captions work on a Mac with nothing
 * else installed. The one thing it cannot ship is the speech model — they are large —
 * so the model is downloaded once, the first time captions are used, and kept beside
 * the settings. Everything runs on this Mac; no audio is uploaded.
 *
 * The transcript written here has the same shape the Python transcriber produces, so
 * captions, cut-by-word and titling do not care which engine made it.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const https = require('node:https')
const prefs = require('./prefs')
const { tool, find, probe } = require('./tools')

const MODEL_DIR = path.join(prefs.SETTINGS_DIR, 'models')
const MODELS = {
  // name -> file, size shown to the user before they commit to a download
  base: { file: 'ggml-base.bin', mb: 148, label: 'Standard' },
  small: { file: 'ggml-small.bin', mb: 488, label: 'More accurate' }
}
const MODEL_URL = file => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`

// What Whisper writes over silence, music or keyboard noise. None of it is speech.
const NON_SPEECH = /^[\[(♪*].*[\])♪*]$|^\[.*$|^\(.*$/
const FILLER_ONLY = new Set(['you', 'thank you', 'thanks for watching', 'thank you for watching', 'bye', 'okay'])

const available = () => !!find('whisper-cli')
const modelPath = name => path.join(MODEL_DIR, (MODELS[name] || MODELS.base).file)
const hasModel = name => {
  try { return fs.statSync(modelPath(name)).size > 10_000_000 } catch { return false }
}

/** The model captions should use: the one in Settings if it is downloaded, else any that is. */
function pickModel (wanted) {
  const preferred = prefs.read().captions?.model || 'base'
  for (const name of [wanted, preferred, 'small', 'base']) if (name && MODELS[name] && hasModel(name)) return name
  return null
}

const downloads = new Map()

/** Downloads a model once. Concurrent callers share the same download. */
function ensureModel (name = 'base', onProgress) {
  if (!MODELS[name]) name = 'base'
  if (hasModel(name)) return Promise.resolve(modelPath(name))
  if (downloads.has(name)) {
    const d = downloads.get(name)
    if (onProgress) d.listeners.push(onProgress)
    return d.promise
  }
  const listeners = onProgress ? [onProgress] : []
  const dest = modelPath(name)
  const part = `${dest}.part`
  const promise = new Promise((resolve, reject) => {
    fs.mkdirSync(MODEL_DIR, { recursive: true })
    const fetch = (url, hops) => {
      https.get(url, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 6) {
          res.resume()
          return fetch(new URL(res.headers.location, url).toString(), hops + 1)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`The speech model could not be downloaded (HTTP ${res.statusCode}).`))
        }
        const total = Number(res.headers['content-length']) || MODELS[name].mb * 1024 * 1024
        let got = 0
        const out = fs.createWriteStream(part)
        res.on('data', chunk => {
          got += chunk.length
          for (const fn of listeners) { try { fn(Math.min(0.999, got / total)) } catch {} }
        })
        res.pipe(out)
        out.on('finish', () => out.close(() => {
          try { fs.renameSync(part, dest); resolve(dest) } catch (e) { reject(e) }
        }))
        out.on('error', reject)
        res.on('error', reject)
      }).on('error', e => reject(new Error(`The speech model could not be downloaded — check the internet connection. (${e.message})`)))
    }
    fetch(MODEL_URL(MODELS[name].file), 0)
  }).finally(() => {
    downloads.delete(name)
    try { fs.unlinkSync(part) } catch {}
  })
  downloads.set(name, { promise, listeners })
  return promise
}

function removeModel (name) {
  try { fs.unlinkSync(modelPath(name)); return true } catch { return false }
}

function status () {
  return {
    available: available(),
    models: Object.entries(MODELS).map(([name, m]) => ({ name, label: m.label, mb: m.mb, downloaded: hasModel(name) })),
    model: pickModel(),
    downloading: [...downloads.keys()]
  }
}

function run (bin, args, { signal, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let tail = ''
    const abort = () => { try { child.kill('SIGTERM') } catch {} }
    if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }) }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', d => { tail = (tail + d).slice(-3000); if (onStderr) onStderr(d) })
    child.on('error', reject)
    child.on('close', code => {
      if (signal) signal.removeEventListener('abort', abort)
      if (signal?.aborted) return reject(new Error('transcription was cancelled'))
      code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited ${code}\n${tail.slice(-800)}`))
    })
  })
}

/** Groups words into sentence-like segments, the way the captions and titler expect. */
function toSegments (words) {
  const segments = []
  let cur = []
  const flush = () => {
    if (!cur.length) return
    segments.push({
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      text: cur.map(w => w.word).join(' ').replace(/\s+/g, ' ').trim()
    })
    cur = []
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    cur.push(w)
    const next = words[i + 1]
    if (/[.!?]$/.test(w.word) || !next || next.start - w.end > 0.9 || cur.length >= 40) flush()
  }
  flush()
  return segments
}

/**
 * Transcribes one audio stream of a recording.
 *
 * @param {object} opts
 * @param {string} opts.source      the recording (screen.mov)
 * @param {number|null} opts.track  absolute stream index of the audio to use (null = first audio)
 * @param {string} [opts.model]     'base' | 'small'
 * @param {string} [opts.language]  ISO code, or 'auto'
 * @param {(pct:number)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
async function transcribe ({ source, track, model, language = 'auto', onProgress, signal }) {
  const bin = find('whisper-cli')
  if (!bin) throw new Error('The speech-to-text engine is missing from this copy of the app.')
  const report = pct => { if (onProgress) { try { onProgress(pct) } catch {} } }

  // First use downloads the model; that is the first stretch of the progress bar.
  let name = pickModel(model)
  let base = 0
  if (!name) {
    name = MODELS[model] ? model : (prefs.read().captions?.model || 'base')
    base = 0.3
    await ensureModel(name, f => report(f * base))
  }
  const scale = 1 - base

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-stt-'))
  const wav = path.join(tmp, 'audio.wav')
  const outBase = path.join(tmp, 'out')
  try {
    await run(tool('ffmpeg'), ['-v', 'error', '-y', '-i', source,
      ...(track != null ? ['-map', `0:${track}`] : ['-map', '0:a:0']),
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal })

    let duration = 0
    try { duration = Number((await probe(wav)).format.duration) || 0 } catch {}

    await run(bin, [
      '-m', modelPath(name), '-f', wav, '-l', language || 'auto',
      '-ojf', '-of', outBase,
      '-ml', '1', '-sow',            // one word per entry, with its own timestamps
      '-sns',                        // no music/noise tokens
      // Whisper tidies speech by default and drops "um" and "uh". Showing it some makes
      // it write them down, which is what lets them be found and cut out.
      '--prompt', 'Umm, let me think, like, hmm... Okay, uh, here is what I am, erm, thinking.',
      '-pp', '-np'
    ], {
      signal,
      onStderr: chunk => {
        const m = /progress\s*=\s*(\d+)%/.exec(chunk)
        if (m) report(base + scale * Math.min(0.99, Number(m[1]) / 100))
      }
    })

    const raw = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8'))
    const words = []
    for (const t of raw.transcription || []) {
      const text = String(t.text || '').trim()
      if (!text || NON_SPEECH.test(text)) continue
      const start = (t.offsets?.from ?? 0) / 1000
      const end = Math.max(start + 0.02, (t.offsets?.to ?? 0) / 1000)
      // Punctuation that arrives on its own belongs to the word before it.
      if (/^[.,!?;:'"’)\]]+$/.test(text) && words.length) {
        words[words.length - 1].word += text
        words[words.length - 1].end = end
        continue
      }
      words.push({ word: text, start: +start.toFixed(3), end: +end.toFixed(3) })
    }

    const text = words.map(w => w.word).join(' ').trim()
    const plain = text.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim()
    const speech = words.length >= 3 && !FILLER_ONLY.has(plain)
    const kept = speech ? words : []
    report(1)
    return {
      language: raw.result?.language || language,
      duration: +duration.toFixed(3),
      segments: toSegments(kept),
      words: kept,
      text: kept.map(w => w.word).join(' ').trim(),
      speech,
      engine: 'whisper.cpp',
      model: name
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

module.exports = { available, status, ensureModel, removeModel, hasModel, pickModel, transcribe, MODELS, MODEL_DIR }
