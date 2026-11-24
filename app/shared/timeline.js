// The edit model, shared by the preview, the timeline and the exporter.
//
// A clip is never altered on disk. Editing is a description laid over it:
//   trim    { in, out }                the part of the take that is in play at all
//   cuts    [{ start, end }]           stretches removed from inside that
//   splits  [t]                        places the take is divided, so each side can
//                                      be selected, deleted or given its own volume
//   gains   [{ start, end, gain }]     volume for a stretch of the take
// All of it is in the clip's own seconds, so an edit stays attached to the footage
// it was made on however much is cut out before it.

const EPS = 0.001
const round = v => Math.round(v * 1000) / 1000

/** Sorted, non-overlapping copy of a list of ranges. */
export function mergeRanges (ranges) {
  const all = (ranges || [])
    .filter(r => r && r.end - r.start > EPS)
    .map(r => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start)
  const out = []
  for (const r of all) {
    const prev = out[out.length - 1]
    if (prev && r.start <= prev.end + 0.01) prev.end = Math.max(prev.end, r.end)
    else out.push(r)
  }
  return out.map(r => ({ start: round(r.start), end: round(r.end) }))
}

/** `ranges` with [a, b] taken out of them. */
function subtractRange (ranges, a, b) {
  const out = []
  for (const r of ranges || []) {
    if (r.end <= a || r.start >= b) { out.push({ ...r }); continue }
    if (r.start < a - EPS) out.push({ ...r, end: round(a) })
    if (r.end > b + EPS) out.push({ ...r, start: round(b) })
  }
  return out
}

/** The stretches of a clip that survive its trim and cuts, divided at its splits. */
export function clipPieces (clip) {
  const inT = clip.trim?.in ?? 0
  const outT = clip.trim?.out ?? clip.duration
  const pieces = []
  let cursor = inT
  for (const cut of mergeRanges(clip.cuts)) {
    const s = Math.max(inT, cut.start)
    const e = Math.min(outT, cut.end)
    if (e <= cursor) continue
    if (s > cursor + EPS) pieces.push([cursor, Math.min(s, outT)])
    cursor = Math.max(cursor, e)
  }
  if (cursor < outT - EPS) pieces.push([cursor, outT])

  const splits = [...(clip.splits || [])].sort((a, b) => a - b)
  const out = []
  for (const [s, e] of pieces) {
    let from = s
    for (const t of splits) {
      if (t > from + 0.02 && t < e - 0.02) { out.push({ in: from, out: t }); from = t }
    }
    out.push({ in: from, out: e })
  }
  return out
}

/**
 * Flattens clips into the output timeline: one segment per surviving piece, so
 * removing footage genuinely shortens the video rather than hiding part of it.
 */
export function buildTimeline (clips) {
  let at = 0
  const segs = []
  ;(clips || []).forEach((clip, clipIndex) => {
    for (const piece of clipPieces(clip)) {
      const duration = piece.out - piece.in
      if (duration <= EPS) continue
      segs.push({
        key: `${clip.id}@${piece.in.toFixed(3)}`,
        clip,
        clipIndex,
        start: at,
        end: at + duration,
        localIn: piece.in,
        localOut: piece.out,
        duration,
        gain: gainAt(clip, (piece.in + piece.out) / 2)
      })
      at += duration
    }
  })
  return { segs, duration: at }
}

/** The segment under output time t (the last one when t is at or past the end). */
export function segmentAt (timeline, t) {
  const segs = timeline.segs
  if (!segs.length) return null
  for (const s of segs) if (t >= s.start && t < s.end) return s
  return t < segs[0].start ? segs[0] : segs[segs.length - 1]
}

/** Output time of a moment in a clip, or null when that moment has been cut out. */
export function toOutputTime (timeline, clipId, local) {
  for (const s of timeline.segs) {
    if (s.clip.id === clipId && local >= s.localIn - EPS && local <= s.localOut + EPS) {
      return s.start + (local - s.localIn)
    }
  }
  return null
}

/* ------------------------------------------------------------------ edits */

