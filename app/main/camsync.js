'use strict'
/**
 * Finds where an older take's camera really sits against its audio.
 *
 * Takes made before the capture engine stamped camera frames on the shared clock
 * have a camera file that starts about a second later than recorded, by an amount
 * that varied from take to take. Nothing on disk says how much — but the footage
 * does: a face moves when it speaks. So this measures movement in the camera
 * picture frame by frame, measures loudness in the microphone track at the same
 * rate, and slides one against the other to find the lag where they line up best.
 *
 * It only ever runs on takes flagged `cameraSync: 'estimated'`. Current recordings
 * are aligned by timestamp and never come through here.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { tool, audioIndices, probe } = require('./export')

const FPS = 30
const W = 96
const H = 54
const WINDOW = 240          // seconds analysed; plenty to lock on, bounded on long takes
const AUDIO_RATE = 8000
// Lips start moving a little before the sound arrives, so the best-fit lag reads
// slightly long. This takes that lead back out.
const LIP_LEAD = 0.06

function collect (bin, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
    child.stdout.on('data', d => chunks.push(d))
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0 && !chunks.length) return reject(new Error(`${path.basename(bin)} exited ${code}`))
      resolve(Buffer.concat(chunks))
    })
  })
}

/** Removes slow drift (a moving average) and scales to unit variance. */
function normalise (x) {
  const n = x.length
  const k = 45
  const half = k >> 1
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i]
  const out = new Float64Array(n)
  let mean = 0
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half)
    const b = Math.min(n, i + half + 1)
    out[i] = x[i] - (prefix[b] - prefix[a]) / (b - a)
    mean += out[i]
  }
  mean /= n || 1
  let sd = 0
  for (let i = 0; i < n; i++) { out[i] -= mean; sd += out[i] * out[i] }
  sd = Math.sqrt(sd / (n || 1)) || 1
  for (let i = 0; i < n; i++) out[i] /= sd
  return out
}

/**
 * @returns {Promise<{offset:number, confidence:number, floor:number}|null>}
 *   offset — seconds on the screen timeline at which the camera file begins
 *   confidence — how far the best lag stands above the rest, in standard deviations
 */
async function measureCameraOffset (clipDir) {
  const screen = path.join(clipDir, 'screen.mov')
  const camera = path.join(clipDir, 'camera.mov')
  if (!fs.existsSync(screen) || !fs.existsSync(camera)) return null

  let manifest = null
  try { manifest = JSON.parse(fs.readFileSync(path.join(clipDir, 'manifest.json'), 'utf8')) } catch {}
  const idx = audioIndices(manifest)
  const track = idx.mic ?? idx.system
  if (track === null || track === undefined) return null

  // The two files stopped together, so the camera cannot start earlier than the
  // difference in their lengths. That bounds the search.
  let floor = 0
  try {
    const s = await probe(screen)
    const c = await probe(camera)
    const audio = (s.streams || []).filter(st => st.codec_type === 'audio').map(st => Number(st.duration) || 0)
    const screenLen = audio.length ? Math.max(...audio) : Number(s.format?.duration) || 0
    floor = Math.max(0, screenLen - (Number(c.format?.duration) || 0))
  } catch {}

  const ff = tool('ffmpeg')
  const [video, pcm] = await Promise.all([
    collect(ff, ['-v', 'error', '-t', String(WINDOW), '-i', camera,
      '-vf', `fps=${FPS},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-']),
    collect(ff, ['-v', 'error', '-t', String(WINDOW + 6), '-i', screen, '-map', `0:a:${track}`,
      '-ac', '1', '-ar', String(AUDIO_RATE), '-f', 's16le', '-'])
  ])

  const frameSize = W * H
  const frames = Math.floor(video.length / frameSize)
  const samples = Math.floor(pcm.length / 2)
  const hop = AUDIO_RATE / FPS
  const steps = Math.min(frames, Math.floor(samples / hop) - 1)
  if (steps < FPS * 4) return null

  // Movement: mean absolute change in the middle of the picture, where the face is.
  const x0 = Math.floor(W * 0.2); const x1 = Math.floor(W * 0.8)
  const y0 = Math.floor(H * 0.2); const y1 = H
  const motion = new Float64Array(frames)
  for (let f = 1; f < frames; f++) {
    let sum = 0
    const a = (f - 1) * frameSize
    const b = f * frameSize
    for (let y = y0; y < y1; y++) {
      const row = y * W
      for (let x = x0; x < x1; x++) sum += Math.abs(video[b + row + x] - video[a + row + x])
    }
    motion[f] = sum
  }

  // Loudness: log RMS of the microphone over each frame's span.
  const env = new Float64Array(steps)
  for (let i = 0; i < steps; i++) {
    const from = Math.floor(i * hop)
    const to = Math.min(samples, Math.floor((i + 1) * hop))
    let sum = 0
    for (let j = from; j < to; j++) { const v = pcm.readInt16LE(j * 2) / 32768; sum += v * v }
    env[i] = Math.log(Math.sqrt(sum / Math.max(1, to - from)) + 1e-5)
  }

  const m = normalise(motion.subarray(0, steps))
  const e = normalise(env)

  // corr(lag): camera-file frame i against timeline frame i + lag.
  const maxLag = FPS * 4
  const corr = new Float64Array(maxLag + 1)
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0
    const n = steps - lag
    for (let i = 0; i < n; i++) sum += m[i] * e[i + lag]
    corr[lag] = sum / n
  }

  const lo = Math.max(0, Math.floor((floor - 0.05) * FPS))
  const hi = Math.min(maxLag, Math.ceil((floor + 2.0) * FPS))
  let best = lo
  for (let lag = lo; lag <= hi; lag++) if (corr[lag] > corr[best]) best = lag

  let mean = 0; let count = 0
  for (let lag = 0; lag <= maxLag; lag++) if (Math.abs(lag - best) > FPS * 0.6) { mean += corr[lag]; count++ }
  mean /= count || 1
  let sd = 0
  for (let lag = 0; lag <= maxLag; lag++) if (Math.abs(lag - best) > FPS * 0.6) sd += (corr[lag] - mean) ** 2
  sd = Math.sqrt(sd / (count || 1)) || 1e-9
  const confidence = (corr[best] - mean) / sd

  // Refine between frames with a parabola through the peak and its neighbours.
  let fine = best
  if (best > 0 && best < maxLag) {
    const a = corr[best - 1]; const b = corr[best]; const c = corr[best + 1]
    const denom = a - 2 * b + c
    if (denom < 0) fine = best + 0.5 * (a - c) / denom
  }

  return {
    offset: Math.max(floor, fine / FPS - LIP_LEAD),
    confidence,
    floor
  }
}

module.exports = { measureCameraOffset }
