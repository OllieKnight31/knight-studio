#!/usr/bin/env node
// Proves the updater end to end, with real builds.
//
//   node build/update-check.mjs <old app .app> <new release .zip> <new version>
//
// Runs the OLD copy of the app from a throwaway folder, pointed at a local update feed
// that offers the NEW release zip. Then, through the app's own Settings → Updates
// screen: check, download, "Restart and update". Afterwards it confirms the app on disk
// is the new version, opens it, and confirms settings made before the update survived.
// Also checks the refusals: a tampered download, and a feed with nothing newer.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'

const [oldApp, zip, newVersion] = process.argv.slice(2)
if (!oldApp || !zip || !newVersion) { console.error('usage: node build/update-check.mjs <old .app> <new .zip> <new version>'); process.exit(2) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-upd-'))
const apps = path.join(home, 'Applications')
fs.mkdirSync(apps, { recursive: true })
const app = path.join(apps, 'Ainable Studio.app')
execFileSync('/usr/bin/ditto', [oldApp, app])
const plist = k => execFileSync('/usr/bin/plutil', ['-extract', k, 'raw', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
const oldVersion = plist('CFBundleShortVersionString')
const settingsDir = path.join(home, 'Library', 'Application Support', 'Ainable Studio')
fs.mkdirSync(settingsDir, { recursive: true })
fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ welcomed: true, tours: { disabled: true }, openAtLogin: false }))

const sha = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')
const feed = { version: newVersion, sha256: sha, notes: 'Share pages, written SOPs and a webhook.' }
let served = 0
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/latest.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ...feed, url: `http://127.0.0.1:${server.address().port}/app.zip` })) }
  if (u.pathname === '/app.zip') { served++; res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(zip).size }); return fs.createReadStream(zip).pipe(res) }
  res.writeHead(404); res.end()
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const feedUrl = `http://127.0.0.1:${server.address().port}/latest.json`

