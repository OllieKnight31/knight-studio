'use strict'
const fs = require('node:fs')
const path = require('node:path')
const prefs = require('./prefs')

// The recordings folder is a setting, so it is looked up each time rather than fixed.
function root () { return prefs.libraryDir() }
function ensureRoot () { const r = root(); fs.mkdirSync(r, { recursive: true }); return r }
function projectDir (id) { return path.join(root(), id) }
function newId (prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Defaults for a new project. Option names and value ranges mirror the feature set
 * documented in research/ so the editor UI maps 1:1 onto what the reference product does.
 */
function defaultProject (name) {
  return {
    version: 1,
    id: newId('prj'),
    name: name || 'Untitled recording',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas: { preset: 'auto', width: 1920, height: 1080 },
    background: {
      type: 'gradient',
      colors: ['#0B0B0F', '#1C1F2B'],
      angle: 135,
      image: null,
      blur: 0
    },
    style: {
      padding: 0.06,        // fraction of the smaller canvas edge
      radius: 18,           // px at 1080p, scaled with canvas
      shadow: 0.45,         // 0..1
      borderWidth: 0,
      borderColor: '#FFFFFF33',
      screenFit: 'fill'     // fill | fit
    },
    camera: {
      shape: 'circle',      // circle | rounded | square
      size: 0.22,           // fraction of canvas height
      position: 'bottom-right',
      offset: { x: 0.04, y: 0.04 },
      mirrored: true,
      borderWidth: 0,
      borderColor: '#FFFFFF'
    },
    cursor: {
      animated: true,
      style: 'macos',       // macos | windows | touch
      size: 1.0,            // 0.5 .. 2.0
      smoothing: 0.55,      // 0..1
      tilt: 0.25,           // 0..1
      clickSpring: 0.6,     // 0..1
      clickRipple: 0.5,     // 0..1
      hideWhenInactive: false,
      returnToStart: false
    },
    autoZoom: {
      style: 'adaptive',    // adaptive | subtle | moderate | intense
      applyOnRecord: true
    },
    subtitles: {
      enabled: false,
      font: 'Inter',
      size: 46,
      weight: 800,
      color: '#FFFFFF',
      highlight: '#C8A24A',
      background: 'rgba(0,0,0,0.55)',
      position: 0.86,
      oneWordAtATime: false,
      uppercase: false
    },
    audio: { micGain: 1.0, systemGain: 0.6, music: null, musicGain: 0.15 },
    folderId: null,       // library folder, null = not filed
    overlays: [],
    clips: []
  }
}

function listProjects () {
  const ROOT = ensureRoot()
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('prj_'))
    .map(d => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(ROOT, d.name, 'project.json'), 'utf8'))
        const first = p.clips[0] || null
        return {
          id: p.id,
          name: p.name,
          updatedAt: p.updatedAt,
          clips: p.clips.length,
          dir: path.join(ROOT, d.name),
          folderId: p.folderId || null,
          driveLink: p.drive?.link || null,
          // For the Share button on the card.
          shared: !!(p.cloud?.id || p.driveShare?.url || p.share?.url),
          exported: !!p.lastExport?.path,
          // The library needs a frame to show; hand it the first clip to thumbnail.
          firstClipDir: first ? path.join(ROOT, d.name, 'clips', first.id) : null,
          duration: p.clips.reduce((t, c) => t + (c.duration || 0), 0),
          hasCamera: p.clips.some(c => c.hasCamera)
        }
      } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

function createProject (name, folderId = null) {
  ensureRoot()
  // Starts with the look saved as the default template, if there is one.
  const p = require('./templates').applyDefault(defaultProject(name))
  p.folderId = folderId || null
  const dir = projectDir(p.id)
  fs.mkdirSync(path.join(dir, 'clips'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'exports'), { recursive: true })
  saveProject(p)
  return p
}

function loadProject (id) {
  const p = JSON.parse(fs.readFileSync(path.join(projectDir(id), 'project.json'), 'utf8'))
  // Clip folders are always inside the project, so their paths are derived rather
  // than trusted: a library that has been moved keeps working without a rewrite.
  for (const c of p.clips || []) c.dir = path.join(projectDir(id), 'clips', c.id)
  if (!Array.isArray(p.overlays)) p.overlays = []
  return p
}

function saveProject (p, { touch = true } = {}) {
  // Filing a video in a folder is not an edit, so it leaves the "last edited" time alone.
  if (touch || !p.updatedAt) p.updatedAt = new Date().toISOString()
  const dir = projectDir(p.id)
  fs.mkdirSync(dir, { recursive: true })
  // Write-then-rename so a crash mid-save can never truncate an existing project.
  const tmp = path.join(dir, 'project.json.tmp')
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2))
  fs.renameSync(tmp, path.join(dir, 'project.json'))
  return p
}

