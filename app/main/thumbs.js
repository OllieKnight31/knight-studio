'use strict'
/**
 * Poster + hover-preview frames for a clip's screen recording.
 *
 * Everything here is best-effort: a clip that will not yield a frame simply has no
 * thumbnail, and the library shows a placeholder. Nothing in this file throws.
 *
 * Files written into a clip directory:
 *   poster.jpg      one representative frame, used as the card image
 *   preview-1.jpg   hover-scrub frames, in time order
 *   preview-2.jpg
 *   preview-3.jpg
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const MAX_WIDTH = 480      // card width; retina 2880x1800 lands at 480x300
const JPEG_Q = 4           // ffmpeg -q:v, 2 (best) .. 31 — 4 keeps frames ~8-30KB
const PREVIEW_COUNT = 3
const PREVIEW_TIMES = [10, 30, 60] // seconds, when the clip is long enough to hold them
const TMP_DIR = '.thumbs-tmp'
const FFMPEG_TIMEOUT_MS = 30000

const { tool, probe } = require('./tools')

function run (bin, args, { timeout = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ ok: false, out: '', err: String(err) })
      return
    }
    let out = ''
    let err = ''
    let done = false
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} finish({ ok: false, out, err: 'timed out' }) }, timeout)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += String(d).slice(0, 4000) })
    child.on('error', e => finish({ ok: false, out, err: String(e) }))
    child.on('close', code => finish({ ok: code === 0, out, err, code }))
  })
}

function statSafe (file) { try { return fs.statSync(file) } catch { return null } }

function readManifest (clipDir) {
  try { return JSON.parse(fs.readFileSync(path.join(clipDir, 'manifest.json'), 'utf8')) } catch { return null }
}

/** Duration from the manifest — no subprocess, so it is safe on the sync path. */
function manifestDuration (clipDir) {
  const d = Number(readManifest(clipDir)?.duration)
  return Number.isFinite(d) && d > 0 ? d : 0
}

async function probeDuration (file) {
  try {
    const d = Number((await probe(file)).format?.duration) || 0
    return Number.isFinite(d) && d > 0 ? d : 0
  } catch { return 0 }
}

function screenFile (clipDir) { return path.join(clipDir, 'screen.mov') }
function posterFile (clipDir) { return path.join(clipDir, 'poster.jpg') }
function previewFile (clipDir, i) { return path.join(clipDir, `preview-${i + 1}.jpg`) }

/**
 * Where the hover previews are sampled.
 *
 * The fixed 10s/30s/60s ladder only makes sense when the clip is actually long enough
 * to hold all three — otherwise two of them would collapse onto the same tail frame.
 * Anything shorter falls back to a proportional spread (25% / 50% / 75%), so a 12s clip
 * yields 3s / 6s / 9s and a 5s clip yields 1.25s / 2.5s / 3.75s.
 */
function previewTimes (duration) {
  if (!(duration > 0)) return []
  const tail = Math.max(0, duration - 0.2) // never sit on the very last frame
  if (PREVIEW_TIMES[PREVIEW_TIMES.length - 1] < tail) return PREVIEW_TIMES.slice()
  return Array.from({ length: PREVIEW_COUNT }, (_, i) =>
    round(Math.min(tail, duration * (i + 1) / (PREVIEW_COUNT + 1))))
}

/**
 * Extra timestamps probed purely to choose the poster.
 *
 * The first is deliberately just past the start (a few frames in, never frame 0, which
 * on a screen capture is often torn or half-composited) — the opening view is usually
 * the most descriptive thing in the recording. The rest spread across the clip so a
 * dark or empty opening can always lose to something better later on.
 */
function posterProbeTimes (duration) {
  if (!(duration > 0)) return []
  const tail = Math.max(0, duration - 0.2)
  return [Math.min(0.35, duration * 0.1), duration * 0.05, duration * 0.3, duration * 0.6]
    .map(t => round(Math.min(tail, Math.max(0, t))))
}