/** Removes [a, b] from the clip. */
export function cutRange (clip, a, b) {
  if (b - a <= EPS) return clip
  return { ...clip, cuts: mergeRanges([...(clip.cuts || []), { start: a, end: b }]) }
}

/** Puts [a, b] back: un-cuts it, and widens the trim if it lies outside it. */
export function restoreRange (clip, a, b) {
  const inT = clip.trim?.in ?? 0
  const outT = clip.trim?.out ?? clip.duration
  const lo = Math.max(0, a)
  const hi = Math.min(clip.duration, b)
  return {
    ...clip,
    trim: { in: Math.min(inT, lo), out: Math.max(outT, hi) },
    cuts: mergeRanges(subtractRange(mergeRanges(clip.cuts), lo, hi))
  }
}

/** Divides the clip at local time t. */
export function splitAt (clip, t) {
  const pieces = clipPieces(clip)
  const inside = pieces.some(p => t > p.in + 0.05 && t < p.out - 0.05)
  if (!inside) return clip
  return { ...clip, splits: [...new Set([...(clip.splits || []), round(t)])].sort((a, b) => a - b) }
}

/** What has been removed from a clip, as ranges — trimmed ends included. */
export function removedRanges (clip) {
  const inT = clip.trim?.in ?? 0
  const outT = clip.trim?.out ?? clip.duration
  const out = []
  if (inT > EPS) out.push({ start: 0, end: inT })
  for (const c of mergeRanges(clip.cuts)) {
    const s = Math.max(inT, c.start)
    const e = Math.min(outT, c.end)
    if (e - s > EPS) out.push({ start: s, end: e })
  }
  if (clip.duration - outT > EPS) out.push({ start: outT, end: clip.duration })
  return out
}

/* ----------------------------------------------------------------- volume */

export function gainAt (clip, local) {
  for (const g of clip.gains || []) if (local >= g.start && local < g.end) return g.gain
  return 1
}

/** Sets the volume of [a, b]. A gain of 1 simply clears whatever was set there. */
export function setGain (clip, a, b, gain) {
  const rest = subtractRange(clip.gains || [], a, b).filter(g => g.end - g.start > EPS)
  if (Math.abs(gain - 1) > 0.005) rest.push({ start: round(a), end: round(b), gain: Math.round(gain * 100) / 100 })
  rest.sort((x, y) => x.start - y.start)
  return { ...clip, gains: rest }
}

/* -------------------------------------------------------------- dead space */

/**
 * Quiet stretches of a clip, read from its waveform.
 *
 * `thresholdDb` is relative to the clip's loudest moment, not an absolute level:
 * laptop microphones record quietly, and an absolute threshold would call a whole
 * softly spoken take silent.
 *
 * @param wave  { rate, peaks } — peaks are 0..1 against the clip's own maximum
 * @returns [{ start, end }] with `pad` seconds of breathing room left on each side
 */
export function findQuiet (wave, { thresholdDb = -30, minSeconds = 0.7, pad = 0.15 } = {}) {
  if (!wave?.peaks?.length) return []
  const limit = Math.pow(10, thresholdDb / 20)
  const { rate, peaks } = wave
  const out = []
  let from = -1
  const close = to => {
    if (from < 0) return
    const start = from / rate + (from === 0 ? 0 : pad)
    const end = to / rate - (to >= peaks.length ? 0 : pad)
    if (to - from >= minSeconds * rate && end - start >= 0.2) out.push({ start: round(start), end: round(end) })
    from = -1
  }
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i] < limit) { if (from < 0) from = i } else close(i)
  }
  close(peaks.length)
  return out
}

/* ------------------------------------------------------------------ camera */

/**
 * Seconds on the clip's timeline at which its camera file begins: the offset the
 * recording measured, plus the per-clip nudge, plus the global camera delay.
 */
export function cameraOffset (clip, prefs) {
  return (clip.cameraStartOffset || 0) + (clip.cameraNudge || 0) + ((prefs?.cameraDelayMs || 0) / 1000)
}
