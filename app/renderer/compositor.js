// Canvas2D compositor. One function draws one frame, and both the live preview and
// the exporter call it — so what you scrub is exactly what renders.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/* ------------------------------------------------------------------ layouts */

/**
 * Returns the destination rectangles for the screen and camera layers.
 * Rect units are canvas pixels. `null` means that layer is not drawn.
 */
export function layoutRects (layout, canvas, style, camera, hasCamera) {
  const W = canvas.width
  const H = canvas.height
  const pad = Math.round(Math.min(W, H) * (style.padding ?? 0.06))
  const inner = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 }

  const bubbleSize = Math.round(H * (camera.size ?? 0.22))
  const ox = Math.round(W * (camera.offset?.x ?? 0.04))
  const oy = Math.round(H * (camera.offset?.y ?? 0.04))
  const corner = {
    'bottom-right': { x: W - bubbleSize - ox, y: H - bubbleSize - oy },
    'bottom-left':  { x: ox,                  y: H - bubbleSize - oy },
    'top-right':    { x: W - bubbleSize - ox, y: oy },
    'top-left':     { x: ox,                  y: oy }
  }[camera.position || 'bottom-right']

  switch (layout) {
    case 'camera':
      return { screen: null, camera: { ...inner }, cameraShape: 'fill' }

    case 'screen':
      return { screen: { ...inner }, camera: null }

    case 'split': {
      // Landscape splits horizontally, portrait/square vertically — matching how the
      // reference product reflows side-by-side for each orientation.
      const gap = Math.round(pad * 0.6)
      if (W >= H) {
        const half = Math.round((inner.w - gap) / 2)
        const camLeft = camera.position?.includes('left')
        return {
          screen: { x: camLeft ? inner.x + half + gap : inner.x, y: inner.y, w: half, h: inner.h },
          camera: { x: camLeft ? inner.x : inner.x + half + gap, y: inner.y, w: half, h: inner.h },
          cameraShape: 'fill'
        }
      }
      const half = Math.round((inner.h - gap) / 2)
      return {
        screen: { x: inner.x, y: inner.y + half + gap, w: inner.w, h: half },
        camera: { x: inner.x, y: inner.y, w: inner.w, h: half },
        cameraShape: 'fill'
      }
    }

    case 'screen-dominant': {
      const camW = Math.round(inner.w * 0.26)
      const camH = Math.round(camW * 9 / 16)
      let box = { x: inner.x + inner.w - camW, y: inner.y + inner.h - camH, w: camW, h: camH }
      if (camera.pos && typeof camera.pos.x === 'number') {
        box = { x: Math.round(camera.pos.x * W - camW / 2), y: Math.round(camera.pos.y * H - camH / 2), w: camW, h: camH }
      }
      box.x = Math.max(0, Math.min(W - box.w, box.x))
      box.y = Math.max(0, Math.min(H - box.h, box.y))
      return { screen: { ...inner }, camera: box, cameraShape: 'rounded' }
    }

    case 'bubble':
    default: {
      // A free position (set by dragging the bubble on the canvas) wins over the
      // corner preset. It is stored as the bubble's CENTRE in canvas fractions so it
      // keeps its place when the canvas size or aspect ratio changes.
      let box = { x: corner.x, y: corner.y, w: bubbleSize, h: bubbleSize }
      if (camera.pos && typeof camera.pos.x === 'number') {
        box = {
          x: Math.round(camera.pos.x * W - bubbleSize / 2),
          y: Math.round(camera.pos.y * H - bubbleSize / 2),
          w: bubbleSize,
          h: bubbleSize
        }
      }
      // Keep it on screen whichever way it was placed.
      box.x = Math.max(0, Math.min(W - box.w, box.x))
      box.y = Math.max(0, Math.min(H - box.h, box.y))
      return { screen: { ...inner }, camera: hasCamera ? box : null, cameraShape: camera.shape || 'circle' }
    }
  }
}

/* --------------------------------------------------------------- background */

