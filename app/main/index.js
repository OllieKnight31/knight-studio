'use strict'
const { app, BrowserWindow, ipcMain, shell, dialog, screen, globalShortcut, protocol, net, Menu, nativeImage, systemPreferences, desktopCapturer, clipboard } = require('electron')
const { pathToFileURL } = require('node:url')
const { Readable } = require('node:stream')
const path = require('node:path')
const fs = require('node:fs')
const capture = require('./capture')
const projects = require('./projects')
const exporter = require('./export')
const drive = require('./drive')
const transcribe = require('./transcribe')
const prefs = require('./prefs')
const thumbs = require('./thumbs')
const titler = require('./titler')
const audio = require('./audio')
const camsync = require('./camsync')
const whisper = require('./whisper')
const databases = require('./databases')
const share = require('./share')
const webhook = require('./webhook')
const ai = require('./ai')
const sop = require('./sop')
const templates = require('./templates')
const updates = require('./updates')
const cloud = require('./cloud')
const driveShare = require('./driveshare')
const secrets = require('./secrets')
const tools = require('./tools')

// A dedicated scheme lets the renderer stream recordings without relaxing webSecurity;
// the dev server runs on http://localhost, which cannot otherwise read file:// URLs.
protocol.registerSchemesAsPrivileged([{
  scheme: 'knight',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true }
}])

// KS_DIST forces the built renderer, so the app runs without the Vite dev server.
const DEV = !app.isPackaged && !process.env.KS_DIST
const DEV_URL = process.env.KS_DEV_URL || 'http://localhost:5173'

let mainWindow = null
let overlayWindow = null
let session = null          // the CaptureSession currently recording
let sessionMeta = null      // { projectId, clipId, dir, startedAt }

function loadRenderer (win, route = '') {
  if (DEV) return win.loadURL(DEV_URL + (route ? `#${route}` : ''))
  return win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'), { hash: route })
}

