'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const { tool, probe } = require('./tools')

function run (bin, args, { onProgress, stderr = false } = {}) {
  return new Promise((resolve, reject) => {
    // No stdin: ffmpeg reads keyboard commands from it, and a pipe nobody writes to
    // is one more thing it can sit waiting on.
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => {
      const s = String(d)
      err += s
      if (onProgress) {
        const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(s)
        if (m) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]))
      }
    })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve(stderr ? err : out)
      : reject(new Error(`${path.basename(bin)} exited ${code}\n${err.slice(-2000)}`)))
  })
}

/**
 * Works out which audio stream index inside a clip's screen.mov holds what.
 * The recorder writes system audio first, then the microphone, so the mapping
 * follows directly from which of the two were enabled.
 */
function audioIndices (manifest) {
  const idx = { system: null, mic: null }

  // Newer recordings state their track order explicitly. Trust that over any
  // assumption, so the order can change without silently mis-mapping the mix.
  const order = manifest?.audioOrder
  if (Array.isArray(order) && order.length) {
    order.forEach((kind, i) => {
      if (kind === 'microphone') idx.mic = i
      else if (kind === 'system') idx.system = i
    })
    return idx
  }

  // Older recordings were written system-first.
  const hasSys = !!manifest?.audio?.system
  const hasMic = !!manifest?.audio?.microphone
  let n = 0
  if (hasSys) idx.system = n++
  if (hasMic) idx.mic = n++
  return idx
}

function readManifest (clipDir) {
  try { return JSON.parse(fs.readFileSync(path.join(clipDir, 'manifest.json'), 'utf8')) } catch { return null }
}

/* --------------------------------------------------------------- loudness */

/**
 * Built-in laptop microphones record quietly — a normal speaking voice lands
 * around -40 LUFS, which is technically present but too soft to hear over
 * anything. So the spoken track is measured and lifted to a broadcast target
 * before it goes into the file, the same way Loom and Tella do it.
 *
 * Two passes: measure with loudnorm's analysis mode, then apply the measured
 * values so the correction is linear (a single gain) rather than a compressor
 * riding the level. Linear keeps the recording sounding like the room.
 */
const LOUDNESS = {
  target: -16,      // LUFS — the usual target for spoken-word web video
  truePeak: -1.5,   // dBTP — headroom so lossy codecs don't clip
  range: 11,        // LU
  maxGain: 30,      // dB — past this we'd only be amplifying the noise floor
  floor: -70        // LUFS — below this the track is silence, leave it alone
}