function deleteProject (id) {
  fs.rmSync(projectDir(id), { recursive: true, force: true })
}

/** Allocates the directory a new clip's raw capture files will be written into. */
function newClipDir (projectId) {
  const clipId = newId('clip')
  const dir = path.join(projectDir(projectId), 'clips', clipId)
  fs.mkdirSync(dir, { recursive: true })
  return { clipId, dir }
}

/** Reads a clip's cursor/click log. Returns [] when the clip has no event data. */
function readEvents (clipDir) {
  const f = path.join(clipDir, 'events.jsonl')
  if (!fs.existsSync(f)) return []
  const out = []
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* skip partial trailing line */ }
  }
  return out
}

/**
 * Builds a clip entry from whatever a capture left on disk.
 * `manifest` may be null when a recording was interrupted before it finalised.
 */
function clipFromDisk (clipId, clipDir, manifest, probed) {
  const duration = manifest?.duration ?? probed?.duration ?? 0
  return {
    id: clipId,
    dir: clipDir,
    createdAt: manifest?.createdAt || fs.statSync(clipDir).birthtime.toISOString(),
    duration,
    width: manifest?.width ?? probed?.width ?? 0,
    height: manifest?.height ?? probed?.height ?? 0,
    hasCamera: manifest ? !!manifest.camera : fs.existsSync(path.join(clipDir, 'camera.mov')),
    hasSystemAudio: !!manifest?.audio?.system,
    hasMic: !!manifest?.audio?.microphone,
    cameraStartOffset: manifest?.cameraStartOffset ?? 0,
    layout: (manifest ? !!manifest.camera : fs.existsSync(path.join(clipDir, 'camera.mov'))) ? 'bubble' : 'screen',
    trim: { in: 0, out: duration },
    cuts: [],
    zooms: [],
    autoZoomApplied: false,
    recovered: true
  }
}

/**
 * Adopts any capture on disk that never made it into project.json.
 *
 * A recording that finishes writing its files but is interrupted before the project
 * is saved — the app quit, a crash, a forced stop — would otherwise leave a complete
 * take stranded on disk while the editor showed an empty canvas. Recovery runs on
 * every load, so a finished recording is never lost.
 */
async function recoverClips (project) {
  const dir = path.join(projectDir(project.id), 'clips')
  if (!fs.existsSync(dir)) return project

  const known = new Set(project.clips.map(c => c.id))
  const found = []

  for (const clipId of fs.readdirSync(dir)) {
    if (known.has(clipId)) continue
    const clipDir = path.join(dir, clipId)
    try {
      if (!fs.statSync(clipDir).isDirectory()) continue
      const screen = path.join(clipDir, 'screen.mov')
      // Anything smaller than this never got a usable frame written.
      if (!fs.existsSync(screen) || fs.statSync(screen).size < 8192) continue

      let manifest = null
      try { manifest = JSON.parse(fs.readFileSync(path.join(clipDir, 'manifest.json'), 'utf8')) } catch {}

      let probed = null
      if (!manifest) {
        // No manifest: the capture was cut short. Ask ffprobe what actually landed.
        try {
          const { probe } = require('./export')
          const info = await probe(screen)
          const v = info.streams?.find(st => st.codec_type === 'video')
          probed = {
            duration: Number(info.format?.duration) || 0,
            width: v?.width ?? 0,
            height: v?.height ?? 0
          }
        } catch { probed = null }
      }

      const clip = clipFromDisk(clipId, clipDir, manifest, probed)
      if (clip.duration > 0.05) found.push(clip)
    } catch { /* skip anything unreadable */ }
  }

  let changed = false
  if (found.length) {
    project.clips = [...project.clips, ...found]
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    changed = true
  }
  // Housekeeping is not an edit: it must not push an old video to the top of the library.
  const adopted = changed
  if (await reconcileCameraOffsets(project)) changed = true
  return changed ? saveProject(project, { touch: adopted }) : project
}

/**
 * Makes sure every camera clip knows where its camera sits on the timeline.
 *
 * Takes recorded by the current engine carry a measured offset. Older takes carry one
 * that is roughly a second short: the camera file began about a second after it was
 * asked to and nothing recorded that. For those, the true offset is at least the
 * difference in length between the two files (they stopped together), so that is
 * applied straight away as a floor, and `cameraSync: 'estimated'` flags the clip for
 * the precise alignment in camsync.js.
 */
