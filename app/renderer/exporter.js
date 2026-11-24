// Offline export: decode each clip once with WebCodecs, composite every frame on
// a canvas, encode with WebCodecs (hardware H.264 on Apple silicon), mux to MP4,
// then hand the silent file to the main process to have the project's audio
// mixed onto it with ffmpeg.
//
// Frames come from FrameSource, which walks each recording sequentially through a
// hardware decoder. The previous approach — seeking a <video> element to every
// output frame — re-decoded from the last keyframe each time and turned a
// six-minute recording into an hour-long export.

import { Muxer, StreamTarget } from 'mp4-muxer'
import { zoomTransformAt } from '../shared/autozoom.js'
import { layoutRects, drawBackground, drawLayer, drawCursor, drawSubtitle, drawOverlays } from './compositor.js'
import { captionAt } from '../shared/captions.js'
import { FrameSource } from './framesource.js'
import { segmentAt, cameraOffset } from '../shared/timeline.js'

const BITRATES = { web: 10e6, high: 20e6, max: 40e6 }

/** Picks the highest H.264 profile/level this machine will actually accept. */
async function pickCodec (width, height, bitrate, fps) {
  const candidates = ['avc1.640034', 'avc1.640033', 'avc1.64002A', 'avc1.4D4033', 'avc1.42E03C']
  for (const codec of candidates) {
    const config = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      hardwareAcceleration: 'prefer-hardware',
      avc: { format: 'avc' }
    }
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config)
      if (supported) return config
    } catch { /* try the next one */ }
  }
  throw new Error('No supported H.264 encoder configuration on this machine')
}

function clock (seconds) {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export async function exportProject ({
  project, media, timeline, canvasSize, output, fps = 60, quality = 'high', prefs, onProgress
}) {
  if (!timeline.duration) throw new Error('Nothing to export — this project has no clips.')

  const width = canvasSize.width
  const height = canvasSize.height
  const bitrate = BITRATES[quality] ?? BITRATES.high
  const config = await pickCodec(width, height, bitrate, fps)

  // One decoder pair per clip, opened the first time the timeline reaches it.
  const sources = new Map()
  const sourceFor = async clip => {
    let s = sources.get(clip.id)
    if (s) return s
    const m = media[clip.id]
    if (!m?.screen?.src) throw new Error('Clip media is still loading — try again in a moment.')
    const screen = await new FrameSource(m.screen.src).open()
    let camera = null
    if (m.camera?.src) {
      try {
        camera = await new FrameSource(m.camera.src).open()
      } catch (e) {
        screen.close()
        throw new Error(`Camera recording could not be decoded: ${e.message}`)
      }
    }
    s = { screen, camera }
    sources.set(clip.id, s)
    return s
  }

  // Stage 1 — render + encode a silent MP4 into a temp file.
  const tmp = await window.knight.exportVideo.beginTemp(`${project.id}.video.mp4`)

  const muxer = new Muxer({
    target: new StreamTarget({
      onData: (data, position) => window.knight.exportVideo.writeChunk(tmp.token, data, position),
      chunked: true
    }),
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: false
  })

  let encoderError = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { encoderError = e }
  })
  encoder.configure(config)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })

  const total = Math.max(1, Math.floor(timeline.duration * fps))
  const frameDur = 1e6 / fps
  const started = performance.now()

  try {
    for (let i = 0; i < total; i++) {
      if (encoderError) throw encoderError
      const t = i / fps
      const seg = segmentAt(timeline, t)
      const clip = seg.clip
      const m = media[clip.id]
      const local = seg.localIn + (t - seg.start)

      const src = await sourceFor(clip)
      const screen = await src.screen.frameAt(local)
      const camera = src.camera
        ? await src.camera.frameAt(Math.max(0, local - cameraOffset(clip, prefs)))
        : null

      drawFrameTo(ctx, { project, clip, m: { ...m, screen, camera }, canvasSize, local, t })

      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameDur), duration: Math.round(frameDur) })
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 })
      frame.close()

      // Keep the encoder queue shallow so memory stays flat on long recordings.
      while (encoder.encodeQueueSize > 8) {
        await new Promise(r => setTimeout(r, 4))
      }

      if (i % 10 === 0) {
        const elapsed = (performance.now() - started) / 1000
        const eta = i > fps * 2 ? ((total - i) * elapsed) / i : null
        onProgress?.(eta === null ? 'rendering' : `rendering · ${clock(eta)} left`, (i / total) * 0.9)
      }
    }

    if (encoderError) throw encoderError
    await encoder.flush()
    encoder.close()
    muxer.finalize()
    await window.knight.exportVideo.closeTemp(tmp.token)
  } catch (e) {
    await window.knight.exportVideo.discardTemp(tmp.token).catch(() => {})
    throw e
  } finally {
    for (const s of sources.values()) { s.screen.close(); s.camera?.close() }
    try { if (encoder.state !== 'closed') encoder.close() } catch {}
  }

  // Stage 2 — mix the project's audio onto the render.
  onProgress?.('adding audio', 0.93)
  let mixed = null
  const segments = timeline.segs.map(s => ({ clipDir: s.clip.dir, start: s.localIn, end: s.localOut, gain: s.gain }))
  try {
    mixed = await window.knight.exportVideo.mux({
      videoFile: tmp.path,
      segments,
      output,
      micGain: project.audio?.micGain ?? 1,
      systemGain: project.audio?.systemGain ?? 0.6,
      music: project.audio?.music || null,
      musicGain: project.audio?.musicGain ?? 0.15
    })
  } finally {
    await window.knight.exportVideo.discardTemp(tmp.token).catch(() => {})
  }
  onProgress?.('done', 1)
  return { output, musicSkipped: !!mixed?.musicSkipped }
}

