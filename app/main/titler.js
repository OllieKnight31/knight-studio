'use strict'
/**
 * Automatic video titles for Knight Studio clips.
 *
 * Two ways in, one way out. If the clip has a transcript with real speech we
 * hand Claude the words; if it doesn't — a silent screen recording, which is
 * the common case here — we pull one representative frame out of screen.mov
 * with ffmpeg and let Claude read the screen instead. Either way the model
 * returns a short human title that gets scrubbed hard on this side before
 * anyone sees it.
 *
 * The whole module is best-effort by design: a title is a nicety, so every
 * path ends in a usable string and nothing in here is allowed to throw.
 *
 * Dependency-free on purpose — global fetch and node:child_process only, so it
 * drops into the Electron main process with no install step.
 */
const { execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

// Opus 5 is the house model. Titling is a small job, so it runs at low effort
// with adaptive thinking left on (Opus 5's default) — cheaper and faster than
// the default effort, without the tool/tag leakage that disabling thinking
// invites on this model.
const MODEL = 'claude-opus-5'
const EFFORT = 'low'
const MAX_TOKENS = 2000

const REQUEST_TIMEOUT_MS = 60000
const FFMPEG_TIMEOUT_MS = 30000
const TRANSCRIPT_CHARS = 4000
const MAX_TITLE_WORDS = 8
const MIN_TITLE_WORDS = 3
const MAX_TITLE_CHARS = 80

// Whisper likes to invent politeness over silence. Anything this short, or on
// this list, is treated as "no speech" rather than as content worth titling.
const MIN_SPEECH_CHARS = 25
const WHISPER_NOISE = new Set([
  'you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching',
  'bye', 'bye.', 'okay', 'ok', 'so', 'yeah', 'mm', 'hmm', 'uh', 'um',
  'subtitles by the amara.org community', 'transcription by castingwords',
  'please subscribe', 'music', 'applause', 'silence'
])

// Titles that describe nothing. If the model lands on one of these we ask once
// more, then give up and use the local fallback.
const GENERIC_TITLES = new Set([
  'screen recording', 'screen capture', 'screencast', 'recording', 'new recording',
  'untitled', 'untitled recording', 'untitled video', 'video', 'my video', 'new video',
  'demo', 'demo video', 'walkthrough', 'tutorial', 'clip', 'new clip', 'test',
  'test recording', 'desktop recording', 'computer screen', 'a screen recording',
  'screen recording video', 'no title', 'title'
])

// The noise people make before they start a sentence. Only used to trim the
// offline fallback title back to the words that carry meaning.
const DISCOURSE_OPENERS = new Set([
  'right', 'so', 'ok', 'okay', 'alright', 'um', 'uh', 'erm', 'er', 'well',
  'yeah', 'yep', 'now', 'look', 'hey', 'hi', 'hello', 'guys', 'everyone',
  'basically', 'anyway', 'and', 'but', 'then', 'just', 'like', 'actually'
])

// Openers that pad a title without saying anything.
const FILLER_PREFIXES = [
  /^title\s*[:\-–—]\s*/i,
  /^a\s+video\s+(about|of|showing|on)\s+/i,
  /^an?\s+recording\s+of\s+/i,
  /^this\s+(video|recording|clip)\s+(shows|is|covers|demonstrates)\s+/i,
  /^(video|recording|clip|screencast)\s+(of|about|showing)\s+/i,
  /^screen\s+recording\s+(of|showing|about)\s+/i,
  /^here('| i)s\s+/i
]

const SYSTEM_PROMPT = [
  'You name screen recordings for a video editor. You reply with the title and nothing else.',
  '',
  'Rules for every title:',
  '- Between 3 and 8 words. Title Case. No trailing period. No quotes, no markdown, no emoji.',
  '- Be specific about the actual content: name the app, document, page, product or task.',
  '  Good: "Reviewing Q3 Pipeline In Notion", "Debugging Stripe Webhook In VS Code".',
  '- Never generic. Never "Screen Recording", "Untitled", "Video", "Demo", "Walkthrough" on their own.',
  '- No filler openers: no "A Video About", no "This Recording Shows", no "Here Is".',
  '- Must be safe as a filename: no slashes, no colons, no newlines.',
  '- If you are unsure what the work is, describe what is concretely visible or said anyway.',
  '',
  'Output exactly one line: the title.'
].join('\n')

// --------------------------------------------------------------------------
// api key
// --------------------------------------------------------------------------

/**
 * An optional dotenv-style file holding the keys, for anyone who keeps them in one
 * place rather than pasting them into Settings. Set with KNIGHT_STUDIO_ENV_FILE or
 * the `ai.envFile` setting; there is no default.
 */
function envFilePath () {
  return process.env.KNIGHT_STUDIO_ENV_FILE || require('./prefs').read().ai?.envFile || ''
}

/**
 * Pulls one variable out of a dotenv-style file. Deliberately narrow: no
 * interpolation, no export of anything into process.env, and the value never
 * gets logged.
 */
function readEnvFileVar (name) {
  let raw
  const file = envFilePath()
  if (!file) return null
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] === '#') continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    let key = trimmed.slice(0, eq).trim()
    if (key.startsWith('export ')) key = key.slice(7).trim()
    if (key !== name) continue
    let value = trimmed.slice(eq + 1).trim()
    if (value.length >= 2 &&
        ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    return value || null
  }
  return null
}