function createMainWindow () {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0A0A0B',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  loadRenderer(mainWindow)
  if (process.env.KS_DEBUG) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message}  (${source}:${line})`)
    })
  }
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })
  return mainWindow
}

/**
 * The floating recorder bar: frameless, transparent and always on top, so it stays
 * reachable over any app. It is excluded from the capture along with the rest of our
 * windows, so it never appears in the recording.
 */
function createOverlay () {
  if (overlayWindow) return overlayWindow
  const display = screen.getPrimaryDisplay()
  const w = 460
  const h = 128
  overlayWindow = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(display.workArea.x + (display.workArea.width - w) / 2),
    y: Math.round(display.workArea.y + display.workArea.height - h - 28),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  loadRenderer(overlayWindow, 'overlay')
  overlayWindow.on('closed', () => { overlayWindow = null })
  return overlayWindow
}

function send (channel, payload) {
  for (const w of [mainWindow, overlayWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

// ---------------------------------------------------------------- IPC: devices

ipcMain.handle('devices:list', async () => capture.listDevices())
ipcMain.handle('devices:requestPermissions', async () => capture.requestPermissions())

// Screen Recording and Accessibility cannot be granted from a prompt — macOS only lets
// the user switch them on in System Settings — so open the exact pane for them.
const PRIVACY_PANES = {
  screenRecording: 'Privacy_ScreenCapture',
  accessibility: 'Privacy_Accessibility',
  camera: 'Privacy_Camera',
  microphone: 'Privacy_Microphone'
}
ipcMain.handle('system:openPrivacy', (_e, which) => {
  const pane = PRIVACY_PANES[which] || 'Privacy'
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
})

// Ask macOS directly for camera and microphone. These land against Knight Studio, and
// the capture engine now shares the app's bundle identity, so one grant covers both.
/**
 * Asks macOS for Accessibility, which is the only way the app ever appears in that
 * settings pane. Opening the pane alone shows an empty list with nothing to switch on,
 * because macOS only lists apps that have actually requested the permission.
 *
 * Returns true when already trusted. Otherwise it registers the request (which adds
 * Knight Studio to the list, pre-ticked or ready to tick) and shows the system prompt.
 */
ipcMain.handle('system:askAccessibility', async () => {
  const trusted = systemPreferences.isTrustedAccessibilityClient(false)
  if (trusted) return { trusted: true, prompted: false }
  // `true` puts up the prompt AND registers the app in the Accessibility list.
  systemPreferences.isTrustedAccessibilityClient(true)
  return { trusted: false, prompted: true }
})

/** Accessibility only takes effect for the event tap after a relaunch. */
ipcMain.handle('app:relaunch', () => {
  app.relaunch()
  app.exit(0)
})

/** Live sources for the recorder's preview, with a thumbnail of each. */
ipcMain.handle('sources:list', async (_e, { width = 640, height = 400 } = {}) => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false
  })
  // Knight Studio's own windows are hidden the moment recording starts, so
  // picking one gives a capture of nothing. Keep them out of the list entirely.
  const ownTitles = new Set(BrowserWindow.getAllWindows().map(w => w.getTitle()).filter(Boolean))
  ownTitles.add(app.getName())

  return sources
    .filter(s => !(s.id.startsWith('window:') && ownTitles.has(s.name)))
    .map(s => ({
      id: s.id,
      name: s.name,
      // display_id lines a screen source up with the CGDirectDisplayID the capture
      // engine uses; window ids are embedded in the source id as window:<id>:0.
      displayId: s.display_id ? Number(s.display_id) : null,
      windowId: s.id.startsWith('window:') ? Number(s.id.split(':')[1]) : null,
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL()
    }))
})

/** macOS input volume, so a mic that is simply turned down can be fixed in the app. */
ipcMain.handle('system:inputVolume', async () => {
  try {
    const out = await exporter.run('/usr/bin/osascript', ['-e', 'input volume of (get volume settings)'])
    const v = parseInt(String(out).trim(), 10)
    return Number.isFinite(v) ? v : null
  } catch { return null }
})

ipcMain.handle('system:setInputVolume', async (_e, level) => {
  const v = Math.max(0, Math.min(100, Math.round(Number(level) || 0)))
  try {
    await exporter.run('/usr/bin/osascript', ['-e', `set volume input volume ${v}`])
    return v
  } catch { return null }
})

ipcMain.handle('system:askMedia', async (_e, kind) => {
  try { return await systemPreferences.askForMediaAccess(kind) } catch { return false }
})

// ---------------------------------------------------------------- IPC: projects

ipcMain.handle('projects:list', async () => {
  // Adopt any stranded captures before listing, so the library reflects what is
  // actually on disk rather than what the last clean shutdown happened to record.
  for (const p of projects.listProjects()) {
    try { await projects.recoverClips(projects.loadProject(p.id)) } catch {}
  }
  return projects.listProjects()
})
ipcMain.handle('projects:create', (_e, name, folderId) => projects.createProject(name, folderId))
ipcMain.handle('projects:load', async (_e, id) => projects.recoverClips(projects.loadProject(id)))
ipcMain.handle('projects:save', (_e, p) => projects.saveProject(p))
ipcMain.handle('projects:delete', (_e, id) => { projects.deleteProject(id); return true })
ipcMain.handle('projects:reveal', (_e, id) => shell.showItemInFolder(path.join(projects.projectDir(id), 'project.json')))
ipcMain.handle('clips:events', (_e, clipDir) => projects.readEvents(clipDir))
ipcMain.handle('clips:thumbs', async (_e, clipDir) => {
  try { return await thumbs.ensureThumbs(clipDir) } catch { return { poster: null, previews: [] } }
})
ipcMain.handle('clips:thumbsCached', (_e, clipDir) => {
  try { return thumbs.readThumbs(clipDir) } catch { return { poster: null, previews: [] } }
})
ipcMain.handle('clips:waveform', async (_e, clipDir) => {
  try { return await audio.waveform(clipDir) } catch { return null }
})

// Older takes only: works out where the camera really sits against the audio.
ipcMain.handle('clips:measureCamera', async (_e, clipDir) => {
  try { return await camsync.measureCameraOffset(clipDir) } catch { return null }
})

ipcMain.handle('clips:retitle', async (_e, projectId, clipId) => {
  const project = projects.loadProject(projectId)
  const clip = project.clips.find(c => c.id === clipId) || project.clips[0]
  if (!clip) return project
  const transcript = transcribe.readTranscript(clip.dir) ||
    await transcribe.transcribeClip({ clipDir: clip.dir }).catch(() => null)
  const { title } = await titler.titleForClip({ clipDir: clip.dir, transcript })
  if (title) { clip.title = title; project.name = title }
  return projects.saveProject(project)
})

ipcMain.handle('clips:delete', (_e, projectId, clipId) => {
  const project = projects.loadProject(projectId)
  const clip = project.clips.find(c => c.id === clipId)
  project.clips = project.clips.filter(c => c.id !== clipId)
  projects.saveProject(project)
  // Take the raw capture files with it; nothing else references them.
  if (clip?.dir) fs.rmSync(clip.dir, { recursive: true, force: true })
  return project
})

ipcMain.handle('clips:reorder', (_e, projectId, fromIndex, toIndex) => {
  const project = projects.loadProject(projectId)
  const max = project.clips.length - 1
  if (fromIndex < 0 || fromIndex > max || toIndex < 0 || toIndex > max) return project
  const [moved] = project.clips.splice(fromIndex, 1)
  project.clips.splice(toIndex, 0, moved)
  return projects.saveProject(project)
})

// ------------------------------------------------------------------- recording
//
// start/stop live here as plain functions rather than inside the IPC handlers,
// because three different things trigger them: the app UI, the Dock menu, and the
// global hotkey. They must all take exactly the same path.

async function startRecording (opts = {}) {
  if (session) throw new Error('a recording is already running')

  // Fill any gaps from the last real recording, so a one-click start from the Dock
  // uses the devices you actually chose last time.
  const last = prefs.read().lastRecording
  const settings = {
    displayId: opts.displayId ?? last.displayId ?? undefined,
    windowId: opts.windowId ?? undefined,
    cameraId: 'cameraId' in opts ? opts.cameraId : last.cameraId,
    micId: 'micId' in opts ? opts.micId : last.micId,
    systemAudio: opts.systemAudio ?? last.systemAudio ?? true,
    fps: opts.fps ?? last.fps ?? 60,
    codec: opts.codec || 'h264'
  }

  const project = opts.projectId
    ? projects.loadProject(opts.projectId)
    : projects.createProject(opts.name, opts.folderId || null)
  const { clipId, dir } = projects.newClipDir(project.id)

  session = new capture.CaptureSession({
    outDir: dir,
    ...settings,
    // Electron owns our windows, so excluding its PID keeps the app out of the shot.
    excludePids: [process.pid]
  })
  sessionMeta = { projectId: project.id, clipId, dir, startedAt: Date.now() }

  session.on('event', msg => send('record:event', msg))
  session.on('capture-error', err => send('record:error', { message: err.message }))
  session.start()

  prefs.write({ lastRecording: { ...last, ...settings, windowId: null } })

  if (opts.hideApp !== false && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
  createOverlay().show()
  setRecordingChrome(true)
  return { projectId: project.id, clipId, dir }
}

async function stopRecording () {
  if (!session) return null
  const manifest = await session.stop()
  const meta = sessionMeta
  session = null
  sessionMeta = null

  overlayWindow?.hide()
  setRecordingChrome(false)

  // Always come back to the front. The main window was hidden to get it out of the
  // shot, and leaving it hidden after a stop would strand the app with no window.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  } else {
    createMainWindow()
  }
  app.focus({ steal: true })

  // A take with no frames is not a recording — it happens when the captured
  // window disappears mid-take. Saving it would put an unopenable clip in the
  // library and strand the recorder waiting for a video that never arrives.
  const screenFile = path.join(meta.dir, 'screen.mov')
  if (!manifest || !manifest.frames || !fs.existsSync(screenFile)) {
    try { fs.rmSync(meta.dir, { recursive: true, force: true }) } catch {}
    try {
      const p = projects.loadProject(meta.projectId)
      if (p && !(p.clips || []).length) projects.deleteProject(meta.projectId)
    } catch {}
    send('record:failed', {
      message: manifest && !manifest.frames
        ? 'That take captured no frames — the window may have closed or been hidden.'
        : 'The recording did not produce a video file.'
    })
    return null
  }

  // Append the finished take to the project as a new clip.
  const project = projects.loadProject(meta.projectId)
  const clip = {
    id: meta.clipId,
    dir: meta.dir,
    createdAt: new Date().toISOString(),
    duration: manifest?.duration ?? 0,
    width: manifest?.width ?? 0,
    height: manifest?.height ?? 0,
    hasCamera: !!manifest?.camera,
    hasSystemAudio: !!manifest?.audio?.system,
    hasMic: !!manifest?.audio?.microphone,
    cameraStartOffset: manifest?.cameraStartOffset ?? 0,
    // Measured from frame timestamps by the capture engine, so it needs no correcting.
    cameraSync: manifest?.cameraSync === 'host-clock' ? 'measured' : undefined,
    layout: manifest?.camera ? 'bubble' : 'screen',
    trim: { in: 0, out: manifest?.duration ?? 0 },
    cuts: [],
    zooms: [],
    autoZoomApplied: false
  }
  project.clips.push(clip)
  projects.saveProject(project)
  send('record:complete', { projectId: project.id, clip })

  // Everything below is best-effort polish that happens after the take is safely
  // saved, so a failure here can never cost a recording.
  finaliseClip(project.id, clip).catch(e => {
    if (process.env.KS_DEBUG) console.log('[finalise] aborted:', e && e.message)
  })

  return { projectId: project.id, clip, manifest }
}

/**
 * Post-processing for a finished take: thumbnails first (fast, and the library needs
 * them immediately), then transcription, then a title derived from what was actually
 * said or shown — so recordings name themselves instead of piling up as "Untitled".
 */
async function finaliseClip (projectId, clip) {
  const patch = clipId => fn => {
    try {
      const p = projects.loadProject(projectId)
      const c = p.clips.find(x => x.id === clipId)
      if (!c) return null
      fn(p, c)
      return projects.saveProject(p)
    } catch { return null }
  }
  const update = patch(clip.id)

  send('finalise:progress', { clipId: clip.id, phase: 'thumbnails' })
  try {
    const t = await thumbs.ensureThumbs(clip.dir)
    update((p, c) => { c.poster = t.poster; c.previews = t.previews })
    send('finalise:progress', { clipId: clip.id, phase: 'thumbnails-done', poster: t.poster })
  } catch (e) { if (process.env.KS_DEBUG) console.log('[finalise] thumbs failed:', e.message) }

  // Measure the clip's loudness now so the editor has a playback gain waiting for
  // it rather than stalling on ffmpeg the first time the project is opened.
  try { await exporter.clipLoudness(clip.dir) } catch { /* best effort */ }

  // Most screen recordings have no speech at all, and Whisper will happily spend
  // minutes decoding fan noise. A sub-second ffmpeg check decides whether it is worth
  // running, and a hard budget bounds it even when it is.
  let transcript = null
  let speech = 1
  try { speech = await transcribe.speechFraction(clip.dir) } catch { speech = 1 }

  if (speech >= 0.15) {
    send('finalise:progress', { clipId: clip.id, phase: 'transcribing' })
    try {
      // A fast model, on a budget. This pass only has to be good enough to name the
      // video — asking for captions re-runs it at full quality.
      const budgetMs = Math.min(120_000, 20_000 + (clip.duration || 0) * 800)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), budgetMs)
      try {
        transcript = await transcribe.transcribeClip({
          clipDir: clip.dir, model: 'base', signal: ac.signal
        })
        update((p, c) => { c.transcribed = true })
      } finally { clearTimeout(timer) }
    } catch (e) { if (process.env.KS_DEBUG) console.log('[finalise] transcribe failed:', e.message) }
  }

  send('finalise:progress', { clipId: clip.id, phase: 'titling' })
  if (process.env.KS_DEBUG) console.log('[finalise] titling, speech=' + speech.toFixed(2))
  try {
    const { title, source } = await titler.titleForClip({ clipDir: clip.dir, transcript })
    if (title) {
      update((p, c) => {
        c.title = title
        // Never overwrite a name the user chose themselves.
        if (!p.name || /^untitled recording$/i.test(p.name)) p.name = title
      })
      send('finalise:progress', { clipId: clip.id, phase: 'done', title, source })
      return
    }
  } catch (e) {
    if (process.env.KS_DEBUG) console.log('[finalise] title failed:', e && e.stack ? e.stack.split('\n')[0] : e)
  }
  send('finalise:progress', { clipId: clip.id, phase: 'done' })
}

/**
 * Quick-record entry point used by the Dock menu and the global hotkey.
 * Shows the floating bar counting down first, so you get a moment to get out of the
 * way of whatever you are about to record.
 */
async function quickRecord ({ withCamera } = {}) {
  if (session) return stopRecording()

  const last = prefs.read().lastRecording
  let cameraId = withCamera ? last.cameraId : null
  if (withCamera && !cameraId) {
    try {
      const devices = await capture.listDevices()
      cameraId = devices.cameras?.[0]?.id ?? null
    } catch { cameraId = null }
  }

  const seconds = prefs.read().countdown ?? 3
  const overlay = createOverlay()
  overlay.show()
  for (let i = seconds; i > 0; i--) {
    send('record:countdown', { n: i })
    await new Promise(r => setTimeout(r, 700))
  }
  send('record:countdown', { n: 0 })

  try {
    return await startRecording({ cameraId, windowId: undefined })
  } catch (e) {
    send('record:error', { message: e.message })
    overlay.hide()
    throw e
  }
}

/** Right-click menu on the Dock icon — reach the recorder without opening the app. */
function buildDockMenu () {
  if (process.platform !== 'darwin' || !app.dock) return
  const recording = !!session
  app.dock.setMenu(Menu.buildFromTemplate(
    recording
      ? [
          { label: 'Stop recording', click: () => stopRecording().catch(() => {}) },
          {
            label: session && sessionMeta ? 'Pause' : 'Pause',
            click: () => session?.pause()
          },
          { label: 'Resume', click: () => session?.resume() },
          { type: 'separator' },
          { label: 'Recording…', enabled: false }
        ]
      : [
          { label: 'Record screen', click: () => quickRecord({ withCamera: false }).catch(() => {}) },
          { label: 'Record screen + camera', click: () => quickRecord({ withCamera: true }).catch(() => {}) },
          { type: 'separator' },
          {
            label: 'New recording…',
            click: () => {
              if (!mainWindow || mainWindow.isDestroyed()) createMainWindow()
              else { mainWindow.show(); mainWindow.focus() }
              app.focus({ steal: true })
              send('ui:navigate', { view: 'recorder' })
            }
          },
          {
            label: 'Open library',
            click: () => {
              if (!mainWindow || mainWindow.isDestroyed()) createMainWindow()
              else { mainWindow.show(); mainWindow.focus() }
              app.focus({ steal: true })
              send('ui:navigate', { view: 'library' })
            }
          }
        ]
  ))
}

/** Toggles anything that should look different while a take is running. */
function setRecordingChrome (recording) {
  if (process.platform !== 'darwin' || !app.dock) return
  app.dock.setBadge(recording ? '●' : '')
  buildDockMenu()

  // Stay running across restarts so the Dock menu and hotkeys are always live.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: prefs.read().openAtLogin !== false, openAsHidden: false })
  }
}

// ---------------------------------------------------------------- IPC: recording

ipcMain.handle('record:start', (_e, opts) => startRecording(opts))
ipcMain.handle('record:pause', () => { session?.pause(); return true })
ipcMain.handle('record:resume', () => { session?.resume(); return true })
ipcMain.handle('record:stop', () => stopRecording())
ipcMain.handle('record:state', () => ({ recording: !!session, ...(sessionMeta || {}) }))
ipcMain.handle('prefs:read', () => prefs.read())
ipcMain.handle('prefs:write', (_e, patch) => {
  const next = prefs.write(patch)
  if (app.isPackaged && 'openAtLogin' in patch) {
    app.setLoginItemSettings({ openAtLogin: next.openAtLogin !== false, openAsHidden: false })
  }
  return next
})

// ---------------------------------------------------------------- IPC: transcription

ipcMain.handle('transcribe:available', async () => {
  try { return await transcribe.isAvailable() } catch { return false }
})

ipcMain.handle('transcribe:read', (_e, clipDir) => {
  try { return transcribe.readTranscript(clipDir) } catch { return null }
})

ipcMain.handle('transcribe:clip', async (event, { clipDir, model, language, force }) => {
  return transcribe.transcribeClip({
    clipDir,
    model,
    language,
    force,
    onProgress: pct => {
      if (!event.sender.isDestroyed()) event.sender.send('transcribe:progress', { clipDir, pct })
    }
  })
})

// ---------------------------------------------------------------- dialogs
//
// Every file and folder picker goes through these two, attached to whichever window
// asked. KS_TEST_OPEN_FILE / KS_TEST_OPEN_DIR / KS_TEST_SAVE_DIR answer them without a
// person, so the automated sweep (build/ui-sweep.mjs) can drive every control.

function dialogWindow (event) {
  const w = event && BrowserWindow.fromWebContents(event.sender)
  return (w && !w.isDestroyed() && w.isVisible()) ? w : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined)
}

async function pickOpen (event, options) {
  const isDir = (options.properties || []).includes('openDirectory')
  const isAudio = (options.filters || []).some(f => f.name === 'Audio')
  const hook = isDir ? process.env.KS_TEST_OPEN_DIR : (isAudio && process.env.KS_TEST_OPEN_AUDIO) || process.env.KS_TEST_OPEN_FILE
  if (hook) return hook
  const win = dialogWindow(event)
  if (win) { win.show(); win.focus() }
  app.focus({ steal: true })
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
}

async function pickSave (event, options) {
  if (process.env.KS_TEST_SAVE_DIR) {
    return path.join(process.env.KS_TEST_SAVE_DIR, path.basename(options.defaultPath || 'file'))
  }
  const win = dialogWindow(event)
  if (win) { win.show(); win.focus() }
  app.focus({ steal: true })
  const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  return r.canceled || !r.filePath ? null : r.filePath
}

// ---------------------------------------------------------------- IPC: settings

ipcMain.handle('settings:pickDirectory', (event, { title, defaultPath } = {}) => pickOpen(event, {
  title: title || 'Choose a folder',
  message: title || 'Choose a folder',
  buttonLabel: 'Choose',
  defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : app.getPath('home'),
  properties: ['openDirectory', 'createDirectory']
}))

/** Changes where recordings are kept, optionally taking the existing ones along. */
ipcMain.handle('settings:setLibraryDir', async (event, { dir, move = true } = {}) => {
  if (session) throw new Error('Stop the recording before moving the library.')
  const target = dir ? path.resolve(dir) : prefs.DEFAULT_LIBRARY
  fs.mkdirSync(target, { recursive: true })
  fs.accessSync(target, fs.constants.W_OK)
  let moved = 0
  if (move) {
    const res = await projects.moveLibrary(target, fraction => {
      if (!event.sender.isDestroyed()) event.sender.send('settings:moveProgress', { fraction })
    })
    moved = res.moved
  }
  const next = prefs.write({ libraryDir: target === prefs.DEFAULT_LIBRARY ? null : target })
  projects.ensureRoot()
  return { prefs: next, dir: target, moved }
})

ipcMain.handle('settings:libraryDir', () => ({
  dir: projects.root(), isDefault: projects.root() === prefs.DEFAULT_LIBRARY, defaultDir: prefs.DEFAULT_LIBRARY
}))

// ---------------------------------------------------------------- IPC: library folders
//
// Every library folder has a twin inside the Google Drive parent folder chosen in
// Settings. Drive is never allowed to fail a local action: the folder is created,
// renamed or filed locally first, and any Drive problem is handed back as a message.

function driveParent () { return prefs.read().drive?.parent || null }

async function driveReady () {
  if (!driveParent()) return false
  try { return await drive.isConfigured() } catch { return false }
}

/** The Drive folder for a library folder, created inside the parent if needed. */
async function driveFolderFor (folderId) {
  const parent = driveParent()
  if (!parent) return null
  if (!folderId) return parent.id
  const folder = projects.readLibrary().folders.find(f => f.id === folderId)
  if (!folder) return parent.id
  if (folder.driveId) return folder.driveId
  const made = await drive.ensureFolderIn(folder.name, parent.id)
  projects.updateFolder(folder.id, { driveId: made.id })
  return made.id
}

ipcMain.handle('library:get', () => projects.readLibrary())

ipcMain.handle('library:createFolder', async (_e, name) => {
  const folder = projects.createFolder(name)
  let driveError = null
  if (await driveReady()) {
    try { await driveFolderFor(folder.id) } catch (e) { driveError = e.message }
  }
  // Confirm it by asking Drive for the folder back, rather than trusting the create call.
  let drive_ = null
  if (!driveError) { try { drive_ = await verifyDriveFolder(folder.id) } catch {} }
  return { library: projects.readLibrary(), folder: projects.readLibrary().folders.find(f => f.id === folder.id), driveError, drive: drive_ }
})

/**
 * Asks Drive whether a library folder's twin really exists. If it has gone (deleted
 * in Drive), it is created again so the next upload has somewhere to land.
 */
async function verifyDriveFolder (folderId) {
  if (!(await driveReady())) return { connected: false }
  const folder = projects.readLibrary().folders.find(f => f.id === folderId)
  if (!folder) return { connected: true, ok: false, detail: 'That folder no longer exists in the library.' }
  let recreated = false
  if (folder.driveId) {
    try {
      const f = await drive.getFolder(folder.driveId)
      return { connected: true, ok: true, recreated, name: f.name, link: f.link, parent: driveParent().name }
    } catch (e) {
      if (e.status !== 404 && e.code !== 'DRIVE_BAD_ARGS') return { connected: true, ok: false, detail: e.message }
      projects.updateFolder(folder.id, { driveId: null })
      recreated = true
    }
  }
  try {
    const id = await driveFolderFor(folder.id)
    const f = await drive.getFolder(id)
    return { connected: true, ok: true, recreated, name: f.name, link: f.link, parent: driveParent().name }
  } catch (e) {
    return { connected: true, ok: false, detail: e.message }
  }
}

ipcMain.handle('library:verifyFolder', (_e, id) => verifyDriveFolder(id))

ipcMain.handle('library:renameFolder', async (_e, id, name) => {
  const clean = String(name || '').trim()
  if (!clean) return { library: projects.readLibrary(), driveError: null }
  const folder = projects.updateFolder(id, { name: clean })
  let driveError = null
  if (folder?.driveId && await driveReady()) {
    try { await drive.renameItem(folder.driveId, clean) } catch (e) { driveError = e.message }
  }
  return { library: projects.readLibrary(), driveError }
})

// The Drive twin is left where it is: deleting a folder here should never take
// uploaded videos with it.
ipcMain.handle('library:deleteFolder', (_e, id) => {
  projects.deleteFolder(id)
  return { library: projects.readLibrary() }
})

ipcMain.handle('library:moveProject', async (_e, projectId, folderId) => {
  const project = projects.setProjectFolder(projectId, folderId)
  let driveError = null
  // A video already in Drive follows its recording into the new folder.
  if (project.drive?.fileId && await driveReady()) {
    try {
      const target = await driveFolderFor(folderId)
      await drive.moveItem(project.drive.fileId, target)
      project.drive.folderId = target
      projects.saveProject(project, { touch: false })
    } catch (e) { driveError = e.message }
  }
  return { driveError }
})

// ---------------------------------------------------------------- IPC: drive

ipcMain.handle('drive:isConfigured', async () => {
  try { return await drive.isConfigured() } catch { return false }
})

ipcMain.handle('drive:status', async () => {
  let configured = false
  try { configured = await drive.isConfigured() } catch {}
  const d = prefs.read().drive
  return { configured, parent: d.parent || null, autoUpload: d.autoUpload !== false, account: drive.account() }
})

function forgetDriveFolders () {
  prefs.write({ drive: { parent: null } })
  for (const f of projects.readLibrary().folders) projects.updateFolder(f.id, { driveId: null })
}

// Signing in happens in the person's own browser, on Google's page.
ipcMain.handle('drive:signIn', async () => {
  const before = drive.account()
  const res = await drive.signIn(url => openInBrowser(url))
  // A different account has different folders; nothing carries over.
  if (before.connected && before.source !== 'app') forgetDriveFolders()
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus() }
  app.focus({ steal: true })
  return res
})
ipcMain.handle('drive:cancelSignIn', () => { drive.cancelSignIn(); return true })
ipcMain.handle('drive:signOut', async () => {
  await drive.signOut()
  forgetDriveFolders()
  return true
})
ipcMain.handle('drive:setClient', (_e, client) => drive.setOwnClient(client))

/**
 * Points the library at a new parent folder in Drive. Folder twins made under the
 * old parent are forgotten and matched up again, by name, under the new one.
 */
async function adoptDriveParent (parent) {
  prefs.write({ drive: { parent } })
  const lib = projects.readLibrary()
  let existing = []
  try { existing = await drive.listFolders(parent.id) } catch {}
  const errors = []
  for (const folder of lib.folders) {
    const match = existing.find(f => f.name === folder.name)
    try {
      const id = match ? match.id : (await drive.createFolder(folder.name, parent.id)).id
      projects.updateFolder(folder.id, { driveId: id })
    } catch (e) { errors.push(`${folder.name}: ${e.message}`) }
  }
  // Folders already in Drive become library folders too, so both sides match.
  const names = new Set(projects.readLibrary().folders.map(f => f.name))
  for (const f of existing) {
    if (!names.has(f.name)) projects.createFolder(f.name, { driveId: f.id })
  }
  return { parent, library: projects.readLibrary(), errors }
}

ipcMain.handle('drive:setParent', async (_e, link) => adoptDriveParent(await drive.getFolder(link)))

ipcMain.handle('drive:createParent', async (_e, name) => {
  const clean = String(name || '').trim() || 'Knight Studio'
  return adoptDriveParent(await drive.ensureFolderIn(clean, 'root').then(f => ({ id: f.id, name: f.name, link: f.link })))
})

ipcMain.handle('drive:clearParent', () => {
  prefs.write({ drive: { parent: null } })
  for (const f of projects.readLibrary().folders) projects.updateFolder(f.id, { driveId: null })
  return { parent: null, library: projects.readLibrary() }
})

ipcMain.handle('drive:test', async () => {
  let configured = false
  try { configured = await drive.isConfigured() } catch {}
  if (!configured) return { ok: false, steps: [{ name: 'Sign in to Google', ok: false, detail: 'Google Drive is not connected yet.' }] }
  return drive.testConnection(driveParent())
})

ipcMain.handle('drive:sync', async () => {
  const parent = driveParent()
  if (!parent) throw new Error('Choose a Google Drive parent folder first.')
  return adoptDriveParent(parent)
})

ipcMain.handle('drive:upload', async (event, { filePath, name, projectId }) => {
  if (!driveParent()) {
    throw new Error('Choose a Google Drive parent folder in Settings before uploading.')
  }
  let project = null
  try { project = projectId ? projects.loadProject(projectId) : null } catch {}
  const folderId = await driveFolderFor(project?.folderId || null)
  const res = await drive.uploadVideo({
    filePath,
    name,
    folderId,
    onProgress: fraction => {
      if (!event.sender.isDestroyed()) event.sender.send('drive:progress', { fraction })
    }
  })
  return res
})

// ---------------------------------------------------------------- IPC: export
//
// The renderer composites and encodes the video, streaming MP4 chunks into a temp
// file through beginTemp/writeChunk/closeTemp, then asks ffmpeg here to mix the
// project's audio onto it.

ipcMain.handle('export:mux', async (_e, args) => exporter.muxWithAudio(args))
ipcMain.handle('export:probe', async (_e, file) => exporter.probe(file))
ipcMain.handle('export:loudness', async (_e, clipDir) => exporter.clipLoudness(clipDir).catch(() => null))

ipcMain.handle('export:chooseTarget', async (_e, defaultName) => {
  // Lets an export be driven without the native save panel (used by the test harness).
  // "Save without asking": straight into the export folder, never over an existing file.
  if (prefs.read().exportDirect) {
    const dir = exportDir()
    const ext = path.extname(defaultName || '') || '.mp4'
    const base = path.basename(defaultName || 'video.mp4', ext) || 'video'
    let target = path.join(dir, base + ext)
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base} ${n}${ext}`)
    return target
  }
  if (process.env.KS_EXPORT_TO) return process.env.KS_EXPORT_TO
  return pickSave(_e, {
    defaultPath: path.join(exportDir(), defaultName || 'knight-studio.mp4'),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
  })
})