/**
 * Draws one finished frame. The live preview and the exporter both call this, so
 * what you scrub is exactly what renders.
 *
 *   local — seconds into the clip (drives zoom, cursor and captions)
 *   t     — seconds into the finished video (drives text and blur overlays)
 *   m     — the clip's media: screen and camera as anything drawable
 *   editing — preview only: id of the overlay being edited, drawn without its fade
 */
export function drawFrameTo (ctx, { project, clip, m, canvasSize, local, t, editing = null }) {
  const size = { width: canvasSize.width, height: canvasSize.height }
  drawBackground(ctx, size, project.background)

  const frame = { width: clip.width || 1920, height: clip.height || 1080 }
  const rects = layoutRects(clip.layout || 'bubble', size, project.style, project.camera, !!m.camera)
  const radius = Math.round((project.style.radius ?? 18) * (size.height / 1080))

  let drawn = null
  if (rects.screen && m.screen) {
    const zoom = zoomTransformAt(local, clip.zooms || [], m.cursorPath, frame)
    drawn = drawLayer(ctx, m.screen, rects.screen, {
      radius,
      shadow: project.style.shadow,
      zoom: { scale: zoom.scale, x: zoom.x, y: zoom.y },
      fit: project.style.screenFit,
      borderWidth: project.style.borderWidth,
      borderColor: project.style.borderColor
    })

    if (project.cursor?.animated && m.cursorPath?.length && drawn) {
      const c = m.cursorPath.find(p => p.t >= local) || m.cursorPath[m.cursorPath.length - 1]
      if (c) {
        const cx = rects.screen.x + ((c.x - drawn.sx) / drawn.vw) * rects.screen.w
        const cy = rects.screen.y + ((c.y - drawn.sy) / drawn.vh) * rects.screen.h
        const inside = cx >= rects.screen.x && cx <= rects.screen.x + rects.screen.w &&
                       cy >= rects.screen.y && cy <= rects.screen.y + rects.screen.h
        if (inside) {
          const click = m.events.find(e => e.type === 'down' && Math.abs(e.t - local) < 0.45)
          const age = click ? Math.abs(local - click.t) : 1
          drawCursor(ctx, cx, cy, {
            size: (project.cursor.size ?? 1) * (size.height / 1080) * 1.4,
            style: project.cursor.style,
            clickSpring: project.cursor.clickSpring,
            clickRipple: project.cursor.clickRipple,
            tilt: project.cursor.tilt,
            press: click ? Math.max(0, 1 - age / 0.18) : 0,
            ripple: click ? Math.min(1, age / 0.45) : 0
          })
        }
      }
    }
  }

  if (rects.camera && m.camera) {
    const cam = project.camera
    const camRadius = rects.cameraShape === 'circle' ? 9999
      : rects.cameraShape === 'square' ? 0
        : Math.round((cam.radius ?? project.style.radius ?? 18) * (size.height / 1080))
    drawLayer(ctx, m.camera, rects.camera, {
      radius: camRadius,
      shape: rects.cameraShape === 'circle' ? 'circle' : 'rect',
      shadow: cam.shadow ?? project.style.shadow,
      fit: 'fill',
      zoom: cameraCrop(m.camera, cam.zoom),
      mirrored: cam.mirrored,
      borderWidth: (cam.borderWidth || 0) * (size.height / 1080),
      borderColor: cam.borderColor
    })
  }

  drawOverlays(ctx, size, project.overlays, t ?? local, {}, editing)

  if (project.subtitles?.enabled && m.captions?.length) {
    const cap = captionAt(m.captions, local)
    if (cap) drawSubtitle(ctx, size, cap.text, project.subtitles)
  }
}

/** Zooming the camera in crops toward the middle of its picture. */
function cameraCrop (source, zoom) {
  const scale = Math.max(1, zoom || 1)
  if (scale === 1) return undefined
  const w = source.videoWidth || source.displayWidth || source.width
  const h = source.videoHeight || source.displayHeight || source.height
  return { scale, x: w / 2, y: h / 2 }
}
