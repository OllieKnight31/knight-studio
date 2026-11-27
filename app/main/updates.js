'use strict'
/**
 * Updates.
 *
 * The app looks at a small "what is the newest version" file on the web. When that
 * names a newer version it offers it, downloads it, checks the download is exactly
 * the file that was published, and swaps itself for the new copy on the next restart.
 * Recordings, settings and connections are stored outside the app and are untouched.
 *
 * Where it looks is set when the app is built (`knight.updateFeed` in package.json).
 * A copy built without one simply says updates are not switched on.
 *
 * The feed is one JSON file:
 *   { "version": "0.9.1", "url": "https://…/Ainable-Studio-0.9.1-mac-universal.zip",
 *     "sha256": "…", "notes": "What changed, in a sentence or two." }
 */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, execFile } = require('node:child_process')
const prefs = require('./prefs')

class UpdateError extends Error {}

const pkg = (() => { try { return require('../../package.json') } catch { return {} } })()
const feedUrl = () => process.env.KS_UPDATE_FEED || pkg.knight?.updateFeed || null
const DIR = path.join(prefs.SETTINGS_DIR, 'updates')
const settings = () => ({ auto: true, ...(prefs.read().updates || {}) })

let state = { phase: 'idle' }   // idle | checking | available | downloading | ready | error | current
let latest = null               // the feed's answer
let staged = null               // { version, appPath }
const listeners = new Set()
const set = next => { state = next; for (const fn of listeners) { try { fn(status()) } catch {} } }

const okAddress = url => {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1')
  } catch { return false }
}

/** 1 if a is newer than b, -1 if older, 0 if the same. */
function compare (a, b) {
  const parts = v => String(v || '0').split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  const x = parts(a); const y = parts(b)
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1 }
  return 0
}

/** The .app this process is running from, or null when it is not an installed copy. */
function bundlePath () {
  const p = path.resolve(process.execPath, '..', '..', '..')
  return p.endsWith('.app') && app.isPackaged ? p : null
}

function status () {
  return {
    enabled: !!feedUrl(),
    current: app.getVersion(),
    auto: settings().auto !== false,
    lastCheckedAt: settings().lastCheckedAt || null,
    phase: state.phase,
    progress: state.progress || 0,
    message: state.message || null,
    version: latest?.version || null,
    notes: latest?.notes || null,
    canInstall: !!bundlePath()
  }
}

function save (patch = {}) {
  const next = { ...settings() }
  if (patch.auto !== undefined) next.auto = !!patch.auto
  prefs.write({ updates: next })
  return status()
}

async function check () {
  const feed = feedUrl()
  if (!feed) throw new UpdateError('Updates are not switched on in this copy of the app.')
  if (!okAddress(feed)) throw new UpdateError('The update address in this copy of the app is not valid.')
  if (['downloading', 'ready'].includes(state.phase)) return status()
  set({ phase: 'checking' })
  try {
    let res
    try { res = await fetch(`${feed}${feed.includes('?') ? '&' : '?'}t=${Date.now()}`, { signal: AbortSignal.timeout(20000), cache: 'no-store' }) } catch (e) {
      throw new UpdateError('Could not check for updates — check the internet connection.')
    }
    if (!res.ok) throw new UpdateError(`Could not check for updates (HTTP ${res.status}).`)
    let info
    try { info = await res.json() } catch { throw new UpdateError('The update information could not be read.') }
    if (!info?.version || !okAddress(info.url) || !/^[0-9a-f]{64}$/i.test(info.sha256 || '')) throw new UpdateError('The update information is incomplete.')
    prefs.write({ updates: { ...settings(), lastCheckedAt: new Date().toISOString() } })
    if (compare(info.version, app.getVersion()) <= 0) {
      latest = null
      set({ phase: 'current' })
    } else {
      latest = { version: String(info.version), url: info.url, sha256: info.sha256.toLowerCase(), notes: String(info.notes || '').slice(0, 600) }
      set({ phase: 'available' })
    }
  } catch (e) {
    set({ phase: 'error', message: String(e.message || e) })
    throw e
  }
  return status()
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim()))
})

function findApp (dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.app')) return path.join(dir, name)
  }
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory() && !name.startsWith('__')) { const found = findApp(p); if (found) return found }
  }
  return null
}

