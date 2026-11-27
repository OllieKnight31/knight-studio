'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// Settings live outside the recordings folder, because the recordings folder is itself
// a setting — it can be moved, and the app still has to find its settings afterwards.
// The app was called Knight Studio before 0.13.0. A Mac that already has the old folders
// keeps using them (nothing is moved or copied); a new install gets the Ainable Studio names.
const pickDir = (base, name, oldName) => {
  const fresh = path.join(base, name), old = path.join(base, oldName)
  return !fs.existsSync(fresh) && fs.existsSync(old) ? old : fresh
}
const SUPPORT_DIR = pickDir(path.join(os.homedir(), 'Library', 'Application Support'), 'Ainable Studio', 'Knight Studio')
const FILE = path.join(SUPPORT_DIR, 'settings.json')
const LEGACY_FILE = path.join(os.homedir(), 'Movies', 'Knight Studio', 'preferences.json')
const DEFAULT_LIBRARY = pickDir(path.join(os.homedir(), 'Movies'), 'Ainable Studio', 'Knight Studio')

// The app wears one brand — Ainable's — and it is not a setting. Anything an older
// version saved under `brand` is ignored.
const BRAND = Object.freeze({
  name: 'Ainable Studio',
  accent: '#F5F5F7',    // bone
  surface: '#0A0A0B'    // night
})

const DEFAULTS = {
  // Last recorder setup, so one-click recording from the Dock behaves the way the
  // last real recording did rather than guessing.
  lastRecording: {
    displayId: null,
    windowId: null,
    cameraId: null,
    micId: null,
    systemAudio: true,
    fps: 60
  },
  countdown: 3,
  // Keeping the app running is what makes the Dock quick-actions and the global
  // hotkeys available at any moment rather than only after you launch it.
  openAtLogin: true,
  brand: BRAND,
  libraryDir: null,      // null = ~/Movies/Ainable Studio
  exportDir: null,       // null = ~/Downloads
  // true = Export saves straight into the export folder, with no save window.
  exportDirect: false,
  // Google Drive. Nothing is uploaded until a parent folder has been chosen: every
  // library folder and every video is created inside it.
  drive: { parent: null, autoUpload: true },
  // Milliseconds added to every camera's position on the timeline. Timestamps put the
  // camera where the hardware says it was; some webcams report late, and this corrects it.
  cameraDelayMs: 0,
  // Which speech model captions use: 'base' (quick) or 'small' (more accurate, bigger download).
  // Set once the first-run system check has been shown.
  welcomed: false,
  // Walkthroughs already shown, by id, plus `disabled` to stop them starting by themselves.
  tours: {},
  // Database connections (Notion, Airtable, Supabase). Keys live in secrets.json, not here.
  databases: {},
  // Share pages: `auto` makes one after every export; `viewer` overrides the page they open on.
  share: { auto: true },
  // One address that is told about every export (Zapier, Make, n8n…). The signing secret lives in secrets.json.
  webhook: {},
  // Saved looks, and the one new videos start with.
  templates: [],
  defaultTemplate: null,
  updates: { auto: true },
  captions: { model: 'base' },
  // Optional dotenv-style file to read AI keys from, for people who keep them in one place.
  ai: { envFile: null }
}

function readRaw () {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch {}
  // First run after the move: carry the old preferences across.
  try { return JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8')) } catch {}
  return {}
}

function read () {
  const raw = readRaw()
  return {
    ...DEFAULTS,
    ...raw,
    lastRecording: { ...DEFAULTS.lastRecording, ...(raw.lastRecording || {}) },
    brand: { ...BRAND },
    drive: { ...DEFAULTS.drive, ...(raw.drive || {}) },
    captions: { ...DEFAULTS.captions, ...(raw.captions || {}) },
    ai: { ...DEFAULTS.ai, ...(raw.ai || {}) },
    tours: { ...(raw.tours || {}) },
    databases: { ...(raw.databases || {}) },
    share: { ...DEFAULTS.share, ...(raw.share || {}) },
    webhook: { ...(raw.webhook || {}) },
    templates: Array.isArray(raw.templates) ? raw.templates : [],
    updates: { ...DEFAULTS.updates, ...(raw.updates || {}) }
  }
}

function write (patch) {
  const cur = read()
  const next = { ...cur, ...patch }
  next.brand = { ...BRAND }
  // Nested groups merge, so saving one value does not wipe its neighbours.
  for (const key of ['drive', 'lastRecording', 'captions', 'ai', 'tours']) {
    if (patch && patch[key]) next[key] = { ...cur[key], ...patch[key] }
  }
  // `toursReset` wipes the record of which walkthroughs have been seen.
  if (patch && patch.toursReset) {
    next.tours = {}
    delete next.toursReset
  }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    const tmp = FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, FILE)
  } catch { /* preferences are a convenience; never fail a recording over them */ }
  return next
}

/** Where recordings are kept. */
function libraryDir () {
  const dir = read().libraryDir
  return dir && typeof dir === 'string' ? dir : DEFAULT_LIBRARY
}

module.exports = { read, write, libraryDir, FILE, DEFAULTS, BRAND, DEFAULT_LIBRARY, SETTINGS_DIR: path.dirname(FILE) }
