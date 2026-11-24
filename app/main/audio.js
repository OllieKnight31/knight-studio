'use strict'
/**
 * Audio analysis for the timeline: the waveform drawn under each clip, which is also
 * what the "remove dead space" tool reads to find the quiet stretches. It comes from
 * the clip's microphone track (system audio when there is no microphone).
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { tool, audioIndices } = require('./export')

const PEAKS_PER_SECOND = 50
const RATE = 8000

function spokenTrack (clipDir) {
  let manifest = null
  try { manifest = JSON.parse(fs.readFileSync(path.join(clipDir, 'manifest.json'), 'utf8')) } catch {}
  const idx = audioIndices(manifest)
  return idx.mic ?? idx.system ?? null
}

/**
 * Peak level per 20 ms, 0..1, cached beside the clip.
 * @returns {Promise<{rate:number, peaks:number[]}|null>}
 */
async function waveform (clipDir) {
  const cache = path.join(clipDir, 'waveform.json')
  try {
    const hit = JSON.parse(fs.readFileSync(cache, 'utf8'))
    if (hit.rate === PEAKS_PER_SECOND && Array.isArray(hit.peaks)) return hit
  } catch {}

  const src = path.join(clipDir, 'screen.mov')
  const track = spokenTrack(clipDir)
  if (!fs.existsSync(src) || track === null) return null

  const pcm = await new Promise((resolve, reject) => {
    const child = spawn(tool('ffmpeg'), ['-v', 'error', '-i', src, '-map', `0:a:${track}`,
      '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    child.stdout.on('data', d => chunks.push(d))
    child.on('error', reject)
    child.on('close', () => resolve(Buffer.concat(chunks)))
  })

  const hop = RATE / PEAKS_PER_SECOND
  const samples = Math.floor(pcm.length / 2)
  const n = Math.floor(samples / hop)
  const raw = new Float64Array(n)
  let top = 0
  for (let i = 0; i < n; i++) {
    let peak = 0
    const from = i * hop
    for (let j = 0; j < hop; j++) {
      const v = Math.abs(pcm.readInt16LE((from + j) * 2))
      if (v > peak) peak = v
    }
    raw[i] = peak
    if (peak > top) top = peak
  }
  // Scaled to the clip's own loudest moment, so a quiet recording still draws a
  // waveform you can read rather than a flat line.
  const scale = top || 1
  const peaks = Array.from(raw, v => Math.round((v / scale) * 1000) / 1000)
  const result = { rate: PEAKS_PER_SECOND, peaks }
  try { fs.writeFileSync(cache, JSON.stringify(result)) } catch {}
  return result
}

module.exports = { waveform }
