import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../ui.jsx'
import { clipPieces, cutRange, restoreRange, removedRanges, toOutputTime } from '../../shared/timeline.js'

const PAD = 14          // left padding of the track area, in px
const MIN_TEXT = 0.3
const MIN_ZOOM = 1.0    // a zoom shorter than a second reads as a glitch
const MIN_PIECE = 0.15

const fmt = s => {
  const t = Math.max(0, s)
  const m = Math.floor(t / 60)
  const sec = Math.floor(t % 60)
  const cs = Math.floor((t % 1) * 100)
  return `${m}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

const tickLabel = s => {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(Math.round(sec)).padStart(2, '0')}`
}

/** Picks a ruler spacing that keeps labels roughly 80px apart at any zoom. */
function tickStep (pxPerSec) {
  for (const step of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) {
    if (step * pxPerSec >= 72) return step
  }
  return 600
}

/** The waveform for one stretch of a clip, drawn once per size change. */
function Wave ({ wave, from, to, width, gain }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const w = Math.max(1, Math.min(4000, Math.round(width)))
    const h = 60
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, w, h)
    if (!wave?.peaks?.length) return
    const css = getComputedStyle(document.documentElement)
    ctx.fillStyle = css.getPropertyValue('--accent').trim() || '#C8A24A'
    const { rate, peaks } = wave
    const span = (to - from) * rate
    const mid = h * 0.58
    for (let x = 0; x < w; x++) {
      const a = Math.floor(from * rate + (x / w) * span)
      const b = Math.max(a + 1, Math.floor(from * rate + ((x + 1) / w) * span))
      let peak = 0
      for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > peak) peak = peaks[i]
      // A square root lifts quiet speech into view; raw peaks hug the centre line.
      const amp = Math.min(1, Math.sqrt(peak) * Math.min(1.6, Math.max(0.05, gain))) * h * 0.4
      ctx.fillRect(x, mid - amp, 1, Math.max(1, amp * 2))
    }
  }, [wave, from, to, width, gain])
  return <canvas ref={ref} />
}

/**
 * The editing timeline: a ruler, the video track (one block per surviving piece of
 * footage, with its waveform), a text track and a zoom track.
 *
 * Everything on it is direct manipulation — drag a block's edge to trim, drag text
 * and zooms to move them, click the scissors marker between two blocks to put a cut
 * back — and every one of those ends up as a change to the project via `commit`.
 */