function round (t) { return Math.round(t * 100) / 100 }

function uniqueTimes (times) {
  const seen = new Set()
  const out = []
  for (const t of [...times].sort((a, b) => a - b)) {
    const key = t.toFixed(2)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/**
 * Grabs one frame, scaled and encoded for a card, and measures it on the way past.
 *
 * signalstats + entropy run on the already-downscaled frame, so the measurement costs
 * nothing on top of the extraction we needed anyway. `-frames:v 1` stops the encoder
 * after one frame but the filter graph may have run ahead, so only the first printed
 * frame block is parsed.
 */
async function grabFrame (src, t, dest) {
  const vf = [
    `scale='min(${MAX_WIDTH},iw)':-2:flags=bicubic`,
    'signalstats',
    'entropy=mode=normal',
    'metadata=print:file=-'
  ].join(',')

  const r = await run(tool('ffmpeg'), [
    '-v', 'error', '-nostdin',
    '-ss', t.toFixed(3), '-i', src,
    '-an', '-sn', '-dn',
    '-frames:v', '1',
    '-vf', vf,
    '-q:v', String(JPEG_Q),
    '-f', 'image2', '-y', dest
  ])

  const st = statSafe(dest)
  if (!r.ok || !st || st.size < 512) return null
  return { t, path: dest, bytes: st.size, ...parseMetrics(r.out) }
}

function parseMetrics (stdout) {
  const m = { yavg: 0, entY: 0, entU: 0, entV: 0 }
  let block = 0
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('frame:')) { block++; if (block > 1) break; continue }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = Number(line.slice(eq + 1))
    if (!Number.isFinite(val)) continue
    if (key === 'lavfi.signalstats.YAVG') m.yavg = val
    else if (key === 'lavfi.entropy.entropy.normal.Y') m.entY = val
    else if (key === 'lavfi.entropy.entropy.normal.U') m.entU = val
    else if (key === 'lavfi.entropy.entropy.normal.V') m.entV = val
  }
  return m
}

/**
 * How much a frame is worth as a poster.
 *
 * The core measure is luma entropy (bits, 0..8): a black frame, a blank desktop or a
 * half-drawn window all hold very little information, while a real screen full of text
 * and chrome holds a lot. Chroma entropy is added at a quarter weight so a colourful
 * frame edges out a grey one of similar detail. Mean luma is used only as a guard —
 * entropy alone can be fooled by sensor-style noise in a nearly black frame, and a
 * blown-out white flash — so the extremes are penalised rather than ranked. Dark UI
 * themes are common and legitimate, hence the penalty floor sits well below them
 * (a dark Notion window measures ~41 YAVG; the penalty only starts under 24).
 */
function scoreFrame (f) {
  const info = f.entY + 0.25 * (f.entU + f.entV)
  let score = info
  if (f.yavg < 24) score -= ((24 - f.yavg) / 24) * 6      // near-black / empty
  if (f.yavg > 240) score -= ((f.yavg - 240) / 15) * 4    // blown white
  return score
}

const EARLY_TIE = 0.15 // bits — within this, prefer the earlier frame

function pickPoster (frames) {
  let best = null
  for (const f of frames) { // frames arrive in ascending time, so ties keep the earliest
    f.score = scoreFrame(f)
    if (!best || f.score > best.score + EARLY_TIE) best = f
  }
  return best
}

/** Copy into place via a temp name so a reader never sees a half-written jpeg. */
function place (from, to) {
  const tmp = `${to}.tmp`
  fs.copyFileSync(from, tmp)
  fs.renameSync(tmp, to)
}

/**
 * Are the cached files present and newer than the recording they came from?
 * Returns null when anything is missing or stale.
 */
