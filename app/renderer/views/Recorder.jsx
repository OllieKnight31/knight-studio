import React, { useEffect, useRef, useState } from 'react'
import { Brand } from '../ui.jsx'
import { requestTour } from '../tour.jsx'
import MicMeter from './MicMeter.jsx'

const PERMISSIONS = [
  { key: 'screenRecording', label: 'Screen recording', why: 'required to record at all' },
  { key: 'microphone', label: 'Microphone', why: 'no voiceover without it' },
  { key: 'camera', label: 'Camera', why: 'the camera bubble is skipped' },
  {
    key: 'accessibility',
    label: 'Accessibility',
    why: 'so it can see where you click — that is what auto zoom follows',
    optional: true,
    detail: 'Recording works without this. You just will not get zooms that follow your clicks.'
  }
]

/** Setup screen: choose what to capture, preview the camera, then start a take. */
export default function Recorder ({ projectId, folderId, onCancel, onDone }) {
  const [devices, setDevices] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)   // a take that finished badly
  const [sourceKind, setSourceKind] = useState('display')   // display | window
  const [displayId, setDisplayId] = useState(null)
  const [windowId, setWindowId] = useState(null)
  const [cameraId, setCameraId] = useState('')
  const [micId, setMicId] = useState('')
  const [systemAudio, setSystemAudio] = useState(true)
  const [fps, setFps] = useState(60)
  const [countdown, setCountdown] = useState(0)
  const [starting, setStarting] = useState(false)
  const [project, setProject] = useState(null)
  const [sources, setSources] = useState([])
  const [screenPreviewLive, setScreenPreviewLive] = useState(false)
  const [needsRestart, setNeedsRestart] = useState(false)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const screenVideoRef = useRef(null)
  const screenStreamRef = useRef(null)

  useEffect(() => {
    window.knight.devices.list().then(d => {
      setDevices(d)
      if (d.displays?.length) setDisplayId(d.displays.find(x => x.isMain)?.id ?? d.displays[0].id)
      if (d.cameras?.length) setCameraId(d.cameras[0].id)
      const builtin = d.microphones?.find(m => /built.?in|macbook/i.test(m.name))
      if (d.microphones?.length) setMicId((builtin || d.microphones[0]).id)
    }).catch(e => setError(e.message))
  }, [])

  useEffect(() => {
    // Coming back from a finished take: the button was left mid-countdown, so clear it.
    setStarting(false)
    if (!projectId) { setProject(null); return }
    window.knight.projects.load(projectId).then(setProject).catch(() => {})
  }, [projectId])

  // A take that ends any other way — the hotkey, the Dock menu, the floating bar —
  // must also release the button.
  useEffect(() => window.knight.record.on('record:complete', () => {
    setStarting(false)
    setCountdown(0)
    setNotice(null)
  }), [])

  // A take can end with nothing usable in it — the captured window closed, say.
  // The recorder stays where it is; it just has to stop pretending to be busy.
  useEffect(() => window.knight.record.on('record:failed', ({ message }) => {
    setStarting(false)
    setCountdown(0)
    setNotice(message || 'That take did not record anything.')
  }), [])

  // Live camera preview so you can frame yourself before the take starts.
  //
  // The capture engine identifies cameras by AVFoundation uniqueID, but getUserMedia
  // uses its own per-origin deviceIds — passing one to the other silently matches
  // nothing and leaves a black box. They share the human-readable label, so match on that.
  useEffect(() => {
    let cancelled = false
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (!cameraId) { if (videoRef.current) videoRef.current.srcObject = null; return }

    const wanted = devices?.cameras?.find(c => c.id === cameraId)?.name || ''
    ;(async () => {
      try {
        // A permissionless enumerate returns blank labels, so open a stream first.
        const probe = await navigator.mediaDevices.getUserMedia({ video: true })
        probe.getTracks().forEach(t => t.stop())
        const all = await navigator.mediaDevices.enumerateDevices()
        const cams = all.filter(d => d.kind === 'videoinput')
        const match = cams.find(d => d.label && wanted && d.label.startsWith(wanted.slice(0, 18))) || cams[0]
        if (!match) return
        const s = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: match.deviceId }, width: 1280, height: 720 }
        })
        if (cancelled) { s.getTracks().forEach(t => t.stop()); return }
        streamRef.current = s
        if (videoRef.current) videoRef.current.srcObject = s
      } catch { /* no preview is survivable; recording uses the native path anyway */ }
    })()
    return () => { cancelled = true }
  }, [cameraId, devices])

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    screenStreamRef.current?.getTracks().forEach(t => t.stop())
  }, [])

  // Keep the list of capturable sources fresh so window thumbnails track reality.
  useEffect(() => {
    let alive = true
    const load = () => window.knight.system.sources({ width: 640, height: 400 })
      .then(list => { if (alive) setSources(list) })
      .catch(() => {})
    load()
    const id = setInterval(load, 4000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  /** The desktopCapturer source matching whatever is selected for recording. */
  const selectedSource = React.useMemo(() => {
    if (sourceKind === 'display') return sources.find(s => s.displayId === displayId) || null
    return sources.find(s => s.windowId === windowId) || null
  }, [sources, sourceKind, displayId, windowId])

  // A live preview of exactly what will be recorded. Falls back to the periodically
  // refreshed thumbnail if the live stream is unavailable.
  useEffect(() => {
    let cancelled = false
    screenStreamRef.current?.getTracks().forEach(t => t.stop())
    screenStreamRef.current = null
    setScreenPreviewLive(false)
    if (!selectedSource) return

    ;(async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: selectedSource.id,
              maxWidth: 1280,
              maxHeight: 800,
              maxFrameRate: 15
            }
          }
        })
        if (cancelled) { s.getTracks().forEach(t => t.stop()); return }
        screenStreamRef.current = s
        if (screenVideoRef.current) screenVideoRef.current.srcObject = s
        setScreenPreviewLive(true)
      } catch {
        setScreenPreviewLive(false)   // the thumbnail below carries the preview instead
      }
    })()
    return () => { cancelled = true }
  }, [selectedSource?.id])

  const clips = project?.clips || []
  const perms = devices?.permissions || {}
  const missing = Object.entries(perms).filter(([, v]) => !v).map(([k]) => k)
  // Accessibility only costs you auto zoom, so it should not read as a hard blocker.
  const blocking = missing.filter(k => !PERMISSIONS.find(p => p.key === k)?.optional)

  const refreshPermissions = async () => {
    const d = await window.knight.devices.list()
    setDevices(prev => ({ ...prev, ...d }))
  }

  const grant = async key => {
    if (key === 'camera' || key === 'microphone') {
      await window.knight.system.askMedia(key === 'camera' ? 'camera' : 'microphone')
    } else if (key === 'accessibility') {
      // Opening the pane alone shows a list Knight Studio is not in — macOS only lists
      // apps that have actually asked. Asking first puts it there ready to switch on.
      const res = await window.knight.system.askAccessibility()
      if (!res?.trusted) {
        await window.knight.system.openPrivacy('accessibility')
        setNeedsRestart(true)
      }
    } else {
      await window.knight.system.openPrivacy(key)
    }
    setTimeout(refreshPermissions, 1200)
  }

  const begin = async () => {
    setStarting(true)
    for (let i = 3; i > 0; i--) {
      setCountdown(i)
      await new Promise(r => setTimeout(r, 700))
    }
    setCountdown(0)
    streamRef.current?.getTracks().forEach(t => t.stop())
    try {
      await window.knight.record.start({
        projectId: projectId || undefined,
        folderId: folderId || undefined,
        displayId: sourceKind === 'display' ? displayId : undefined,
        windowId: sourceKind === 'window' ? windowId : undefined,
        cameraId: cameraId || undefined,
        micId: micId || undefined,
        systemAudio,
        fps
      })
    } catch (e) {
      setError(e.message)
      setStarting(false)
    }
  }

  if (error) {
    return (
      <div className="shell">
        <header className="topbar"><Brand /></header>
        <div className="empty">
          <h2>Couldn't start</h2>
          <p className="muted" style={{ maxWidth: 520 }}>{error}</p>
          <button className="btn" style={{ marginTop: 18 }} onClick={onCancel}>Back</button>
        </div>
      </div>
    )
  }

  if (!devices) return <div className="shell"><div className="empty muted">Finding cameras and displays…</div></div>

  return (
    <div className="shell">
      {countdown > 0 && <div className="countdown"><span>{countdown}</span></div>}

      <header className="topbar">
        <button className="btn ghost" onClick={onCancel}>← Library</button>
        <div className="spacer drag" />
        <button className="btn ghost" data-tour="help" onClick={() => requestTour('recorder', true)}>Show me around</button>
        {clips.length > 0 && (
          <button className="btn" onClick={() => onDone(projectId)}>
            Done — edit {clips.length} clip{clips.length === 1 ? '' : 's'}
          </button>
        )}
        <button className="btn primary" onClick={begin} disabled={starting}>
          {starting ? 'Starting…' : clips.length ? 'Record another clip' : 'Start recording'}
        </button>
      </header>

      {notice && (
        <div className="rec-notice">
          <span>{notice}</span>
          <button className="btn ghost sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="rec-layout">
        <section className="rec-preview">
          <div className="preview-frame">
            {selectedSource
              ? (
                <>
                  <video
                    ref={screenVideoRef}
                    autoPlay muted playsInline
                    className="screen-preview"
                    style={{ display: screenPreviewLive ? 'block' : 'none' }}
                  />
                  {!screenPreviewLive && selectedSource.thumbnail && (
                    <img className="screen-preview" src={selectedSource.thumbnail} alt="" draggable={false} />
                  )}
                  {!screenPreviewLive && !selectedSource.thumbnail && (
                    <div className="cam-off muted">Preparing preview…</div>
                  )}
                </>
                )
              : (
                <div className="cam-off muted">
                  {sourceKind === 'window' ? 'Choose a window to preview it' : 'Finding that display…'}
                </div>
                )}

            {cameraId && (
              <video ref={videoRef} autoPlay muted playsInline className="cam-bubble" />
            )}

            <span className="preview-tag">
              {selectedSource ? selectedSource.name : 'Nothing selected'}
            </span>
          </div>

          <p className="muted" style={{ marginTop: 14, textAlign: 'center' }}>
            Recording {sourceKind === 'display' ? 'a display' : 'a window'} at {fps} fps
            {cameraId ? ' with camera' : ''}{micId ? ' and mic' : ''}.
          </p>

          {clips.length > 0 && (
            <div className="clip-strip">
              {clips.map((c, i) => (
                <div key={c.id} className="clip-chip">
                  <span className="clip-chip-n">{i + 1}</span>
                  <span>{c.hasCamera ? 'Screen + camera' : 'Screen'}</span>
                  <span className="val">{c.duration.toFixed(1)}s</span>
                  <button className="btn ghost sm" title="Delete this take"
                    onClick={async () => setProject(await window.knight.projects.deleteClip(projectId, c.id))}>✕</button>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="rec-panel">
          <div className={`perms ${blocking.length ? 'needs' : 'ok'}`}>
            <div className="row between">
              <span className="label" style={{ margin: 0 }}>
                {blocking.length
                  ? 'Permissions needed'
                  : missing.length ? 'Ready to record' : 'Permissions granted'}
              </span>
              <button className="btn ghost sm" onClick={refreshPermissions} title="Re-check">↻</button>
            </div>
            {PERMISSIONS.map(({ key, label, why, optional, detail }) => (
              <div key={key} className="perm-row">
                <span className={`perm-dot ${perms[key] ? 'on' : optional ? 'optional' : ''}`} />
                <span className="perm-label">
                  {label}
                  {!perms[key] && <span className="perm-why">{why}</span>}
                </span>
                {perms[key]
                  ? <span className="val">Granted</span>
                  : <button className="btn sm" onClick={() => grant(key)}>Allow</button>}
              </div>
            ))}
            {!perms.accessibility && !needsRestart && (
              <p className="panel-sub muted" style={{ marginTop: 2 }}>
                {PERMISSIONS.find(p => p.key === 'accessibility').detail}
              </p>
            )}
            {!missing.length && !needsRestart && (
              <p className="panel-sub muted" style={{ marginTop: 2 }}>
                Granted once — recording will not ask again.
              </p>
            )}
            {needsRestart && (
              <div className="col" style={{ gap: 7 }}>
                <p className="panel-sub muted" style={{ margin: 0 }}>
                  <strong>Knight Studio</strong> is now in the Accessibility list that just
                  opened — switch it on there. macOS does not let an app tick that box for
                  you, which is the whole point of it. Then relaunch, because the click
                  listener only attaches on a fresh start.
                </p>
                <button className="btn sm" onClick={() => window.knight.system.relaunch()}>
                  Relaunch Knight Studio
                </button>
                <button className="btn sm ghost" onClick={() => window.knight.system.openPrivacy('accessibility')}>
                  Open the list again
                </button>
              </div>
            )}
          </div>

          <div className="field">
            <span className="label">Capture</span>
            <div className="seg">
              <button className={sourceKind === 'display' ? 'on' : ''} onClick={() => setSourceKind('display')}>Screen</button>
              <button className={sourceKind === 'window' ? 'on' : ''} onClick={() => setSourceKind('window')}>Window</button>
            </div>
          </div>

          {sourceKind === 'display'
            ? (
              <div className="field">
                <span className="label">Display</span>
                <select className="select" value={displayId ?? ''} onChange={e => setDisplayId(Number(e.target.value))}>
                  {devices.displays.map(d => (
                    <option key={d.id} value={d.id}>{d.name} — {d.pixelWidth}×{d.pixelHeight}{d.isMain ? ' (main)' : ''}</option>
                  ))}
                </select>
              </div>
              )
            : (
              <div className="field">
                <span className="label">Window</span>
                <select className="select" value={windowId ?? ''} onChange={e => setWindowId(Number(e.target.value))}>
                  <option value="">Choose a window…</option>
                  {/* Listed from the same enumeration that feeds the preview, so what
                      you see is guaranteed to be the window that gets recorded. */}
                  {sources.filter(s => s.windowId).map(s => (
                    <option key={s.id} value={s.windowId}>{s.name.slice(0, 70)}</option>
                  ))}
                </select>
              </div>
              )}

          <div className="field">
            <span className="label">Camera</span>
            <select className="select" value={cameraId} onChange={e => setCameraId(e.target.value)}>
              <option value="">None</option>
              {devices.cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          <div className="field">
            <span className="label">Microphone</span>
            <select className="select" value={micId} onChange={e => setMicId(e.target.value)}>
              <option value="">None</option>
              {devices.microphones.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>

          <MicMeter micId={micId} devices={devices} systemAudio={systemAudio} />

          <div className="row between">
            <span className="label" style={{ textTransform: 'none', fontSize: 12.5, color: 'var(--text)' }}>System audio</span>
            <label className="switch">
              <input type="checkbox" checked={systemAudio} onChange={e => setSystemAudio(e.target.checked)} />
              <span />
            </label>
          </div>

          <div className="field">
            <span className="label">Frame rate</span>
            <div className="seg">
              {[30, 60].map(f => (
                <button key={f} className={fps === f ? 'on' : ''} onClick={() => setFps(f)}>{f} fps</button>
              ))}
            </div>
          </div>

          <p className="hint muted">
            Your cursor and clicks are recorded alongside the video, so zooms can follow
            exactly where you worked.
          </p>
        </aside>
      </div>
    </div>
  )
}