export default function Timeline ({
  project, timeline, media, time, playing, setPlaying, seek, commit,
  selectedSeg, setSelectedSeg, selectedZoom, setSelectedZoom, selectedOverlay, setSelectedOverlay,
  setTool, onSplit, onDeleteSeg, onRemoveQuiet, onAddText, undo, redo, canUndo, canRedo,
  previewVolume, setPreviewVolume, previewMuted, setPreviewMuted
}) {
  const scrollRef = useRef(null)
  const dragRef = useRef(null)
  const [pxPerSec, setPxPerSec] = useState(40)
  const [fitted, setFitted] = useState(false)

  const fit = () => {
    const el = scrollRef.current
    if (!el || !timeline.duration) return
    setPxPerSec(Math.max(2, Math.min(240, (el.clientWidth - PAD * 2 - 8) / timeline.duration)))
  }
  // Start with the whole video in view; after that the zoom is the user's.
  useLayoutEffect(() => {
    if (!fitted && timeline.duration) { fit(); setFitted(true) }
  }, [timeline.duration, fitted])

  const width = Math.max(300, timeline.duration * pxPerSec)

  // Keep the playhead in view while it plays.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !playing) return
    const x = PAD + time * pxPerSec
    if (x > el.scrollLeft + el.clientWidth - 60 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80)
  }, [time, playing, pxPerSec])

  const timeAt = clientX => {
    const el = scrollRef.current
    const box = el.getBoundingClientRect()
    return (clientX - box.left + el.scrollLeft - PAD) / pxPerSec
  }

  /* ------------------------------------------------------------- dragging */

  useEffect(() => {
    const onMove = e => {
      const d = dragRef.current
      if (!d) return
      const delta = (e.clientX - d.originX) / d.pxPerSec
      if (Math.abs(e.clientX - d.originX) > 2) d.moved = true

      if (d.kind === 'scrub') { seek(timeAt(e.clientX)); return }

      if (d.kind === 'edge') {
        // Always recomputed from the clip as it was when the drag began, so dragging
        // back and forth cannot pile up edits.
        let next
        const snap = x => Math.round(x * 1000) / 1000
        if (d.side === 'l') {
          const v = snap(Math.max(d.min, Math.min(d.localOut - MIN_PIECE, d.localIn + delta)))
          next = v > d.localIn ? cutRange(d.clip, d.localIn, v) : restoreRange(d.clip, v, d.localIn)
          // A section is identified by where it starts, so keep it selected as that moves.
          setSelectedSeg(`${d.clip.id}@${v.toFixed(3)}`)
        } else {
          const v = snap(Math.min(d.max, Math.max(d.localIn + MIN_PIECE, d.localOut + delta)))
          next = v < d.localOut ? cutRange(d.clip, v, d.localOut) : restoreRange(d.clip, d.localOut, v)
        }
        commit(p => ({ ...p, clips: p.clips.map(c => (c.id === d.clip.id ? next : c)) }), { group: d.group })
        return
      }

      if (d.kind === 'zoom') {
        let { start, end } = d
        const span = end - start
        if (d.mode === 'move') { start = Math.max(0, Math.min(d.limit - span, d.start + delta)); end = start + span }
        else if (d.mode === 'start') start = Math.max(0, Math.min(d.end - MIN_ZOOM, d.start + delta))
        else end = Math.min(d.limit, Math.max(d.start + MIN_ZOOM, d.end + delta))
        commit(p => ({
          ...p,
          clips: p.clips.map(c => (c.id !== d.clipId ? c
            : { ...c, zooms: (c.zooms || []).map(z => (z.id === d.id ? { ...z, start: +start.toFixed(3), end: +end.toFixed(3) } : z)) }))
        }), { group: d.group })
        return
      }

      if (d.kind === 'overlay') {
        let { start, end } = d
        const span = end - start
        const limit = Math.max(d.end, timeline.duration)
        if (d.mode === 'move') { start = Math.max(0, Math.min(limit - span, d.start + delta)); end = start + span }
        else if (d.mode === 'start') start = Math.max(0, Math.min(d.end - MIN_TEXT, d.start + delta))
        else end = Math.min(limit, Math.max(d.start + MIN_TEXT, d.end + delta))
        commit(p => ({
          ...p,
          overlays: (p.overlays || []).map(o => (o.id === d.id ? { ...o, start: +start.toFixed(3), end: +end.toFixed(3) } : o))
        }), { group: d.group })
      }
    }
    const onUp = () => { dragRef.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [commit, seek, setSelectedSeg, timeline.duration, pxPerSec])

  const group = () => `drag_${Date.now()}`

  const startEdge = (ev, seg, side) => {
    ev.stopPropagation()
    const clip = seg.clip
    const pieces = clipPieces(clip)
    const i = pieces.findIndex(p => Math.abs(p.in - seg.localIn) < 0.002)
    const prev = pieces[i - 1]
    const next = pieces[i + 1]
    dragRef.current = {
      kind: 'edge', side, clip, group: group(), originX: ev.clientX, pxPerSec,
      localIn: seg.localIn, localOut: seg.localOut,
      // An edge can be pulled out as far as the neighbouring piece, or the end of the take.
      min: prev ? prev.out : 0,
      max: next ? next.in : clip.duration
    }
    setSelectedSeg(seg.key)
  }

  const blockMode = ev => {
    const box = ev.currentTarget.getBoundingClientRect()
    return ev.clientX - box.left < 8 ? 'start' : box.right - ev.clientX < 8 ? 'end' : 'move'
  }

  /* --------------------------------------------------------------- render */

  const selected = timeline.segs.find(s => s.key === selectedSeg) || null
  const step = tickStep(pxPerSec)
  const ticks = useMemo(() => {
    const out = []
    for (let t = 0; t <= timeline.duration + 0.001; t += step) out.push(t)
    return out
  }, [timeline.duration, step])

  // Places where footage has been removed, shown as a marker between the pieces.
  const cutMarks = useMemo(() => {
    const out = []
    for (const clip of project.clips) {
      for (const r of removedRanges(clip)) {
        // The marker sits where the surviving footage resumes (or ends).
        const after = toOutputTime(timeline, clip.id, r.end)
        const before = toOutputTime(timeline, clip.id, r.start)
        const at = after ?? before
        if (at === null) continue
        out.push({ key: `${clip.id}:${r.start}`, clipId: clip.id, at, ...r })
      }
    }
    return out
  }, [project.clips, timeline])

  const overlays = project.overlays || []
  const zoomBlocks = timeline.segs.flatMap(s => (s.clip.zooms || [])
    .filter(z => z.end > s.localIn && z.start < s.localOut)
    .map(z => ({ seg: s, z })))

  return (
    <section className="timeline">
      <div className="transport">
        <button className="tbtn play" onClick={() => setPlaying(p => !p)}
          data-tip="Play or pause the preview" data-tip-title={playing ? 'Pause' : 'Play'} data-tip-key="Space">
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <span className="mono">{fmt(time)}</span>
        <span className="dim">/</span>
        <span className="mono dim">{fmt(timeline.duration)}</span>

        <span className="sep" />
        <button className="tbtn wide" onClick={onSplit}
          data-tip="Divides the video at the playhead, so each side can be removed or have its own volume."
          data-tip-title="Split" data-tip-key="S">
          <Icon name="split" />Split
        </button>
        <button className="tbtn wide danger" disabled={!selected || timeline.segs.length < 2} onClick={onDeleteSeg}
          data-tip="Removes the selected section and closes the gap. Click the scissors marker left behind to bring it back."
          data-tip-title="Delete section" data-tip-key="⌫">
          <Icon name="trash" />Delete
        </button>
        <button className="tbtn wide" onClick={onRemoveQuiet}
          data-tip="Finds the stretches where nobody is speaking and cuts them out. Fine-tune how aggressive it is under Cut."
          data-tip-title="Remove dead space">
          <Icon name="quiet" />Dead space
        </button>
        <span className="sep" />
        <button className="tbtn wide" onClick={() => onAddText('headline')}
          data-tip="Adds a large title at the playhead. Drag it on the video to place it, and on the timeline to time it."
          data-tip-title="Add headline">
          <Icon name="headline" />Headline
        </button>
        <button className="tbtn wide" onClick={() => onAddText('text')}
          data-tip="Adds a line of text at the playhead."
          data-tip-title="Add text">
          <Icon name="text" />Text
        </button>
        <span className="sep" />
        <button className="tbtn" disabled={!canUndo} onClick={undo} data-tip="Undo the last change" data-tip-title="Undo" data-tip-key="⌘Z"><Icon name="undo" /></button>
        <button className="tbtn" disabled={!canRedo} onClick={redo} data-tip="Redo" data-tip-title="Redo" data-tip-key="⇧⌘Z"><Icon name="redo" /></button>

        <div className="spacer drag" />
        <button className="tbtn" onClick={fit} data-tip="Fit the whole video in the timeline" data-tip-title="Fit"><Icon name="fit" /></button>
        <input className="zoom-slider" type="range" min={Math.log(2)} max={Math.log(240)} step="0.01"
          value={Math.log(pxPerSec)} data-tip="Zoom the timeline in for precise cuts, out for the whole picture" data-tip-title="Timeline zoom"
          onChange={e => setPxPerSec(Math.exp(Number(e.target.value)))} />
        <span className="sep" />
        <button className="tbtn" onClick={() => setPreviewMuted(v => !v)}
          data-tip="Only affects what you hear while editing, not the exported video" data-tip-title={previewMuted ? 'Unmute preview' : 'Mute preview'}>
          <Icon name={previewMuted ? 'mute' : 'volume'} />
        </button>
        <input className="vol" type="range" min="0" max="1.5" step="0.05" value={previewVolume}
          data-tip="Preview loudness only — the export is unaffected" data-tip-title={`Preview volume ${Math.round(previewVolume * 100)}%`}
          onChange={e => { setPreviewVolume(Number(e.target.value)); setPreviewMuted(false) }} />
      </div>

      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-inner" style={{ width: width + PAD * 2 }}
          onPointerDown={e => {
            // Empty track area: move the playhead, and clear the selection.
            if (e.target === e.currentTarget || e.target.classList.contains('tl-track')) {
              seek(timeAt(e.clientX))
              dragRef.current = { kind: 'scrub', originX: e.clientX, pxPerSec }
              setSelectedSeg(null); setSelectedOverlay(null); setSelectedZoom(null)
            }
          }}>
          <div className="tl-ruler" style={{ width }}
            onPointerDown={e => {
              seek(timeAt(e.clientX))
              dragRef.current = { kind: 'scrub', originX: e.clientX, pxPerSec }
            }}>
            {ticks.map(t => <span key={t} className="tl-tick" style={{ left: t * pxPerSec }}>{tickLabel(t)}</span>)}
          </div>

          <div className="tl-track video" style={{ width }}>
            <span className="tl-track-label">Video</span>
            {timeline.segs.map(s => {
              const w = Math.max(6, s.duration * pxPerSec - 2)
              return (
                <div key={s.key}
                  className={`tl-seg ${s.key === selectedSeg ? 'sel' : ''} ${s.gain === 0 ? 'muted' : ''}`}
                  style={{ left: s.start * pxPerSec, width: w }}
                  onPointerDown={ev => {
                    ev.stopPropagation()
                    setSelectedSeg(s.key); setSelectedOverlay(null); setSelectedZoom(null)
                    seek(timeAt(ev.clientX))
                    dragRef.current = { kind: 'scrub', originX: ev.clientX, pxPerSec }
                  }}>
                  <Wave wave={media[s.clip.id]?.wave} from={s.localIn} to={s.localOut} width={w} gain={s.gain} />
                  {w > 70 && <span className="tl-seg-label">{s.duration.toFixed(1)}s</span>}
                  {w > 60 && Math.abs(s.gain - 1) > 0.005 && (
                    <span className="tl-seg-gain">{s.gain === 0 ? 'muted' : `${Math.round(s.gain * 100)}%`}</span>
                  )}
                  <span className="tl-handle l" data-tip="Drag to trim the start of this section"
                    onPointerDown={ev => startEdge(ev, s, 'l')} />
                  <span className="tl-handle r" data-tip="Drag to trim the end of this section"
                    onPointerDown={ev => startEdge(ev, s, 'r')} />
                </div>
              )
            })}
            {cutMarks.map(c => (
              <span key={c.key} className="tl-cutmark" style={{ left: c.at * pxPerSec }}
                data-tip={`${(c.end - c.start).toFixed(1)}s removed here. Click to put it back.`} data-tip-title="Cut"
                onPointerDown={ev => ev.stopPropagation()}
                onClick={ev => {
                  ev.stopPropagation()
                  commit(p => ({ ...p, clips: p.clips.map(cl => (cl.id === c.clipId ? restoreRange(cl, c.start, c.end) : cl)) }))
                }}>
                <Icon name="cut" />
              </span>
            ))}
          </div>

          <div className={`tl-track text ${overlays.length ? '' : 'none'}`} style={{ width }}
            data-empty="No text yet — add a headline or a line of text from the bar above">
            <span className="tl-track-label">Text</span>
            {overlays.map(o => (
              <div key={o.id} className={`tl-block ${o.type === 'blur' ? 'blur' : 'text'} ${o.id === selectedOverlay ? 'sel' : ''}`}
                style={{ left: o.start * pxPerSec, width: Math.max(14, (o.end - o.start) * pxPerSec - 2) }}
                data-tip="Drag to move, drag an edge to change how long it shows"
                onPointerDown={ev => {
                  ev.stopPropagation()
                  dragRef.current = {
                    kind: 'overlay', id: o.id, mode: blockMode(ev), group: group(),
                    originX: ev.clientX, start: o.start, end: o.end, pxPerSec
                  }
                  setSelectedOverlay(o.id); setSelectedSeg(null); setSelectedZoom(null)
                  setTool('text')
                }}>
                {o.type === 'blur' ? 'Blur' : (o.text || 'Text').split('\n')[0]}
              </div>
            ))}
          </div>

          <div className={`tl-track zooms ${zoomBlocks.length ? '' : 'none'}`} style={{ width }}
            data-empty="No zooms — add them under Zoom">
            <span className="tl-track-label">Zooms</span>
            {zoomBlocks.map(({ seg, z }) => (
              <div key={seg.key + z.id} className={`tl-block zoom ${z.id === selectedZoom ? 'sel' : ''}`}
                style={{
                  left: (seg.start + Math.max(0, z.start - seg.localIn)) * pxPerSec,
                  width: Math.max(14, (Math.min(z.end, seg.localOut) - Math.max(z.start, seg.localIn)) * pxPerSec - 2)
                }}
                data-tip={`${z.scale.toFixed(2)}× · ${z.mode === 'auto' ? 'follows the cursor' : 'fixed point'}. Drag to move, drag an edge to retime.`}
                onPointerDown={ev => {
                  ev.stopPropagation()
                  dragRef.current = {
                    kind: 'zoom', id: z.id, clipId: seg.clip.id, mode: blockMode(ev), group: group(),
                    originX: ev.clientX, start: z.start, end: z.end, limit: seg.clip.duration, pxPerSec
                  }
                  setSelectedZoom(z.id); setSelectedSeg(seg.key); setSelectedOverlay(null)
                  setTool('zoom')
                }}>
                {z.scale.toFixed(1)}×
              </div>
            ))}
          </div>

          <div className="playhead" style={{ left: PAD + time * pxPerSec }} />
        </div>
      </div>
    </section>
  )
}