export function drawBackground (ctx, canvas, bg, images) {
  const W = canvas.width
  const H = canvas.height
  ctx.save()
  if (bg.type === 'image' && images?.background) {
    // cover-fit the image
    const img = images.background
    const s = Math.max(W / img.width, H / img.height)
    const w = img.width * s
    const h = img.height * s
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h)
    if (bg.blur) { ctx.filter = `blur(${bg.blur}px)`; ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h); ctx.filter = 'none' }
  } else if (bg.type === 'color') {
    ctx.fillStyle = bg.colors?.[0] || '#0B0B0F'
    ctx.fillRect(0, 0, W, H)
  } else {
    const a = ((bg.angle ?? 135) * Math.PI) / 180
    // Project the gradient axis across the canvas diagonal so the angle reads true.
    const len = Math.abs(W * Math.cos(a)) + Math.abs(H * Math.sin(a))
    const cx = W / 2
    const cy = H / 2
    const dx = (Math.cos(a) * len) / 2
    const dy = (Math.sin(a) * len) / 2
    const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy)
    const cols = bg.colors?.length ? bg.colors : ['#0B0B0F', '#1C1F2B']
    cols.forEach((c, i) => g.addColorStop(cols.length === 1 ? i : i / (cols.length - 1), c))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
  }
  ctx.restore()
}

/* ------------------------------------------------------------- layer drawing */

function roundRectPath (ctx, r, radius) {
  const rad = Math.min(radius, r.w / 2, r.h / 2)
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, rad)
}

/**
 * Draws one video layer into `rect`, honouring the zoom transform, corner radius,
 * shadow, border and fill/fit behaviour.
 *
 * `zoom` is in SOURCE pixel space: { scale, x, y } — the point of the source frame
 * that should sit at the centre of the destination rect.
 */
export function drawLayer (ctx, source, rect, opts = {}) {
  if (!source || !rect || rect.w <= 0 || rect.h <= 0) return
  // <video> elements, decoded VideoFrames and canvases/images all draw the same way.
  const sw = source.videoWidth || source.displayWidth || source.width
  const sh = source.videoHeight || source.displayHeight || source.height
  if (!sw || !sh) return

  const radius = opts.radius ?? 0
  const zoom = opts.zoom || { scale: 1, x: sw / 2, y: sh / 2 }
  const fit = opts.fit || 'fill'

  // Source rectangle after zoom.
  let vw = sw / zoom.scale
  let vh = sh / zoom.scale

  // Match the destination aspect so the image is never stretched.
  const destAR = rect.w / rect.h
  const viewAR = vw / vh
  if (fit === 'fill') {
    if (viewAR > destAR) vw = vh * destAR
    else vh = vw / destAR
  } else {
    if (viewAR > destAR) vh = vw / destAR
    else vw = vh * destAR
  }

  let sx = zoom.x - vw / 2
  let sy = zoom.y - vh / 2
  sx = clamp(sx, 0, Math.max(0, sw - vw))
  sy = clamp(sy, 0, Math.max(0, sh - vh))

  ctx.save()
  if (opts.shadow) {
    ctx.save()
    ctx.shadowColor = `rgba(0,0,0,${clamp(opts.shadow, 0, 1)})`
    ctx.shadowBlur = Math.round(Math.max(rect.w, rect.h) * 0.045)
    ctx.shadowOffsetY = Math.round(Math.max(rect.w, rect.h) * 0.018)
    ctx.fillStyle = '#000'
    roundRectPath(ctx, rect, radius)
    ctx.fill()
    ctx.restore()
  }

  if (opts.shape === 'circle') {
    ctx.beginPath()
    ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, Math.min(rect.w, rect.h) / 2, 0, Math.PI * 2)
    ctx.clip()
  } else {
    roundRectPath(ctx, rect, radius)
    ctx.clip()
  }

  if (opts.mirrored) {
    ctx.translate(rect.x + rect.w, rect.y)
    ctx.scale(-1, 1)
    ctx.drawImage(source, sx, sy, vw, vh, 0, 0, rect.w, rect.h)
  } else {
    ctx.drawImage(source, sx, sy, vw, vh, rect.x, rect.y, rect.w, rect.h)
  }
  ctx.restore()

  if (opts.borderWidth > 0) {
    ctx.save()
    ctx.strokeStyle = opts.borderColor || '#fff'
    ctx.lineWidth = opts.borderWidth
    if (opts.shape === 'circle') {
      ctx.beginPath()
      ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, Math.min(rect.w, rect.h) / 2 - opts.borderWidth / 2, 0, Math.PI * 2)
      ctx.stroke()
    } else {
      roundRectPath(ctx, rect, radius)
      ctx.stroke()
    }
    ctx.restore()
  }
  return { sx, sy, vw, vh }
}