/** The API key: Settings first, then the environment, then the env file. Never logged. */
function resolveApiKey (override) {
  if (typeof override === 'string' && override.trim()) return override.trim()
  const saved = require('./secrets').get('anthropicKey')
  if (saved) return saved
  const fromEnv = process.env.ANTHROPIC_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return readEnvFileVar('ANTHROPIC_API_KEY')
}

function resolveGeminiKey () {
  const saved = require('./secrets').get('geminiKey')
  if (saved) return saved
  const fromEnv = process.env.GEMINI_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return readEnvFileVar('GEMINI_API_KEY')
}

const GEMINI_MODEL = 'gemini-2.5-flash'

/**
 * Asks Gemini for a title, converting the Anthropic-shaped content blocks to Gemini
 * parts. This is the fallback provider: Claude is preferred and is tried first, but a
 * key with no credit must not leave every recording called "Untitled".
 */
async function askGemini ({ apiKey, content, signal }) {
  const parts = []
  for (const block of content) {
    if (block.type === 'text') parts.push({ text: block.text })
    else if (block.type === 'image') {
      parts.push({ inline_data: { mime_type: block.source.media_type, data: block.source.data } })
    }
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      signal,
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { maxOutputTokens: 512, temperature: 0.4 }
      })
    }
  )
  if (!res.ok) throw new Error(`gemini http ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || 'gemini error')
  const out = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join(' ')
  return (out || '').trim()
}

/**
 * Tries Claude, then Gemini, then gives up. Returns a cleaned title or null.
 */
async function titleFromAnyProvider ({ content, signal, onProgress }) {
  const claudeKey = resolveApiKey()
  if (claudeKey) {
    try {
      report(onProgress, 'asking claude')
      const t = await titleFromContent({ apiKey: claudeKey, content, signal })
      if (t) return t
    } catch { /* fall through to the next provider */ }
  }
  const geminiKey = resolveGeminiKey()
  if (geminiKey) {
    try {
      report(onProgress, 'asking gemini')
      const raw = await askGemini({ apiKey: geminiKey, content, signal })
      const cleaned = sanitizeTitle(raw)
      if (cleaned) return cleaned
    } catch { /* fall through to the local title */ }
  }
  return null
}

/**
 * Whether a key is available at all, so the UI can skip offering auto-titles.
 * @returns {Promise<boolean>}
 */
async function isConfigured () {
  try {
    // Either provider is enough — Claude is preferred, Gemini is the fallback.
    return Boolean(resolveApiKey() || resolveGeminiKey())
  } catch {
    return false
  }
}

// --------------------------------------------------------------------------
// transcript
// --------------------------------------------------------------------------

/** Loads <clipDir>/transcript.json without caring whether it exists. */
function readTranscriptFile (clipDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(clipDir, 'transcript.json'), 'utf8'))
    return (parsed && typeof parsed === 'object') ? parsed : null
  } catch {
    return null
  }
}

/** Flattens a transcript into one string of spoken text. */
function transcriptText (transcript) {
  if (!transcript || typeof transcript !== 'object') return ''
  if (Array.isArray(transcript.segments) && transcript.segments.length) {
    return transcript.segments
      .map(s => (s && typeof s.text === 'string') ? s.text.trim() : '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  if (typeof transcript.text === 'string') return transcript.text.replace(/\s+/g, ' ').trim()
  return ''
}

/**
 * True when the transcript holds something worth titling, as opposed to the
 * one-word artefacts Whisper produces over a silent track.
 */
function hasSpeech (transcript) {
  const text = transcriptText(transcript)
  if (text.length < MIN_SPEECH_CHARS) return false
  const normalised = text.toLowerCase().replace(/[^a-z0-9\s.]/g, '').replace(/\s+/g, ' ').trim()
  if (WHISPER_NOISE.has(normalised) || WHISPER_NOISE.has(normalised.replace(/\.$/, ''))) return false
  const words = normalised.split(' ').filter(Boolean)
  if (words.length < 6) return false
  // A track of repeated filler ("you you you") isn't speech either.
  if (new Set(words).size < 4) return false
  return true
}

// --------------------------------------------------------------------------
// frame grab
// --------------------------------------------------------------------------

function findFfmpeg () { return require('./tools').find('ffmpeg') }

function run (bin, args, timeout) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

/** The clip's manifest, or null. */
function readManifest (clipDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(clipDir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Timestamps worth sampling: a few seconds in (past the title-card / desktop
 * fade-in) and then spread across the body of the recording.
 */
function sampleTimes (duration) {
  const d = (typeof duration === 'number' && duration > 0) ? duration : null
  if (!d) return [3, 6, 10, 15, 25]
  if (d <= 2) return [Math.max(0, d / 2)]
  const fractions = [0.12, 0.3, 0.5, 0.7, 0.85]
  const lower = Math.min(2.5, d * 0.08)
  const upper = Math.max(0, d - 0.6)
  const out = []
  for (const f of fractions) {
    const t = Math.min(upper, Math.max(lower, d * f))
    const rounded = Math.round(t * 100) / 100
    if (!out.includes(rounded)) out.push(rounded)
  }
  return out
}

/**
 * Grabs one JPEG at `time`, and reports its average luma so near-black frames
 * can be skipped. signalstats rides along in the same pass so this costs one
 * ffmpeg invocation per candidate, not two.
 *
 * @returns {Promise<{buffer: Buffer, luma: number}|null>}
 */
async function grabFrame (ffmpeg, source, time, outFile) {
  const args = [
    '-nostdin', '-y',
    '-ss', String(time),
    '-i', source,
    '-an', '-sn', // video only; decoding the audio tracks here is wasted work
    '-frames:v', '1',
    '-vf', "scale='min(1456,iw)':-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    '-q:v', '4',
    '-f', 'image2',
    outFile
  ]
  // Candidates share one output path, so clear it first — otherwise a failed
  // run would hand back the previous candidate's bytes.
  try { fs.rmSync(outFile, { force: true }) } catch { /* nothing there yet */ }

  const { stderr } = await run(ffmpeg, args, FFMPEG_TIMEOUT_MS)
  let buffer
  try {
    buffer = fs.readFileSync(outFile)
  } catch {
    return null
  }
  if (!buffer.length) return null
  const match = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(stderr)
  const luma = match ? Number(match[1]) : 128 // no reading -> assume it's fine
  return { buffer, luma: Number.isFinite(luma) ? luma : 128 }
}

/**
 * Picks a representative frame from a recording: samples a handful of
 * timestamps, drops the near-black ones, and keeps the busiest survivor —
 * JPEG size at a fixed quality is a decent stand-in for "has stuff on it".
 *
 * @returns {Promise<{data: string, mediaType: string, time: number}|null>}
 */
async function representativeFrame ({ clipDir, duration, onProgress } = {}) {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) return null

  const sources = ['screen.mov', 'camera.mov']
    .map(f => path.join(clipDir, f))
    .filter(f => { try { return fs.existsSync(f) } catch { return false } })
  if (!sources.length) return null
  const source = sources[0]

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-title-'))
  const outFile = path.join(tmpDir, 'frame.jpg')
  let best = null
  try {
    for (const time of sampleTimes(duration)) {
      report(onProgress, `sampling frame at ${time}s`)
      const frame = await grabFrame(ffmpeg, source, time, outFile)
      if (!frame) continue
      // Near-black (a locked screen, a fade, a blank desktop) tells Claude nothing.
      if (frame.luma < 26) {
        if (!best) best = { ...frame, time, score: frame.buffer.length * 0.25 }
        continue
      }
      const score = frame.buffer.length
      if (!best || score > best.score) best = { ...frame, time, score }
      // A big, bright frame is good enough — stop paying for more samples.
      if (frame.luma >= 40 && frame.buffer.length > 90 * 1024) break
    }
  } catch {
    // fall through to whatever we managed to capture
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* tmp cleanup is optional */ }
  }

  if (!best) return null
  return { data: best.buffer.toString('base64'), mediaType: 'image/jpeg', time: best.time }
}

// --------------------------------------------------------------------------
// title cleanup
// --------------------------------------------------------------------------

/** Capitalises a word without flattening acronyms (API, Q3, VS, iOS). */
function capitalise (word) {
  if (!word) return word
  if (/[A-Z]/.test(word.slice(1))) return word // already has internal caps
  if (/^[A-Z0-9]+$/.test(word)) return word // ALLCAPS / Q3
  return word[0].toUpperCase() + word.slice(1)
}

/**
 * Turns whatever the model said into something safe to put on disk, or null
 * when it isn't salvageable.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function sanitizeTitle (raw) {
  if (typeof raw !== 'string') return null

  // First non-empty line only — models occasionally add a stray explanation.
  let title = raw.split(/\r?\n/).map(l => l.trim()).find(Boolean) || ''

  title = title
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // control chars, newlines included
    .replace(/^[*_`#\s]+|[*_`#\s]+$/g, '') // markdown wrappers
    .trim()

  // Surrounding quotes, straight or curly, possibly doubled up.
  for (let i = 0; i < 3; i++) {
    const stripped = title.replace(/^["'“”‘’«»]+\s*|\s*["'“”‘’«»]+$/g, '').trim()
    if (stripped === title) break
    title = stripped
  }

  for (const pattern of FILLER_PREFIXES) title = title.replace(pattern, '').trim()

  // Filename hygiene: these become spaces rather than vanishing, so "Q3/Q4"
  // reads as "Q3 Q4" instead of "Q3Q4".
  title = title.replace(/[\\/:*?"<>|]+/g, ' ')

  title = title
    .replace(/\s+/g, ' ')
    .replace(/[.,;:\-–—\s]+$/g, '') // trailing punctuation, period included
    .trim()

  if (!title) return null

  let words = title.split(' ').filter(Boolean)
  if (words.length > MAX_TITLE_WORDS) words = words.slice(0, MAX_TITLE_WORDS)
  if (words.length < MIN_TITLE_WORDS) return null

  title = words.map(capitalise).join(' ')
  if (title.length > MAX_TITLE_CHARS) {
    // Trim back to a word boundary rather than mid-word.
    title = title.slice(0, MAX_TITLE_CHARS).replace(/\s+\S*$/, '').trim()
    if (title.split(' ').filter(Boolean).length < MIN_TITLE_WORDS) return null
  }

  const key = title.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  if (!key) return null
  if (GENERIC_TITLES.has(key)) return null
  // "Untitled Recording 4", "Screen Recording 2026" and friends.
  if (GENERIC_TITLES.has(key.replace(/\s*\d+$/, '').trim())) return null

  return title
}

/** dd Mon yyyy, no colons, safe in a filename. */
function stamp (date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const hours = date.getHours()
  const mins = String(date.getMinutes()).padStart(2, '0')
  const suffix = hours < 12 ? 'am' : 'pm'
  const h12 = ((hours + 11) % 12) + 1
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()} ${h12}.${mins}${suffix}`
}

/** When the recording happened, best guess. */
function clipDate (clipDir, manifest) {
  const raw = manifest && manifest.createdAt
  if (raw) {
    const d = new Date(raw)
    if (!Number.isNaN(d.getTime())) return d
  }
  try {
    return fs.statSync(path.join(clipDir, 'screen.mov')).mtime
  } catch {
    return new Date()
  }
}

/**
 * Drops the run-up people say before they say anything — "right, so...",
 * "okay um, well..." — so an offline title starts on the actual sentence.
 */
function stripDiscourseOpeners (sentence) {
  let words = sentence.split(/\s+/).filter(Boolean)
  for (let i = 0; i < 6 && words.length > MIN_TITLE_WORDS; i++) {
    const head = words[0].toLowerCase().replace(/[^a-z']/g, '')
    if (!DISCOURSE_OPENERS.has(head)) break
    words = words.slice(1)
  }
  return words.join(' ')
}

/**
 * The local, offline title. First choice is the opening sentence of the
 * transcript; otherwise a date stamp, which is at least unambiguous.
 */
function fallbackTitle ({ clipDir, transcript, manifest } = {}) {
  const text = transcriptText(transcript)
  if (text) {
    const sentence = stripDiscourseOpeners((text.split(/(?<=[.!?])\s+/)[0] || text).trim())
    const candidate = sanitizeTitle(sentence.split(/\s+/).slice(0, MAX_TITLE_WORDS).join(' '))
    if (candidate) return candidate
  }
  return `Screen Recording ${stamp(clipDate(clipDir, manifest))}`
}

// --------------------------------------------------------------------------
// claude
// --------------------------------------------------------------------------

function report (onProgress, stage) {
  if (!onProgress) return
  try { onProgress(stage) } catch { /* a UI callback must never kill the job */ }
}

/**
 * One Messages API call. Raw HTTPS via global fetch so the main process stays
 * dependency-free. Retries once on 429 / 5xx; never throws for the caller's
 * benefit, returns null instead.
 *
 * @returns {Promise<string|null>} the model's raw text
 */
async function askClaude ({ apiKey, content, signal }) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }]
  })

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const onAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); return null }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': API_VERSION,
          'x-api-key': apiKey
        },
        body,
        signal: controller.signal
      })

      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500
        // Body is read but never surfaced verbatim — it can echo request detail.
        try { await res.text() } catch { /* ignore */ }
        if (retryable && attempt === 0) {
          await new Promise(r => setTimeout(r, 1200))
          continue
        }
        return null
      }

      const json = await res.json()
      if (!json || json.stop_reason === 'refusal') return null
      const text = (json.content || [])
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('')
        .trim()
      return text || null
    } catch {
      if (attempt === 0 && !(signal && signal.aborted)) {
        await new Promise(r => setTimeout(r, 800))
        continue
      }
      return null
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
  return null
}

/** Asks, sanitises, and asks once more if the first answer was junk. */
async function titleFromContent ({ apiKey, content, signal }) {
  const first = await askClaude({ apiKey, content, signal })
  const cleaned = sanitizeTitle(first)
  if (cleaned) return cleaned

  const nudge = content.concat([{
    type: 'text',
    text: 'Your previous answer was rejected as too generic, too short, or malformed. ' +
      'Answer again with a single line of 3 to 8 Title Case words that name something ' +
      'concrete from this recording. Do not use the words "screen recording", "video", ' +
      '"untitled" or "demo" on their own.'
  }])
  return sanitizeTitle(await askClaude({ apiKey, content: nudge, signal }))
}

// --------------------------------------------------------------------------
// public entry point
// --------------------------------------------------------------------------

/**
 * Names a clip.
 *
 * Prefers the spoken word when there is any; otherwise reads the screen. If
 * neither Claude nor ffmpeg can help, falls back to something local and
 * sensible. This function does not throw.
 *
 * @param {object}   opts
 * @param {string}   opts.clipDir      clip folder holding screen.mov + manifest.json
 * @param {object}  [opts.transcript]  a transcript already in hand; read from
 *                                     disk when omitted
 * @param {string}  [opts.apiKey]      override the resolved API key (tests)
 * @param {(stage:string)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{title: string, source: 'transcript'|'vision'|'fallback'}>}
 */
async function titleForClip ({ clipDir, transcript, apiKey, onProgress, signal } = {}) {
  let manifest = null
  let resolvedTranscript = transcript || null

  try {
    if (!clipDir || typeof clipDir !== 'string') {
      return { title: `Screen Recording ${stamp(new Date())}`, source: 'fallback' }
    }
    manifest = readManifest(clipDir)
    if (!resolvedTranscript) resolvedTranscript = readTranscriptFile(clipDir)

    if (!resolveApiKey(apiKey) && !resolveGeminiKey()) {
      report(onProgress, 'no api key — using a local title')
      return { title: fallbackTitle({ clipDir, transcript: resolvedTranscript, manifest }), source: 'fallback' }
    }

    // ---- speech, if there is any
    if (hasSpeech(resolvedTranscript)) {
      report(onProgress, 'reading transcript')
      const text = transcriptText(resolvedTranscript).slice(0, TRANSCRIPT_CHARS)
      const content = [{
        type: 'text',
        text: `Transcript of a screen recording${
          resolvedTranscript.duration ? ` (${Math.round(resolvedTranscript.duration)} seconds)` : ''
        }:\n\n${text}\n\nTitle this recording.`
      }]
      const title = await titleFromAnyProvider({ content, signal, onProgress })
      if (title) return { title, source: 'transcript' }
    }

    // ---- otherwise, read the screen
    report(onProgress, 'grabbing a frame')
    const duration = (manifest && manifest.duration) ||
      (resolvedTranscript && resolvedTranscript.duration) || null
    const frame = await representativeFrame({ clipDir, duration, onProgress })
    if (frame) {
      const content = [
        { type: 'image', source: { type: 'base64', media_type: frame.mediaType, data: frame.data } },
        {
          type: 'text',
          text: `This is a single frame from a silent screen recording${
            duration ? ` lasting about ${Math.round(duration)} seconds` : ''
          }. Read what is on screen — the app, the window title, the page, the document, ` +
            'the data — and title the recording after that. Name the specific thing you can see.'
        }
      ]
      const title = await titleFromAnyProvider({ content, signal, onProgress })
      if (title) return { title, source: 'vision' }
    }

    report(onProgress, 'using a local title')
    return { title: fallbackTitle({ clipDir, transcript: resolvedTranscript, manifest }), source: 'fallback' }
  } catch {
    // Anything unexpected still has to produce a name.
    try {
      return { title: fallbackTitle({ clipDir, transcript: resolvedTranscript, manifest }), source: 'fallback' }
    } catch {
      return { title: `Screen Recording ${stamp(new Date())}`, source: 'fallback' }
    }
  }
}

module.exports = {
  titleForClip,
  isConfigured,
  resolveApiKey,
  resolveGeminiKey,
  askGemini,
  // exported for tests and for callers that want the pieces
  sanitizeTitle,
  fallbackTitle,
  hasSpeech,
  transcriptText,
  representativeFrame,
  MODEL
}
