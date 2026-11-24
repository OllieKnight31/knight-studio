import React from 'react'
import { generateZooms, STYLES } from '../../shared/autozoom.js'
import { removedRanges, restoreRange } from '../../shared/timeline.js'
import { CANVAS_PRESETS } from '../presets.js'
import { FONTS } from '../compositor.js'
import { Row, Slider, Toggle, Seg, Colour, Icon } from '../ui.jsx'
import { findFillers, isFiller } from '../../shared/captions.js'
import { Templates, WriteUp, SharePage, CloudShare, DriveSharePage } from './ExportExtras.jsx'

const GRADIENTS = [
  ['#0B0B0F', '#1C1F2B'], ['#101014', '#2A2118'], ['#0E1116', '#16303B'],
  ['#1A1024', '#341C3E'], ['#0F1A14', '#1D3A2A'], ['#241016', '#43202A'],
  ['#C8A24A', '#6E5320'], ['#141418', '#3A3A46'], ['#1E3A8A', '#0EA5E9'],
  ['#7C3AED', '#DB2777'], ['#F97316', '#FACC15'], ['#F4F4F2', '#D9D9D4']
]
const SOLIDS = ['#0A0A0C', '#16161B', '#242430', '#3A3A46', '#C8A24A', '#8A6F32', '#1D3A2A', '#341C3E', '#1E3A8A', '#7C3AED', '#FFFFFF', '#F4F4F2']

const FONT_LABELS = {
  system: 'System', helvetica: 'Helvetica', avenir: 'Avenir', futura: 'Futura',
  georgia: 'Georgia', impact: 'Impact', mono: 'Monospace'
}

const LAYOUTS = [
  ['bubble', 'Bubble', 'Your screen fills the frame with the camera in a corner.', 'M2 3h26v14H2zM20 10h6v5h-6z'],
  ['split', 'Side by side', 'Screen and camera share the frame equally.', 'M2 3h12v14H2zM16 3h12v14H16z'],
  ['screen-dominant', 'Screen + inset', 'Screen fills the frame with a widescreen camera inset.', 'M2 3h26v14H2zM18 11h8v4.500h-8z'],
  ['screen', 'Screen only', 'Hides the camera.', 'M2 3h26v14H2z'],
  ['camera', 'Camera only', 'Hides the screen — just you.', 'M2 3h26v14H2zM15 7.500a2.500 2.500 0 1 0 0 5 2.500 2.500 0 0 0 0-5z']
]

const Head = ({ title, children }) => (
  <div className="panel-head"><h3>{title}</h3><p className="panel-sub muted">{children}</p></div>
)