/** Where exports are offered to be saved: the folder from Settings, else Downloads. */
function exportDir () {
  const dir = prefs.read().exportDir
  if (dir) { try { fs.mkdirSync(dir, { recursive: true }); return dir } catch {} }
  return app.getPath('downloads')
}

// Streamed export writes: the renderer muxes MP4 and sends positioned chunks here.
const openFiles = new Map()

ipcMain.handle('export:beginTemp', (_e, name) => {
  const dir = path.join(app.getPath('temp'), 'knight-studio')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  const token = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  openFiles.set(token, { path: file, fd: fs.openSync(file, 'w+') })
  return { token, path: file }
})

ipcMain.handle('export:writeChunk', (_e, token, data, position) => {
  const h = openFiles.get(token)
  if (!h || h.fd == null) throw new Error('unknown export file handle')
  const buf = Buffer.from(data)
  fs.writeSync(h.fd, buf, 0, buf.length, position)
  return true
})

ipcMain.handle('export:closeTemp', (_e, token) => {
  const h = openFiles.get(token)
  if (!h) return false
  if (h.fd != null) { fs.closeSync(h.fd); h.fd = null }
  return true
})

ipcMain.handle('export:discardTemp', (_e, token) => {
  const h = openFiles.get(token)
  if (!h) return false
  try { if (h.fd != null) fs.closeSync(h.fd) } catch {}
  try { fs.unlinkSync(h.path) } catch {}
  openFiles.delete(token)
  return true
})

