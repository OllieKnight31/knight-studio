import React, { useEffect, useState, useCallback } from 'react'
import Library from './views/Library.jsx'
import Recorder from './views/Recorder.jsx'
import Editor from './views/Editor.jsx'
import Overlay from './views/Overlay.jsx'
import { SharingScreen, ShareDialog } from './views/Sharing.jsx'
import Settings from './views/Settings.jsx'
import { TooltipLayer } from './ui.jsx'
import { TourLayer, requestTour } from './tour.jsx'
import { applyBrand } from './theme.js'

/**
 * Two entry points share this bundle: the main window (library → recorder → editor)
 * and the small always-on-top recording bar, selected by the URL hash.
 */
export default function App () {
  const isOverlay = typeof window !== 'undefined' && window.location.hash === '#overlay'
  const [view, setView] = useState('library')     // library | recorder | editor
  const [projectId, setProjectId] = useState(null)
  const [folderId, setFolderId] = useState(null)  // library folder a new recording is filed in
  const [prefs, setPrefs] = useState(null)
  const [sharing, setSharing] = useState(false)   // the Sharing screen
  const [shareId, setShareId] = useState(null)    // a video whose Share box is open
  const [settings, setSettings] = useState(null)  // null | tab id
  const [libraryRev, setLibraryRev] = useState(0) // bumped when settings change what the library shows

  useEffect(() => { window.knight.prefs.read().then(setPrefs).catch(() => {}) }, [])
  useEffect(() => { if (prefs) applyBrand() }, [prefs])

  // First launch: open on the system check, so the permissions macOS needs are
  // dealt with before the first recording rather than discovered during it.
  useEffect(() => {
    if (isOverlay || !prefs || prefs.welcomed) return
    setSettings('system')
    window.knight.prefs.write({ welcomed: true }).then(setPrefs).catch(() => {})
  }, [isOverlay, !!prefs])

  const savePrefs = useCallback(patch => {
    // Applied to the screen straight away, then written; the colour pickers fire
    // continuously and should feel instant.
    setPrefs(cur => (cur ? { ...cur, ...patch, ...mergeGroups(cur, patch) } : cur))
    window.knight.prefs.write(patch).then(setPrefs).catch(() => {})
  }, [])

  const openEditor = useCallback(id => { setProjectId(id); setView('editor') }, [])
  const openRecorder = useCallback((id = null, folder = null) => {
    setProjectId(id); setFolderId(folder); setView('recorder')
  }, [])
  const openSettings = useCallback((tab = 'files') => setSettings(tab), [])

  // A finished take returns to the recorder rather than the editor, so takes can be
  // stacked up one after another — that is the whole point of recording in clips.
  useEffect(() => {
    if (isOverlay) return
    return window.knight.record.on('record:complete', ({ projectId }) => {
      setProjectId(projectId)
      setView('recorder')
    })
  }, [isOverlay])

  // The Dock menu can ask the window to jump straight to a view.
  useEffect(() => {
    if (isOverlay) return
    return window.knight.ui.onNavigate(({ view }) => {
      if (view === 'recorder') openRecorder(null)
      else if (view === 'library') { setProjectId(null); setView('library') }
    })
  }, [isOverlay, openRecorder])

  // Each screen introduces itself the first time it is visited. The request is
  // ignored if that walkthrough has been seen, and waits for the screen to be ready.
  const ready = !!prefs
  useEffect(() => {
    if (isOverlay || !ready) return
    if (view === 'editor' && !projectId) return
    requestTour(view)
  }, [isOverlay, ready, view, projectId])

  if (isOverlay) return <Overlay />
  if (!prefs) return null

  let screen
  if (view === 'recorder') {
    screen = (
      <Recorder
        projectId={projectId}
        folderId={folderId}
        onCancel={() => { setProjectId(null); setView('library') }}
        onDone={id => openEditor(id)}
      />
    )
  } else if (view === 'editor' && projectId) {
    screen = (
      <Editor
        projectId={projectId}
        prefs={prefs}
        savePrefs={savePrefs}
        onBack={() => { setProjectId(null); setView('library') }}
        onRecordAnother={() => openRecorder(projectId)}
        onOpenSettings={openSettings}
        onOpenShare={id => setShareId(id)}
      />
    )
  } else {
    screen = (
      <Library
        key={libraryRev}
        prefs={prefs}
        onNew={folder => openRecorder(null, folder)}
        onOpen={openEditor}
        onOpenSettings={openSettings}
        onOpenSharing={() => setSharing(true)}
        onOpenShare={id => setShareId(id)}
      />
    )
  }

  return (
    <>
      {screen}
      {settings && (
        <Settings
          prefs={prefs} savePrefs={savePrefs} setPrefs={setPrefs} initialTab={settings}
          onClose={() => setSettings(null)}
          onLibraryChanged={() => setLibraryRev(n => n + 1)}
        />
      )}
      {sharing && <SharingScreen onClose={() => setSharing(false)} onOpenSettings={openSettings} />}
      {shareId && <ShareDialog videoId={shareId} onClose={() => setShareId(null)} />}
      {view !== 'recorder' && !settings && !sharing && <UpdatePill onOpen={() => openSettings('updates')} />}
      <TourLayer prefs={prefs} savePrefs={savePrefs} />
      <TooltipLayer />
    </>
  )
}

/** A quiet note in the corner when a newer version has been found. */
function UpdatePill ({ onOpen }) {
  const [st, setSt] = useState(null)
  const [hidden, setHidden] = useState(null)
  useEffect(() => {
    window.knight.updates.status().then(setSt).catch(() => {})
    return window.knight.updates.onChange(setSt)
  }, [])
  if (!st || !['available', 'ready'].includes(st.phase) || hidden === st.version) return null
  return (
    <div className="update-pill" data-act="update-pill">
      <button onClick={onOpen}>{st.phase === 'ready' ? `Version ${st.version} is ready — restart to update` : `Version ${st.version} is available`}</button>
      <button className="x" aria-label="Dismiss" onClick={() => setHidden(st.version)}>×</button>
    </div>
  )
}

/** Mirrors the main process: nested groups merge rather than replace. */
function mergeGroups (cur, patch) {
  const out = {}
  for (const key of ['drive', 'lastRecording', 'captions', 'ai', 'tours']) {
    if (patch[key]) out[key] = { ...cur[key], ...patch[key] }
  }
  return out
}
