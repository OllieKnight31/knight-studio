import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { generateZooms, buildCursorPath, STYLES } from '../../shared/autozoom.js'
import { layoutRects, overlayAt, drawOverlaySelection } from '../compositor.js'
import { buildCaptions, findSilences, cutsForWords, findFillers, spokenLines, outputCues } from '../../shared/captions.js'
import {
  buildTimeline, segmentAt, cutRange, splitAt, setGain, findQuiet, mergeRanges, cameraOffset
} from '../../shared/timeline.js'
import Panels from './Panels.jsx'
import Timeline from './Timeline.jsx'
import { CANVAS_PRESETS } from '../presets.js'
import { exportProject, drawFrameTo } from '../exporter.js'
import { Icon } from '../ui.jsx'
import { fileURL } from '../theme.js'
import { requestTour, onTourTool } from '../tour.jsx'

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const newId = prefix => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

// The tool rail. `tip` is what the hover card says the tool is for.
export const TOOLS = [
  { id: 'setup', label: 'Setup', icon: 'setup', key: '1', tip: 'Name the video and choose its size and shape — widescreen, square or vertical.' },
  { id: 'cut', label: 'Cut', icon: 'cut', key: 'C', tip: 'Trim the ends, split it into sections, delete the parts you do not want and strip out dead space.' },
  { id: 'layout', label: 'Layout', icon: 'layout', key: 'Y', tip: 'How the screen and camera share the frame: camera bubble, side by side, shape, size and timing.' },
  { id: 'zoom', label: 'Zoom', icon: 'zoom', key: 'Z', tip: 'Zoom in on what you clicked — automatically, or by adding your own zooms.' },
  { id: 'style', label: 'Style', icon: 'style', key: 'B', tip: 'The background behind the recording, plus padding, rounded corners, shadow and border.' },
  { id: 'cursor', label: 'Cursor', icon: 'cursor', key: 'O', tip: 'The size and smoothness of the mouse pointer, and the click effect.' },
  { id: 'text', label: 'Text', icon: 'text', key: 'T', tip: 'Headlines and text on the video, and blur boxes to hide anything private.' },
  { id: 'audio', label: 'Audio', icon: 'audio', key: 'A', tip: 'Microphone and system sound levels, volume for one section, and background music.' },
  { id: 'subtitles', label: 'Captions', icon: 'subtitles', key: 'U', tip: 'Transcribe the video, show captions, and cut words straight from the transcript.' },
  { id: 'export', label: 'Export', icon: 'export', key: 'E', tip: 'Save the finished video as an MP4 and send it to Google Drive.' }
]

const TEXT_PRESETS = {
  headline: {
    text: 'Your headline', x: 0.1, y: 0.07, w: 0.8, h: 0.16, size: 88, weight: 800, align: 'center',
    color: '#FFFFFF', background: 'none', shadow: true, font: 'system'
  },
  text: {
    text: 'Your text here', x: 0.08, y: 0.78, w: 0.6, h: 0.12, size: 48, weight: 650, align: 'left',
    color: '#FFFFFF', background: 'rgba(0,0,0,0.55)', shadow: false, font: 'system'
  }
}