async function reconcileCameraOffsets (project) {
  let changed = false
  for (const clip of project.clips) {
    if (!clip.hasCamera || clip.cameraSync) continue
    let manifest = null
    try { manifest = JSON.parse(fs.readFileSync(path.join(clip.dir, 'manifest.json'), 'utf8')) } catch {}
    if (manifest?.cameraSync === 'host-clock') {
      clip.cameraStartOffset = manifest.cameraStartOffset ?? 0
      clip.cameraSync = 'measured'
      changed = true
      continue
    }
    try {
      const { probe } = require('./export')
      const scr = await probe(path.join(clip.dir, 'screen.mov'))
      const cam = await probe(path.join(clip.dir, 'camera.mov'))
      const audio = (scr.streams || []).filter(st => st.codec_type === 'audio').map(st => Number(st.duration) || 0)
      const screenLen = audio.length ? Math.max(...audio) : Number(scr.format?.duration) || clip.duration
      const camLen = Number(cam.format?.duration) || 0
      if (camLen > 0) {
        clip.cameraStartOffset = Math.max(0, Math.min(5, screenLen - camLen + 0.2))
        clip.cameraSync = 'estimated'
        changed = true
      }
    } catch { /* leave the clip as it was; it is retried on the next load */ }
  }
  return changed
}

/* ---------------------------------------------------------------- folders */

// Library folders are a label on each project plus a small index beside the
// recordings. Projects are not moved on disk when they are filed — only the label
// changes — so filing is instant and can never lose a recording.
function libraryFile () { return path.join(ensureRoot(), 'library.json') }

function readLibrary () {
  try {
    const lib = JSON.parse(fs.readFileSync(libraryFile(), 'utf8'))
    return { folders: Array.isArray(lib.folders) ? lib.folders : [] }
  } catch { return { folders: [] } }
}

function writeLibrary (lib) {
  const tmp = libraryFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(lib, null, 2))
  fs.renameSync(tmp, libraryFile())
  return lib
}

function createFolder (name, extra = {}) {
  const lib = readLibrary()
  const folder = { id: newId('fld'), name: String(name || 'New folder').trim() || 'New folder', createdAt: new Date().toISOString(), driveId: null, ...extra }
  lib.folders.push(folder)
  writeLibrary(lib)
  return folder
}

function updateFolder (id, patch) {
  const lib = readLibrary()
  const folder = lib.folders.find(f => f.id === id)
  if (!folder) return null
  Object.assign(folder, patch)
  writeLibrary(lib)
  return folder
}

/** Removes a folder. Its videos are kept and simply become unfiled. */
function deleteFolder (id) {
  const lib = readLibrary()
  const folder = lib.folders.find(f => f.id === id) || null
  lib.folders = lib.folders.filter(f => f.id !== id)
  writeLibrary(lib)
  for (const p of listProjects()) {
    if (p.folderId !== id) continue
    try { const full = loadProject(p.id); full.folderId = null; saveProject(full, { touch: false }) } catch {}
  }
  return folder
}

function setProjectFolder (projectId, folderId) {
  const p = loadProject(projectId)
  p.folderId = folderId || null
  return saveProject(p, { touch: false })
}

/**
 * Moves every recording to a new library folder. Rename when the destination is on
 * the same volume (instant), copy-then-delete when it is not.
 */
async function moveLibrary (toDir, onProgress) {
  const from = ensureRoot()
  const to = path.resolve(toDir)
  if (to === from) return { moved: 0 }
  if (to.startsWith(from + path.sep)) throw new Error('The new location cannot be inside the current one.')
  fs.mkdirSync(to, { recursive: true })
  const entries = fs.readdirSync(from).filter(n => n.startsWith('prj_') || n === 'library.json')
  let moved = 0
  for (const name of entries) {
    const src = path.join(from, name)
    const dst = path.join(to, name)
    if (fs.existsSync(dst)) { moved++; continue }
    try {
      fs.renameSync(src, dst)
    } catch (e) {
      if (e.code !== 'EXDEV') throw e
      await fs.promises.cp(src, dst, { recursive: true })
      await fs.promises.rm(src, { recursive: true, force: true })
    }
    moved++
    if (onProgress) onProgress(moved / entries.length)
  }
  return { moved }
}

module.exports = {
  root, ensureRoot, projectDir, newId, defaultProject,
  listProjects, createProject, loadProject, saveProject, deleteProject,
  newClipDir, readEvents, recoverClips, clipFromDisk, reconcileCameraOffsets,
  readLibrary, createFolder, updateFolder, deleteFolder, setProjectFolder, moveLibrary
}