ipcMain.handle('file:pickAudio', async event => {
  const file = await pickOpen(event, {
    title: 'Choose background music',
    buttonLabel: 'Use this track',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'aiff', 'aif', 'flac', 'ogg', 'caf'] }]
  })
  if (!file) return null
  let hasAudio = false
  try { hasAudio = (await exporter.probe(file)).streams.some(st => st.codec_type === 'audio') } catch {}
  if (!hasAudio) throw new Error('That file has no sound in it that the app can read. Try an MP3, M4A or WAV.')
  return file
})

ipcMain.handle('file:saveText', async (event, { defaultName, text }) => {
  const target = await pickSave(event, {
    defaultPath: path.join(exportDir(), defaultName || 'subtitles.srt')
  })
  if (!target) return null
  fs.writeFileSync(target, text, 'utf8')
  return target
})

// Copying goes through the main process: the web clipboard only works while the window
// has keyboard focus, so a copy button could silently do nothing.
ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text || '')); return true })

ipcMain.handle('shell:open', (_e, p) => shell.openPath(p))
ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p))

// Web links open in Chrome when it is installed, and in the default browser otherwise.
async function openInBrowser (url) {
  if (!/^https:\/\//i.test(String(url))) return false
  if (fs.existsSync('/Applications/Google Chrome.app')) {
    try { await exporter.run('/usr/bin/open', ['-a', 'Google Chrome', String(url)]); return true } catch {}
  }
  await shell.openExternal(String(url))
  return true
}
ipcMain.handle('shell:openExternal', (_e, url) => openInBrowser(url))

// ---------------------------------------------------------------- IPC: databases
//
// Notion, Airtable and Supabase. The window can save a connection, test it, and ask for
// a finished export to be sent; the keys themselves stay in the main process.

const dbError = e => { throw new Error(String(e.message || e)) }
ipcMain.handle('databases:status', () => databases.status())
ipcMain.handle('databases:save', (_e, which, config) => { try { return databases.save(which, config) } catch (e) { dbError(e) } })
ipcMain.handle('databases:disconnect', (_e, which) => databases.disconnect(which))
ipcMain.handle('databases:test', (_e, which) => databases.test(which))

/** Everything worth telling another tool about one exported video. */
function videoRecord (projectId, { filePath, link, durationSeconds, transcript } = {}) {
  let project = null
  try { project = projects.loadProject(projectId) } catch {}
  if (!project) return null
  const folder = projects.readLibrary().folders.find(f => f.id === project.folderId)?.name || ''
  // What was said in the finished video if the editor passed it; otherwise every clip in full.
  const said = String(transcript || '').trim() || (project.clips || [])
    .map(c => { try { return transcribe.readTranscript(c.dir)?.text || '' } catch { return '' } })
    .filter(Boolean).join(' ').trim()
  return {
    id: project.id,
    title: project.name || 'Untitled video',
    link: link || project.cloud?.url || project.driveShare?.url || project.share?.url || project.drive?.link || '',
    driveLink: project.drive?.link || '',
    share: project.cloud?.url || project.driveShare?.url || project.share?.url || '',
    embed: project.cloud?.embed || project.driveShare?.embed || project.share?.embed || '',
    durationSeconds: Number(durationSeconds) || 0,
    folder,
    fileName: filePath ? path.basename(filePath) : '',
    exportedAt: new Date().toISOString(),
    transcript: said,
    summary: project.ai?.summary || '',
    chapterList: project.ai?.chapters || [],
    chapters: ai.chapterText(project.ai?.chapters)
  }
}

/** Sends one exported video to the connected databases. */
ipcMain.handle('databases:send', async (_e, { projectId, filePath, link, durationSeconds, transcript, only } = {}) => {
  const record = videoRecord(projectId, { filePath, link, durationSeconds, transcript })
  if (!record) return []
  return databases.send(record, { filePath: filePath && fs.existsSync(filePath) ? filePath : null, only: only || null })
})

// ---------------------------------------------------------------- IPC: webhook

const friendly = fn => async (...args) => { try { return await fn(...args) } catch (e) { throw new Error(String(e.message || e)) } }
ipcMain.handle('webhook:status', () => webhook.status())
ipcMain.handle('webhook:save', friendly((_e, patch) => webhook.save(patch)))
ipcMain.handle('webhook:disconnect', () => webhook.disconnect())
ipcMain.handle('webhook:test', () => webhook.test())
ipcMain.handle('webhook:send', async (_e, { projectId, filePath, durationSeconds, transcript } = {}) => {
  const r = videoRecord(projectId, { filePath, durationSeconds, transcript })
  if (!r) return { which: 'webhook', name: 'Webhook', ok: false, detail: 'The video could not be read.' }
  return webhook.send({
    id: r.id, title: r.title, folder: r.folder, fileName: r.fileName, durationSeconds: r.durationSeconds, exportedAt: r.exportedAt,
    driveLink: r.driveLink, shareLink: r.share, embedCode: r.embed, summary: r.summary, chapters: r.chapterList, chaptersText: r.chapters,
    transcript: r.transcript
  })
})

// ---------------------------------------------------------------- IPC: share pages in Google Drive

/**
 * Makes or refreshes a video's Drive share page. Uploads the export to Drive first if
 * this video is not there yet, so it works from the library as well as after an export.
 */
async function publishDriveShare (event, projectId, { filePath, duration, aspect, cues } = {}) {
  if (!(await driveReady())) throw new Error('Connect Google Drive and choose a parent folder in Settings first.')
  let project = projects.loadProject(projectId)
  const last = project.lastExport || {}
  const file = filePath || (last.path && fs.existsSync(last.path) ? last.path : null)
  let videoId = project.drive?.fileId || null
  if (videoId && !(await drive.exists(videoId))) videoId = null
  if (!videoId) {
    if (!file) throw new Error('Export the video first — the share page plays the exported file.')
    const folderId = await driveFolderFor(project.folderId || null)
    const res = await drive.uploadVideo({
      filePath: file, name: path.basename(file), folderId,
      onProgress: fraction => { if (!event.sender.isDestroyed()) event.sender.send('share:progress', { projectId, phase: 'uploading', fraction }) }
    })
    project = projects.loadProject(projectId)
    project.drive = { fileId: res.id, link: res.webViewLink, folderId: res.folderId, uploadedAt: new Date().toISOString() }
    projects.saveProject(project, { touch: false })
    videoId = res.id
  }
  // Google takes a little while to prepare a new upload for playback. If this video
  // already has a page playing an earlier copy, keep that one on screen until the new
  // copy is ready, then switch — so the link never shows "still processing".
  const prev = project.driveShare || null
  const args = { project, parentId: driveParent().id, filePath: file, duration: duration ?? last.duration, aspect: aspect ?? last.aspect, cues: cues || last.cues || [] }
  const ready = await drive.playable(videoId)
  const holdOld = !ready && prev?.videoId && prev.videoId !== videoId && await drive.playable(prev.videoId)
  const out = await driveShare.publish({ ...args, videoId: holdOld ? prev.videoId : videoId })
  const save = page => { const fresh = projects.loadProject(projectId); fresh.driveShare = page; projects.saveProject(fresh, { touch: false }); return fresh }
  const fresh = save({ ...out, ready: holdOld ? true : ready, ...(holdOld ? { pendingVideoId: videoId } : {}) })
  watchDrivePage(event.sender, projectId, videoId, holdOld ? args : null)
  return { ...fresh.driveShare, drive: fresh.drive }
}

const driveWatchers = new Map()
/** Waits for Google to finish preparing a video, then marks its page ready (switching it to the new copy if it was held back). */
function watchDrivePage (sender, projectId, videoId, swapArgs) {
  clearInterval(driveWatchers.get(projectId))
  let tries = 0
  const timer = setInterval(async () => {
    tries++
    let ok = false
    try { ok = await drive.playable(videoId) } catch {}
    if (!ok && tries < 240) return
    clearInterval(timer); driveWatchers.delete(projectId)
    if (!ok) return
    try {
      let project = projects.loadProject(projectId)
      if (!project.driveShare) return
      if (swapArgs && project.driveShare.pendingVideoId === videoId) {
        const out = await driveShare.publish({ ...swapArgs, project, videoId })
        project = projects.loadProject(projectId)
        project.driveShare = { ...out, ready: true }
      } else {
        project.driveShare = { ...project.driveShare, ready: true }
      }
      projects.saveProject(project, { touch: false })
      if (!sender.isDestroyed()) sender.send('driveShare:changed', { projectId, page: project.driveShare })
    } catch {}
  }, Number(process.env.KS_DRIVE_POLL_MS) || 8000)
  driveWatchers.set(projectId, timer)
}
ipcMain.handle('driveShare:publish', friendly((event, { projectId, ...rest } = {}) => publishDriveShare(event, projectId, rest)))
ipcMain.handle('driveShare:unpublish', friendly(async (_e, projectId) => {
  const project = projects.loadProject(projectId)
  await driveShare.unpublish(project.driveShare)
  delete project.driveShare
  projects.saveProject(project, { touch: false })
  return true
}))
ipcMain.handle('driveShare:ready', () => driveReady())

// ---------------------------------------------------------------- IPC: sharing with people

ipcMain.handle('cloud:status', () => cloud.status())
ipcMain.handle('cloud:save', (_e, patch) => cloud.save(patch))
ipcMain.handle('cloud:requestCode', friendly((_e, email) => cloud.requestCode(email)))
ipcMain.handle('cloud:verify', friendly((_e, email, code) => cloud.verify(email, code)))
ipcMain.handle('cloud:refresh', friendly(() => cloud.refreshProfile()))
ipcMain.handle('cloud:signOut', () => cloud.signOut())
ipcMain.handle('cloud:publish', friendly(async (event, { projectId, filePath, duration, aspect, cues } = {}) => {
  const project = projects.loadProject(projectId)
  const folder = projects.readLibrary().folders.find(f => f.id === project.folderId)?.name || ''
  return cloud.publish({
    project, filePath, duration, aspect, cues, folder,
    onProgress: (phase, fraction) => { if (!event.sender.isDestroyed()) event.sender.send('share:progress', { projectId, phase, fraction }) }
  })
}))
ipcMain.handle('cloud:links', (_e, id, aspect) => ({ url: cloud.linkFor(id), embed: cloud.embedFor(id, aspect) }))
/** Forgets a video's place on the sharing service in whichever local recording it belonged to. */
function forgetCloud (id) {
  for (const item of projects.listProjects()) {
    try {
      const p = projects.loadProject(item.id)
      if (p.cloud?.id === id) { delete p.cloud; projects.saveProject(p, { touch: false }) }
    } catch {}
  }
}
ipcMain.handle('cloud:remove', friendly(async (_e, id) => { const r = await cloud.remove(id); forgetCloud(id); return r }))

/**
 * The Share button on a video in the library. Does the most useful thing available:
 *   signed in to sharing      → uploads the last export if it is not there yet, then the Share box opens
 *   a share page already made → copies its link
 *   share pages set up        → makes the page from the last export and copies its link
 *   only a Drive link         → copies that
 * and otherwise says what is needed first.
 */
ipcMain.handle('share:forProject', friendly(async (event, projectId) => {
  const project = projects.loadProject(projectId)
  const last = project.lastExport
  const file = last?.path && fs.existsSync(last.path) ? last.path : null
  const folder = projects.readLibrary().folders.find(f => f.id === project.folderId)?.name || ''
  const progress = (phase, fraction) => { if (!event.sender.isDestroyed()) event.sender.send('share:progress', { projectId, phase, fraction }) }
  const cl = cloud.status()

  if (cl.signedIn) {
    if (project.cloud?.id) {
      // It may have been taken down from the Sharing screen on another Mac.
      try { await cloud.sharing(project.cloud.id); return { kind: 'box', id: project.cloud.id } } catch { delete project.cloud }
    }
    if (!file) return { kind: 'export' }
    const res = await cloud.publish({ project, filePath: file, duration: last.duration, aspect: last.aspect, cues: last.cues || [], folder, onProgress: progress })
    const fresh = projects.loadProject(projectId)
    fresh.cloud = res
    projects.saveProject(fresh, { touch: false })
    return { kind: 'box', id: res.id, uploaded: true }
  }
  if (project.driveShare?.url) { clipboard.writeText(project.driveShare.url); return { kind: 'copied', what: 'Share link', url: project.driveShare.url } }
  if (project.share?.url) { clipboard.writeText(project.share.url); return { kind: 'copied', what: 'Share link', url: project.share.url } }
  // Google Drive connected: that is all a share page needs.
  if (await driveReady()) {
    if (!file && !project.drive?.fileId) return { kind: 'export' }
    const res = await publishDriveShare(event, projectId, {})
    clipboard.writeText(res.url)
    return { kind: 'copied', what: 'Share link', url: res.url, made: true }
  }
  if (cl.enabled) return { kind: 'signin' }
  if (share.status().ready) {
    if (!file) return { kind: 'export' }
    const res = await share.publish({ project, filePath: file, duration: last.duration, aspect: last.aspect, cues: last.cues || [], onProgress: progress })
    const fresh = projects.loadProject(projectId)
    fresh.share = res
    projects.saveProject(fresh, { touch: false })
    clipboard.writeText(res.url)
    return { kind: 'copied', what: 'Share link', url: res.url, made: true }
  }
  if (project.drive?.link) { clipboard.writeText(project.drive.link); return { kind: 'copied', what: 'Google Drive link', url: project.drive.link } }
  return { kind: 'setup' }
}))
ipcMain.handle('cloud:sharing', friendly((_e, id) => cloud.sharing(id)))
ipcMain.handle('cloud:share', friendly((_e, id, emails, opts) => cloud.share(id, emails, opts)))
ipcMain.handle('cloud:unshare', friendly((_e, id, email, folder) => cloud.unshare(id, email, folder)))
ipcMain.handle('cloud:setAccess', friendly((_e, id, access) => cloud.setAccess(id, access)))
ipcMain.handle('cloud:videos', friendly(() => cloud.videos()))
ipcMain.handle('cloud:people', friendly(() => cloud.people()))
ipcMain.handle('cloud:removePerson', friendly((_e, email) => cloud.removePerson(email)))
ipcMain.handle('cloud:team', friendly(() => cloud.team()))
ipcMain.handle('cloud:setMember', friendly((_e, email, role) => cloud.setMember(email, role)))
ipcMain.handle('cloud:removeMember', friendly((_e, email) => cloud.removeMember(email)))
ipcMain.handle('cloud:renameWorkspace', friendly((_e, name) => cloud.renameWorkspace(name)))

// ---------------------------------------------------------------- IPC: share pages

ipcMain.handle('share:status', () => share.status())
ipcMain.handle('share:save', friendly((_e, patch) => share.save(patch)))
ipcMain.handle('share:test', () => share.test())
ipcMain.handle('share:publish', friendly(async (event, { projectId, filePath, duration, aspect, cues } = {}) => {
  const project = projects.loadProject(projectId)
  return share.publish({
    project, filePath, duration, aspect, cues,
    onProgress: (phase, fraction) => { if (!event.sender.isDestroyed()) event.sender.send('share:progress', { projectId, phase, fraction }) }
  })
}))
ipcMain.handle('share:unpublish', friendly((_e, info) => share.unpublish(info)))
ipcMain.handle('share:stats', friendly((_e, id) => share.stats(id)))

// ---------------------------------------------------------------- IPC: chapters, summary, written SOP

ipcMain.handle('ai:analyse', friendly((_e, { title, lines, duration } = {}) => ai.analyse({ title, lines, duration })))

/** Prints an HTML file to PDF in a window nobody sees. */
async function htmlToPdf (htmlPath, pdfPath) {
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, javascript: false } })
  try {
    await win.loadFile(htmlPath)
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', preferCSSPageSize: true })
    fs.writeFileSync(pdfPath, pdf)
  } finally {
    win.destroy()
  }
}