const pct = v => `${Math.round(v * 100)}%`
const secs = v => `${Number(v).toFixed(2)}s`
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export default function Panels (props) {
  const [notice, setNotice] = React.useState(null)    // a problem to show inside the panel
  const {
    tool, project, commit, clip, seg, selectedSeg, updateClip, media, timeline, time, seek,
    onExport, exportState, driveStatus, dbStatus, prefs, onOpenSettings,
    shareStatus, hookStatus, savePrefs, onWriteUp, aiState, onBuildSop, sopState,
    onPublishShare, onUnpublishShare, shareState, onRemoveFillers, onApplyTemplate,
    cloudStatus, cloudState, onOpenShare, onPublishCloud, onRemoveCloud,
    driveOn, driveShareState, onPublishDrive, onUnpublishDrive,
    onRetitle, retitling, onDeleteClip, onMoveClip,
    onTranscribe, transcribeState, onRemoveSilences, onRemoveWords, onSaveSRT,
    onSplit, onDeleteSection, onRemoveQuiet, setSectionGain,
    selectedZoom, setSelectedZoom, updateZoom, removeZoom, addZoomAt,
    selectedOverlay, setSelectedOverlay, addOverlay, updateOverlay, removeOverlay
  } = props

  // `soft` names the control, so a slider dragged across its range is one undo step.
  const set = patch => commit(p => ({ ...p, ...patch }), { soft: `set:${Object.keys(patch)}` })
  const setGroup = key => patch => commit(p => ({ ...p, [key]: { ...p[key], ...patch } }), { soft: `${key}:${Object.keys(patch)}` })
  const setStyle = setGroup('style')
  const setCam = setGroup('camera')
  const setCursor = setGroup('cursor')
  const setBg = setGroup('background')
  const setSub = setGroup('subtitles')
  const setAudio = setGroup('audio')
  const setClip = patch => clip && updateClip(clip.id, patch,
    typeof patch === 'function' ? undefined : { soft: `clip:${Object.keys(patch)}` })

  /* ------------------------------------------------------------------ setup */

  if (tool === 'setup') {
    return (
      <>
        <Head title="Setup">Name the video and pick the shape it will be exported in.</Head>
        <Row label="Name">
          <input className="input" value={project.name} onChange={e => set({ name: e.target.value })} />
        </Row>
        <button className="btn sm" disabled={retitling} onClick={onRetitle}
          data-tip="Listens to what was said (or looks at the screen if nothing was) and writes a title for you.">
          {retitling ? 'Watching and listening…' : 'Name it from the video'}
        </button>

        <div className="group">
          <span className="label">Canvas</span>
          <div className="presets">
            {Object.entries(CANVAS_PRESETS).map(([k, v]) => {
              const w = v.w || 16; const h = v.h || 10
              const s = 18 / Math.max(w, h)
              return (
                <button key={k} className={`preset ${project.canvas.preset === k ? 'on' : ''}`}
                  data-tip={v.w ? `${v.w}×${v.h}` : 'Matches the shape of your recording'}
                  onClick={() => commit(p => ({ ...p, canvas: { ...p.canvas, preset: k } }))}>
                  <svg viewBox="0 0 30 20"><rect x={15 - (w * s) / 2} y={10 - (h * s) / 2} width={w * s} height={h * s} rx="1.500"
                    fill="none" stroke="currentColor" strokeWidth="1.400" /></svg>
                  {v.label}
                </button>
              )
            })}
          </div>
        </div>

        <Templates project={project} onApply={onApplyTemplate} />

        <div className="group">
          <span className="label">This video</span>
          <p className="panel-sub muted">
            {project.clips.length} clip{project.clips.length === 1 ? '' : 's'} · {mmss(timeline.duration)} after edits.
            Each take is kept as its own clip, so you can re-record just the part that went wrong.
          </p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => window.knight.projects.reveal(project.id)}>Show in Finder</button>
            {project.drive?.link && (
              <button className="btn sm" onClick={() => window.knight.shell.openExternal(project.drive.link)}>Open in Drive</button>
            )}
          </div>
        </div>

        <div className="group">
          <span className="label">App settings</span>
          <p className="panel-sub muted">Where files are kept, Google Drive, sharing and the recording countdown all live in Settings.</p>
          <button className="btn sm" onClick={() => onOpenSettings('files')}><Icon name="settings" width="14" height="14" />Open Settings</button>
        </div>
      </>
    )
  }

  /* -------------------------------------------------------------------- cut */

  if (tool === 'cut') {
    if (!clip) return <p className="muted">No clip selected.</p>
    const clips = project.clips
    const removed = removedRanges(clip)
    const dead = { thresholdDb: -30, minSeconds: 0.7, pad: 0.15, ...(project.deadSpace || {}) }
    const setDead = patch => commit(p => ({ ...p, deadSpace: { ...dead, ...patch } }), { soft: `dead:${Object.keys(patch)}` })
    const section = timeline.segs.find(s => s.key === selectedSeg) || null

    return (
      <>
        <Head title="Cut">
          Work on the timeline: drag a section's edge to trim it, split at the playhead, select a
          section and delete it. Nothing is destroyed — every cut can be put back.
        </Head>

        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={onSplit} data-tip="Divide the video at the playhead" data-tip-key="S">
            <Icon name="split" width="14" height="14" />Split at playhead
          </button>
          <button className="btn sm" disabled={!section || timeline.segs.length < 2} onClick={onDeleteSection}
            data-tip="Remove the selected section and close the gap" data-tip-key="⌫">
            <Icon name="trash" width="14" height="14" />Delete section
          </button>
        </div>
        <p className="panel-sub muted">
          {section
            ? `Selected: ${secs(section.duration)} starting at ${mmss(section.start)}.`
            : 'Click a section on the timeline to select it.'}
        </p>

        <div className="group">
          <span className="label">Remove dead space</span>
          <p className="panel-sub muted">Cuts out the pauses where nobody is speaking, leaving a little breathing room either side.</p>
          <Slider label="Shortest pause to remove" value={dead.minSeconds} min={0.3} max={3} step={0.05}
            format={secs} onChange={v => setDead({ minSeconds: v })}
            tip="Pauses shorter than this are left in, so the delivery still sounds natural." />
          <Slider label="Sensitivity" value={-dead.thresholdDb} min={18} max={45} step={1}
            format={v => (v <= 24 ? 'gentle' : v <= 33 ? 'balanced' : 'aggressive')}
            onChange={v => setDead({ thresholdDb: -v })}
            tip="Gentle only removes true silence. Aggressive also treats quiet breaths and background noise as dead space." />
          <Slider label="Breathing room" value={dead.pad} min={0} max={0.5} step={0.01}
            format={secs} onChange={v => setDead({ pad: v })}
            tip="How much of each pause is kept on either side of the cut, so words are never clipped." />
          <button className="btn sm" onClick={onRemoveQuiet}><Icon name="quiet" width="14" height="14" />Remove dead space</button>
        </div>

        <div className="group">
          <div className="row between">
            <span className="label">Removed from this clip ({removed.length})</span>
            {removed.length > 0 && (
              <button className="btn ghost sm" style={{ padding: '2px 6px' }}
                onClick={() => setClip(c => ({ ...c, cuts: [], trim: { in: 0, out: c.duration } }))}
                data-tip="Puts back everything that was cut from this clip">Restore all</button>
            )}
          </div>
          <div className="col" style={{ gap: 5, maxHeight: 170, overflow: 'auto' }}>
            {removed.map(r => (
              <div key={r.start} className="chip row between" style={{ width: '100%' }}>
                <span>{mmss(r.start)} · {secs(r.end - r.start)}</span>
                <button className="btn ghost sm" style={{ padding: '0 4px' }} data-tip="Put this section back"
                  onClick={() => setClip(c => restoreRange(c, r.start, r.end))}><Icon name="restore" width="13" height="13" /></button>
              </div>
            ))}
            {!removed.length && <span className="muted" style={{ fontSize: 11.5 }}>Nothing has been cut.</span>}
          </div>
        </div>

        {clips.length > 1 && (
          <div className="group">
            <span className="label">Clips in this video ({clips.length})</span>
            <div className="col" style={{ gap: 5 }}>
              {clips.map((c, i) => (
                <div key={c.id} className={`chip row between ${c.id === clip.id ? 'on' : ''}`} style={{ width: '100%' }}>
                  <span>{i + 1}. {c.hasCamera ? 'Screen + camera' : 'Screen'} · {c.duration.toFixed(1)}s</span>
                  <span className="row" style={{ gap: 2 }}>
                    <button className="btn ghost sm" style={{ padding: '0 3px' }} disabled={i === 0}
                      data-tip="Move earlier" onClick={() => onMoveClip(i, i - 1)}>↑</button>
                    <button className="btn ghost sm" style={{ padding: '0 3px' }} disabled={i === clips.length - 1}
                      data-tip="Move later" onClick={() => onMoveClip(i, i + 1)}>↓</button>
                    <button className="btn ghost sm" style={{ padding: '0 3px' }}
                      data-tip="Delete this clip and its recording for good" onClick={() => onDeleteClip(c.id)}>✕</button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </>
    )
  }

  /* ----------------------------------------------------------------- layout */

  if (tool === 'layout') {
    if (!clip) return <p className="muted">No clip selected.</p>
    const cam = project.camera
    const options = clip.hasCamera ? LAYOUTS : LAYOUTS.filter(l => l[0] === 'screen')
    const syncNote = {
      measured: 'Lined up from the recording’s own timestamps.',
      aligned: 'Lined up with your voice automatically.',
      approximate: 'Lined up approximately — there was not enough speech to be sure. Adjust below if lips and voice look out.',
      estimated: 'Being lined up…'
    }[clip.cameraSync] || ''
    return (
      <>
        <Head title="Layout">How the screen and the camera share the frame.</Head>
        <div className="presets">
          {options.map(([v, l, tip, d]) => (
            <button key={v} className={`preset ${clip.layout === v ? 'on' : ''}`} data-tip={tip} data-tip-title={l}
              onClick={() => setClip({ layout: v })}>
              <svg viewBox="0 0 30 20"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.400" strokeLinejoin="round" /></svg>
              {l}
            </button>
          ))}
        </div>
        <Row label="Screen fit" tip="Fill crops the recording to fill its area. Fit shows all of it, with bars if the shapes differ.">
          <Seg value={project.style.screenFit} onChange={v => setStyle({ screenFit: v })}
            options={[['fill', 'Fill'], ['fit', 'Fit']]} />
        </Row>

        {clip.hasCamera && (
          <>
            <div className="group">
              <span className="label">Camera</span>
              <Row label="Shape">
                <Seg value={cam.shape} onChange={v => setCam({ shape: v })}
                  options={[['circle', 'Circle'], ['rounded', 'Rounded'], ['square', 'Square']]} />
              </Row>
              <Slider label="Size" value={cam.size} min={0.1} max={0.6} step={0.005} format={pct} onChange={v => setCam({ size: v })} />
              {cam.shape === 'rounded' && (
                <Slider label="Corner radius" value={cam.radius ?? project.style.radius} min={0} max={120} step={1}
                  format={v => `${Math.round(v)}px`} onChange={v => setCam({ radius: v })} />
              )}
              <Slider label="Zoom in on me" value={cam.zoom ?? 1} min={1} max={2.5} step={0.01}
                format={v => `${v.toFixed(2)}×`} onChange={v => setCam({ zoom: v })}
                tip="Crops in toward the middle of the camera picture, to cut out the room around you." />
              <Slider label="Border" value={cam.borderWidth || 0} min={0} max={14} step={1}
                format={v => (v ? `${Math.round(v)}px` : 'none')} onChange={v => setCam({ borderWidth: v })} />
              {cam.borderWidth > 0 && <Colour label="Border colour" value={cam.borderColor} onChange={v => setCam({ borderColor: v })} />}
              <Slider label="Shadow" value={cam.shadow ?? project.style.shadow} min={0} max={1} step={0.02}
                onChange={v => setCam({ shadow: v })} />
              <Toggle label="Mirror camera" checked={cam.mirrored} onChange={v => setCam({ mirrored: v })}
                tip="Flips the picture left to right, the way you see yourself in a mirror." />
            </div>

            <div className="group">
              <span className="label">Position</span>
              <Row label="Corner">
                <select className="select" value={cam.position} onChange={e => setCam({ position: e.target.value, pos: null })}>
                  {['bottom-right', 'bottom-left', 'top-right', 'top-left'].map(p => (
                    <option key={p} value={p}>{p.replace('-', ' ')}</option>
                  ))}
                </select>
              </Row>
              <p className="panel-sub muted">
                Or drag the camera on the video to place it anywhere.
                {cam.pos ? ' It is currently placed by hand.' : ''}
              </p>
              {cam.pos && (
                <button className="btn sm ghost" onClick={() => setCam({ pos: null })}>
                  Snap back to {cam.position.replace('-', ' ')}
                </button>
              )}
            </div>

            <div className="group">
              <span className="label">Camera timing</span>
              <p className="panel-sub muted">{syncNote}</p>
              <Slider label="Nudge" value={clip.cameraNudge || 0} min={-0.5} max={0.5} step={0.01}
                format={v => (Math.abs(v) < 0.005 ? 'none' : `${v > 0 ? '+' : ''}${Math.round(v * 1000)} ms — camera ${v > 0 ? 'later' : 'earlier'}`)}
                onChange={v => setClip({ cameraNudge: v })}
                tip="If your lips move before you hear the word, move the camera later. If the sound comes first, move it earlier." />
              {Math.abs(clip.cameraNudge || 0) > 0.005 && (
                <button className="btn sm ghost" onClick={() => setClip({ cameraNudge: 0 })}>Reset nudge</button>
              )}
            </div>
          </>
        )}
      </>
    )
  }

  /* ------------------------------------------------------------------- zoom */

  if (tool === 'zoom') {
    if (!clip) return <p className="muted">No clip selected.</p>
    const hasClicks = (media[clip.id]?.events || []).some(e => e.type === 'down')
    const zooms = clip.zooms || []
    const sel = zooms.find(z => z.id === selectedZoom) || null
    const local = seg ? seg.localIn + Math.max(0, Math.min(seg.duration, time - seg.start)) : 0

    const regenerate = style => {
      const zoomsNext = generateZooms(media[clip.id]?.events || [], {
        style, duration: clip.duration, frame: { width: clip.width, height: clip.height }
      })
      commit(p => ({
        ...p,
        autoZoom: { ...p.autoZoom, style },
        clips: p.clips.map(c => (c.id === clip.id ? { ...c, zooms: zoomsNext, autoZoomApplied: true } : c))
      }))
      setSelectedZoom(null)
    }

    return (
      <>
        <Head title="Zoom">Zoom in on the part of the screen that matters, then ease back out.</Head>
        {!hasClicks && (
          <p className="panel-sub muted">
            This clip has no click data, so automatic zoom has nothing to work from. You can
            still add zooms by hand.
          </p>
        )}

        <Row label="Automatic zoom" tip="How eagerly zooms are created from your clicks.">
          <select className="select" value={project.autoZoom.style}
            onChange={e => regenerate(e.target.value)} disabled={!hasClicks}>
            {Object.keys(STYLES).map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
          </select>
        </Row>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" disabled={!hasClicks} onClick={() => regenerate(project.autoZoom.style)}
            data-tip="Rebuilds every zoom on this clip from where you clicked. Replaces the zooms that are there.">Regenerate</button>
          <button className="btn sm" onClick={() => addZoomAt(clip, local)}
            data-tip="Adds a zoom starting at the playhead">Add zoom at playhead</button>
          <button className="btn sm ghost" onClick={() => { setClip({ zooms: [] }); setSelectedZoom(null) }}>Clear all</button>
        </div>
        <Toggle label="Zoom new recordings automatically" checked={project.autoZoom.applyOnRecord}
          onChange={v => commit(p => ({ ...p, autoZoom: { ...p.autoZoom, applyOnRecord: v } }))} />

        {sel && (
          <div className="group">
            <div className="row between">
              <span className="label">Selected zoom</span>
              <span className="val">{sel.start.toFixed(2)}s → {sel.end.toFixed(2)}s</span>
            </div>
            <Row label="Follow">
              <Seg value={sel.mode} onChange={v => updateZoom(clip.id, sel.id, { mode: v })}
                options={[['auto', 'Follow cursor', 'The zoom moves with the mouse pointer'], ['manual', 'Fixed point', 'The zoom stays on one spot you choose']]} />
            </Row>
            <Slider label="How far in" value={sel.scale} min={1.1} max={4} step={0.05}
              format={v => `${v.toFixed(2)}×`} onChange={v => updateZoom(clip.id, sel.id, { scale: v })} />
            <Slider label="Ease in / out" value={sel.ramp} min={0.15} max={1.5} step={0.05}
              format={secs} onChange={v => updateZoom(clip.id, sel.id, { ramp: v })}
              tip="How long the zoom takes to glide in and back out. Shorter is punchier." />
            {sel.mode === 'manual' && (
              <>
                <Slider label="Across" value={sel.target.x} min={0} max={clip.width || 1920} step={10}
                  format={v => pct(v / (clip.width || 1920))}
                  onChange={v => updateZoom(clip.id, sel.id, { target: { ...sel.target, x: v } })} />
                <Slider label="Down" value={sel.target.y} min={0} max={clip.height || 1080} step={10}
                  format={v => pct(v / (clip.height || 1080))}
                  onChange={v => updateZoom(clip.id, sel.id, { target: { ...sel.target, y: v } })} />
              </>
            )}
            <div className="row">
              <button className="btn sm ghost" onClick={() => removeZoom(clip.id, sel.id)}>Delete zoom</button>
            </div>
          </div>
        )}

        <div className="group">
          <span className="label">Zooms on this clip ({zooms.length})</span>
          <div className="col" style={{ gap: 5, maxHeight: 170, overflow: 'auto' }}>
            {zooms.map(z => (
              <div key={z.id} className={`chip row between ${z.id === selectedZoom ? 'on' : ''}`}
                style={{ width: '100%', cursor: 'pointer' }}
                onClick={() => setSelectedZoom(z.id)}>
                <span>{z.start.toFixed(1)}s → {z.end.toFixed(1)}s</span>
                <span className="val">{z.scale.toFixed(2)}×</span>
              </div>
            ))}
            {!zooms.length && <span className="muted" style={{ fontSize: 11.5 }}>None yet.</span>}
          </div>
          <p className="panel-sub muted">Drag a zoom on the timeline to move it, or drag its edge to retime it.</p>
        </div>
      </>
    )
  }

  /* ------------------------------------------------------------------ style */

  if (tool === 'style') {
    const bg = project.background
    const cols = bg.colors?.length ? bg.colors : ['#0B0B0F', '#1C1F2B']
    return (
      <>
        <Head title="Style">The backdrop behind your recording and how the recording sits on it.</Head>
        <Row label="Background">
          <Seg value={bg.type === 'color' ? 'color' : 'gradient'} onChange={v => setBg({ type: v })}
            options={[['gradient', 'Gradient'], ['color', 'Solid colour']]} />
        </Row>
        <div className="swatches">
          {(bg.type === 'color' ? SOLIDS : GRADIENTS).map((g, i) => {
            const c = Array.isArray(g) ? g : [g]
            const on = JSON.stringify(bg.colors) === JSON.stringify(c)
            return (
              <div key={i} className={`swatch ${on ? 'on' : ''}`}
                style={{ background: c.length > 1 ? `linear-gradient(135deg, ${c[0]}, ${c[1]})` : c[0] }}
                onClick={() => setBg({ colors: c })} />
            )
          })}
        </div>
        {bg.type === 'color'
          ? <Colour label="Your own colour" value={cols[0]} onChange={v => setBg({ colors: [v] })} />
          : (
            <>
              <Colour label="Gradient from" value={cols[0]} onChange={v => setBg({ colors: [v, cols[1] || v] })} />
              <Colour label="Gradient to" value={cols[1] || cols[0]} onChange={v => setBg({ colors: [cols[0], v] })} />
              <Slider label="Angle" value={bg.angle} min={0} max={360} step={1}
                format={v => `${Math.round(v)}°`} onChange={v => setBg({ angle: v })} />
            </>
            )}
        <button className="btn sm ghost" onClick={() => setBg({ type: 'gradient', colors: ['#0A0A0B', '#45454A'], angle: 135 })}
          data-tip="Builds a gradient from the app's own colours">Use brand colours</button>

        <div className="group">
          <span className="label">Frame</span>
          <Slider label="Padding" value={project.style.padding} min={0} max={0.18} step={0.005}
            format={pct} onChange={v => setStyle({ padding: v })}
            tip="How much background shows around the recording. Zero is edge to edge." />
          <Slider label="Corner radius" value={project.style.radius} min={0} max={64} step={1}
            format={v => `${Math.round(v)}px`} onChange={v => setStyle({ radius: v })} />
          <Slider label="Shadow" value={project.style.shadow} min={0} max={1} step={0.02}
            onChange={v => setStyle({ shadow: v })} />
          <Slider label="Border" value={project.style.borderWidth} min={0} max={12} step={1}
            format={v => (v ? `${Math.round(v)}px` : 'none')} onChange={v => setStyle({ borderWidth: v })} />
          {project.style.borderWidth > 0 && (
            <Colour label="Border colour" value={project.style.borderColor} onChange={v => setStyle({ borderColor: v })} />
          )}
        </div>
      </>
    )
  }

  /* ----------------------------------------------------------------- cursor */

  if (tool === 'cursor') {
    return (
      <>
        <Head title="Cursor">The mouse pointer is redrawn over your recording, so it can be bigger, smoother and easier to follow.</Head>
        <Toggle label="Show the cursor" checked={project.cursor.animated} onChange={v => setCursor({ animated: v })} />
        <Row label="Look">
          <Seg value={project.cursor.style} onChange={v => setCursor({ style: v })}
            options={[['macos', 'Black'], ['windows', 'White']]} />
        </Row>
        <Slider label="Size" value={project.cursor.size} min={0.5} max={2.5} step={0.05}
          format={v => `${v.toFixed(2)}×`} onChange={v => setCursor({ size: v })} />
        <Slider label="Smooth movement" value={project.cursor.smoothing} min={0} max={0.95} step={0.01}
          onChange={v => setCursor({ smoothing: v })}
          tip="Higher is calmer and glides more; lower follows your hand exactly." />
        <Slider label="Lean into movement" value={project.cursor.tilt} min={0} max={1} step={0.02}
          onChange={v => setCursor({ tilt: v })} tip="Tilts the pointer slightly in the direction it is travelling." />
        <div className="group">
          <span className="label">Clicks</span>
          <Slider label="Press effect" value={project.cursor.clickSpring} min={0} max={1} step={0.02}
            onChange={v => setCursor({ clickSpring: v })} tip="The pointer dips briefly on each click." />
          <Slider label="Ripple" value={project.cursor.clickRipple} min={0} max={1} step={0.02}
            onChange={v => setCursor({ clickRipple: v })} tip="A ring spreads out from each click so viewers see where you pressed." />
        </div>
      </>
    )
  }

  /* ------------------------------------------------------------------- text */

  if (tool === 'text') {
    const overlays = project.overlays || []
    const sel = overlays.find(o => o.id === selectedOverlay) || null
    const up = patch => updateOverlay(sel.id, patch, { soft: `ov:${sel.id}:${Object.keys(patch)}` })
    const place = (x, y) => up({ x: x === 'l' ? 0.05 : x === 'c' ? (1 - sel.w) / 2 : 0.95 - sel.w, y: y === 't' ? 0.06 : y === 'm' ? (1 - sel.h) / 2 : 0.94 - sel.h })
    return (
      <>
        <Head title="Text">Headlines and text on top of the video, and blur boxes to hide anything private.</Head>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => addOverlay('headline')} data-tip="A large title, centred near the top"><Icon name="headline" width="14" height="14" />Headline</button>
          <button className="btn sm" onClick={() => addOverlay('text')} data-tip="A line of text on a dark strip, lower left"><Icon name="text" width="14" height="14" />Text</button>
          <button className="btn sm" onClick={() => addOverlay('blur')} data-tip="Blurs a rectangle — for emails, numbers, anything private"><Icon name="blur" width="14" height="14" />Blur</button>
        </div>
        <p className="panel-sub muted">New items start at the playhead. Drag them on the video to place them and on the timeline to time them.</p>

        {sel && (
          <div className="group">
            {sel.type === 'text' && (
              <>
                <Row label="Text">
                  <textarea className="input" value={sel.text} rows={2}
                    onChange={e => up({ text: e.target.value })} />
                </Row>
                <Row label="Font">
                  <select className="select" value={sel.font || 'system'} onChange={e => up({ font: e.target.value })}>
                    {Object.keys(FONTS).map(f => <option key={f} value={f}>{FONT_LABELS[f]}</option>)}
                  </select>
                </Row>
                <Slider label="Size" value={sel.size} min={18} max={180} step={1}
                  format={v => `${Math.round(v)}px`} onChange={v => up({ size: v })} />
                <Row label="Weight">
                  <Seg value={sel.weight >= 800 ? 800 : sel.weight >= 600 ? 650 : 400} onChange={v => up({ weight: v })}
                    options={[[400, 'Regular'], [650, 'Bold'], [800, 'Heavy']]} />
                </Row>
                <Row label="Align">
                  <Seg value={sel.align || 'left'} onChange={v => up({ align: v })}
                    options={[['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]} />
                </Row>
                <Colour label="Text colour" value={sel.color} onChange={v => up({ color: v })} />
                <Toggle label="Background strip" checked={sel.background && sel.background !== 'none'}
                  onChange={v => up({ background: v ? 'rgba(0,0,0,0.55)' : 'none' })} />
                {sel.background && sel.background !== 'none' && (
                  <Colour label="Strip colour" value={/^#/.test(sel.background) ? sel.background : '#000000'}
                    onChange={v => up({ background: v })} />
                )}
                <Toggle label="Drop shadow" checked={sel.shadow} onChange={v => up({ shadow: v })}
                  tip="Keeps text readable over a busy picture without needing a background strip." />
                <Toggle label="ALL CAPS" checked={sel.uppercase} onChange={v => up({ uppercase: v })} />
              </>
            )}
            {sel.type === 'blur' && (
              <Slider label="Blur strength" value={sel.amount} min={4} max={60} step={1}
                format={v => `${Math.round(v)}px`} onChange={v => up({ amount: v })} />
            )}

            <Row label="Place it" tip="Jumps the box to a spot on the frame. You can also just drag it on the video.">
              <div className="swatches" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 5 }}>
                {['t', 'm', 'b'].flatMap(y => ['l', 'c', 'r'].map(x => (
                  <button key={y + x} className="btn sm" style={{ justifyContent: 'center', padding: '5px 0' }}
                    onClick={() => place(x, y)}>
                    {{ t: 'Top', m: 'Mid', b: 'Low' }[y]} {{ l: 'L', c: 'C', r: 'R' }[x]}
                  </button>
                )))}
              </div>
            </Row>
            <Slider label="Box width" value={sel.w} min={0.05} max={1} step={0.005} format={pct}
              onChange={v => up({ w: v, x: Math.min(sel.x, 1 - v) })}
              tip="Text wraps onto a new line when it reaches the edge of its box." />
            <Slider label="Box height" value={sel.h} min={0.03} max={1} step={0.005} format={pct}
              onChange={v => up({ h: v, y: Math.min(sel.y, 1 - v) })} />
            <Slider label="Opacity" value={sel.opacity ?? 1} min={0.1} max={1} step={0.02} format={pct}
              onChange={v => up({ opacity: v })} />
            <Slider label="Fade in / out" value={sel.fade ?? 0.3} min={0.01} max={1.5} step={0.01} format={secs}
              onChange={v => up({ fade: v })} />
            <Slider label="Appears at" value={sel.start} min={0} max={Math.max(1, timeline.duration)} step={0.05}
              format={secs} onChange={v => up({ start: Math.min(v, sel.end - 0.3) })} />
            <Slider label="Disappears at" value={sel.end} min={0} max={Math.max(1, timeline.duration)} step={0.05}
              format={secs} onChange={v => up({ end: Math.max(v, sel.start + 0.3) })} />
            <div className="row">
              <button className="btn sm" onClick={() => up({ start: 0, end: timeline.duration })}
                data-tip="Keeps it on screen from the first frame to the last">Show for whole video</button>
              <button className="btn sm ghost" onClick={() => removeOverlay(sel.id)}>Delete</button>
            </div>
          </div>
        )}

        <div className="group">
          <span className="label">On this video ({overlays.length})</span>
          <div className="col" style={{ gap: 5, maxHeight: 150, overflow: 'auto' }}>
            {overlays.map(o => (
              <div key={o.id} className={`chip row between ${o.id === selectedOverlay ? 'on' : ''}`}
                style={{ width: '100%', cursor: 'pointer' }}
                onClick={() => { setSelectedOverlay(o.id); seek(o.start + 0.01) }}>
                <span>{o.type === 'text' ? `“${(o.text || '').slice(0, 20)}”` : 'Blur box'}</span>
                <span className="val">{mmss(o.start)}–{mmss(o.end)}</span>
              </div>
            ))}
            {!overlays.length && <span className="muted" style={{ fontSize: 11.5 }}>None yet.</span>}
          </div>
        </div>
      </>
    )
  }

  /* ------------------------------------------------------------------ audio */

  if (tool === 'audio') {
    const section = timeline.segs.find(s => s.key === selectedSeg) || seg
    const loud = clip ? media[clip.id]?.loudness : null
    return (
      <>
        <Head title="Audio">Levels for the whole video, the volume of a single section, and background music.</Head>
        <Slider label="Microphone" value={project.audio.micGain} min={0} max={2} step={0.05} format={pct}
          onChange={v => setAudio({ micGain: v })}
          tip="Your voice. It is already levelled to a standard loudness on export; this is on top of that." />
        <Slider label="System sound" value={project.audio.systemGain} min={0} max={2} step={0.05} format={pct}
          onChange={v => setAudio({ systemGain: v })}
          tip="Sound the computer was playing — videos, notification pings, the other side of a call." />
        {loud && (
          <p className="panel-sub muted">
            This take was recorded {loud.gainDb > 1 ? `quietly and is lifted by ${loud.gainDb.toFixed(0)} dB` : 'at a good level'} so it plays back at a normal loudness.
          </p>
        )}

        <div className="group">
          <span className="label">Selected section</span>
          {section
            ? (
              <>
                <p className="panel-sub muted">{secs(section.duration)} starting at {mmss(section.start)}. Split the video on the timeline to change the volume of just one part.</p>
                <Slider label="Volume" value={section.gain} min={0} max={2} step={0.05}
                  format={v => (v === 0 ? 'muted' : pct(v))}
                  onChange={v => setSectionGain(section, v)} />
                <div className="row">
                  <button className="btn sm" onClick={() => setSectionGain(section, section.gain === 0 ? 1 : 0)}>
                    <Icon name={section.gain === 0 ? 'volume' : 'mute'} width="14" height="14" />{section.gain === 0 ? 'Unmute' : 'Mute section'}
                  </button>
                  {Math.abs(section.gain - 1) > 0.005 && (
                    <button className="btn sm ghost" onClick={() => setSectionGain(section, 1)}>Reset</button>
                  )}
                </div>
              </>
              )
            : <p className="panel-sub muted">Click a section on the timeline.</p>}
        </div>

        <div className="group">
          <span className="label">Background music</span>
          {project.audio.music
            ? (
              <div className="chip row between" style={{ width: '100%' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {project.audio.music.split('/').pop()}
                </span>
                <button className="btn ghost sm" style={{ padding: '0 4px' }}
                  onClick={() => setAudio({ music: null })}>✕</button>
              </div>
              )
            : (
              <button className="btn sm" onClick={async () => {
                setNotice(null)
                try {
                  const f = await window.knight.files.pickAudio()
                  if (f) setAudio({ music: f })
                } catch (e) {
                  setNotice(String(e.message || e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''))
                }
              }}>Choose a track…</button>
              )}
          {project.audio.music && (
            <Slider label="Music level" value={project.audio.musicGain} min={0} max={0.6} step={0.01} format={pct}
              onChange={v => setAudio({ musicGain: v })} tip="Kept low by default so it sits under your voice. It loops to cover the whole video." />
          )}
          {notice && <span className="val" style={{ color: 'var(--rec)' }}>{notice}</span>}
          <p className="panel-sub muted">Music is mixed in when you export; it does not play in the preview.</p>
        </div>

        <div className="group">
          <span className="label">Dead space</span>
          <p className="panel-sub muted">Cut out the pauses where nobody is speaking.</p>
          <button className="btn sm" onClick={onRemoveQuiet}><Icon name="quiet" width="14" height="14" />Remove dead space</button>
        </div>
      </>
    )
  }

  /* -------------------------------------------------------------- subtitles */

  if (tool === 'subtitles') {
    const m = clip ? media[clip.id] : null
    const words = m?.transcript?.words || []
    const busy = transcribeState && transcribeState.clipId === clip?.id && transcribeState.pct < 1 && !transcribeState.error
    const cutCount = (clip?.cuts || []).length
    // Across the whole video, not just this clip — that is what the button acts on.
    const fillerCount = project.clips.reduce((n, c) => n + findFillers(media[c.id]?.transcript?.words, c.cuts || []).length, 0)
    const sub = project.subtitles

    return (
      <>
        <Head title="Captions">Turn speech into captions, and edit the video by editing the words.</Head>

        {!words.length && (
          <>
            <p className="panel-sub muted">
              Transcription runs on this Mac — nothing is uploaded.
            </p>
            <button className="btn" disabled={busy || !clip} onClick={() => onTranscribe(clip)}>
              {busy ? 'Transcribing…' : 'Transcribe this clip'}
            </button>
          </>
        )}

        {busy && (
          <div className="progress"><i style={{ width: `${Math.round((transcribeState.pct || 0) * 100)}%` }} /></div>
        )}
        {transcribeState?.error && (
          <span className="val" style={{ color: 'var(--rec)' }}>{transcribeState.error}</span>
        )}
        {transcribeState?.pct === 1 && !words.length && (
          <span className="val">No speech found in this clip.</span>
        )}

        {words.length > 0 && (
          <>
            <Toggle label="Show captions on the video" checked={sub.enabled} onChange={v => setSub({ enabled: v })} />

            <div className="field">
              <div className="row between">
                <span className="label">Transcript ({words.length} words)</span>
                <span className="val">click a word to cut it</span>
              </div>
              <div className="transcript">
                {words.map((w, i) => {
                  const cut = (clip.cuts || []).some(c => w.start >= c.start - 0.03 && w.end <= c.end + 0.03)
                  return (
                    <span key={i}
                      className={`tword ${cut ? 'cut' : ''} ${!cut && isFiller(w) ? 'filler' : ''}`}
                      data-tip={`${w.start.toFixed(2)}s — click to remove this word, shift-click to jump to it`}
                      onClick={e => {
                        if (e.shiftKey) seek(timeline.segs.find(s => s.clip.id === clip.id && w.start >= s.localIn && w.start <= s.localOut)?.start ?? 0)
                        else if (!cut) onRemoveWords(clip, [w])
                      }}>
                      {w.word}
                    </span>
                  )
                })}
              </div>
            </div>

            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn sm" data-act="remove-fillers" onClick={() => onRemoveFillers()}
                data-tip="Cuts every “um”, “uh” and “erm” out of the whole video in one go. One undo puts them all back."
                data-tip-title="Remove filler words">
                Remove filler words{fillerCount ? ` (${fillerCount})` : ''}
              </button>
              <button className="btn sm" onClick={() => onRemoveSilences(clip)}
                data-tip="Cuts every gap between words longer than about two thirds of a second">Remove pauses</button>
              <button className="btn sm" onClick={() => onSaveSRT()}
                data-tip="Saves a subtitle file timed to the edited video, for YouTube or LinkedIn">Export SRT</button>
              <button className="btn sm ghost" disabled={!cutCount}
                onClick={() => updateClip(clip.id, { cuts: [] })}>
                Undo cuts{cutCount ? ` (${cutCount})` : ''}
              </button>
            </div>
            <button className="btn sm ghost" onClick={() => onTranscribe(clip)} disabled={busy}>
              Re-transcribe
            </button>

            <div className="group">
              <span className="label">Caption look</span>
              <Row label="Font">
                <select className="select" value={sub.font in FONTS ? sub.font : 'system'} onChange={e => setSub({ font: e.target.value })}>
                  {Object.keys(FONTS).map(f => <option key={f} value={f}>{FONT_LABELS[f]}</option>)}
                </select>
              </Row>
              <Slider label="Size" value={sub.size} min={20} max={110} step={1}
                format={v => `${Math.round(v)}px`} onChange={v => setSub({ size: v })} />
              <Slider label="Height on screen" value={sub.position} min={0.08} max={0.95} step={0.01}
                format={pct} onChange={v => setSub({ position: v })} />
              <Colour label="Text colour" value={sub.color} onChange={v => setSub({ color: v })} />
              <Toggle label="Background strip" checked={sub.background && sub.background !== 'none'}
                onChange={v => setSub({ background: v ? 'rgba(0,0,0,0.55)' : 'none' })} />
              <Toggle label="One word at a time" checked={sub.oneWordAtATime} onChange={v => setSub({ oneWordAtATime: v })}
                tip="The punchy style used on short-form video: each word appears on its own." />
              <Toggle label="ALL CAPS" checked={sub.uppercase} onChange={v => setSub({ uppercase: v })} />
            </div>
          </>
        )}
      </>
    )
  }

  /* ----------------------------------------------------------------- export */

  if (tool === 'export') {
    const busy = exportState && !['done', 'error', 'uploaded'].includes(exportState.phase)
    const driveReady = driveStatus?.configured && driveStatus.parent
    return (
      <>
        <Head title="Export">Save the finished video as an MP4.</Head>
        <Row label="Frame rate" tip="60 is smoother for screen recordings. 30 makes a smaller file.">
          <Seg value={project.exportFps || 60} onChange={v => set({ exportFps: v })}
            options={[[30, '30 fps'], [60, '60 fps']]} />
        </Row>
        <Row label="Quality">
          <select className="select" value={project.exportQuality || 'high'} onChange={e => set({ exportQuality: e.target.value })}>
            <option value="web">Web — smallest file</option>
            <option value="high">High — recommended</option>
            <option value="max">Maximum — largest file</option>
          </select>
        </Row>
        <p className="panel-sub muted">{mmss(timeline.duration)} long. Sound levels and music are under Audio.</p>

        {driveStatus && !driveStatus.configured && (
          <div className="group">
            <span className="label">Google Drive</span>
            <p className="panel-sub muted">Connect a Google account and every export uploads itself, with a link ready to share.</p>
            <button className="btn sm" onClick={() => onOpenSettings('drive')}><Icon name="drive" width="14" height="14" />Connect Google Drive</button>
          </div>
        )}
        {driveStatus?.configured && (
          driveReady
            ? (
              <div className="group">
                <span className="label">Google Drive</span>
                <Toggle label="Upload this video after export"
                  checked={prefs.drive?.autoUpload !== false && project.driveUpload !== false}
                  onChange={v => set({ driveUpload: v })} />
                <p className="panel-sub muted">
                  Goes into <b>{driveStatus.parent.name}</b>{project.folderId ? ', inside the folder this video is filed in' : ''}.
                  {prefs.drive?.autoUpload === false ? ' Automatic uploads are switched off in Settings.' : ''}
                </p>
              </div>
              )
            : (
              <div className="group">
                <span className="label">Google Drive</span>
                <p className="panel-sub muted">Choose a parent folder in Drive and exports will upload into it.</p>
                <button className="btn sm" onClick={() => onOpenSettings('drive')}><Icon name="drive" width="14" height="14" />Choose Drive folder</button>
              </div>
              )
        )}

        {dbStatus && (() => {
          const names = { notion: 'Notion', airtable: 'Airtable', supabase: 'Supabase' }
          const on = Object.keys(names).filter(k => dbStatus[k]?.configured)
          const sending = on.filter(k => dbStatus[k].auto !== false)
          return (
            <div className="group">
              <span className="label">Databases</span>
              {on.length
                ? (
                  <>
                    <Toggle label="Add this video to your databases"
                      checked={project.databaseSend !== false && sending.length > 0}
                      onChange={v => set({ databaseSend: v })} />
                    <p className="panel-sub muted">
                      {sending.length ? `Goes to ${sending.map(k => names[k]).join(', ')} after export.` : 'Each connection is switched off in Settings.'}
                    </p>
                  </>
                  )
                : (
                  <>
                    <p className="panel-sub muted">Log every export in Notion, Airtable or Supabase.</p>
                    <button className="btn sm" onClick={() => onOpenSettings('databases')}><Icon name="grid" width="14" height="14" />Connect a database</button>
                  </>
                  )}
            </div>
          )
        })()}

        <WriteUp project={project} prefs={prefs} savePrefs={savePrefs} set={set} seek={seek}
          aiState={aiState} onWriteUp={onWriteUp} sopState={sopState} onBuildSop={onBuildSop}
          exportedPath={exportState?.output || project.lastExport?.path || null} onOpenSettings={onOpenSettings} />

        <CloudShare project={project} set={set} status={cloudStatus} state={cloudState} busy={busy}
          onOpenShare={onOpenShare} onPublish={onPublishCloud} onRemove={onRemoveCloud} onOpenSettings={onOpenSettings} />

        {/* With Google Drive connected, a share page needs nothing else. */}
        {driveOn && <DriveSharePage project={project} set={set} state={driveShareState} busy={busy}
          onPublish={onPublishDrive} onUnpublish={onUnpublishDrive} uploadsOff={prefs.drive?.autoUpload === false || project.driveUpload === false} />}

        {/* Share pages kept in your own Supabase: offered when that is already set up, or when there is no other way to share. */}
        {(shareStatus?.ready || (!cloudStatus?.enabled && !driveOn)) && <SharePage project={project} set={set} status={shareStatus} state={shareState}
          onPublish={onPublishShare} onUnpublish={onUnpublishShare} onOpenSettings={onOpenSettings} busy={busy} />}

        {hookStatus?.configured && (
          <div className="group">
            <span className="label">Webhook</span>
            <Toggle label="Tell your webhook about this video"
              checked={project.webhookSend !== false && hookStatus.auto !== false}
              onChange={v => set({ webhookSend: v })} />
            {hookStatus.auto === false && <p className="panel-sub muted">The webhook is switched off in Settings.</p>}
          </div>
        )}

        <button className="btn primary" disabled={busy} onClick={() => onExport({
          fps: project.exportFps || 60,
          quality: project.exportQuality || 'high'
        })}>{busy ? 'Exporting…' : 'Export MP4'}</button>

        {exportState && (
          <div className="col" style={{ gap: 8 }}>
            <div className="progress">
              <i style={{ width: `${Math.round(((exportState.phase === 'uploading'
                ? exportState.uploadProgress
                : exportState.progress) || 0) * 100)}%` }} />
            </div>
            <span className="val">
              {exportState.phase === 'error' ? `Failed: ${exportState.message}`
                : exportState.phase === 'uploaded' ? 'Exported and uploaded'
                : exportState.phase === 'done' ? 'Exported'
                : exportState.phase === 'uploading'
                  ? `uploading to Drive… ${Math.round((exportState.uploadProgress || 0) * 100)}%`
                  : `${exportState.phase}…`}
            </span>
            {exportState.note && <span className="val" style={{ color: 'var(--rec)' }}>{exportState.note}</span>}
            {(exportState.databases || []).map(d => (
              <div key={d.name} className="row between">
                <span className="val" style={{ color: d.ok ? 'var(--ok)' : 'var(--rec)' }}>
                  {d.ok ? `✓ Added to ${d.name}${d.stored ? ', with the video file' : ''}` : `${d.name}: ${d.detail}`}
                </span>
                {d.ok && d.url && <button className="btn sm ghost" style={{ padding: '2px 6px' }} onClick={() => window.knight.shell.openExternal(d.url)}>Open</button>}
              </div>
            ))}
            {exportState.writeUp && (
              <span className="val" style={{ color: exportState.writeUp.ok ? 'var(--ok)' : 'var(--rec)' }}>
                {exportState.writeUp.ok ? `✓ Summary and ${exportState.writeUp.chapters} chapter${exportState.writeUp.chapters === 1 ? '' : 's'} written` : `Write-up: ${exportState.writeUp.detail}`}
              </span>
            )}
            {exportState.share && (
              <span className="val" style={{ color: exportState.share.ok ? 'var(--ok)' : 'var(--rec)' }}>
                {exportState.share.ok ? `✓ Share page ready${exportState.share.reduced ? ' (a smaller copy was uploaded to fit your storage)' : ''}` : `Share page: ${exportState.share.detail}`}
              </span>
            )}
            {exportState.drivePage && (
              <span className="val" style={{ color: exportState.drivePage.ok ? 'var(--ok)' : 'var(--rec)' }}>
                {exportState.drivePage.ok ? '✓ Share page ready' : `Share page: ${exportState.drivePage.detail}`}
              </span>
            )}
            {exportState.cloud && (
              <span className="val" style={{ color: exportState.cloud.ok ? 'var(--ok)' : 'var(--rec)' }}>
                {exportState.cloud.ok ? `✓ Ready to share${exportState.cloud.reduced ? ' (as a smaller copy)' : ''}` : `Sharing: ${exportState.cloud.detail}`}
              </span>
            )}
            {exportState.webhook && (
              <span className="val" style={{ color: exportState.webhook.ok ? 'var(--ok)' : 'var(--rec)' }}>
                {exportState.webhook.ok ? '✓ Webhook told' : `Webhook: ${exportState.webhook.detail}`}
              </span>
            )}
            {exportState.uploadError && <span className="val" style={{ color: 'var(--rec)' }}>Drive: {exportState.uploadError}</span>}
            {['done', 'uploaded'].includes(exportState.phase) && (
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="btn sm" onClick={() => window.knight.shell.reveal(exportState.output)}>Show in Finder</button>
                <button className="btn sm" onClick={() => window.knight.shell.open(exportState.output)}>Play</button>
                {exportState.link && (
                  <button className="btn sm" onClick={async e => {
                    const b = e.currentTarget
                    await window.knight.shell.copy(exportState.link)
                    b.textContent = 'Copied ✓'
                    setTimeout(() => { if (b.isConnected) b.textContent = 'Copy Drive link' }, 1800)
                  }}>Copy Drive link</button>
                )}
              </div>
            )}
          </div>
        )}
      </>
    )
  }

  return null
}