/** Runs loudnorm in analysis mode over a filter graph and returns its report. */
async function measureLoudness (inputArgs, filters, label) {
  const probeFilters = filters.concat(
    `${label}loudnorm=I=${LOUDNESS.target}:TP=${LOUDNESS.truePeak}:LRA=${LOUDNESS.range}:print_format=json[ln]`)
  let report
  try {
    report = await run(tool('ffmpeg'), [
      ...inputArgs,
      '-filter_complex', probeFilters.join(';'),
      '-map', '[ln]', '-f', 'null', '-'
    ], { stderr: true })
  } catch {
    return null // analysis is best-effort; a failure just means no normalisation
  }
  const m = report.match(/\{[^{}]*"input_i"[\s\S]*?\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    const num = v => (v === undefined || v === null || !isFinite(Number(v)) ? null : Number(v))
    const stats = {
      i: num(j.input_i),
      tp: num(j.input_tp),
      lra: num(j.input_lra),
      thresh: num(j.input_thresh),
      offset: num(j.target_offset)
    }
    if (stats.i === null || stats.thresh === null) return null
    return stats
  } catch { return null }
}

/** Turns a loudnorm measurement into the filter that applies it. */
function loudnormFilter (stats, label, outLabel) {
  // Never try to lift silence, and never pull more than maxGain out of a track —
  // beyond that the noise floor arrives before the voice does.
  if (stats.i <= LOUDNESS.floor) return null
  const target = Math.min(LOUDNESS.target, stats.i + LOUDNESS.maxGain)
  // Normalise in both directions: a take recorded too hot gets brought down and
  // its peaks limited, which is how a clipped recording stops sounding harsh.
  if (Math.abs(target - stats.i) < 0.5) return null // already on target
  const opts = [
    `I=${target}`,
    `TP=${LOUDNESS.truePeak}`,
    `LRA=${LOUDNESS.range}`,
    `measured_I=${stats.i}`,
    stats.tp !== null ? `measured_TP=${stats.tp}` : null,
    stats.lra !== null ? `measured_LRA=${stats.lra}` : null,
    `measured_thresh=${stats.thresh}`,
    stats.offset !== null ? `offset=${stats.offset}` : null,
    'linear=true',
    'print_format=summary'
  ].filter(Boolean).join(':')
  // loudnorm resamples to 192 kHz internally, so put the rate back afterwards.
  return `${label}loudnorm=${opts},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo${outLabel}`
}

/**
 * Measures one clip's own audio and works out how much gain the editor should
 * apply on playback, so what you hear while editing matches what the export
 * will sound like. Cached beside the clip — the measurement never changes.
 */
async function clipLoudness (clipDir) {
  const cache = path.join(clipDir, 'loudness.json')
  try { return JSON.parse(fs.readFileSync(cache, 'utf8')) } catch {}

  const src = path.join(clipDir, 'screen.mov')
  if (!fs.existsSync(src)) return null

  // A <video> element only plays the first audio track, and the recorder puts
  // the microphone there, so that is the track to measure.
  const stats = await measureLoudness(['-y', '-i', src], ['[0:a:0]anull[spoken]'], '[spoken]')
  if (!stats) return null

  let gainDb = 0
  if (stats.i > LOUDNESS.floor) {
    // Take the smaller of "reach the loudness target" and "stay under the peak
    // ceiling" — playback has no limiter, so peaks decide the ceiling.
    const toTarget = LOUDNESS.target - stats.i
    const toCeiling = stats.tp === null ? toTarget : (-1 - stats.tp)
    gainDb = Math.max(0, Math.min(LOUDNESS.maxGain, toTarget, toCeiling))
  }
  const result = { measured: stats.i, peak: stats.tp, gainDb, gain: Math.pow(10, gainDb / 20) }
  try { fs.writeFileSync(cache, JSON.stringify(result)) } catch {}
  return result
}

/* -------------------------------------------------------------------- mux */

/**
 * Builds the project's audio track from the same segment list the renderer drew,
 * then muxes it onto the rendered (silent) video.
 *
 * segments: [{ clipDir, start, end, gain? }] in output order — trims and cuts already applied.
 */
async function muxWithAudio ({
  videoFile, segments, output,
  micGain = 1, systemGain = 0.6,
  music = null, musicGain = 0.15,
  normalise = true,
  onProgress
}) {
  if (!fs.existsSync(videoFile)) throw new Error(`rendered video not found: ${videoFile}`)
  const usable = (segments || []).filter(s => s && s.clipDir && s.end > s.start)

  // A music file that is missing, moved or has no sound in it must not sink the whole
  // export — the video is still worth having without it.
  let hasMusic = false
  let musicLength = 0
  if (music && fs.existsSync(music)) {
    try {
      const info = await probe(music)
      hasMusic = info.streams.some(st => st.codec_type === 'audio')
      musicLength = Number(info.format?.duration) || 0
    } catch { hasMusic = false }
  }
  const musicSkipped = !!music && !hasMusic

  if (!usable.length && !hasMusic) {
    // Nothing to mix — just container-copy the silent render into place.
    await run(tool('ffmpeg'), ['-y', '-i', videoFile, '-c', 'copy', '-movflags', '+faststart', output])
    return { output, audio: false, musicSkipped }
  }

  // ---- the spoken track: every clip's own audio, trimmed and concatenated.
  // These inputs come first so their indices are the same in both ffmpeg passes.
  const clipArgs = []
  const clipFilters = []
  const labels = []
  let input = 0

  for (const seg of usable) {
    const src = path.join(seg.clipDir, 'screen.mov')
    const manifest = readManifest(seg.clipDir)
    const idx = audioIndices(manifest)
    const dur = (seg.end - seg.start).toFixed(6)

    if (!fs.existsSync(src) || (idx.system === null && idx.mic === null)) {
      // Clip carries no audio: hold the timeline open with matching silence.
      clipArgs.push('-f', 'lavfi', '-t', dur, '-i', 'anullsrc=r=48000:cl=stereo')
      labels.push(`[${input}:a]`)
      input++
      continue
    }

    clipArgs.push('-i', src)
    const parts = []
    if (idx.system !== null) {
      clipFilters.push(`[${input}:a:${idx.system}]atrim=${seg.start}:${seg.end},asetpts=PTS-STARTPTS,volume=${systemGain}[s${input}]`)
      parts.push(`[s${input}]`)
    }
    if (idx.mic !== null) {
      clipFilters.push(`[${input}:a:${idx.mic}]atrim=${seg.start}:${seg.end},asetpts=PTS-STARTPTS,volume=${micGain}[m${input}]`)
      parts.push(`[m${input}]`)
    }
    let label = parts[0]
    if (parts.length === 2) {
      clipFilters.push(`${parts.join('')}amix=inputs=2:normalize=0:dropout_transition=0[a${input}]`)
      label = `[a${input}]`
    }
    // A volume set on this stretch of the timeline, on top of the track levels.
    const gain = Number(seg.gain)
    if (Number.isFinite(gain) && Math.abs(gain - 1) > 0.001) {
      clipFilters.push(`${label}volume=${Math.max(0, gain).toFixed(4)}[g${input}]`)
      label = `[g${input}]`
    }
    labels.push(label)
    input++
  }

  const hasSpoken = labels.length > 0
  if (hasSpoken) {
    clipFilters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[spoken]`)
  }

  // ---- pass 1: measure the spoken track so the lift can be a single flat gain.
  let spokenLabel = '[spoken]'
  let loudness = null
  if (hasSpoken && normalise) {
    const stats = await measureLoudness(['-y', ...clipArgs], clipFilters.slice(), '[spoken]')
    const filter = stats && loudnormFilter(stats, '[spoken]', '[spokenN]')
    if (filter) {
      clipFilters.push(filter)
      spokenLabel = '[spokenN]'
      loudness = { measured: stats.i, target: Math.min(LOUDNESS.target, stats.i + LOUDNESS.maxGain) }
    }
  }

  // ---- pass 2: assemble the real output.
  const args = ['-y', ...clipArgs]
  input = usable.length

  // The rendered video goes in after the clips so its index is easy to reference.
  args.push('-i', videoFile)
  const videoInput = input
  input++

  const filters = clipFilters.slice()
  let outLabel = spokenLabel

  if (hasMusic) {
    // The track is repeated inside the filter graph, not with -stream_loop: the bundled
    // ffmpeg deadlocks when a looped input feeds a mix, and every export with music
    // hung on "adding audio". aloop holds one pass of the track and replays it; atrim
    // stops it at the length of the video.
    const total = usable.reduce((t, s) => t + (s.end - s.start), 0) || 1
    args.push('-i', music)
    const musicInput = input
    input++
    const loopSamples = Math.ceil((musicLength || total) * 48000) + 48000
    filters.push(`[${musicInput}:a]aresample=48000,aloop=loop=-1:size=${loopSamples},atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `volume=${musicGain},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[bed]`)
    if (hasSpoken) {
      filters.push(`${spokenLabel}[bed]amix=inputs=2:duration=first:normalize=0[aout]`)
    } else {
      filters.push('[bed]anull[aout]')
    }
    outLabel = '[aout]'
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', `${videoInput}:v:0`, '-map', outLabel,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2',
    '-shortest', '-movflags', '+faststart',
    output
  )

  await run(tool('ffmpeg'), args, { onProgress })
  return { output, audio: true, loudness, musicSkipped }
}

/** Re-encodes to constant frame rate — useful for platforms that dislike VFR. */
async function normaliseCFR ({ input, output, fps = 60, onProgress }) {
  await run(tool('ffmpeg'), [
    '-y', '-i', input,
    '-fps_mode', 'cfr', '-r', String(fps),
    '-c:v', 'h264_videotoolbox', '-b:v', '20M',
    '-c:a', 'copy', '-movflags', '+faststart', output
  ], { onProgress })
  return output
}

module.exports = { probe, muxWithAudio, normaliseCFR, clipLoudness, tool, run, audioIndices }