function freshCache (clipDir) {
  const src = statSafe(screenFile(clipDir))
  if (!src) return null
  const poster = statSafe(posterFile(clipDir))
  if (!poster || poster.mtimeMs < src.mtimeMs) return null
  const previews = []
  for (let i = 0; i < PREVIEW_COUNT; i++) {
    const p = previewFile(clipDir, i)
    const st = statSafe(p)
    if (!st || st.mtimeMs < src.mtimeMs) return null
    previews.push(p)
  }
  return { poster: posterFile(clipDir), previews }
}

/**
 * Cached thumbnails without generating anything — sync and subprocess-free, for the
 * library's first paint. Returns `{ poster: null, previews: [] }` when nothing is cached.
 *
 * The preview timestamps are recomputed from the clip's duration rather than stored, so
 * no sidecar file is needed. A caller that already holds the clip record (a recovered
 * clip has no manifest on disk) can pass `duration` to fill them in.
 */
function readThumbs (clipDir, { duration = 0 } = {}) {
  try {
    const hit = freshCache(clipDir)
    if (!hit) return { poster: null, previews: [] }
    const times = previewTimes(duration > 0 ? duration : manifestDuration(clipDir))
    return {
      poster: hit.poster,
      previews: hit.previews.map((p, i) => ({ t: times[i] ?? null, path: p }))
    }
  } catch { return { poster: null, previews: [] } }
}

/**
 * Generates (or reuses) a clip's poster and hover previews.
 *
 * One ffmpeg seek per sampled timestamp: the preview timestamps are sampled anyway, so
 * the poster is chosen from those plus a handful of extra probes, and the winner is
 * copied into place rather than re-extracted.
 */
async function ensureThumbs (clipDir, { force = false } = {}) {
  const empty = { poster: null, previews: [] }
  let tmpDir = null
  try {
    if (!clipDir) return empty
    const src = screenFile(clipDir)
    if (!statSafe(src)) return empty

    if (!force) {
      const hit = readThumbs(clipDir)
      if (hit.poster) return hit
    }

    let duration = manifestDuration(clipDir)
    if (!duration) duration = await probeDuration(src)
    if (!duration) return empty

    const pTimes = previewTimes(duration)
    const times = uniqueTimes([...pTimes, ...posterProbeTimes(duration)])
    if (!times.length) return empty

    tmpDir = path.join(clipDir, TMP_DIR)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.mkdirSync(tmpDir, { recursive: true })

    const frames = []
    for (let i = 0; i < times.length; i++) {
      const f = await grabFrame(src, times[i], path.join(tmpDir, `f${i}.jpg`))
      if (f) frames.push(f)
    }
    if (!frames.length) return empty

    // Previews: the exact frame if it was grabbed, else the nearest one that was.
    const previews = []
    for (let i = 0; i < pTimes.length; i++) {
      const want = pTimes[i]
      const f = frames.find(x => x.t === want) ||
        frames.reduce((a, b) => Math.abs(b.t - want) < Math.abs(a.t - want) ? b : a)
      const dest = previewFile(clipDir, previews.length)
      place(f.path, dest)
      previews.push({ t: want, path: dest })
    }

    const best = pickPoster(frames)
    const poster = posterFile(clipDir)
    place(best.path, poster)

    return { poster, previews }
  } catch {
    return empty
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {} }
  }
}

/**
 * Runs ensureThumbs over every clip in a project, one at a time so a library scan never
 * saturates the machine with ffmpeg processes. Keyed by clip id (the clip directory name).
 */
async function ensureThumbsForProject (projectDir, opts = {}) {
  const out = {}
  try {
    const clipsDir = path.join(projectDir, 'clips')
    let entries = []
    try { entries = fs.readdirSync(clipsDir, { withFileTypes: true }) } catch { return out }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const clipDir = path.join(clipsDir, e.name)
      if (!statSafe(screenFile(clipDir))) continue
      out[e.name] = await ensureThumbs(clipDir, opts)
    }
  } catch { /* a broken project must not break the library */ }
  return out
}

module.exports = { ensureThumbs, readThumbs, ensureThumbsForProject }