export default function Editor ({ projectId, prefs, savePrefs, onBack, onRecordAnother, onOpenSettings, onOpenShare }) {
  const [project, setProject] = useState(null)
  const [media, setMedia] = useState({})       // clipId -> { screen, camera, cursorPath, events, wave, … }
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [tool, setTool] = useState('setup')
  const [selectedSeg, setSelectedSeg] = useState(null)       // segment key
  const [selectedZoom, setSelectedZoom] = useState(null)     // zoom id
  const [selectedOverlay, setSelectedOverlay] = useState(null)
  const [exportState, setExportState] = useState(null)
  const [driveStatus, setDriveStatus] = useState(null)
  const [dbStatus, setDbStatus] = useState(null)
  const [shareStatus, setShareStatus] = useState(null)
  const [hookStatus, setHookStatus] = useState(null)
  const [aiState, setAiState] = useState(null)               // { busy } | { error } | { done }
  const [sopState, setSopState] = useState(null)             // { busy } | { error } | { html, pdf }
  const [shareState, setShareState] = useState(null)         // { busy, phase } | { error }
  const [cloudStatus, setCloudStatus] = useState(null)
  const [cloudState, setCloudState] = useState(null)         // { busy, phase } | { error }
  const [driveShareState, setDriveShareState] = useState(null) // { busy } | { error }
  const [retitling, setRetitling] = useState(false)
  const [transcribeState, setTranscribeState] = useState(null)
  const [status, setStatus] = useState(null)                 // short message over the stage
  const [, setHistoryRev] = useState(0)
  const [hover, setHover] = useState(null)                   // 'camera' | 'overlay' | null
  const [previewVolume, setPreviewVolume] = useState(1)
  const [previewMuted, setPreviewMuted] = useState(false)

  const projectRef = useRef(null)
  const historyRef = useRef({ undo: [], redo: [], lastAt: 0, lastGroup: null })
  const saveRef = useRef({ timer: null, pending: null })
  const exportingRef = useRef(false)      // pauses the preview loop while a render runs
  const stageDragRef = useRef(null)
  const canvasRef = useRef(null)
  const mediaHostRef = useRef(null)
  const rafRef = useRef(0)
  const timeRef = useRef(0)
  const playingRef = useRef(false)
  const lastTickRef = useRef(0)
  const audioRef = useRef(null)        // { ctx, nodes: Map<clipId, {src, gain}> }
  const volumeRef = useRef(1)
  const prefsRef = useRef(prefs)
  const selectedOverlayRef = useRef(null)

  useEffect(() => { timeRef.current = time }, [time])
  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => { volumeRef.current = previewMuted ? 0 : previewVolume }, [previewVolume, previewMuted])
  useEffect(() => { prefsRef.current = prefs }, [prefs])
  useEffect(() => { selectedOverlayRef.current = selectedOverlay }, [selectedOverlay])
  useEffect(() => { window.knight.drive.status().then(setDriveStatus).catch(() => setDriveStatus(null)) }, [prefs.drive])
  // Re-read whenever Settings may have changed a connection.
  useEffect(() => { window.knight.databases.status().then(setDbStatus).catch(() => setDbStatus(null)) }, [prefs, tool])
  useEffect(() => { window.knight.share.status().then(setShareStatus).catch(() => setShareStatus(null)) }, [prefs, tool])
  useEffect(() => { window.knight.webhook.status().then(setHookStatus).catch(() => setHookStatus(null)) }, [prefs, tool])
  useEffect(() => { window.knight.cloud.status().then(setCloudStatus).catch(() => setCloudStatus(null)) }, [prefs, tool])

  /* ------------------------------------------------------------ walkthroughs */

  // A walkthrough can open a tool itself, so "Next" always lands on something visible.
  useEffect(() => onTourTool(id => setTool(id)), [])

  // Each tool introduces itself the first time it is opened — but not the one the
  // editor happens to open on, which the editor's own walkthrough already covers.
  const firstToolRef = useRef(true)
  useEffect(() => {
    if (firstToolRef.current) { firstToolRef.current = false; return }
    requestTour(`editor:${tool}`)
  }, [tool])

  /* ------------------------------------------------------- saving + history */

  const flushSave = useCallback(() => {
    const s = saveRef.current
    clearTimeout(s.timer)
    s.timer = null
    const p = s.pending
    s.pending = null
    return p ? window.knight.projects.save(p) : Promise.resolve()
  }, [])

  const scheduleSave = useCallback(next => {
    const s = saveRef.current
    s.pending = next
    clearTimeout(s.timer)
    s.timer = setTimeout(flushSave, 250)
  }, [flushSave])

  useEffect(() => () => { flushSave() }, [flushSave])

  /**
   * The one way the project changes. Records the previous state for undo, shows the
   * new one, and saves it shortly after.
   *
   *   group   — changes sharing a group collapse into one undo step (a whole drag)
   *   soft    — names the control being moved; changes with the same name arriving
   *             within a moment of each other collapse, so dragging a slider is one
   *             undo step rather than sixty
   *   history — false for changes that are not the user's edit (auto-alignment)
   *
   * Anything else is its own undo step, however quickly it follows the last.
   */
  const commit = useCallback((updater, opts = {}) => {
    const prev = projectRef.current
    if (!prev) return
    const next = typeof updater === 'function' ? updater(prev) : updater
    if (!next || next === prev) return
    if (opts.history !== false) {
      const h = historyRef.current
      const now = Date.now()
      const tag = opts.group || (opts.soft ? `soft:${opts.soft}` : null)
      const same = !!tag && h.lastGroup === tag && (!!opts.group || now - h.lastAt < 700)
      if (!same) {
        h.undo.push(prev)
        if (h.undo.length > 100) h.undo.shift()
      }
      h.redo = []
      h.lastAt = now
      h.lastGroup = tag
      setHistoryRev(n => n + 1)
    }
    projectRef.current = next
    setProject(next)
    scheduleSave(next)
  }, [scheduleSave])

  /** Replaces the project with one the main process returned (it is already saved). */
  const adopt = useCallback(next => {
    projectRef.current = next
    setProject(next)
  }, [])

  const stepHistory = useCallback(dir => {
    const h = historyRef.current
    const from = dir < 0 ? h.undo : h.redo
    const to = dir < 0 ? h.redo : h.undo
    if (!from.length) return
    to.push(projectRef.current)
    const next = from.pop()
    h.lastAt = 0
    h.lastGroup = null
    projectRef.current = next
    setProject(next)
    scheduleSave(next)
    setHistoryRev(n => n + 1)
  }, [scheduleSave])
  const undo = useCallback(() => stepHistory(-1), [stepHistory])
  const redo = useCallback(() => stepHistory(1), [stepHistory])

  const updateClip = useCallback((clipId, fn, opts) => {
    commit(p => ({ ...p, clips: p.clips.map(c => (c.id === clipId ? (typeof fn === 'function' ? fn(c) : { ...c, ...fn }) : c)) }), opts)
  }, [commit])

  const say = useCallback((text, ms = 4000) => {
    setStatus(text)
    if (text && ms) setTimeout(() => setStatus(s => (s === text ? null : s)), ms)
  }, [])

  /* ------------------------------------------------------------- derived */

  const timeline = useMemo(() => buildTimeline(project?.clips || []), [project?.clips])
  const timelineRef = useRef(timeline)
  useEffect(() => { timelineRef.current = timeline }, [timeline])

  const oneWord = project?.subtitles?.oneWordAtATime
  useEffect(() => {
    setMedia(prev => {
      let changed = false
      const next = {}
      for (const [id, m] of Object.entries(prev)) {
        if (!m.transcript) { next[id] = m; continue }
        changed = true
        next[id] = { ...m, captions: buildCaptions(m.transcript.words, { oneWordAtATime: oneWord }) }
      }
      return changed ? next : prev
    })
  }, [oneWord])

  const canvasSize = useMemo(() => {
    const preset = CANVAS_PRESETS[project?.canvas?.preset || 'auto']
    if (preset && preset.w) return { width: preset.w, height: preset.h }
    const first = project?.clips?.[0]
    if (first?.width) {
      const scale = 1920 / first.width
      return { width: 1920, height: Math.round(first.height * scale / 2) * 2 }
    }
    return { width: 1920, height: 1080 }
  }, [project?.canvas?.preset, project?.clips])
  const canvasSizeRef = useRef(canvasSize)
  useEffect(() => { canvasSizeRef.current = canvasSize }, [canvasSize])

  /** Puts a saved look on this video. One undo step. */
  const applyTemplate = useCallback(async id => {
    const look = await window.knight.templates.get(id)
    if (!look) return false
    commit(p => {
      const next = { ...p }
      for (const k of Object.keys(look)) next[k] = { ...(p[k] || {}), ...look[k] }
      return next
    })
    say('Template applied. Undo with ⌘Z.')
    return true
  }, [commit, say])

  // The section under the playhead is the one the panels act on unless another is selected.
  const activeSeg = timeline.segs.find(s => s.key === selectedSeg) || segmentAt(timeline, time)
  const clip = activeSeg?.clip || project?.clips?.[0] || null

  /* ----------------------------------------------------------- load project */

  // Chromium deprioritises decoding for <video> elements outside the document, so the
  // preview would sit on a frozen first frame. Parking them in an offscreen host (not
  // display:none, which stops decoding outright) keeps frames flowing.
  useEffect(() => {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none'
    document.body.appendChild(host)
    mediaHostRef.current = host
    return () => { host.remove(); mediaHostRef.current = null }
  }, [])

  useEffect(() => {
    let alive = true
    window.knight.projects.load(projectId).then(async p => {
      if (!alive) return
      const store = {}
      for (const c of p.clips) {
        const events = await window.knight.projects.events(c.dir)
        const screen = document.createElement('video')
        screen.crossOrigin = 'anonymous'
        screen.src = fileURL(c.dir + '/screen.mov')
        screen.preload = 'auto'
        // Not muted: this is the element you actually hear while editing. Its
        // level is set by the gain stage below, not by the element.
        screen.muted = false
        screen.volume = 1
        screen.addEventListener('error', () => {
          console.error('screen video failed to load', screen.src, screen.error && screen.error.code, screen.error && screen.error.message)
        })
        screen.playsInline = true
        mediaHostRef.current?.appendChild(screen)
        let camera = null
        if (c.hasCamera) {
          camera = document.createElement('video')
          camera.crossOrigin = 'anonymous'
          camera.src = fileURL(c.dir + '/camera.mov')
          camera.preload = 'auto'
          camera.muted = true
          camera.playsInline = true
          mediaHostRef.current?.appendChild(camera)
        }
        const transcript = await window.knight.transcribe.read(c.dir)
        // Laptop microphones record quietly, so preview playback gets the same
        // lift the export applies — otherwise the editor sounds broken.
        const loudness = await window.knight.exportVideo.loudness(c.dir).catch(() => null)
        store[c.id] = {
          events,
          screen,
          camera,
          transcript,
          loudness,
          wave: null,
          captions: transcript ? buildCaptions(transcript.words, {
            oneWordAtATime: p.subtitles?.oneWordAtATime
          }) : [],
          cursorPath: buildCursorPath(events, { smoothing: p.cursor?.smoothing ?? 0.55 })
        }
        // Apply auto-zoom to fresh clips, the way the recorder preference implies.
        if (!c.autoZoomApplied && p.autoZoom?.applyOnRecord && c.width) {
          c.zooms = generateZooms(events, {
            style: p.autoZoom.style,
            duration: c.duration,
            frame: { width: c.width, height: c.height }
          })
          c.autoZoomApplied = true
        }
      }
      if (!alive) return
      for (const m of Object.values(store)) {
        for (const el of [m.screen, m.camera]) {
          if (!el) continue
          const nudge = () => { try { el.currentTime = 0.04 } catch {} }
          if (el.readyState >= 1) nudge()
          else el.addEventListener('loadedmetadata', nudge, { once: true })
          el.load()
        }
      }
      setMedia(store)
      projectRef.current = p
      setProject(p)
      window.knight.projects.save(p)

      // Waveforms arrive after the editor is usable; the timeline fills them in.
      for (const c of p.clips) {
        window.knight.projects.waveform(c.dir).then(wave => {
          if (alive && wave) setMedia(prev => (prev[c.id] ? { ...prev, [c.id]: { ...prev[c.id], wave } } : prev))
        }).catch(() => {})
      }

      // Older takes only: find where the camera really sits against the voice.
      for (const c of p.clips) {
        if (!c.hasCamera || c.cameraSync !== 'estimated') continue
        say('Lining the camera up with your voice…', 0)
        const res = await window.knight.projects.measureCamera(c.dir).catch(() => null)
        if (!alive) return
        const sure = res && res.confidence >= 3.5
        commit(cur => ({
          ...cur,
          clips: cur.clips.map(x => (x.id !== c.id ? x : {
            ...x,
            cameraStartOffset: sure ? res.offset : (res ? res.floor + 0.25 : x.cameraStartOffset),
            cameraSync: sure ? 'aligned' : 'approximate'
          }))
        }), { history: false })
        say(sure ? 'Camera lined up with your voice.' : 'Camera lined up approximately — fine-tune it under Layout if needed.')
      }
    })
    return () => { alive = false }
  }, [projectId])

  /* --------------------------------------------------------------- titles */

  const retitle = useCallback(async () => {
    setRetitling(true)
    try {
      await flushSave()
      const next = await window.knight.projects.retitle(projectId, clip?.id)
      if (next) adopt(next)
    } catch { /* leave the name as it was */ } finally { setRetitling(false) }
  }, [projectId, clip, flushSave, adopt])

  /* --------------------------------------------------- transcript operations */

  const runTranscribe = useCallback(async target => {
    if (!target) return
    setTranscribeState({ clipId: target.id, pct: 0 })
    const stop = window.knight.transcribe.onProgress(({ clipDir, pct }) => {
      if (clipDir === target.dir) setTranscribeState({ clipId: target.id, pct })
    })
    try {
      const transcript = await window.knight.transcribe.run({ clipDir: target.dir, force: true })
      setMedia(prev => ({
        ...prev,
        [target.id]: {
          ...prev[target.id],
          transcript,
          captions: buildCaptions(transcript.words, { oneWordAtATime: projectRef.current?.subtitles?.oneWordAtATime })
        }
      }))
      setTranscribeState({ clipId: target.id, pct: 1, words: transcript.words?.length ?? 0 })
    } catch (e) {
      setTranscribeState({ clipId: target.id, error: e.message })
    } finally {
      stop()
    }
  }, [])

  /** Merges new cut ranges into a clip. */
  const addCuts = useCallback((clipId, ranges) => {
    if (!ranges?.length) return
    updateClip(clipId, c => ({ ...c, cuts: mergeRanges([...(c.cuts || []), ...ranges]) }))
  }, [updateClip])

  const removeSilences = useCallback(target => {
    const words = media[target?.id]?.transcript?.words
    if (!words?.length) return
    addCuts(target.id, findSilences(words, { duration: target.duration }))
  }, [media, addCuts])

  const removeWords = useCallback((target, words) => addCuts(target.id, cutsForWords(words)), [addCuts])

  /** Cuts every "um", "uh" and "erm" out of every clip that has been transcribed. */
  const removeFillers = useCallback(() => {
    const p = projectRef.current
    let count = 0
    let seconds = 0
    let transcribed = 0
    const clips = p.clips.map(c => {
      const words = media[c.id]?.transcript?.words
      if (!words?.length) return c
      transcribed++
      const fillers = findFillers(words, c.cuts || [])
      if (!fillers.length) return c
      const before = buildTimeline([c]).duration
      const next = { ...c, cuts: mergeRanges([...(c.cuts || []), ...cutsForWords(fillers, { pad: 0.03 })]) }
      const after = buildTimeline([next]).duration
      if (after < 0.5) return c            // never cut a clip down to nothing
      count += fillers.length
      seconds += before - after
      return next
    })
    if (!transcribed) { say('Transcribe the clip first — filler words are found in the transcript.'); return 0 }
    if (!count) { say('No filler words found. If you can hear some, press Re-transcribe and try again.'); return 0 }
    commit({ ...p, clips })
    setSelectedSeg(null)
    say(`Removed ${count} filler word${count === 1 ? '' : 's'} (${seconds.toFixed(1)}s). Undo with ⌘Z.`, 6000)
    return count
  }, [media, commit, say])

  const saveSRT = useCallback(async () => {
    // Times are stamped on the OUTPUT timeline, so the file matches the exported video.
    const lines = []
    let n = 1
    const stamp = t => {
      const h = Math.floor(t / 3600)
      const m = Math.floor((t % 3600) / 60)
      const sec = Math.floor(t % 60)
      const ms = Math.round((t % 1) * 1000)
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`
    }
    for (const seg of timeline.segs) {
      for (const cap of media[seg.clip.id]?.captions || []) {
        const start = Math.max(cap.start, seg.localIn)
        const end = Math.min(cap.end, seg.localOut)
        if (end <= start) continue
        const gs = seg.start + (start - seg.localIn)
        const ge = seg.start + (end - seg.localIn)
        lines.push(`${n++}\n${stamp(gs)} --> ${stamp(ge)}\n${cap.text}\n`)
      }
    }
    if (!lines.length) return null
    return window.knight.files.saveText({
      defaultName: `${project.name.replace(/[^\w-]+/g, '-')}.srt`,
      text: lines.join('\n')
    })
  }, [timeline, media, project])

  /* ----------------------------------------------------------- timeline edits */

  const seek = useCallback(t => {
    const clamped = clamp(t, 0, timelineRef.current.duration)
    timeRef.current = clamped
    setTime(clamped)
  }, [])

  const split = useCallback(() => {
    const seg = segmentAt(timelineRef.current, timeRef.current)
    if (!seg) return
    const local = seg.localIn + (timeRef.current - seg.start)
    if (local - seg.localIn < 0.1 || seg.localOut - local < 0.1) {
      say('Move the playhead to where you want the split — it is at the very edge of a section.')
      return
    }
    updateClip(seg.clip.id, c => splitAt(c, local))
    // Select the part after the split, ready to delete or adjust.
    setSelectedSeg(`${seg.clip.id}@${(Math.round(local * 1000) / 1000).toFixed(3)}`)
  }, [updateClip, say])

  const deleteSection = useCallback(() => {
    const tl = timelineRef.current
    const seg = tl.segs.find(s => s.key === selectedSeg)
    if (!seg) return
    if (tl.segs.length < 2) { say('This is the only section left — split the video first, then delete the part you do not want.'); return }
    updateClip(seg.clip.id, c => cutRange(c, seg.localIn, seg.localOut))
    setSelectedSeg(null)
    seek(Math.min(seg.start, tl.duration - seg.duration))
  }, [selectedSeg, updateClip, seek, say])

  /** Cuts the quiet stretches out of every clip, using each clip's waveform. */
  const removeQuiet = useCallback(() => {
    const p = projectRef.current
    const opts = { thresholdDb: -30, minSeconds: 0.7, pad: 0.15, ...(p.deadSpace || {}) }
    let count = 0
    let seconds = 0
    let waiting = false
    const clips = p.clips.map(c => {
      const wave = media[c.id]?.wave
      if (!wave) { waiting = true; return c }
      const before = buildTimeline([c]).duration
      const next = { ...c, cuts: mergeRanges([...(c.cuts || []), ...findQuiet(wave, opts)]) }
      const after = buildTimeline([next]).duration
      if (after < 0.5) return c            // never cut a clip down to nothing
      if (before - after > 0.01) { count += next.cuts.length - (c.cuts || []).length; seconds += before - after }
      return next
    })
    if (waiting && !count) { say('Still reading the audio — try again in a moment.'); return }
    if (!count) { say('No dead space found at this setting. Lower the pause length or raise the sensitivity under Cut.'); return }
    commit({ ...p, clips })
    setSelectedSeg(null)
    say(`Removed ${seconds.toFixed(1)}s of dead space. Undo with ⌘Z, or click any scissors marker to put one back.`, 6000)
  }, [media, commit, say])

  const setSectionGain = useCallback((seg, gain) => {
    if (!seg) return
    updateClip(seg.clip.id, c => setGain(c, seg.localIn, seg.localOut, gain), { soft: `gain:${seg.key}` })
  }, [updateClip])

  /* ------------------------------------------------------------- overlay CRUD */

  const addOverlay = useCallback(kind => {
    const at = timeRef.current
    const end = Math.max(at + 0.5, Math.min(at + 4, timelineRef.current.duration))
    const overlay = kind === 'blur'
      ? { id: newId('ov'), type: 'blur', start: at, end, x: 0.35, y: 0.4, w: 0.3, h: 0.12, amount: 16, radius: 8, fade: 0.15, opacity: 1 }
      : { id: newId('ov'), type: 'text', kind, start: at, end, fade: 0.3, opacity: 1, uppercase: false, ...TEXT_PRESETS[kind === 'headline' ? 'headline' : 'text'] }
    commit(p => ({ ...p, overlays: [...(p.overlays || []), overlay] }))
    setSelectedOverlay(overlay.id)
    setSelectedSeg(null)
    setTool('text')
  }, [commit])

  const updateOverlay = useCallback((id, patch, opts) => {
    commit(p => ({ ...p, overlays: (p.overlays || []).map(o => (o.id === id ? { ...o, ...patch } : o)) }), opts)
  }, [commit])

  const removeOverlay = useCallback(id => {
    commit(p => ({ ...p, overlays: (p.overlays || []).filter(o => o.id !== id) }))
    setSelectedOverlay(null)
  }, [commit])

  /* ------------------------------------------------------------------- clips */

  const deleteClip = useCallback(async clipId => {
    await flushSave()
    adopt(await window.knight.projects.deleteClip(projectId, clipId))
    historyRef.current = { undo: [], redo: [], lastAt: 0, lastGroup: null }   // the files are gone; nothing to undo to
    setSelectedSeg(null)
  }, [projectId, flushSave, adopt])

  const moveClip = useCallback(async (from, to) => {
    await flushSave()
    adopt(await window.knight.projects.reorderClips(projectId, from, to))
  }, [projectId, flushSave, adopt])

  /* ------------------------------------------------------------- zoom editing */

  const updateZoom = useCallback((clipId, zoomId, patch) => {
    updateClip(clipId, c => ({ ...c, zooms: (c.zooms || []).map(z => (z.id === zoomId ? { ...z, ...patch } : z)) }),
      { soft: `zoom:${zoomId}:${Object.keys(patch)}` })
  }, [updateClip])

  const removeZoom = useCallback((clipId, zoomId) => {
    updateClip(clipId, c => ({ ...c, zooms: (c.zooms || []).filter(z => z.id !== zoomId) }))
    setSelectedZoom(null)
  }, [updateClip])

  const addZoomAt = useCallback((target, localStart) => {
    if (!target) return
    const existing = target.zooms || []
    // Fill up to five seconds, stopping at the next zoom or the end of the clip.
    let end = Math.min(target.duration, localStart + 5)
    for (const z of existing) if (z.start > localStart) end = Math.min(end, z.start)
    if (end - localStart < 1) { say('There is no room for a zoom here — move the playhead to a gap between zooms.'); return }
    const style = STYLES[projectRef.current.autoZoom?.style || 'adaptive']
    const zoom = {
      id: newId('z'),
      start: localStart, end, mode: 'auto',
      target: { x: (target.width || 1920) / 2, y: (target.height || 1080) / 2 },
      scale: style.scale,
      ramp: style.ramp
    }
    updateClip(target.id, c => ({ ...c, zooms: [...(c.zooms || []), zoom].sort((a, b) => a.start - b.start) }))
    setSelectedZoom(zoom.id)
  }, [updateClip, say])

  /* -------------------------------------------------------------- rendering */

  const drawFrame = useCallback(t => {
    const canvas = canvasRef.current
    const p = projectRef.current
    if (!canvas || !p) return
    const ctx = canvas.getContext('2d')
    const seg = segmentAt(timeline, t)
    if (!seg) return
    const m = media[seg.clip.id]
    if (!m) return
    const local = seg.localIn + (t - seg.start)
    drawFrameTo(ctx, {
      project: p,
      clip: seg.clip,
      m: {
        ...m,
        screen: m.screen.readyState >= 2 ? m.screen : null,
        camera: m.camera && m.camera.readyState >= 2 ? m.camera : null
      },
      canvasSize: { width: canvas.width, height: canvas.height },
      local,
      t,
      // The text being edited stays fully visible instead of fading at its ends.
      editing: playingRef.current ? null : selectedOverlayRef.current
    })
    // Editing aid, never part of the export: show which text box is selected.
    const sel = selectedOverlayRef.current && (p.overlays || []).find(o => o.id === selectedOverlayRef.current)
    if (sel && t >= sel.start && t <= sel.end) {
      drawOverlaySelection(ctx, canvas, sel, getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
    }
  }, [media, timeline])

  /* ------------------------------------------------------- preview audio */

  // Each clip's screen element is routed through its own gain node. The gain is
  // the measured lift for that recording, so a quiet clip and a loud one both
  // come out at a sensible level — and it matches what the export produces.
  // A WebAudio graph is the only way to get gain above 1.0; element.volume caps
  // at unity, which is far too quiet for a built-in microphone.
  useEffect(() => {
    if (!media || !Object.keys(media).length) return
    let ctx = audioRef.current?.ctx
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return
      ctx = new AC()
      audioRef.current = { ctx, nodes: new Map() }
    }
    const { nodes } = audioRef.current
    for (const [id, m] of Object.entries(media)) {
      if (!m.screen || nodes.has(id)) continue
      try {
        const src = ctx.createMediaElementSource(m.screen)
        const gain = ctx.createGain()
        gain.gain.value = 0            // the tick loop opens the active clip
        src.connect(gain).connect(ctx.destination)
        nodes.set(id, { src, gain, boost: m.loudness?.gain ?? 1 })
      } catch {
        // Already routed (React strict-mode double mount) — nothing to do.
      }
    }
  }, [media])

  // Browsers start an AudioContext suspended until a gesture; pressing play is one.
  useEffect(() => {
    const ctx = audioRef.current?.ctx
    if (playing && ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
  }, [playing])

  useEffect(() => () => { audioRef.current?.ctx?.close?.().catch?.(() => {}) }, [])

  // One rAF loop drives playback, media sync and painting.
  //
  // While playing, the screen recording is the clock. It carries the sound, so the
  // playhead is read off it rather than counted up separately — a separately counted
  // playhead drifts against the audio, and the camera then drifts against both. The
  // camera is slaved to that same clock: nudged faster or slower by a few percent to
  // hold its place, and only hard-seeked when it is badly out.
  useEffect(() => {
    if (!project) return
    const tick = now => {
      rafRef.current = requestAnimationFrame(tick)
      const dt = lastTickRef.current ? (now - lastTickRef.current) / 1000 : 0
      lastTickRef.current = now
      const tl = timeline

      let t = timeRef.current
      let seg = segmentAt(tl, t)

      if (playingRef.current && seg) {
        const el = media[seg.clip.id]?.screen
        const expected = seg.localIn + (t - seg.start)
        if (!el) {
          t += dt
        } else if (el.readyState >= 2 && !el.seeking && !el.paused) {
          const local = el.currentTime
          // Close to where the playhead says it should be: trust the recording's clock.
          if (Math.abs(local - (expected + dt)) < 0.25) t = Math.max(seg.start, seg.start + (local - seg.localIn))
        }
        // Reached the end of this section: carry on into the next one, skipping
        // whatever was cut out in between.
        if (t >= seg.end - 0.004) {
          const next = tl.segs[tl.segs.indexOf(seg) + 1]
          if (!next) {
            t = tl.duration
            setPlaying(false)
            playingRef.current = false
          } else {
            t = next.start
            const jump = next.clip !== seg.clip || Math.abs(next.localIn - seg.localOut) > 0.005
            if (jump && next.clip === seg.clip && el && !el.seeking) el.currentTime = next.localIn
            seg = next
          }
        }
        t = clamp(t, 0, tl.duration)
        if (t !== timeRef.current) { timeRef.current = t; setTime(t) }
        seg = segmentAt(tl, t)
      }

      if (seg) {
        const local = seg.localIn + (t - seg.start)
        const running = playingRef.current
        const ctx = audioRef.current?.ctx
        // What you hear lags the recording's clock by the audio output delay, so the
        // camera is shown that much later too — it is the lips that have to match.
        const heard = running && ctx ? Math.min(0.3, (ctx.baseLatency || 0) + (ctx.outputLatency || 0)) : 0

        for (const [id, mm] of Object.entries(media)) {
          const active = id === seg.clip.id
          // Only the clip under the playhead is audible, and only while running —
          // scrubbing a paused timeline should stay silent.
          const node = audioRef.current?.nodes.get(id)
          if (node) {
            const level = (projectRef.current?.audio?.micGain ?? 1) * seg.gain
            const want = active && running ? node.boost * volumeRef.current * level : 0
            if (Math.abs(node.gain.gain.value - want) > 1e-3) {
              // A short ramp instead of a step, so switching clips doesn't click.
              node.gain.gain.setTargetAtTime(want, ctx.currentTime, 0.01)
            }
          }

          const scr = mm.screen
          if (scr) {
            if (!active) { if (!scr.paused) scr.pause() } else {
              const drift = Math.abs(scr.currentTime - local)
              if (drift > (running ? 0.25 : 1 / 120) && scr.readyState >= 1 && !scr.seeking) scr.currentTime = local
              if (running && scr.paused) scr.play().catch(() => {})
              if (!running && !scr.paused) scr.pause()
            }
          }

          const cam = mm.camera
          if (cam) {
            if (!active) { if (!cam.paused) cam.pause(); continue }
            const target = local - cameraOffset(seg.clip, prefsRef.current) - heard
            if (!running || target <= 0) {
              // Paused, or before the camera's first frame: hold the exact frame.
              if (!cam.paused) cam.pause()
              cam.playbackRate = 1
              const want = Math.max(0, target)
              if (Math.abs(cam.currentTime - want) > 1 / 120 && cam.readyState >= 1 && !cam.seeking) cam.currentTime = want
            } else {
              const off = cam.currentTime - target
              if (Math.abs(off) > 0.3) {
                if (cam.readyState >= 1 && !cam.seeking) cam.currentTime = target
                cam.playbackRate = 1
              } else {
                cam.playbackRate = Math.abs(off) < 0.012 ? 1 : clamp(1 - off * 1.5, 0.9, 1.1)
              }
              if (cam.paused) cam.play().catch(() => {})
            }
          }
        }
      }
      // The export composites on the main thread; painting the preview alongside
      // it would only slow the render down.
      if (!exportingRef.current) drawFrame(t)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(rafRef.current); lastTickRef.current = 0 }
  }, [!!project, media, timeline, drawFrame])

  /* -------------------------------------------------------------- shortcuts */

  useEffect(() => {
    const onKey = e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return
      if (document.querySelector('.modal-back')) return
      const k = e.key.toLowerCase()
      if (e.metaKey || e.ctrlKey) {
        if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() }
        return
      }
      if (e.code === 'Space') { e.preventDefault(); setPlaying(p => !p); return }
      if (k === 's') { split(); return }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (selectedOverlay) removeOverlay(selectedOverlay)
        else if (selectedZoom && clip) removeZoom(clip.id, selectedZoom)
        else if (selectedSeg) deleteSection()
        return
      }
      const found = TOOLS.find(x => x.key.toLowerCase() === k)
      if (found) { setTool(found.id); return }
      if (e.key === 'ArrowLeft') seek(timeRef.current - (e.shiftKey ? 1 : 1 / 30))
      if (e.key === 'ArrowRight') seek(timeRef.current + (e.shiftKey ? 1 : 1 / 30))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, split, deleteSection, removeOverlay, removeZoom, seek, selectedOverlay, selectedZoom, selectedSeg, clip])

  /* ------------------------------------------- chapters, summary, written SOP */

  const clean = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

  /** Reads the transcript of the finished video and writes its summary, chapters and steps. */
  const writeUp = useCallback(async () => {
    const lines = spokenLines(timelineRef.current, media)
    if (!lines.length) {
      const e = 'Transcribe the video under Captions first — the write-up is made from what was said.'
      setAiState({ error: e })
      return { ok: false, detail: e }
    }
    setAiState({ busy: true })
    try {
      const result = await window.knight.ai.analyse({ title: projectRef.current.name, lines, duration: timelineRef.current.duration })
      commit(cur => ({ ...cur, ai: result }), { history: false })
      setAiState({ done: true })
      return { ok: true, ...result }
    } catch (e) {
      setAiState({ error: clean(e) })
      return { ok: false, detail: clean(e) }
    }
  }, [media, commit])

  /** Builds the written SOP (HTML + PDF) with a screenshot per step from the exported video. */
  const buildSop = useCallback(async videoPath => {
    setSopState({ busy: true })
    try {
      if (!projectRef.current.ai?.steps?.length) {
        const w = await writeUp()
        if (!w.ok) { setSopState({ error: w.detail }); return null }
      }
      await flushSave()
      const out = await window.knight.ai.buildSop({ projectId, videoPath: videoPath || projectRef.current.lastExport?.path || null, duration: timelineRef.current.duration })
      setSopState(out)
      return out
    } catch (e) {
      setSopState({ error: clean(e) })
      return null
    }
  }, [projectId, flushSave, writeUp])

  /* ------------------------------------------------------------- share pages */

  const publishShare = useCallback(async filePath => {
    const file = filePath || projectRef.current.lastExport?.path
    if (!file) { setShareState({ error: 'Export the video first — the share page plays the exported file.' }); return null }
    setShareState({ busy: true, phase: 'uploading', fraction: 0 })
    const stop = window.knight.share.onProgress(({ projectId: id, phase, fraction }) => {
      if (id === projectId) setShareState({ busy: true, phase, fraction })
    })
    try {
      await flushSave()
      const size = canvasSizeRef.current
      const res = await window.knight.share.publish({
        projectId, filePath: file, duration: timelineRef.current.duration,
        aspect: size?.width && size?.height ? size.width / size.height : null,
        cues: outputCues(timelineRef.current, media)
      })
      commit(cur => ({ ...cur, share: { ...res } }), { history: false })
      setShareState(null)
      return res
    } catch (e) {
      setShareState({ error: clean(e) })
      return { error: clean(e) }
    } finally {
      stop()
    }
  }, [projectId, media, flushSave, commit])

  /* ----------------------------------------------- share pages in Google Drive */

  // Google finishes preparing an upload a little after the page is made; main says when.
  useEffect(() => window.knight.driveShare.onChange(({ projectId: id, page }) => {
    if (id === projectId) commit(cur => (cur.driveShare ? { ...cur, driveShare: page } : cur), { history: false })
  }), [projectId, commit])

  /** Makes or refreshes this video's share page using nothing but Google Drive. */
  const publishDrive = useCallback(async filePath => {
    setDriveShareState({ busy: true })
    const stop = window.knight.share.onProgress(({ projectId: id, phase }) => { if (id === projectId) setDriveShareState({ busy: true, phase }) })
    try {
      await flushSave()
      const size = canvasSizeRef.current
      const res = await window.knight.driveShare.publish({
        projectId, filePath: filePath || null, duration: timelineRef.current.duration,
        aspect: size?.width && size?.height ? size.width / size.height : null,
        cues: outputCues(timelineRef.current, media)
      })
      const { drive: d, ...page } = res
      commit(cur => ({ ...cur, driveShare: page, ...(d ? { drive: d } : {}) }), { history: false })
      setDriveShareState(null)
      return page
    } catch (e) {
      setDriveShareState({ error: clean(e) })
      return { error: clean(e) }
    } finally {
      stop()
    }
  }, [projectId, media, flushSave, commit])

  const unpublishDrive = useCallback(async () => {
    await flushSave()
    try { await window.knight.driveShare.unpublish(projectId) } catch (e) { setDriveShareState({ error: clean(e) }); return }
    commit(cur => { const { driveShare: _gone, ...rest } = cur; return rest }, { history: false })
    setDriveShareState(null)
  }, [projectId, flushSave, commit])

  /* ---------------------------------------------------- sharing with people */

  /** Uploads the exported video to the sharing service (or replaces it). The link never changes. */
  const publishCloud = useCallback(async filePath => {
    const file = filePath || projectRef.current.lastExport?.path
    if (!file) { setCloudState({ error: 'Export the video first — sharing sends the exported file.' }); return null }
    setCloudState({ busy: true, phase: 'uploading' })
    const stop = window.knight.share.onProgress(({ projectId: id, phase }) => { if (id === projectId) setCloudState({ busy: true, phase }) })
    try {
      await flushSave()
      const size = canvasSizeRef.current
      const res = await window.knight.cloud.publish({
        projectId, filePath: file, duration: timelineRef.current.duration,
        aspect: size?.width && size?.height ? size.width / size.height : null,
        cues: outputCues(timelineRef.current, media)
      })
      commit(cur => ({ ...cur, cloud: { ...res } }), { history: false })
      setCloudState(null)
      return res
    } catch (e) {
      setCloudState({ error: clean(e) })
      return { error: clean(e) }
    } finally {
      stop()
    }
  }, [projectId, media, flushSave, commit])

  /** Opens the Share box, uploading the last export first if this video is not on the service yet. */
  const openShare = useCallback(async () => {
    let id = projectRef.current.cloud?.id
    if (!id) { const res = await publishCloud(); id = res?.id }
    if (id) onOpenShare(id)
  }, [publishCloud, onOpenShare])

  const removeCloud = useCallback(async () => {
    const id = projectRef.current.cloud?.id
    if (!id) return
    try { await window.knight.cloud.remove(id) } catch (e) { setCloudState({ error: clean(e) }); return }
    commit(cur => { const { cloud: _gone, ...rest } = cur; return rest }, { history: false })
    setCloudState(null)
  }, [commit])

  const unpublishShare = useCallback(async () => {
    const info = projectRef.current.share
    if (!info) return
    try { await window.knight.share.unpublish(info) } catch {}
    commit(cur => { const { share: _gone, ...rest } = cur; return rest }, { history: false })
    setShareState(null)
  }, [commit])

  /* ----------------------------------------------------------------- export */

  const driveOn = !!(driveStatus?.configured && driveStatus.parent)

  const runExport = async opts => {
    setExportState({ phase: 'starting', progress: 0 })
    exportingRef.current = true
    setPlaying(false)
    try {
      await flushSave()
      const p = projectRef.current
      const target = await window.knight.exportVideo.chooseTarget(`${p.name.replace(/[^\w-]+/g, '-')}.mp4`)
      if (!target) { setExportState(null); return }
      const result = await exportProject({
        project: p, media, timeline, canvasSize, output: target, prefs: prefsRef.current, ...opts,
        onProgress: (phase, progress) => setExportState({ phase, progress })
      })
      const note = result?.musicSkipped ? 'The background music file could not be read, so it was left out.' : null
      setExportState({ phase: 'done', progress: 1, output: target, note })
      // Remembered so a share page or a written SOP can be made later without exporting again.
      // The shape and captions are kept too, so the library's Share button can publish it without opening the editor.
      commit(cur => ({ ...cur, lastExport: { path: target, at: new Date().toISOString(), duration: timeline.duration, aspect: canvasSizeRef.current.width / canvasSizeRef.current.height, cues: outputCues(timelineRef.current, media) } }), { history: false })

      // Optional hand-off to Drive, into the folder that matches this video's
      // library folder inside the parent folder chosen in Settings.
      if (driveOn && prefsRef.current.drive?.autoUpload !== false && p.driveUpload !== false) {
        const stop = window.knight.drive.onProgress(({ fraction }) =>
          setExportState(st => ({ ...st, phase: 'uploading', uploadProgress: fraction })))
        try {
          const res = await window.knight.drive.upload({ filePath: target, name: target.split('/').pop(), projectId })
          commit(cur => ({ ...cur, drive: { fileId: res.id, link: res.webViewLink, folderId: res.folderId, uploadedAt: new Date().toISOString() } }), { history: false })
          setExportState({ phase: 'uploaded', progress: 1, output: target, link: res.webViewLink, note })
        } catch (e) {
          setExportState({ phase: 'done', progress: 1, output: target, note, uploadError: e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') })
        } finally {
          stop()
        }
      }

      // Everything after this point is a hand-off. None of it can undo the export, and
      // each step reports for itself, so one failing never hides the others.
      const settle = () => setExportState(st => ({ ...st, phase: st.link ? 'uploaded' : 'done' }))

      // The write-up comes first, because the share page, the databases and the webhook
      // all carry the summary and chapters.
      if (prefsRef.current.ai?.writeUpOnExport && p.writeUp !== false) {
        setExportState(st => ({ ...st, phase: 'writing the summary and chapters' }))
        const w = await writeUp()
        setExportState(st => ({ ...st, writeUp: w.ok ? { ok: true, chapters: w.chapters.length, steps: w.steps.length } : { ok: false, detail: w.detail } }))
        settle()
      }

      // A share page from Google Drive alone: the video is already there.
      if (driveOn && projectRef.current.drive?.fileId && p.drivePage !== false && prefsRef.current.drive?.sharePages !== false) {
        setExportState(st => ({ ...st, phase: 'making the share page' }))
        const res = await publishDrive(target)
        setExportState(st => ({ ...st, drivePage: res?.url ? { ok: true, url: res.url } : { ok: false, detail: res?.error || 'The share page could not be made.' } }))
        settle()
      }

      const sh = await window.knight.share.status().catch(() => null)
      if (sh?.ready && sh.auto !== false && p.sharePage !== false) {
        setExportState(st => ({ ...st, phase: 'making the share page' }))
        const res = await publishShare(target)
        setExportState(st => ({ ...st, share: res?.url ? { ok: true, url: res.url, embed: res.embed, reduced: res.reduced, counting: res.counting } : { ok: false, detail: res?.error || 'The share page could not be made.' } }))
        settle()
      }

      // Sharing with people: put the new export behind the video's existing link.
      const cl = await window.knight.cloud.status().catch(() => null)
      if (cl?.signedIn && cl.auto !== false && p.cloudShare !== false) {
        setExportState(st => ({ ...st, phase: 'getting it ready to share' }))
        const res = await publishCloud(target)
        setExportState(st => ({ ...st, cloud: res?.url ? { ok: true, url: res.url, reduced: res.reduced } : { ok: false, detail: res?.error || 'The video could not be uploaded.' } }))
        settle()
      }

      await flushSave()
      const said = spokenLines(timelineRef.current, media).map(l => l.text).join(' ')

      // Add the video to any connected database (Notion, Airtable, Supabase).
      const dbs = await window.knight.databases.status().catch(() => null)
      const wanted = dbs ? Object.keys(dbs).filter(k => dbs[k].configured && dbs[k].auto !== false) : []
      if (wanted.length && p.databaseSend !== false) {
        setExportState(st => ({ ...st, phase: 'adding to your databases' }))
        let results = []
        try {
          results = await window.knight.databases.send({
            projectId, filePath: target, link: projectRef.current?.drive?.link || '', durationSeconds: timeline.duration, transcript: said
          })
        } catch (e) {
          results = [{ name: 'Databases', ok: false, detail: clean(e) }]
        }
        setExportState(st => ({ ...st, databases: results }))
        settle()
      }

      // Last, tell the webhook, so whatever it triggers has every link to work with.
      const hook = await window.knight.webhook.status().catch(() => null)
      if (hook?.configured && hook.auto !== false && p.webhookSend !== false) {
        setExportState(st => ({ ...st, phase: 'telling your webhook' }))
        let r
        try { r = await window.knight.webhook.send({ projectId, filePath: target, durationSeconds: timeline.duration, transcript: said }) } catch (e) { r = { name: 'Webhook', ok: false, detail: clean(e) } }
        setExportState(st => ({ ...st, webhook: r }))
        settle()
      }
    } catch (e) {
      setExportState({ phase: 'error', message: e.message })
    } finally {
      exportingRef.current = false
    }
  }

  /* ---------------------------------------- dragging things on the canvas */

  /** Canvas-pixel coordinates for a pointer event, accounting for CSS scaling. */
  const canvasPoint = e => {
    const canvas = canvasRef.current
    const box = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - box.left) / box.width) * canvas.width,
      y: ((e.clientY - box.top) / box.height) * canvas.height
    }
  }

  /** The camera rect currently on screen, or null when no camera is shown. */
  const cameraRect = () => {
    const seg = segmentAt(timeline, timeRef.current)
    if (!seg || !media[seg.clip.id]?.camera) return null
    if (!['bubble', 'screen-dominant'].includes(seg.clip.layout || 'bubble')) return null
    return layoutRects(seg.clip.layout || 'bubble', canvasSize, project.style, project.camera, true).camera
  }

  const hitTest = e => {
    const p = canvasPoint(e)
    // The selected text wins where two overlap: you drag the one you are working on,
    // not whichever happens to sit on top.
    const sel = (project.overlays || []).filter(x => x.id === selectedOverlay)
    const o = overlayAt(sel, canvasSize, timeRef.current, p.x, p.y) ||
      overlayAt(project.overlays, canvasSize, timeRef.current, p.x, p.y)
    if (o) return { kind: 'overlay', overlay: o, p }
    const rect = cameraRect()
    if (rect && p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) {
      return { kind: 'camera', rect, p }
    }
    return { kind: null, p }
  }

  const onStagePointerDown = e => {
    const hit = hitTest(e)
    if (hit.kind === 'overlay') {
      e.preventDefault()
      const o = hit.overlay
      stageDragRef.current = {
        kind: 'overlay', id: o.id, group: `ovdrag_${Date.now()}`,
        dx: hit.p.x / canvasSize.width - o.x, dy: hit.p.y / canvasSize.height - o.y, w: o.w, h: o.h
      }
      setSelectedOverlay(o.id)
      setSelectedSeg(null)
      setTool('text')
    } else if (hit.kind === 'camera') {
      e.preventDefault()
      stageDragRef.current = {
        kind: 'camera', group: `camdrag_${Date.now()}`,
        grabX: hit.p.x - (hit.rect.x + hit.rect.w / 2),
        grabY: hit.p.y - (hit.rect.y + hit.rect.h / 2)
      }
    } else {
      setSelectedOverlay(null)
    }
  }

  const onStagePointerMove = e => {
    const d = stageDragRef.current
    if (!d) {
      const kind = hitTest(e).kind
      if (kind !== hover) setHover(kind)
      return
    }
    const p = canvasPoint(e)
    if (d.kind === 'overlay') {
      updateOverlay(d.id, {
        x: clamp(p.x / canvasSize.width - d.dx, 0, 1 - d.w),
        y: clamp(p.y / canvasSize.height - d.dy, 0, 1 - d.h)
      }, { group: d.group })
    } else {
      commit(prev => ({
        ...prev,
        camera: {
          ...prev.camera,
          pos: {
            x: clamp((p.x - d.grabX) / canvasSize.width, 0, 1),
            y: clamp((p.y - d.grabY) / canvasSize.height, 0, 1)
          }
        }
      }), { group: d.group })
    }
  }

  const onStagePointerUp = () => { stageDragRef.current = null }

  /* ------------------------------------------------------------------ render */

  if (!project) return <div className="shell"><div className="empty muted">Opening project…</div></div>

  if (!project.clips.length) {
    return (
      <div className="shell">
        <header className="topbar">
          <button className="btn ghost" onClick={onBack}>← Library</button>
          <div className="spacer drag" />
          <button className="btn primary" onClick={onRecordAnother}>Record a clip</button>
        </header>
        <div className="empty">
          <div className="empty-mark">◉</div>
          <h2>This project has no clips yet</h2>
          <p className="muted">Record one and it will appear here ready to edit.</p>
          <button className="btn primary" style={{ marginTop: 18 }} onClick={onRecordAnother}>Record a clip</button>
        </div>
      </div>
    )
  }

  const h = historyRef.current
  const back = async () => { await flushSave(); onBack() }

  return (
    <div className="editor">
      <header className="topbar">
        <button className="btn ghost" onClick={back}>← Library</button>
        <div className="brand" style={{ marginLeft: 6 }}><span className="brand-name">{project.name}</span></div>
        <div className="spacer drag" />
        <button className="btn ghost" data-tour="help" onClick={() => requestTour('editor', true)}
          data-tip="A short walkthrough of the editor">Show me around</button>
        <span className="tag">{canvasSize.width}×{canvasSize.height}</span>
        <button className="btn" onClick={async () => { await flushSave(); onRecordAnother() }}
          data-tip="Adds another take to the end of this video">Record another clip</button>
        <button className="btn primary" onClick={() => setTool('export')}>Export</button>
      </header>

      <nav className="tools">
        {TOOLS.map(tl => (
          <button key={tl.id} className={`tool ${tool === tl.id ? 'on' : ''}`} onClick={() => setTool(tl.id)}
            data-tip={tl.tip} data-tip-title={tl.label} data-tip-key={tl.key} data-tip-side="right">
            <Icon name={tl.icon} />{tl.label}
          </button>
        ))}
        <div className="tools-end">
          <button className="tool" onClick={() => onOpenSettings('files')}
            data-tip="Where files are kept, Google Drive, sharing, captions and recording options."
            data-tip-title="Settings" data-tip-side="right">
            <Icon name="settings" />Settings
          </button>
        </div>
      </nav>

      <aside className="panel">
        <button className="panel-help" data-tour="section-help" onClick={() => requestTour(`editor:${tool}`, true)}
          data-tip="A short walkthrough of this tool" data-tip-title="How this works">?</button>
        <Panels
          tool={tool} setTool={setTool} project={project} commit={commit} clip={clip} seg={activeSeg}
          selectedSeg={selectedSeg} updateClip={updateClip}
          media={media} time={time} timeline={timeline} seek={seek}
          onExport={runExport} exportState={exportState} driveStatus={driveStatus} dbStatus={dbStatus}
          shareStatus={shareStatus} hookStatus={hookStatus} savePrefs={savePrefs}
          onWriteUp={writeUp} aiState={aiState} onBuildSop={buildSop} sopState={sopState}
          onPublishShare={publishShare} onUnpublishShare={unpublishShare} shareState={shareState}
          onRemoveFillers={removeFillers} onApplyTemplate={applyTemplate}
          driveOn={driveOn} driveShareState={driveShareState} onPublishDrive={publishDrive} onUnpublishDrive={unpublishDrive}
          cloudStatus={cloudStatus} cloudState={cloudState} onOpenShare={openShare} onPublishCloud={publishCloud} onRemoveCloud={removeCloud}
          prefs={prefs} onOpenSettings={onOpenSettings}
          onRetitle={retitle} retitling={retitling}
          onDeleteClip={deleteClip} onMoveClip={moveClip}
          onTranscribe={runTranscribe} transcribeState={transcribeState}
          onRemoveSilences={removeSilences} onRemoveWords={removeWords} onSaveSRT={saveSRT}
          onSplit={split} onDeleteSection={deleteSection} onRemoveQuiet={removeQuiet} setSectionGain={setSectionGain}
          selectedZoom={selectedZoom} setSelectedZoom={setSelectedZoom}
          updateZoom={updateZoom} removeZoom={removeZoom} addZoomAt={addZoomAt}
          selectedOverlay={selectedOverlay} setSelectedOverlay={setSelectedOverlay}
          addOverlay={addOverlay} updateOverlay={updateOverlay} removeOverlay={removeOverlay}
        />
      </aside>

      <section className="stage">
        <canvas
          ref={canvasRef}
          width={canvasSize.width}
          height={canvasSize.height}
          style={{ cursor: stageDragRef.current ? 'grabbing' : hover ? 'grab' : 'default' }}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          onPointerLeave={onStagePointerUp}
        />
        {status && <div className="stage-hint">{status}</div>}
      </section>

      <Timeline
        project={project} timeline={timeline} media={media} time={time}
        playing={playing} setPlaying={setPlaying} seek={seek} commit={commit}
        selectedSeg={selectedSeg} setSelectedSeg={setSelectedSeg}
        selectedZoom={selectedZoom} setSelectedZoom={setSelectedZoom}
        selectedOverlay={selectedOverlay} setSelectedOverlay={setSelectedOverlay}
        setTool={setTool}
        onSplit={split} onDeleteSeg={deleteSection} onRemoveQuiet={removeQuiet} onAddText={addOverlay}
        undo={undo} redo={redo} canUndo={h.undo.length > 0} canRedo={h.redo.length > 0}
        previewVolume={previewVolume} setPreviewVolume={setPreviewVolume}
        previewMuted={previewMuted} setPreviewMuted={setPreviewMuted}
      />
    </div>
  )
}