/* -------------------------------------------------------------------- cursor */

/** macOS-style arrow, drawn at unit scale then transformed. */
const ARROW = [[0, 0], [0, 16.5], [4.1, 12.8], [6.7, 18.6], [9.4, 17.4], [6.8, 11.7], [12.2, 11.3]]

export function drawCursor (ctx, x, y, opts = {}) {
  const size = (opts.size ?? 1) * (opts.canvasScale ?? 1)
  const press = clamp(opts.press ?? 0, 0, 1)
  const spring = 1 - press * 0.22 * (opts.clickSpring ?? 0)
  const tilt = (opts.tilt ?? 0) * clamp((opts.vx ?? 0) / 900, -1, 1) * 0.5

  // click ripple
  if (opts.ripple > 0 && (opts.clickRipple ?? 0) > 0) {
    const r = opts.ripple
    ctx.save()
    ctx.globalAlpha = (1 - r) * 0.5
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2.5 * size
    ctx.beginPath()
    ctx.arc(x, y, 6 * size + r * 46 * size * (opts.clickRipple ?? 1), 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  ctx.save()
  ctx.globalAlpha = clamp(opts.opacity ?? 1, 0, 1)
  ctx.translate(x, y)
  ctx.rotate(tilt)
  ctx.scale(size * spring * 1.6, size * spring * 1.6)
  ctx.beginPath()
  ARROW.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)))
  ctx.closePath()
  ctx.fillStyle = opts.style === 'windows' ? '#ffffff' : '#000000'
  ctx.strokeStyle = opts.style === 'windows' ? '#000000' : '#ffffff'
  ctx.lineWidth = 1.4
  ctx.lineJoin = 'round'
  ctx.shadowColor = 'rgba(0,0,0,.35)'
  ctx.shadowBlur = 3
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.stroke()
  ctx.restore()
}

/* ------------------------------------------------------------------ overlays */

export const FONTS = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", sans-serif',
  helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  avenir: '"Avenir Next", Avenir, sans-serif',
  futura: 'Futura, "Trebuchet MS", sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  impact: 'Impact, "Arial Black", sans-serif',
  mono: '"SF Mono", Menlo, monospace'
}
const fontStack = key => FONTS[key] || FONTS.system

/** Breaks text into lines no wider than `maxWidth`, honouring typed line breaks. */
function wrapLines (ctx, text, maxWidth) {
  const out = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (line && ctx.measureText(next).width > maxWidth) { out.push(line); line = word } else line = next
    }
    out.push(line)
  }
  return out.length ? out : ['']
}

/** The overlay under a canvas point at time t, topmost first, or null. */
export function overlayAt (overlays, canvas, t, px, py) {
  for (let i = (overlays || []).length - 1; i >= 0; i--) {
    const o = overlays[i]
    if (t < o.start || t > o.end) continue
    const x = o.x * canvas.width
    const y = o.y * canvas.height
    if (px >= x && px <= x + o.w * canvas.width && py >= y && py <= y + o.h * canvas.height) return o
  }
  return null
}

/** Editing aid only (never exported): outlines the selected overlay's box. */
export function drawOverlaySelection (ctx, canvas, o, colour = '#C8A24A') {
  if (!o) return
  const u = canvas.height / 1080
  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = 2 * u
  ctx.setLineDash([8 * u, 6 * u])
  ctx.strokeRect(o.x * canvas.width, o.y * canvas.height, o.w * canvas.width, o.h * canvas.height)
  ctx.restore()
}

/**
 * Draws timed overlays on top of the composited frame.
 *
 * Geometry is stored as fractions of the canvas, so an overlay keeps its place when
 * the canvas size or aspect ratio changes.
 */
