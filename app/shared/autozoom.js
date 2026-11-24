// Auto-zoom engine — turns a recorded cursor/click log into cinematic zoom segments,
// and evaluates the resulting camera transform at any point in time.
//
// Both the live editor preview and the offline exporter call into here, so what you
// scrub is exactly what renders.

/** The four generation styles, mirroring the reference product's presets. */
export const STYLES = {
  subtle:   { scale: 1.35, lead: 0.60, hold: 2.20, clusterGap: 3.5, ramp: 0.75, minGap: 1.6 },
  moderate: { scale: 1.60, lead: 0.45, hold: 1.60, clusterGap: 2.5, ramp: 0.60, minGap: 1.0 },
  adaptive: { scale: 1.75, lead: 0.40, hold: 1.40, clusterGap: 2.0, ramp: 0.55, minGap: 0.8 },
  intense:  { scale: 2.10, lead: 0.30, hold: 1.00, clusterGap: 1.2, ramp: 0.40, minGap: 0.5 }
}

const MIN_DURATION = 1.0   // a zoom shorter than this reads as a glitch, not a move
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/** Cubic ease-in-out — the standard "expensive camera" feel. */
export function easeInOut (t) {
  t = clamp(t, 0, 1)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/**
 * Builds a smoothed, monotonically-timed cursor path from the raw event log.
 * Raw cursor data is jittery and arrives at an uneven rate; an exponential filter
 * plus resampling gives the camera something stable to follow.
 */
export function buildCursorPath (events, { smoothing = 0.55, sampleRate = 60 } = {}) {
  const raw = events
    .filter(e => e.x != null && e.y != null && e.type !== 'meta')
    .map(e => ({ t: e.t, x: e.x, y: e.y }))
    .sort((a, b) => a.t - b.t)
  if (!raw.length) return []

  const dt = 1 / sampleRate
  const end = raw[raw.length - 1].t
  // Heavier `smoothing` means a slower follow; map it onto a per-sample lerp factor.
  const alpha = clamp(1 - smoothing, 0.02, 1)
  const path = []
  let i = 0
  let cx = raw[0].x
  let cy = raw[0].y
  for (let t = raw[0].t; t <= end + dt; t += dt) {
    while (i < raw.length - 1 && raw[i + 1].t <= t) i++
    // linear interpolation between the two bracketing samples
    let tx = raw[i].x
    let ty = raw[i].y
    if (i < raw.length - 1) {
      const a = raw[i]
      const b = raw[i + 1]
      const span = b.t - a.t
      const f = span > 0 ? clamp((t - a.t) / span, 0, 1) : 0
      tx = a.x + (b.x - a.x) * f
      ty = a.y + (b.y - a.y) * f
    }
    cx += (tx - cx) * alpha
    cy += (ty - cy) * alpha
    path.push({ t, x: cx, y: cy })
  }
  return path
}

export function cursorAt (path, t) {
  if (!path.length) return null
  if (t <= path[0].t) return path[0]
  if (t >= path[path.length - 1].t) return path[path.length - 1]
  // uniform sample rate, so index directly rather than searching
  const dt = path.length > 1 ? path[1].t - path[0].t : 1 / 60
  const idx = clamp(Math.round((t - path[0].t) / dt), 0, path.length - 1)
  return path[idx]
}

/**
 * Groups clicks into "moments of attention". Two clicks belong to the same zoom when
 * they are close in time and the cursor did not travel far between them — that is what
 * separates "still working here" from "moved somewhere else".
 */
function clusterClicks (events, cfg, frame) {
  const clicks = events.filter(e => e.type === 'down').sort((a, b) => a.t - b.t)
  if (!clicks.length) return []
  const travelLimit = Math.hypot(frame.width, frame.height) * 0.22
  const clusters = []
  let cur = [clicks[0]]
  for (let i = 1; i < clicks.length; i++) {
    const prev = cur[cur.length - 1]
    const c = clicks[i]
    const near = Math.hypot(c.x - prev.x, c.y - prev.y) < travelLimit
    if (c.t - prev.t <= cfg.clusterGap && near) cur.push(c)
    else { clusters.push(cur); cur = [c] }
  }
  clusters.push(cur)
  return clusters
}

/**
 * Generates zoom segments from a clip's event log.
 * Returns [] when the clip carries no click data (e.g. a camera-only clip), which is
 * the same condition under which the reference product disables auto-zoom.
 */
export function generateZooms (events, { style = 'adaptive', duration = 0, frame } = {}) {
  const cfg = STYLES[style] || STYLES.adaptive
  if (!frame || !frame.width || !frame.height) return []
  const clusters = clusterClicks(events, cfg, frame)
  if (!clusters.length) return []

  const segs = []
  for (const cluster of clusters) {
    const first = cluster[0]
    const last = cluster[cluster.length - 1]
    const start = Math.max(0, first.t - cfg.lead)
    const end = Math.min(duration || last.t + cfg.hold, last.t + cfg.hold)
    if (end - start < MIN_DURATION) continue
    // Centre on the cluster's mean click position.
    const cx = cluster.reduce((s, c) => s + c.x, 0) / cluster.length
    const cy = cluster.reduce((s, c) => s + c.y, 0) / cluster.length
    segs.push({
      id: `z_${Math.round(start * 1000)}`,
      start,
      end,
      mode: 'auto',              // follow the cursor while zoomed
      target: { x: cx, y: cy },
      scale: cfg.scale,
      ramp: cfg.ramp
    })
  }

  // Merge or drop segments that overlap, so cards never sit on top of each other.
  segs.sort((a, b) => a.start - b.start)
  const merged = []
  for (const s of segs) {
    const prev = merged[merged.length - 1]
    if (prev && s.start < prev.end + cfg.minGap) {
      prev.end = Math.max(prev.end, s.end)
      prev.target = { x: (prev.target.x + s.target.x) / 2, y: (prev.target.y + s.target.y) / 2 }
    } else {
      merged.push({ ...s })
    }
  }
  return merged.filter(s => s.end - s.start >= MIN_DURATION)
}

/**
 * The camera transform at time `t`: how far in, and on what point.
 * Centres are clamped so the zoomed viewport never shows past the edge of the frame.
 */
export function zoomTransformAt (t, segments, cursorPath, frame) {
  const idle = { scale: 1, x: frame.width / 2, y: frame.height / 2 }
  if (!segments || !segments.length) return idle

  const seg = segments.find(s => t >= s.start - s.ramp && t <= s.end + s.ramp)
  if (!seg) return idle

  // Ease in over `ramp` before the segment, hold, then ease back out after it.
  let progress
  if (t < seg.start) progress = easeInOut((t - (seg.start - seg.ramp)) / seg.ramp)
  else if (t > seg.end) progress = 1 - easeInOut((t - seg.end) / seg.ramp)
  else progress = 1
  progress = clamp(progress, 0, 1)

  const scale = 1 + (seg.scale - 1) * progress
  let tx = seg.target.x
  let ty = seg.target.y
  if (seg.mode === 'auto' && cursorPath && cursorPath.length) {
    const c = cursorAt(cursorPath, clamp(t, seg.start, seg.end))
    if (c) { tx = c.x; ty = c.y }
  }

  // Blend from frame centre towards the target as the zoom ramps in.
  const cx = idle.x + (tx - idle.x) * progress
  const cy = idle.y + (ty - idle.y) * progress

  // Keep the visible rectangle inside the frame.
  const halfW = frame.width / (2 * scale)
  const halfH = frame.height / (2 * scale)
  return {
    scale,
    x: clamp(cx, halfW, frame.width - halfW),
    y: clamp(cy, halfH, frame.height - halfH)
  }
}