ipcMain.handle('sop:build', friendly(async (_e, { projectId, videoPath, duration } = {}) => {
  const project = projects.loadProject(projectId)
  if (!project.ai?.steps?.length) throw new Error('Write the chapters and summary first — the steps come from the same reading of the video.')
  const dir = videoPath && fs.existsSync(videoPath) ? path.dirname(videoPath) : path.join(projects.projectDir(projectId), 'exports')
  const name = (project.name || 'Untitled video').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return sop.build({
    title: project.name || 'Untitled video',
    summary: project.ai.summary,
    steps: project.ai.steps,
    videoPath, duration,
    outBase: path.join(dir, `${name} - SOP`),
    shareUrl: project.share?.url || project.drive?.link || '',
    toPdf: htmlToPdf
  })
}))

// ---------------------------------------------------------------- IPC: templates

ipcMain.handle('templates:list', () => templates.list())
ipcMain.handle('templates:save', friendly((_e, name, projectId) => templates.save(name, projects.loadProject(projectId))))
ipcMain.handle('templates:remove', (_e, id) => templates.remove(id))
ipcMain.handle('templates:setDefault', (_e, id) => templates.setDefault(id))
ipcMain.handle('templates:get', (_e, id) => templates.get(id))

// ---------------------------------------------------------------- IPC: updates