/** Downloads the new version and gets it ready, without touching the running app. */
async function download () {
  if (state.phase === 'ready' && staged) return status()
  if (!latest) await check()
  if (!latest) throw new UpdateError('This is already the newest version.')
  const info = latest
  set({ phase: 'downloading', progress: 0 })
  const zip = path.join(DIR, `update-${info.version}.zip`)
  const out = path.join(DIR, `staged-${info.version}`)
  try {
    fs.rmSync(DIR, { recursive: true, force: true })
    fs.mkdirSync(DIR, { recursive: true })

    let res
    try { res = await fetch(info.url, { signal: AbortSignal.timeout(60 * 60 * 1000) }) } catch { throw new UpdateError('The download could not be started — check the internet connection.') }
    if (!res.ok || !res.body) throw new UpdateError(`The update could not be downloaded (HTTP ${res.status}).`)
    const total = Number(res.headers.get('content-length')) || 0
    const hash = crypto.createHash('sha256')
    const file = fs.createWriteStream(zip)
    let got = 0
    let shown = 0
    try {
      for await (const chunk of res.body) {
        hash.update(chunk)
        got += chunk.length
        if (!file.write(chunk)) await new Promise(r => file.once('drain', r))
        const f = total ? got / total : 0
        if (f - shown > 0.01) { shown = f; set({ phase: 'downloading', progress: Math.min(0.97, f) }) }
      }
    } catch { throw new UpdateError('The download was interrupted. Try again.') }
    await new Promise((resolve, reject) => file.end(err => err ? reject(err) : resolve()))

    // The file must be byte-for-byte the one that was published.
    if (hash.digest('hex') !== info.sha256) throw new UpdateError('The download did not match what was published, so it was thrown away. Try again.')

    set({ phase: 'downloading', progress: 0.98 })
    fs.mkdirSync(out, { recursive: true })
    await run('/usr/bin/ditto', ['-x', '-k', zip, out]).catch(() => { throw new UpdateError('The update could not be unpacked.') })
    fs.rmSync(zip, { force: true })
    const appPath = findApp(out)
    if (!appPath) throw new UpdateError('The update did not contain the app.')

    // It has to be this app, at the version that was promised, and intact.
    const plist = path.join(appPath, 'Contents', 'Info.plist')
    const id = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist]).catch(() => '')
    const version = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]).catch(() => '')
    if (id !== (pkg.build?.appId || 'com.knightstudio.app')) throw new UpdateError('The update is not this app, so it was thrown away.')
    if (version !== info.version) throw new UpdateError('The update is not the version that was announced, so it was thrown away.')
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]).catch(() => { throw new UpdateError('The update is damaged, so it was thrown away. Try again.') })

    staged = { version: info.version, appPath }
    set({ phase: 'ready', progress: 1 })
  } catch (e) {
    fs.rmSync(DIR, { recursive: true, force: true })
    staged = null
    set({ phase: 'error', message: String(e.message || e) })
    throw e
  }
  return status()
}

/** Swaps the app for the downloaded copy and reopens it. Call only when nothing is recording. */
function install () {
  if (!staged || !fs.existsSync(staged.appPath)) throw new UpdateError('The update has not been downloaded yet.')
  const dest = process.env.KS_UPDATE_TARGET || bundlePath()
  if (!dest) throw new UpdateError('This copy is not an installed app, so it cannot update itself.')
  if (dest.includes('/AppTranslocation/')) throw new UpdateError('Move the app into your Applications folder, open it from there, and update again.')
  try { fs.accessSync(path.dirname(dest), fs.constants.W_OK) } catch { throw new UpdateError(`The app cannot be replaced where it is (${path.dirname(dest)}). Move it to a folder you can change, such as Applications.`) }

  // The swap runs after this process has gone, and puts the old copy back if it fails.
  const script = path.join(DIR, 'install.sh')
  fs.writeFileSync(script, `#!/bin/sh
PID="$1"; NEW="$2"; DEST="$3"; REOPEN="$4"; WORK="$5"
i=0
while kill -0 "$PID" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done
OLD="$DEST.previous"
rm -rf "$OLD"
mv "$DEST" "$OLD" || exit 1
if /usr/bin/ditto "$NEW" "$DEST"; then
  rm -rf "$OLD"
  /usr/bin/xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
else
  rm -rf "$DEST"
  mv "$OLD" "$DEST"
fi
[ "$REOPEN" = "1" ] && /usr/bin/open "$DEST"
rm -rf "$WORK"
exit 0
`, { mode: 0o755 })
  const child = spawn('/bin/sh', [script, String(process.pid), staged.appPath, dest, process.env.KS_UPDATE_NO_REOPEN ? '0' : '1', DIR],
    { detached: true, stdio: 'ignore' })
  child.unref()
  setTimeout(() => app.quit(), 150)
  return true
}

/** A quiet check shortly after launch, and once a day while the app stays open. */
function startAutomaticChecks () {
  const tick = () => {
    if (!feedUrl() || settings().auto === false) return
    if (!['idle', 'current', 'error'].includes(state.phase)) return
    check().catch(() => {})
  }
  setTimeout(tick, Number(process.env.KS_UPDATE_DELAY_MS) || 15000)
  setInterval(tick, 24 * 60 * 60 * 1000).unref()
}

const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn) }

module.exports = { status, save, check, download, install, startAutomaticChecks, onChange, compare, UpdateError }