export function drawOverlays (ctx, canvas, overlays, t, images = {}, editing = null) {
  if (!overlays?.length) return
  const W = canvas.width
  const H = canvas.height

  for (const o of overlays) {
    if (t < o.start || t > o.end) continue
    // fade in and out so nothing pops on screen
    const fade = o.id === editing ? 1 : Math.min(1, Math.min(t - o.start, o.end - t) / (o.fade ?? 0.3))
    const alpha = clamp(fade, 0, 1) * (o.opacity ?? 1)
    if (alpha <= 0) continue

    const x = (o.x ?? 0.1) * W
    const y = (o.y ?? 0.1) * H
    const w = (o.w ?? 0.3) * W
    const h = (o.h ?? 0.15) * H

    ctx.save()
    ctx.globalAlpha = alpha

    if (o.type === 'blur') {
      // Redraw the region over itself through a blur filter — the cheapest way to
      // obscure part of an already-composited frame.
      ctx.filter = `blur(${Math.max(2, (o.amount ?? 14) * (H / 1080))}px)`
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, (o.radius ?? 8) * (H / 1080))
      ctx.clip()
      ctx.drawImage(ctx.canvas, x, y, w, h, x, y, w, h)
      ctx.filter = 'none'
    } else if (o.type === 'image' && images[o.id]) {
      const img = images[o.id]
      const scale = Math.min(w / img.width, h / img.height)
      const dw = img.width * scale
      const dh = img.height * scale
      ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
    } else if (o.type === 'text') {
      const size = (o.size ?? 52) * (H / 1080)
      ctx.font = `${o.weight ?? 700} ${size}px ${fontStack(o.font)}`
      ctx.textBaseline = 'middle'
      ctx.textAlign = o.align || 'left'
      const label = o.uppercase ? String(o.text || '').toUpperCase() : String(o.text || '')
      const lines = wrapLines(ctx, label, w)
      const lineH = size * 1.18
      const blockH = lines.length * lineH
      const tx = o.align === 'center' ? x + w / 2 : o.align === 'right' ? x + w : x
      const top = y + h / 2 - blockH / 2

      if (o.background && o.background !== 'none') {
        const widest = Math.max(1, ...lines.map(l => ctx.measureText(l).width))
        const padX = size * 0.5
        const padY = size * 0.3
        const bw = widest + padX * 2
        const bx = o.align === 'center' ? tx - bw / 2 : o.align === 'right' ? tx - bw + padX : tx - padX
        ctx.fillStyle = o.background
        ctx.beginPath()
        ctx.roundRect(bx, top - padY, bw, blockH + padY * 2, size * 0.26)
        ctx.fill()
      }
      if (o.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,.6)'
        ctx.shadowBlur = size * 0.22
        ctx.shadowOffsetY = size * 0.05
      }
      ctx.fillStyle = o.color || '#FFFFFF'
      lines.forEach((line, i) => ctx.fillText(line, tx, top + lineH * (i + 0.5)))
    }
    ctx.restore()
  }
}

/* ----------------------------------------------------------------- subtitles */

export function drawSubtitle (ctx, canvas, text, sub, activeWord) {
  if (!text || !sub?.enabled) return
  const W = canvas.width
  const H = canvas.height
  const size = sub.size * (H / 1080)
  ctx.save()
  ctx.font = `${sub.weight || 800} ${size}px ${fontStack(sub.font)}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const label = sub.uppercase ? text.toUpperCase() : text
  const y = H * (sub.position ?? 0.86)
  const m = ctx.measureText(label)
  const padX = size * 0.5
  const padY = size * 0.32

  if (sub.background && sub.background !== 'none') {
    ctx.fillStyle = sub.background
    ctx.beginPath()
    ctx.roundRect(W / 2 - m.width / 2 - padX, y - size / 2 - padY, m.width + padX * 2, size + padY * 2, size * 0.28)
    ctx.fill()
  }
  ctx.fillStyle = activeWord ? sub.highlight || '#C8A24A' : sub.color || '#fff'
  ctx.fillText(label, W / 2, y)
  ctx.restore()
}

export { clamp }