ipcMain.handle('updates:status', () => updates.status())
ipcMain.handle('updates:save', (_e, patch) => updates.save(patch))
ipcMain.handle('updates:check', friendly(() => updates.check()))
ipcMain.handle('updates:download', friendly(() => updates.download()))
ipcMain.handle('updates:install', friendly(() => {
  if (session) throw new Error('Stop the recording first, then update.')
  return updates.install()
}))
updates.onChange(st => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:changed', st) })

// ---------------------------------------------------------------- IPC: captions + AI titles

ipcMain.handle('captions:status', async () => {
  let env = { ok: false }
  try { env = await transcribe.checkEnvironment() } catch {}
  return { ok: !!env.ok, engine: env.engine || null, ...whisper.status(), chosen: prefs.read().captions.model }
})

ipcMain.handle('captions:downloadModel', async (event, name) => {
  await whisper.ensureModel(name, fraction => {
    if (!event.sender.isDestroyed()) event.sender.send('captions:modelProgress', { name, fraction })
  })
  prefs.write({ captions: { model: name } })
  return whisper.status()
})

ipcMain.handle('captions:removeModel', (_e, name) => { whisper.removeModel(name); return whisper.status() })

// Keys are write-only from the window's side: it can set or clear one and ask
// whether one exists, but never read it back.
const AI_KEYS = { anthropic: 'anthropicKey', gemini: 'geminiKey' }
ipcMain.handle('ai:status', async () => ({
  anthropic: secrets.has('anthropicKey'),
  gemini: secrets.has('geminiKey'),
  any: await titler.isConfigured()
}))
ipcMain.handle('ai:setKey', (_e, which, value) => {
  if (!AI_KEYS[which]) return false
  secrets.set(AI_KEYS[which], String(value || '').trim() || null)
  return true
})

// ---------------------------------------------------------------- IPC: system check

/** Everything the app depends on, in one list, so a problem is visible rather than silent. */
ipcMain.handle('system:check', async () => {
  let devices = null
  try { devices = await capture.listDevices() } catch {}
  let stt = { ok: false }
  try { stt = await transcribe.checkEnvironment() } catch {}
  let ffmpegOk = false
  try { await exporter.run(tools.tool('ffmpeg'), ['-version']); ffmpegOk = true } catch {}
  let engineOk = false
  try { capture.binaryPath(); engineOk = true } catch {}
  return {
    version: app.getVersion(),
    macos: process.getSystemVersion(),
    arch: process.arch,
    packaged: app.isPackaged,
    engine: engineOk,
    ffmpeg: ffmpegOk,
    captions: { ok: !!stt.ok, engine: stt.engine || null, model: whisper.pickModel() },
    permissions: devices?.permissions || null,
    cameras: devices?.cameras?.length ?? 0,
    microphones: devices?.microphones?.length ?? 0,
    drive: drive.account(),
    libraryDir: projects.root()
  }
})

// ---------------------------------------------------------------- IPC: overlay

ipcMain.handle('overlay:resize', (_e, { width, height }) => {
  if (!overlayWindow) return false
  const b = overlayWindow.getBounds()
  overlayWindow.setBounds({ ...b, width: Math.round(width), height: Math.round(height) })
  return true
})

/**
 * Earlier versions uploaded into a "Knight Studio" folder at the top of My Drive
 * without asking. If this account has that folder and no parent has been chosen yet,
 * it becomes the parent, so uploads carry on landing where they always did. Checked
 * once; after that the parent is whatever Settings says.
 */
async function adoptLegacyDriveFolder () {
  const p = prefs.read()
  if (p.drive.parent || p.drive.legacyChecked) return
  if (!(await drive.isConfigured())) return
  const legacy = await drive.findLegacyFolder()
  prefs.write({ drive: { legacyChecked: true } })
  if (legacy) await adoptDriveParent(legacy)
}

// ---------------------------------------------------------------- app lifecycle

app.whenReady().then(() => {
  projects.ensureRoot()
  updates.startAutomaticChecks()

  // Serve only from inside the projects root — never arbitrary paths from the page.
  //
  // Range support is not optional here: without Content-Length / Accept-Ranges and a
  // real 206, Chromium treats the response as an unseekable stream, and the editor can
  // neither scrub nor render frames for export. Ranges are handled directly rather than
  // delegated, because net.fetch over file:// does not turn a Range request into a 206.
  const MIME = {
    '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4a': 'audio/mp4',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
    '.svg': 'image/svg+xml'
  }

  createMainWindow()

  protocol.handle('knight', request => {
    try {
      const filePath = path.normalize(decodeURIComponent(new URL(request.url).pathname))
      const allowed = [projects.root(), prefs.SETTINGS_DIR]
      if (!allowed.some(dir => filePath === dir || filePath.startsWith(dir + path.sep))) {
        return new Response('forbidden', { status: 403 })
      }
      if (!fs.existsSync(filePath)) return new Response('not found', { status: 404 })

      const size = fs.statSync(filePath).size
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
      const base = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }

      const range = request.headers.get('range') || request.headers.get('Range')
      const m = range && /bytes=(\d*)-(\d*)/.exec(range)
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0
        let end = m[2] ? parseInt(m[2], 10) : size - 1
        if (Number.isNaN(start) || start < 0) start = 0
        if (Number.isNaN(end) || end >= size) end = size - 1
        if (start > end) {
          return new Response('range not satisfiable', {
            status: 416,
            headers: { ...base, 'Content-Range': `bytes */${size}` }
          })
        }
        return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
          status: 206,
          headers: {
            ...base,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`
          }
        })
      }

      return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
        status: 200,
        headers: { ...base, 'Content-Length': String(size) }
      })
    } catch (e) {
      return new Response(String(e), { status: 400 })
    }
  })

  buildDockMenu()
  adoptLegacyDriveFolder().catch(() => {})

  // Start or stop from anywhere, without going to the app first.
  // Cmd+Shift+5 and 6 belong to macOS screenshots, so 7 and 8 are used here.
  const shortcuts = [
    ['CommandOrControl+Shift+7', () => quickRecord({ withCamera: false }).catch(() => {})],
    ['CommandOrControl+Shift+8', () => {
      if (session) stopRecording().catch(() => {})
      else quickRecord({ withCamera: true }).catch(() => {})
    }]
  ]
  for (const [accel, fn] of shortcuts) {
    const ok = globalShortcut.register(accel, fn)
    if (process.env.KS_DEBUG || !ok) {
      console.log(`[shortcut] ${accel}: ${ok ? 'registered' : 'FAILED (already taken by another app)'}`)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    else mainWindow?.show()
  })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  // Never leave an orphaned capture process holding the screen.
  if (session) session.stop()
})