let failed = 0
const note = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  Updates        ${name}${detail ? `  — ${detail}` : ''}`) }

async function launch (extraEnv = {}) {
  const port = 9300 + Math.floor(Math.random() * 150)
  const child = spawn(path.join(app, 'Contents', 'MacOS', 'Ainable Studio'), [`--remote-debugging-port=${port}`, '-ApplePersistenceIgnoreState', 'YES', `--user-data-dir=${path.join(home, 'ud')}`],
    { env: { ...process.env, HOME: home, KS_DRIVE_CONFIG_DIR: '/nonexistent', KS_UPDATE_FEED: feedUrl, KS_UPDATE_NO_REOPEN: '1', ...extraEnv }, stdio: 'ignore' })
  let page
  for (let i = 0; i < 160 && !page; i++) { await sleep(250); try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url) && !/#overlay/.test(t.url)) } catch {} }
  if (!page) throw new Error('the app did not start')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const run = async (fn, arg) => {
    const r = await send('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description?.split('\n')[0])
    return r.result?.result?.value
  }
  await sleep(1500)
  const exited = new Promise(r => child.once('exit', r))
  return { run, child, exited }
}
const openUpdates = String(async () => {
  const w = ms => new Promise(r => setTimeout(r, ms))
  if (!document.querySelector('.modal')) { [...document.querySelectorAll('.lib-foot .folder')].find(b => /Settings/.test(b.textContent)).click(); await w(600) }
  ;[...document.querySelectorAll('.modal-nav .folder')].find(b => b.textContent.trim() === 'Updates').click(); await w(600)
  return document.querySelector('[data-conn=updates]').textContent
})
const state = String(async () => document.querySelector('[data-conn=updates] [data-conn-state]')?.textContent || '')
const press = String(async act => { const b = document.querySelector(`[data-act=${act}]`); if (!b) return false; b.click(); return true })
const until = async (a, re, ms = 600000) => { const end = Date.now() + ms; let s = ''; while (Date.now() < end) { s = await a.run(state).catch(() => s); if (re.test(s)) return s; await sleep(500) } return s }

try {
  /* 1. nothing newer */
  feed.version = oldVersion
  let a = await launch()
  await a.run(openUpdates)
  await a.run(press, 'update-check')
  note('a feed with nothing newer says this is the newest version', /newest version/.test(await until(a, /newest|available|did not/, 20000)), `running ${oldVersion}`)

  /* 2. tampered download */
  feed.version = newVersion
  feed.sha256 = 'a'.repeat(64)
  await a.run(press, 'update-check')
  const avail = await until(a, /is available|did not/, 20000)
  note('a newer version is found and offered, with its notes', new RegExp(`Version ${newVersion.replace(/\./g, '\\.')} is available`).test(avail) && /Share pages, written SOPs/.test(await a.run(openUpdates)), avail)
  await a.run(press, 'update-download')
  await until(a, /did not work|ready to install/, 900000)
  const refused = await a.run(String(async () => document.querySelector('[data-conn=updates] .notice.err')?.textContent || ''))
  note('a download that does not match what was published is thrown away', /did not match what was published/.test(refused) && !fs.existsSync(path.join(settingsDir, 'updates')), refused)

  /* 3. the real thing */
  feed.sha256 = sha
  await a.run(String(async () => { await window.knight.prefs.write({ exportDirect: true, countdown: 5 }); return true }))
  await a.run(press, 'update-check')
  await until(a, /is available/, 20000)
  const t0 = Date.now()
  await a.run(press, 'update-download')
  const ready = await until(a, /ready to install|did not work/, 900000)
  note('downloads, verifies and stages the new version without touching the running app', /ready to install/.test(ready) && plist('CFBundleShortVersionString') === oldVersion && served === 2, `${ready} · ${Math.round((Date.now() - t0) / 1000)}s`)
  await a.run(press, 'update-install')
  await Promise.race([a.exited, sleep(20000)])
  for (let i = 0; i < 240 && (fs.existsSync(`${app}.previous`) || plist('CFBundleShortVersionString') !== newVersion); i++) await sleep(500)
  await sleep(1500)
  let signed = true
  try { execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' }) } catch { signed = false }
  note('“Restart and update” closes the app and swaps it for the new version', plist('CFBundleShortVersionString') === newVersion && !fs.existsSync(`${app}.previous`) && signed && !fs.existsSync(path.join(settingsDir, 'updates')),
    `on disk: ${plist('CFBundleShortVersionString')} · signature intact=${signed} · nothing left behind`)

  /* 4. the new copy opens, and remembers */
  a = await launch({ KS_UPDATE_DELAY_MS: '1500' })
  const after = await a.run(String(async () => {
    const st = await window.knight.updates.status(); const p = await window.knight.prefs.read(); const sys = await window.knight.system.check()
    return { version: sys.version, direct: p.exportDirect, countdown: p.countdown, phase: st.phase, logo: document.querySelector('.brand-logo')?.getAttribute('aria-label') }
  }))
  await sleep(3500)
  const quiet = await a.run(String(async () => ({ phase: (await window.knight.updates.status()).phase, pill: !!document.querySelector('[data-act=update-pill]') })))
  note('the updated app opens as the new version with settings intact, and now reports it is current',
    after.version === newVersion && after.direct === true && after.countdown === 5 && after.logo === 'Ainable' && quiet.phase === 'current' && !quiet.pill,
    `version ${after.version} · countdown ${after.countdown} kept · automatic check → ${quiet.phase}`)

  /* 5. the automatic check announces a newer one */
  a.child.kill(); await sleep(1500)
  feed.version = '99.0.0'
  a = await launch({ KS_UPDATE_DELAY_MS: '1500' })
  await sleep(4500)
  const pill = await a.run(String(async () => document.querySelector('[data-act=update-pill]')?.textContent || ''))
  note('a newer version found by the automatic check is announced in the corner', /Version 99\.0\.0 is available/.test(pill), pill)
  a.child.kill()
} catch (e) {
  note('ran to the end', false, e.message)
}
server.close()
await sleep(800)
fs.rmSync(home, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
