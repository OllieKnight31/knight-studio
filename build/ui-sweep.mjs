#!/usr/bin/env node
// Clicks through every control in the app and reports what works.
//
//   node build/ui-sweep.mjs <project folder to test on> [app executable]
//
// Runs against a throwaway home folder holding a COPY of one project, so nothing the
// sweep does can touch real recordings or settings. File and folder pickers are
// answered by the KS_TEST_* hooks in the main process; nothing waits for a person.
// Uploads are disabled (KS_DRIVE_CONFIG_DIR points nowhere). Controls whose only effect
// is outside the app — opening Finder, a browser or System Settings — are checked for
// a working handler but not clicked.
//
// Prints one line per control and exits non-zero if anything failed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { startMock } from './db-mock.mjs'
import { startSupabase, available as supabaseAvailable } from './supabase-local.mjs'
import { startModel, startReceiver, startViewer, startBrowser, makeSpokenProject } from './feature-stubs.mjs'
import crypto from 'node:crypto'

const [projectSrc, appExe] = process.argv.slice(2)
if (!projectSrc || !fs.existsSync(path.join(projectSrc, 'project.json'))) {
  console.error('usage: node build/ui-sweep.mjs <project folder> [app executable]')
  process.exit(2)
}
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-sweep-'))
const lib = path.join(home, 'Movies', 'Knight Studio')
const settingsDir = path.join(home, 'Library', 'Application Support', 'Knight Studio')
const assets = path.join(home, 'assets')
const out = path.join(home, 'out')
for (const d of [lib, settingsDir, assets, out, path.join(home, 'Moved library'), path.join(home, 'Exports here')]) fs.mkdirSync(d, { recursive: true })

// A copy of the project, under a fixed id so the sweep can find it.
const PID = 'prj_sweep0000000'
fs.cpSync(projectSrc, path.join(lib, PID), { recursive: true })
const pj = JSON.parse(fs.readFileSync(path.join(lib, PID, 'project.json'), 'utf8'))
pj.id = PID
pj.name = 'Sweep test video'
fs.writeFileSync(path.join(lib, PID, 'project.json'), JSON.stringify(pj, null, 2))
for (const f of ['transcript.json']) {
  for (const c of fs.readdirSync(path.join(lib, PID, 'clips'))) fs.rmSync(path.join(lib, PID, 'clips', c, f), { force: true })
}
// The speech model, if this Mac has one, so captions can be tested without a download.
const model = path.join(os.homedir(), 'Library', 'Application Support', 'Knight Studio', 'models', 'ggml-base.bin')
if (fs.existsSync(model)) {
  fs.mkdirSync(path.join(settingsDir, 'models'), { recursive: true })
  try { fs.linkSync(model, path.join(settingsDir, 'models', 'ggml-base.bin')) } catch { fs.copyFileSync(model, path.join(settingsDir, 'models', 'ggml-base.bin')) }
}
// Test assets: a PNG logo, a HEIC logo (must be converted), a music track.
fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(assets, 'logo.png'))
execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', path.join(assets, 'logo.png'), '--out', path.join(assets, 'logo.heic')], { stdio: 'ignore' })
const ffmpeg = fs.existsSync(path.join(root, 'vendor/bin/ffmpeg')) ? path.join(root, 'vendor/bin/ffmpeg') : 'ffmpeg'
execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', path.join(assets, 'music.m4a')])

// Notion, Airtable and Supabase are played by a stand-in, so those connections can be
// saved, tested and sent to without real accounts.
const mock = await startMock()
// For the share page, write-up and webhook checks: a real local database playing
// Supabase, a stand-in for the AI model, an address that receives webhooks, the share
// page served locally, and a separate invisible browser to watch it in.
const sb = supabaseAvailable() ? await startSupabase({ fileLimit: 1e9 }) : null
const aiModel = await startModel()
const receiver = await startReceiver()
// The sharing service (sign-in, people, watch history): a second local database with
// cloud/schema.sql run on it, the way the real service's project is set up.
const cloud = supabaseAvailable() ? await startSupabase({ fileLimit: 1e9 }) : null
if (cloud) { cloud.sql(fs.readFileSync(path.join(root, 'cloud', 'schema.sql'), 'utf8')); cloud.createBucket('videos', true); await new Promise(r => setTimeout(r, 900)) }
const viewer = await startViewer(root, cloud ? { url: cloud.url, key: cloud.anonKey } : null)
const browser = await startBrowser()
const template = JSON.parse(JSON.stringify(pj))
const port = 9500 + Math.floor(Math.random() * 400)
const exe = appExe || path.join(root, 'node_modules/.bin/electron')
const args = appExe ? [] : ['.']
const env = {
  ...process.env,
  HOME: home,
  KS_DIST: '1',
  KS_DEBUG: '1',
  KNIGHT_STUDIO_STT: 'builtin',
  KS_DRIVE_CONFIG_DIR: '/nonexistent',
  KS_EXPORT_TO: path.join(out, 'export.mp4'),
  KS_TEST_SAVE_DIR: out,
  KS_NOTION_API: `${mock.base}/notion`,
  KS_AIRTABLE_API: `${mock.base}/airtable`,
  KS_ANTHROPIC_API: aiModel.base,
  ...(cloud ? { KS_CLOUD_URL: cloud.url, KS_CLOUD_KEY: cloud.anonKey } : {}),
  ...(process.env.SWEEP_LIVE_VIEWER ? {} : { KS_SHARE_VIEWER: viewer.base }),
  ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '',
  KS_TEST_OPEN_FILE: path.join(assets, 'logo.png'),
  KS_TEST_OPEN_AUDIO: path.join(assets, 'music.m4a'),
  KS_TEST_OPEN_DIR: path.join(home, 'Exports here')
}
const child = spawn(exe, [...args, `--remote-debugging-port=${port}`, '-ApplePersistenceIgnoreState', 'YES', `--user-data-dir=${path.join(home, 'ud')}`],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
const logs = []
child.stdout.on('data', d => logs.push(String(d)))
child.stderr.on('data', d => logs.push(String(d)))

const sleep = ms => new Promise(r => setTimeout(r, ms))
const stopEverything = async () => {
  try { child.kill() } catch {}
  for (const x of [browser, sb, cloud]) { try { if (x) await x.close() } catch {} }
  for (const x of [aiModel, receiver, viewer, mock]) { try { x.close() } catch {} }
}
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, async e => { console.error(`\nthe sweep stopped early: ${e?.stack || e}`); await stopEverything(); process.exit(1) })
let page
for (let i = 0; i < 160 && !page; i++) {
  await sleep(250)
  try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url) && !/#overlay/.test(t.url)) } catch {}
}
if (!page) { console.error('app did not start\n' + logs.join('')); child.kill(); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Runtime.enable')
const pageErrors = []
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description?.split('\n')[0])
})

async function run (fnSource, arg) {
  const expr = `(${fnSource})(${JSON.stringify(arg ?? null)})`
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) { const d = r.result.exceptionDetails.exception?.description?.split('\n') || ['evaluation failed']; throw new Error(d[0] + (d[2] ? ` (step at${(d.find(l => /<anonymous>:\d+:\d+\)?$/.test(l) && !/at click|at must|at pick/.test(l)) || '').replace(/.*<anonymous>/, ' line ')})` : '')) }
  return r.result?.result?.value
}

// Helpers installed in the page (again after a reload).
const HELPERS = String(() => {
  const w = ms => new Promise(r => setTimeout(r, ms))
  const visible = el => !!el && el.getClientRects().length > 0
  const txt = el => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  const all = (sel, root = document) => [...root.querySelectorAll(sel)].filter(visible)
  const find = (sel, text, root) => all(sel, root).find(el => {
    const t = txt(el)
    return text instanceof RegExp ? text.test(t) : t === text || t.startsWith(text)
  })
  const click = el => {
    if (!el) throw new Error('control not found')
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, button: 0 }
    el.dispatchEvent(new PointerEvent('pointerdown', o))
    el.dispatchEvent(new MouseEvent('mousedown', o))
    el.dispatchEvent(new PointerEvent('pointerup', o))
    el.dispatchEvent(new MouseEvent('mouseup', o))
    el.click()
  }
  // React keeps its own copy of an input's value; set it through the native setter.
  const setValue = (el, value) => {
    if (!el) throw new Error('input not found')
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value))
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const fieldByLabel = (label, root) => {
    const l = all('.label', root || document).find(x => txt(x).toLowerCase().startsWith(label.toLowerCase()))
    return l ? (l.closest('.field') || l.parentElement) : null
  }
  const slider = (label, value, root) => {
    const f = fieldByLabel(label, root)
    const input = f?.querySelector('input[type=range]')
    if (!input) throw new Error(`slider “${label}” not found`)
    setValue(input, value)
    return f.querySelector('.val')?.textContent
  }
  const toggle = (label, root) => {
    const row = all('.row.between', root || document).find(r => txt(r).startsWith(label) && r.querySelector('.switch input'))
    const input = row?.querySelector('.switch input')
    if (!input) throw new Error(`toggle “${label}” not found`)
    const before = input.checked
    input.click()
    return { before, after: input.checked }
  }
  const segButton = (text, root) => find('.seg button', text, root)
  const key = (k, extra = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: extra.code || '', bubbles: true, ...extra }))
  const project = async () => { await w(450); return window.knight.projects.load('prj_sweep0000000') }
  const prefs = () => window.knight.prefs.read()
  const closeTours = async () => { for (let i = 0; i < 3 && document.querySelector('.tour-card'); i++) { key('Escape'); await w(250) } }
  const closeModal = async () => { const b = find('.modal-nav .btn', 'Done'); if (b) { click(b); await w(300) } }
  const tool = async name => { click(find('.tools .tool', name)); await w(450); await closeTours() }
  // A dropdown, changed the way a person changes it: one change event.
  const pick = (el, value) => { if (!el) throw new Error('dropdown not found'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, String(value)); el.dispatchEvent(new Event('change', { bubbles: true })) }
  const must = sel => { const el = document.querySelector(sel); if (!el) throw new Error(`not on screen: ${sel}`); return el }
  const projectOf = async pid => { await w(450); return window.knight.projects.load(pid) }
  const settingsTab = async name => {
    if (!document.querySelector('.modal')) { click(find('.lib-foot .folder', /Settings/) || find('.tools .tool', 'Settings')); await w(500) }
    click(all('.modal-nav .folder').find(b => txt(b) === name)); await w(600)
  }
  const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await w(200) } }
  window.__t = { w, visible, txt, all, find, click, setValue, pick, must, fieldByLabel, slider, toggle, segButton, key, project, projectOf, settingsTab, waitFor, prefs, closeTours, closeModal, tool }
  return true
})
await run(HELPERS)

const results = []
// SWEEP_NEW_ONLY=1 runs just the newer features (from the spoken recording onwards) — quicker while working on them.
let skipping = !!process.env.SWEEP_NEW_ONLY
if (skipping) fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ welcomed: true, tours: { disabled: true }, brand: { name: 'Sweep Studio', accent: '#ff3366', surface: '#ffffff' } }))
async function check (area, name, fn, arg) {
  if (skipping) return
  let ok = false
  let detail = ''
  try {
    const r = await run(fn, arg)
    ok = r === true || (r && r.ok === true)
    detail = typeof r === 'object' && r ? (r.detail || '') : (r === true ? '' : String(r))
  } catch (e) {
    detail = e.message
  }
  results.push({ area, name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${area.padEnd(14)} ${name}${detail ? `  — ${detail}` : ''}\n`)
}

/* =================================================================== first run */

await sleep(2500)
await check('First run', 'opens on the system check', String(async () => {
  const { w } = window.__t
  for (let i = 0; i < 20 && !document.querySelector('.modal'); i++) await w(250)
  return { ok: /System check/.test(document.querySelector('.modal-body')?.textContent || '') }
}))

/* ==================================================================== settings */

await check('Settings', 'tabs all open', String(async () => {
  const { w, all, txt, click } = window.__t
  const names = all('.modal-nav .folder').map(txt)
  const seen = []
  for (const n of names) { click(all('.modal-nav .folder').find(b => txt(b) === n)); await w(500); seen.push(`${n}:${!!document.querySelector('.modal-body h3')}`) }
  return { ok: names.length === 10 && seen.every(s => s.endsWith('true')), detail: seen.join(' ') }
}))

await check('Branding', 'there is no Branding tab, and nothing in Settings changes the look', String(async () => {
  const { all, txt } = window.__t
  const tabs = all('.modal-nav .folder').map(txt)
  const body = document.querySelector('.modal')?.textContent || ''
  return { ok: !tabs.includes('Branding') && !/Colourway|Choose a logo|Brand colour/.test(body) && !document.querySelector('.colourway, .logo-well') && !window.knight.settings.pickLogo, detail: tabs.join(', ') }
}))

await check('Branding', 'the app wears the Ainable logo and colours, whatever an older version saved', String(async () => {
  const { w } = window.__t
  // an older version's saved brand must be ignored, and a new one cannot be written
  const after = await window.knight.prefs.write({ brand: { name: 'Sweep Studio', accent: '#ff3366', surface: '#ffffff', logo: '/tmp/x.png' } }); await w(300)
  const css = getComputedStyle(document.documentElement)
  const logo = document.querySelector('.topbar .brand svg.brand-logo')
  const box = logo?.getBoundingClientRect()
  const accent = css.getPropertyValue('--accent').trim().toUpperCase(); const surface = css.getPropertyValue('--surface').trim().toUpperCase()
  const b = (await window.__t.prefs()).brand
  return {
    ok: accent === '#F5F5F7' && surface === '#0A0A0B' && document.documentElement.dataset.theme === 'dark' && logo?.getAttribute('aria-label') === 'Ainable' && box.width > 60 && box.height > 14 &&
      b.accent === '#F5F5F7' && b.surface === '#0A0A0B' && !b.logo && after.brand.accent === '#F5F5F7' && getComputedStyle(document.body).backgroundColor === 'rgb(10, 10, 11)' && document.title === 'Knight Studio',
    detail: `accent ${accent} · background ${surface} · logo “${logo?.getAttribute('aria-label')}” ${Math.round(box?.width)}×${Math.round(box?.height)} · saved brand ${b.accent}/${b.surface}`
  }
}))

await check('Files', 'export folder: change location', String(async () => {
  const { w, all, txt, click, find } = window.__t
  click(all('.modal-nav .folder').find(b => txt(b) === 'Files')); await w(500)
  const section = all('.modal-body section').find(s => /Export folder/.test(s.textContent))
  click(find('.btn', 'Change location', section)); await w(800)
  const shown = txt(section.querySelector('.path'))
  const saved = (await window.__t.prefs()).exportDir
  return { ok: /Exports here$/.test(saved || '') && shown === saved, detail: `shown=${shown}` }
}))

await check('Files', 'export folder: back to Downloads', String(async () => {
  const { w, all, find, click } = window.__t
  const section = all('.modal-body section').find(s => /Export folder/.test(s.textContent))
  click(find('.btn', 'Use Downloads', section)); await w(500)
  return { ok: (await window.__t.prefs()).exportDir === null }
}))

await check('Files', 'save exports without asking: straight to the folder, never overwriting', String(async () => {
  const { w, all, toggle, find, click } = window.__t
  const section = all('.modal-body section').find(s => /Export folder/.test(s.textContent))
  click(find('.btn', 'Change location', section)); await w(700)
  const t = toggle('Save exports here without asking'); await w(500)
  const first = await window.knight.exportVideo.chooseTarget('Sweep clip.mp4')
  const again0 = await window.knight.exportVideo.chooseTarget('Sweep clip.mp4')
  toggle('Save exports here without asking'); await w(400)
  const section2 = all('.modal-body section').find(s => /Export folder/.test(s.textContent))
  click(find('.btn', 'Use Downloads', section2)); await w(400)
  const off = (await window.__t.prefs()).exportDirect === false
  return { ok: t.after === true && /Exports here\/Sweep clip\.mp4$/.test(first) && again0 === first && off, detail: first.split('/').slice(-2).join('/') }
}))

await check('Files', 'recordings folder: move library to a new location', String(async () => {
  const { w, all, find, click, txt } = window.__t
  const section = all('.modal-body section').find(s => /Recordings folder/.test(s.textContent))
  click(find('.btn', 'Change location', section)); await w(2500)
  const shown = txt(section.querySelector('.path'))
  const note = txt(document.querySelector('.modal-body .notice'))
  const list = await window.knight.projects.list()
  return { ok: /Exports here$/.test(shown) && list.some(p => p.id === 'prj_sweep0000000'), detail: `${shown.split('/').pop()} · ${note} · ${list.length} project(s)` }
}))

await check('Files', 'recordings folder: back to the default', String(async () => {
  const { w, all, find, click, txt } = window.__t
  const section = all('.modal-body section').find(s => /Recordings folder/.test(s.textContent))
  click(find('.btn', 'Use the default', section)); await w(2500)
  const list = await window.knight.projects.list()
  return { ok: /Movies\/Knight Studio$/.test(txt(section.querySelector('.path'))) && list.some(p => p.id === 'prj_sweep0000000') }
}))

await check('Files', '“Show in Finder” has a handler', String(async () => typeof window.knight.shell.open === 'function'))

await check('Drive', 'not-connected screen offers a way in', String(async () => {
  const { w, all, txt, click } = window.__t
  click(all('.modal-nav .folder').find(b => txt(b) === 'Google Drive')); await w(800)
  const body = txt(document.querySelector('.modal-body'))
  return { ok: /Connect Google Drive|Google OAuth client/.test(body), detail: body.slice(0, 80) }
}))

await check('Drive', 'own-client form rejects a bad client id', String(async () => {
  const { w, all, find, click, setValue } = window.__t
  const opener = find('.modal-body .btn', 'Use my own Google client')
  if (opener) { click(opener); await w(300) }
  const inputs = all('.modal-body input.input')
  setValue(inputs[0], 'not-a-client'); setValue(inputs[1], 'secret'); await w(200)
  click(find('.modal-body .btn', 'Save client')); await w(500)
  return { ok: /does not look like/.test(document.querySelector('.modal-body .notice.err')?.textContent || '') }
}))

/* =================================================================== databases */

const dbCard = String((which) => [...document.querySelectorAll('.db-card')].find(c => c.dataset.db === which))
await run(`() => { window.__t.dbCard = ${dbCard}; return true }`)

await check('Databases', 'tutorial video and written guide on each connection', String(async () => {
  const { w, all, txt, click } = window.__t
  click(all('.modal-nav .folder').find(b => txt(b) === 'Databases')); await w(900)
  const cards = all('.db-card')
  const got = []
  for (const c of cards) {
    const v = c.querySelector('video')
    const poster = await new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = v ? v.poster : 'x:' })
    const playable = v ? await fetch(v.querySelector('source').src).then(r => r.ok ? r.blob() : null).then(b => (b ? b.size : 0)).catch(() => 0) : 0
    got.push(`${c.dataset.db}: steps=${c.querySelectorAll('.guide li').length} poster=${poster > 0} video=${Math.round(playable / 1024)}KB`)
  }
  return { ok: cards.length === 3 && got.every(g => /steps=5 poster=true video=[1-9]\d{2,}KB/.test(g)), detail: got.join(' · ') }
}))

for (const [which, name, fill] of [
  ['notion', 'Notion', ['notion-good', 'https://www.notion.so/acme/Videos-0123456789abcdef0123456789abcdef?v=2']],
  ['airtable', 'Airtable', ['at-good', 'https://airtable.com/appAAAAAAAAAAAAAA/tblBBBBBBBBBBBBBB/viwCCCCCCCCCCCCCC']]
]) {
  await check('Databases', `${name}: wrong key is explained, right key passes the test`, `async () => {
    const { w, find, click, setValue, txt, dbCard } = window.__t
    const card = () => dbCard(${JSON.stringify(which)})
    const inputs = () => card().querySelectorAll('input.input')
    setValue(inputs()[0], 'definitely-wrong'); setValue(inputs()[1], ${JSON.stringify(fill[1])}); await w(150)
    click(find('.btn', 'Test connection', card()))
    for (let i = 0; i < 60 && !card().querySelector('.notice b'); i++) await w(250)
    const bad = txt(card().querySelector('.notice.err'))
    setValue(inputs()[0], ${JSON.stringify(fill[0])}); await w(150)
    click(find('.btn', 'Test connection', card()))
    await w(600); for (let i = 0; i < 80 && !card().querySelector('.notice.ok b'); i++) await w(250)
    const good = txt(card().querySelector('.notice.ok'))
    const steps = card().querySelectorAll('.notice.ok .perm-dot.on').length
    const st = (await window.knight.databases.status())[${JSON.stringify(which)}]
    return { ok: /does not accept/.test(bad) && /is working/.test(good) && steps === 5 && st.configured && !JSON.stringify(st).includes(${JSON.stringify(fill[0])}), detail: steps + ' steps passed · connected to ' + (st.databaseName || st.tableName) }
  }`)
}

await check('Databases', 'Supabase: missing table points at the setup, which lists the table', String(async () => {
  const { w, find, click, setValue, txt, dbCard } = window.__t
  const card = () => dbCard('supabase')
  const inputs = () => card().querySelectorAll('input.input')
  setValue(inputs()[0], window.__mockBase + '/supabase'); setValue(inputs()[1], 'sb-good'); await w(150)
  click(find('.btn', 'Test connection', card()))
  for (let i = 0; i < 60 && !card().querySelector('.notice.err b'); i++) await w(250)
  const bad = txt(card().querySelector('.notice.err'))
  const sql = card().querySelector('.code-box')?.textContent || ''
  return { ok: /Copy the table setup/.test(bad) && /create table if not exists public\.videos/.test(sql) && /transcript text/.test(sql), detail: bad.slice(0, 90) }
}).replace('window.__mockBase', JSON.stringify(mock.base)))

mock.state.supabase.table = true      // as if the person had run the table setup
await check('Databases', 'Supabase: passes once the table exists; file storage can be switched on', String(async () => {
  const { w, find, click, setValue, txt, dbCard, toggle } = window.__t
  const card = () => dbCard('supabase')
  click(find('.btn', 'Test connection', card()))
  await w(600); for (let i = 0; i < 80 && !card().querySelector('.notice.ok b'); i++) await w(250)
  const steps = card().querySelectorAll('.notice.ok .perm-dot.on').length
  const show = find('.btn', 'Show setup', card()); if (show) { click(show); await w(300) }
  toggle('Store the video file in Supabase too', card()); await w(500)
  const bucket = [...card().querySelectorAll('.field')].find(f => /Storage bucket/.test(f.textContent))?.querySelector('input')
  setValue(bucket, 'videos'); await w(150)
  click(find('.btn', 'Save', card())); await w(700)
  const st = (await window.knight.databases.status()).supabase
  return { ok: steps === 4 && st.upload === true && st.bucket === 'videos', detail: `${steps} steps passed · bucket=${st.bucket}` }
}))

await check('Databases', '“Add every export” switch and Disconnect', String(async () => {
  const { w, find, click, toggle, dbCard } = window.__t
  const t = toggle('Add every exported video to Airtable', dbCard('airtable')); await w(500)
  const off = (await window.knight.databases.status()).airtable.auto === false
  toggle('Add every exported video to Airtable', dbCard('airtable')); await w(500)
  const on = (await window.knight.databases.status()).airtable.auto === true
  return { ok: off && on }
}))

await check('Captions', 'tab shows engine and models', String(async () => {
  const { w, all, txt, click } = window.__t
  click(all('.modal-nav .folder').find(b => txt(b).startsWith('Captions'))); await w(800)
  const body = txt(document.querySelector('.modal-body'))
  return { ok: /Standard — 148 MB/.test(body), detail: /in use/.test(body) ? 'model present' : 'no model' }
}))

await check('Captions', 'save + remove an AI key (never shown back)', String(async () => {
  const { w, all, find, click, setValue } = window.__t
  const field = all('.modal-body .field').find(f => /Anthropic/.test(f.textContent))
  setValue(field.querySelector('input'), 'sk-ant-test-key'); await w(150)
  click(find('.btn', 'Save', field)); await w(500)
  const saved = (await window.knight.ai.status()).anthropic
  const fieldAfter = all('.modal-body .field').find(f => /Anthropic/.test(f.textContent))
  const leaked = fieldAfter.querySelector('input').value.includes('sk-ant')
  click(find('.btn', 'Remove', fieldAfter)); await w(500)
  const removed = !(await window.knight.ai.status()).anthropic
  return { ok: saved && !leaked && removed, detail: `saved=${saved} leaked=${leaked} removed=${removed}` }
}))

await check('Recording', 'countdown, login and camera delay save', String(async () => {
  const { w, all, txt, click, slider, toggle } = window.__t
  click(all('.modal-nav .folder').find(b => txt(b) === 'Recording')); await w(500)
  slider('Countdown', 5); slider('Camera delay', 40)
  const t = toggle('Keep running after login'); await w(500)
  const p = await window.__t.prefs()
  toggle('Keep running after login'); slider('Camera delay', 0); slider('Countdown', 3); await w(300)
  return { ok: p.countdown === 5 && p.cameraDelayMs === 40 && p.openAtLogin === t.after, detail: `countdown=${p.countdown} delay=${p.cameraDelayMs} login=${p.openAtLogin}` }
}))

await check('System', 'check again + walkthrough switch + reset', String(async () => {
  const { w, all, txt, click, find, toggle } = window.__t
  click(all('.modal-nav .folder').find(b => txt(b) === 'System check'))
  for (let i = 0; i < 40 && !find('.modal-body .btn', 'Check again'); i++) await w(250)
  click(find('.modal-body .btn', 'Check again'))
  await w(500); for (let i = 0; i < 40 && !find('.modal-body .btn', 'Check again'); i++) await w(250)
  const green = all('.modal-body .perm-dot.on').length
  const t = toggle('Start walkthroughs automatically'); await w(300)
  const off = (await window.__t.prefs()).tours.disabled === true
  toggle('Start walkthroughs automatically'); await w(300)
  click(find('.modal-body .btn', 'Show them all again')); await w(400)
  const reset = Object.keys((await window.__t.prefs()).tours).filter(k => k !== 'disabled').length === 0
  return { ok: green >= 3 && off && reset, detail: `${green} green · off=${off} · reset=${reset}` }
}))

await check('Settings', 'Done and Escape close it', String(async () => {
  const { w, click, find, key, closeTours } = window.__t
  click(find('.modal-nav .btn', 'Done')); await w(400)
  const closed = !document.querySelector('.modal')
  await closeTours()
  click(find('.lib-foot .folder', 'Settings')); await w(400)
  key('Escape'); await w(400)
  return { ok: closed && !document.querySelector('.modal') }
}))

/* ===================================================================== library */

await check('Library', 'walkthrough plays and replays', String(async () => {
  const { w, click, find, key, closeTours } = window.__t
  await closeTours()
  click(find('.topbar .btn', 'Show me around')); await w(800)
  const steps = []
  for (let i = 0; i < 8 && document.querySelector('.tour-card'); i++) { steps.push(!!document.querySelector('.tour-spot')); key('ArrowRight'); await w(350) }
  return { ok: steps.length >= 4 && steps.every(Boolean) && !document.querySelector('.tour-card'), detail: `${steps.length} steps` }
}))

await check('Library', 'new folder', String(async () => {
  const { w, find, click, setValue } = window.__t
  click(find('.lib-side .folder', 'New folder')); await w(300)
  const input = document.querySelector('.lib-side .folder input')
  setValue(input, 'Sweep Folder')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await w(800)
  const lib = await window.knight.library.get()
  return { ok: lib.folders.some(f => f.name === 'Sweep Folder') && !!find('.lib-side .folder', 'Sweep Folder') }
}))

await check('Library', 'rename folder', String(async () => {
  const { w, find, click, setValue, all } = window.__t
  const row = find('.lib-side .folder', 'Sweep Folder')
  click(row.querySelector('.folder-actions span')); await w(300)
  const input = row.querySelector('input')
  setValue(input, 'Sweep Renamed')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await w(700)
  return { ok: (await window.knight.library.get()).folders.some(f => f.name === 'Sweep Renamed') }
}))

await check('Library', 'drag a video onto a folder', String(async () => {
  const { w, find, click } = window.__t
  click(find('.lib-side .folder', 'All videos')); await w(400)
  const card = document.querySelector('.card')
  const row = find('.lib-side .folder', 'Sweep Renamed')
  if (!row) return { ok: false, detail: 'rows: ' + window.__t.all('.lib-side .folder').map(window.__t.txt).join(' | ') }
  const dt = new DataTransfer()
  card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
  row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); await w(800)
  const p = (await window.knight.projects.list()).find(x => x.id === 'prj_sweep0000000')
  const folder = (await window.knight.library.get()).folders.find(f => f.name === 'Sweep Renamed')
  return { ok: p.folderId === folder.id }
}))

await check('Library', 'folder view, “Not in a folder”, “All videos”', String(async () => {
  const { w, find, click, all } = window.__t
  click(find('.lib-side .folder', 'Sweep Renamed')); await w(400)
  const inFolder = all('.grid .card').length
  click(find('.lib-side .folder', 'Not in a folder')); await w(400)
  const unfiled = all('.grid .card').length
  click(find('.lib-side .folder', 'All videos')); await w(400)
  const everything = all('.grid .card').length
  return { ok: inFolder === 1 && unfiled === 0 && everything === 1, detail: `${inFolder}/${unfiled}/${everything}` }
}))

await check('Library', 'move menu: take out of folder', String(async () => {
  const { w, find, click } = window.__t
  const card = document.querySelector('.card')
  card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
  click(card.querySelector('.card-move')); await w(400)
  const menu = document.querySelector('.menu')
  click(find('.menu button', 'Take out of its folder')); await w(700)
  const p = (await window.knight.projects.list()).find(x => x.id === 'prj_sweep0000000')
  return { ok: !!menu && !p.folderId }
}))

await check('Library', 'move menu: into a folder', String(async () => {
  const { w, find, click } = window.__t
  click(document.querySelector('.card .card-move')); await w(400)
  click(find('.menu button', 'Sweep Renamed')); await w(700)
  const p = (await window.knight.projects.list()).find(x => x.id === 'prj_sweep0000000')
  return { ok: !!p.folderId }
}))

await check('Library', 'delete folder keeps the video', String(async () => {
  const { w, find, click } = window.__t
  const row = find('.lib-side .folder', 'Sweep Renamed')
  click(row.querySelectorAll('.folder-actions span')[1]); await w(800)
  const list = await window.knight.projects.list()
  return { ok: !(await window.knight.library.get()).folders.length && list.length === 1 && !list[0].folderId }
}))

await check('Library', 'hover previews', String(async () => {
  const { w } = window.__t
  const card = document.querySelector('.card')
  card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
  for (let i = 0; i < 20 && !card.querySelector('.card-thumb img'); i++) await w(250)
  return { ok: !!card.querySelector('.card-thumb img') }
}))

await check('Library', 'tooltips on controls', String(async () => {
  const { w, find } = window.__t
  const el = find('.topbar .btn', 'New recording')
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await w(500)
  const tip = document.querySelector('.tip')?.textContent
  window.dispatchEvent(new MouseEvent('mousedown')); await w(100)
  return { ok: !!tip, detail: tip }
}))

/* ==================================================================== recorder */

await check('Recorder', 'opens, walkthrough runs, controls respond', String(async () => {
  const { w, find, click, all, key, closeTours, segButton, setValue } = window.__t
  click(find('.topbar .btn', 'New recording'))
  for (let i = 0; i < 40 && !document.querySelector('.rec-panel'); i++) await w(250)
  for (let i = 0; i < 12 && !document.querySelector('.tour-card'); i++) await w(250)
  const tour = !!document.querySelector('.tour-card')
  await closeTours()
  const fps30 = segButton('30 fps'); if (fps30) { click(fps30); await w(200) }
  const fpsOn = segButton('30 fps')?.classList.contains('on')
  const selects = all('.rec-panel select')
  const audio = all('.rec-panel .switch input')[0]
  if (audio) { audio.click(); await w(150); audio.click() }
  const perms = all('.perm-row').length
  click(find('.topbar .btn', '← Library')); await w(800)
  return { ok: tour && fpsOn && selects.length >= 2 && perms >= 3 && !!document.querySelector('.lib-side'), detail: `tour=${tour} fps=${fpsOn} selects=${selects.length} perms=${perms}` }
}))

/* ====================================================================== editor */

await check('Editor', 'opens the video', String(async () => {
  const { w, click, closeTours } = window.__t
  click(document.querySelector('.card'))
  for (let i = 0; i < 60 && !document.querySelector('.stage canvas'); i++) await w(250)
  for (let i = 0; i < 20 && !document.querySelector('.tl-seg'); i++) await w(250)
  await w(1500)
  await closeTours()
  return { ok: !!document.querySelector('.tl-seg') }
}))

await check('Editor', 'every tool opens, with a walkthrough', String(async () => {
  const { w, all, txt, click, key, closeTours } = window.__t
  const names = all('.tools .tool').map(txt).filter(n => n !== 'Settings')
  const got = []
  for (const n of names) {
    click(all('.tools .tool').find(b => txt(b) === n)); await w(400)
    let tour = false
    for (let i = 0; i < 10 && !tour; i++) { tour = !!document.querySelector('.tour-card'); if (!tour) await w(200) }
    const h3 = txt(document.querySelector('.panel h3'))
    got.push(`${n}:${h3 ? 'ok' : 'empty'}${tour ? '+tour' : ''}`)
    await closeTours()
  }
  return { ok: names.length === 10 && got.every(g => /:ok\+tour/.test(g) || g.startsWith('Setup')), detail: got.join(' ') }
}))

await check('Editor', '? button replays the tool walkthrough', String(async () => {
  const { w, click, closeTours } = window.__t
  click(document.querySelector('.panel-help')); await w(700)
  const shown = !!document.querySelector('.tour-card')
  await closeTours()
  return { ok: shown }
}))

await check('Setup', 'rename, canvas presets', String(async () => {
  const { w, tool, all, setValue, click } = window.__t
  await tool('Setup')
  setValue(document.querySelector('.panel input.input'), 'Sweep renamed video'); await w(700)
  const presets = all('.panel .preset')
  const sizes = []
  for (const p of presets) { click(p); await w(250); sizes.push(document.querySelector('.topbar .tag')?.textContent) }
  click(presets[0]); await w(300)
  const p = await window.__t.project()
  return { ok: p.name === 'Sweep renamed video' && new Set(sizes).size >= 6, detail: sizes.join(' ') }
}))

await check('Cut', 'split, select, delete, restore marker, undo/redo', String(async () => {
  const { w, tool, find, click, key } = window.__t
  await tool('Cut')
  const segs = () => document.querySelectorAll('.tl-seg').length
  const marks = () => document.querySelectorAll('.tl-cutmark').length
  // Counts are relative: the test video may already carry cuts of its own.
  const n = segs(); const m = marks()
  const first = document.querySelector('.tl-seg'); const fb = first.getBoundingClientRect()
  const ruler = document.querySelector('.tl-ruler'); const rb = ruler.getBoundingClientRect()
  ruler.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: fb.left + fb.width * 0.5, clientY: rb.top + 5 }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await w(300)
  click(find('.transport .tbtn', 'Split')); await w(400)
  const afterSplit = segs()
  click(document.querySelectorAll('.tl-seg')[1]); await w(200)
  click(find('.transport .tbtn', 'Delete')); await w(500)
  const afterDelete = segs(); const marksAfter = marks()
  key('z', { metaKey: true }); await w(400)
  const undone = segs()
  key('z', { metaKey: true, shiftKey: true }); await w(400)
  const redone = segs()
  click(document.querySelector('.tl-cutmark')); await w(500)
  const restored = marks()
  return { ok: afterSplit === n + 1 && afterDelete === n && marksAfter >= m && undone === n + 1 && redone === n && restored === marksAfter - 1, detail: `sections ${n}→${afterSplit}→${afterDelete}, undo ${undone}, redo ${redone}, cut markers ${marksAfter}→${restored}` }
}))

await check('Cut', 'trim by dragging an edge', String(async () => {
  const { w } = window.__t
  const before = (await window.__t.project()).clips[0].trim
  const h = document.querySelector('.tl-seg .tl-handle.l'); const hb = h.getBoundingClientRect()
  h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: hb.left + 3, clientY: hb.top + 10 }))
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: hb.left + 60, clientY: hb.top + 10 }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await w(700)
  const c = (await window.__t.project()).clips[0]
  return { ok: (c.cuts || []).some(x => x.start < 0.01) || (c.trim.in > before.in), detail: JSON.stringify(c.cuts) }
}))

await check('Cut', 'dead-space sliders + remove + restore all', String(async () => {
  const { w, find, click, slider } = window.__t
  slider('Shortest pause', 0.4); slider('Sensitivity', 40); slider('Breathing room', 0.05); await w(600)
  const d = (await window.__t.project()).deadSpace || {}
  click(find('.panel .btn', 'Remove dead space')); await w(900)
  const hint = document.querySelector('.stage-hint')?.textContent || ''
  const restore = find('.panel .btn', 'Restore all')
  if (restore) { click(restore); await w(700) }
  const c = (await window.__t.project()).clips[0]
  const settings = d.minSeconds === 0.4 && d.thresholdDb === -40 && d.pad === 0.05
  const ran = /Removed|No dead space|Still reading/.test(hint)
  const clean = !(c.cuts || []).length
  return { ok: settings && ran && clean, detail: `settings saved=${settings} (${JSON.stringify(d)}) · ran=${ran} · restored=${clean} · ${hint.slice(0, 40)}` }
}))

await check('Layout', 'every layout, fit, shape, sliders, colour, mirror, corner, nudge', String(async () => {
  const { w, tool, all, click, segButton, slider, toggle, setValue, find } = window.__t
  await tool('Layout')
  const layouts = []
  for (const p of all('.panel .presets .preset')) { click(p); await w(200); layouts.push((await window.__t.project()).clips[0].layout) }
  click(all('.panel .presets .preset')[0]); await w(200)
  click(segButton('Fit')); await w(150); click(segButton('Fill'))
  const hasCam = (await window.__t.project()).clips[0].hasCamera
  let cam = 'no camera in this clip'
  if (hasCam) {
    click(segButton('Rounded')); await w(200)
    slider('Size', 0.3); slider('Corner radius', 30); slider('Zoom in on me', 1.4); slider('Border', 4); await w(300)
    const colour = all('.panel input[type=color]')[0]; if (colour) setValue(colour, '#00ff88')
    slider('Shadow', 0.2); toggle('Mirror camera')
    setValue(document.querySelector('.panel select'), 'top-left'); await w(200)
    slider('Nudge', 0.1); await w(400)
    const reset = find('.panel .btn', 'Reset nudge'); if (reset) click(reset)
    await w(400)
    const p = await window.__t.project()
    cam = `shape=${p.camera.shape} size=${p.camera.size} zoom=${p.camera.zoom} border=${p.camera.borderWidth} colour=${p.camera.borderColor} pos=${p.camera.position} nudge=${p.clips[0].cameraNudge}`
    if (!(p.camera.shape === 'rounded' && p.camera.size === 0.3 && p.camera.zoom === 1.4 && p.camera.position === 'top-left' && !p.clips[0].cameraNudge)) return { ok: false, detail: cam }
  }
  return { ok: new Set(layouts).size === all('.panel .presets .preset').length, detail: `${layouts.join(',')} · ${cam}` }
}))

await check('Layout', 'drag the camera on the video', String(async () => {
  const { w } = window.__t
  if (!(await window.__t.project()).clips[0].hasCamera) return { ok: true, detail: 'no camera in this clip' }
  const canvas = document.querySelector('.stage canvas'); const b = canvas.getBoundingClientRect()
  const p0 = await window.__t.project()
  // Find the bubble by scanning for the grab cursor.
  let start = null
  for (let y = 0.05; y < 1 && !start; y += 0.05) {
    for (let x = 0.05; x < 1 && !start; x += 0.05) {
      canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: b.left + b.width * x, clientY: b.top + b.height * y }))
      await w(5)
      if (canvas.style.cursor === 'grab') start = { x: b.left + b.width * x, y: b.top + b.height * y }
    }
  }
  if (!start) return { ok: false, detail: 'camera not found on canvas' }
  canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: start.x, clientY: start.y }))
  canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: start.x + 80, clientY: start.y + 40 }))
  canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await w(600)
  const p1 = await window.__t.project()
  return { ok: JSON.stringify(p0.camera.pos) !== JSON.stringify(p1.camera.pos), detail: JSON.stringify(p1.camera.pos) }
}))

await check('Zoom', 'add, select, follow, scale, ease, target, delete, clear, auto toggle', String(async () => {
  const { w, tool, find, click, segButton, slider, toggle } = window.__t
  await tool('Zoom')
  const n0 = (await window.__t.project()).clips[0].zooms.length
  click(find('.panel .btn', 'Clear all')); await w(300)
  const ruler = document.querySelector('.tl-ruler'); const rb = ruler.getBoundingClientRect()
  ruler.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rb.left + rb.width * 0.1, clientY: rb.top + 5 }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await w(300)
  click(find('.panel .btn', 'Add zoom')); await w(500)
  const added = (await window.__t.project()).clips[0].zooms.length
  click(segButton('Fixed point')); await w(200)
  slider('How far in', 2.5); slider('Ease in', 0.8); slider('Across', 500); slider('Down', 300); await w(400)
  const z = (await window.__t.project()).clips[0].zooms[0]
  const block = document.querySelector('.tl-block.zoom')
  click(find('.panel .btn', 'Delete zoom')); await w(400)
  const t = toggle('Zoom new recordings automatically'); toggle('Zoom new recordings automatically')
  const regen = find('.panel .btn', 'Regenerate'); const canRegen = regen && !regen.disabled
  if (canRegen) { click(regen); await w(400) }
  return { ok: added === 1 && z.mode === 'manual' && z.scale === 2.5 && z.ramp === 0.8 && z.target.x === 500 && !!block, detail: `before=${n0} added=${added} regenerate=${canRegen ? (await window.__t.project()).clips[0].zooms.length : 'no clicks'}` }
}))

await check('Style', 'background type, swatches, colours, angle, brand, frame', String(async () => {
  const { w, tool, all, click, segButton, slider, setValue, find } = window.__t
  await tool('Style')
  click(segButton('Solid colour')); await w(200)
  click(all('.panel .swatch')[3]); await w(200)
  setValue(all('.panel input[type=color]')[0], '#123456'); await w(200)
  const solid = (await window.__t.project()).background
  click(segButton('Gradient')); await w(200)
  click(all('.panel .swatch')[2]); await w(200)
  const pickers = all('.panel input[type=color]'); setValue(pickers[0], '#aa0000'); setValue(pickers[1], '#0000aa')
  slider('Angle', 45); await w(200)
  const grad = (await window.__t.project()).background
  click(find('.panel .btn', 'Use brand colours')); await w(300)
  slider('Padding', 0.1); slider('Corner radius', 30); slider('Shadow', 0.7); slider('Border', 3); await w(300)
  const bc = all('.panel input[type=color]').pop(); setValue(bc, '#ffffff'); await w(400)
  const p = await window.__t.project()
  return { ok: solid.type === 'color' && solid.colors[0] === '#123456' && grad.colors.join() === '#aa0000,#0000aa' && grad.angle === 45 && p.style.padding === 0.1 && p.style.borderWidth === 3, detail: `${solid.colors[0]} ${grad.colors.join('→')} ${p.style.borderColor}` }
}))

await check('Cursor', 'toggle, look, every slider', String(async () => {
  const { w, tool, segButton, slider, toggle, click } = window.__t
  await tool('Cursor')
  const t = toggle('Show the cursor'); toggle('Show the cursor')
  click(segButton('White')); await w(150)
  slider('Size', 2); slider('Smooth movement', 0.2); slider('Lean into movement', 0.5); slider('Press effect', 0.9); slider('Ripple', 0.1); await w(400)
  const c = (await window.__t.project()).cursor
  return { ok: c.style === 'windows' && c.size === 2 && c.smoothing === 0.2 && c.tilt === 0.5 && c.clickSpring === 0.9 && c.clickRipple === 0.1 && c.animated === true }
}))

await check('Text', 'headline/text/blur, every control, drag on video, delete', String(async () => {
  const { w, tool, find, click, setValue, slider, toggle, segButton, all } = window.__t
  await tool('Text')
  click(find('.panel .btn', 'Headline')); await w(400)
  click(find('.panel .btn', 'Text')); await w(400)
  click(find('.panel .btn', 'Blur')); await w(400)
  const p0 = await window.__t.project()
  const blocks = document.querySelectorAll('.tl-block.text, .tl-block.blur').length
  // edit the headline
  click(all('.panel .chip').find(c => /Your headline/.test(c.textContent))); await w(300)
  setValue(document.querySelector('.panel textarea'), 'Sweep headline\nsecond line'); await w(150)
  setValue(document.querySelector('.panel select'), 'georgia'); await w(150)
  slider('Size', 100); click(segButton('Regular')); click(segButton('Right')); await w(150)
  setValue(all('.panel input[type=color]')[0], '#ff0000')
  toggle('Background strip'); toggle('Drop shadow'); toggle('ALL CAPS'); await w(200)
  click(all('.panel .btn').find(b => b.textContent.trim() === 'Low R')); await w(150)
  slider('Box width', 0.5); slider('Box height', 0.2); slider('Opacity', 0.8); slider('Fade', 0.5); await w(150)
  click(find('.panel .btn', 'Show for whole video')); await w(400)
  const o = (await window.__t.project()).overlays.find(x => x.kind === 'headline')
  // drag it on the canvas
  const canvas = document.querySelector('.stage canvas'); const b = canvas.getBoundingClientRect()
  const cx = b.left + (o.x + o.w / 2) * b.width; const cy = b.top + (o.y + o.h / 2) * b.height
  canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy })); await w(40)
  // A hand moves in steps, a frame or two apart — not in the same instant as the press.
  for (let i = 1; i <= 5; i++) { canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx - 20 * i, clientY: cy - 16 * i })); await w(30) }
  canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await w(500)
  const moved = (await window.__t.project()).overlays.find(x => x.kind === 'headline')
  // delete the blur
  click(all('.panel .chip').find(c => /Blur box/.test(c.textContent))); await w(200)
  click(find('.panel .btn', 'Delete')); await w(400)
  const p1 = await window.__t.project()
  const okEdit = o.text === 'Sweep headline\nsecond line' && o.font === 'georgia' && o.size === 100 && o.weight === 400 && o.align === 'right' && o.color === '#ff0000' && o.shadow === false && o.uppercase === true && o.w === 0.5 && o.start === 0
  return { ok: p0.overlays.length === 3 && blocks === 3 && okEdit && moved.x !== o.x && p1.overlays.length === 2, detail: `edit=${okEdit} moved=${moved.x !== o.x}` }
}))

await check('Text', 'timeline drag of a text block', String(async () => {
  const { w } = window.__t
  const before = (await window.__t.project()).overlays[1]
  const blk = document.querySelectorAll('.tl-block.text')[1]; const bb = blk.getBoundingClientRect()
  blk.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: bb.left + bb.width / 2, clientY: bb.top + 5 }))
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: bb.left + bb.width / 2 + 40, clientY: bb.top + 5 }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await w(500)
  const after = (await window.__t.project()).overlays[1]
  return { ok: after.start !== before.start, detail: `${before.start.toFixed(2)} → ${after.start.toFixed(2)}` }
}))

await check('Audio', 'levels, section volume, mute, music, music level', String(async () => {
  const { w, tool, find, click, slider } = window.__t
  await tool('Audio')
  slider('Microphone', 1.5); slider('System sound', 0.3); await w(300)
  click(document.querySelector('.tl-seg')); await w(200)
  slider('Volume', 0.5); await w(400)
  const g1 = (await window.__t.project()).clips[0].gains
  click(find('.panel .btn', 'Mute section')); await w(300)
  const muted = document.querySelector('.tl-seg.muted')
  click(find('.panel .btn', 'Unmute')); await w(300)
  click(find('.panel .btn', 'Choose a track')); await w(2500)
  const p = await window.__t.project()
  const panelNote = [...document.querySelectorAll('.panel .val')].map(v => v.textContent).filter(t => /file|sound|read/i.test(t)).join(' ')
  if (p.audio.music) { slider('Music level', 0.3); await w(300) }
  const p2 = await window.__t.project()
  return { ok: p.audio.micGain === 1.5 && p.audio.systemGain === 0.3 && g1.some(g => g.gain === 0.5) && !!muted && /music\.m4a$/.test(p.audio.music || '') && p2.audio.musicGain === 0.3, detail: `music=${(p.audio.music || '').split('/').pop()} ${panelNote}` }
}))

await check('Captions', 'transcribe with the built-in engine', String(async () => {
  const { w, tool, find, click } = window.__t
  await tool('Captions')
  const btn = find('.panel .btn', 'Transcribe this clip')
  if (!btn) return { ok: !!document.querySelector('.panel .transcript'), detail: 'already transcribed' }
  click(btn)
  for (let i = 0; i < 300; i++) {
    await w(1000)
    if (document.querySelector('.panel .transcript') || /No speech|exited|missing|could not|Error/.test(document.querySelector('.panel').textContent)) break
  }
  const words = document.querySelectorAll('.tword').length
  const msg = [...document.querySelectorAll('.panel .val')].map(v => v.textContent).join(' / ')
  return { ok: words > 0 || /No speech found/.test(msg), detail: words ? `${words} words` : msg }
}))

await check('Captions', 'word cut, remove pauses, SRT, undo cuts, styling', String(async () => {
  const { w, find, click, toggle, slider, setValue, all } = window.__t
  if (!document.querySelector('.tword')) return { ok: true, detail: 'no speech in this clip — skipped' }
  const tCap = toggle('Show captions on the video')
  click(document.querySelectorAll('.tword')[2]); await w(400)
  const cut1 = (await window.__t.project()).clips[0].cuts.length
  click(find('.panel .btn', 'Remove pauses')); await w(400)
  click(find('.panel .btn', 'Export SRT')); await w(600)
  click(find('.panel .btn', 'Undo cuts')); await w(400)
  const cut2 = (await window.__t.project()).clips[0].cuts.length
  setValue(document.querySelector('.panel select'), 'impact'); slider('Size', 60); slider('Height on screen', 0.5)
  setValue(all('.panel input[type=color]')[0], '#ffff00'); toggle('Background strip'); toggle('One word at a time'); toggle('ALL CAPS'); await w(400)
  const s = (await window.__t.project()).subtitles
  return { ok: tCap.after && cut1 >= 1 && cut2 === 0 && s.font === 'impact' && s.size === 60 && s.oneWordAtATime && s.uppercase, detail: `cuts ${cut1}→${cut2}` }
}))

await check('Timeline', 'play/pause, zoom, fit, mute, volume, undo/redo buttons, text buttons', String(async () => {
  const { w, find, click, setValue } = window.__t
  const time = () => document.querySelector('.transport .mono').textContent
  const t0 = time()
  click(document.querySelector('.tbtn.play')); await w(1500)
  const t1 = time()
  click(document.querySelector('.tbtn.play')); await w(300)
  setValue(document.querySelector('.transport .zoom-slider'), Math.log(100)); await w(200)
  const wide = document.querySelector('.tl-inner').getBoundingClientRect().width
  click([...document.querySelectorAll('.transport .tbtn')].find(b => b.dataset.tipTitle === 'Fit')); await w(300)
  const fitted = document.querySelector('.tl-inner').getBoundingClientRect().width
  const mute = [...document.querySelectorAll('.transport .tbtn')].find(b => /mute/i.test(b.dataset.tipTitle || '')); click(mute); click(mute)
  setValue(document.querySelector('.transport .vol'), 0.7)
  const undo = [...document.querySelectorAll('.transport .tbtn')].find(b => b.dataset.tipTitle === 'Undo')
  const n = (await window.__t.project()).overlays.length
  click([...document.querySelectorAll('.transport .tbtn')].find(b => b.dataset.tipTitle === 'Add text')); await w(400)
  const n2 = (await window.__t.project()).overlays.length
  click(undo); await w(400)
  const n3 = (await window.__t.project()).overlays.length
  return { ok: t1 !== t0 && Math.abs(wide - fitted) > 5 && n2 === n + 1 && n3 === n, detail: `${t0}→${t1} zoom ${Math.round(wide)}→${Math.round(fitted)}px text ${n}→${n2}→${n3}` }
}))

await check('Shortcuts', 'space, S, ⌫, arrows, tool keys', String(async () => {
  const { w, key } = window.__t
  const time = () => document.querySelector('.transport .mono').textContent
  const segs = () => document.querySelectorAll('.tl-seg').length
  key(' ', { code: 'Space' }); await w(800); key(' ', { code: 'Space' }); await w(200)
  const t1 = time()
  key('ArrowRight', { shiftKey: true }); await w(200)
  const moved = time() !== t1
  const before = segs()
  key('s'); await w(400)
  const split = segs()
  key('z', { metaKey: true }); await w(300)
  key('c'); await w(200)
  const cut = document.querySelector('.panel h3')?.textContent
  key('e'); await w(200)
  const exp = document.querySelector('.panel h3')?.textContent
  return { ok: moved && split === before + 1 && cut === 'Cut' && exp === 'Export', detail: `split ${before}→${split}` }
}))

await check('Export', 'settings and a real export', String(async () => {
  const { w, tool, find, click, segButton, setValue } = window.__t
  await tool('Export')
  click(segButton('30 fps')); setValue(document.querySelector('.panel select'), 'web'); await w(300)
  const drive = !!find('.panel .btn', 'Connect Google Drive')
  click(find('.panel .btn', 'Export MP4'))
  let state = ''
  for (let i = 0; i < 900; i++) {
    await w(1000)
    state = [...document.querySelectorAll('.panel .val')].map(v => v.textContent).join(' / ')
    if (/Exported|Failed/.test(state)) break
  }
  const buttons = [...document.querySelectorAll('.panel .btn.sm')].map(b => b.textContent)
  for (let i = 0; i < 60 && !/Added to|:/.test([...document.querySelectorAll('.panel .val')].map(v => v.textContent).join(' ').replace(state, '')); i++) await w(500)
  await w(1500)
  const added = [...document.querySelectorAll('.panel .val')].map(v => v.textContent).filter(t => /Added to/.test(t))
  return { ok: /Exported/.test(state) && buttons.includes('Show in Finder') && buttons.includes('Play') && drive && added.length === 3, detail: `${state} · ${added.join(' · ')}` }
}))

await check('Editor', 'Settings cog and back to library', String(async () => {
  const { w, find, click, closeModal } = window.__t
  click(find('.tools .tool', 'Settings')); await w(500)
  const opened = !!document.querySelector('.modal')
  await closeModal()
  click(find('.topbar .btn', '← Library')); await w(900)
  return { ok: opened && !!document.querySelector('.lib-side') }
}))

if (!process.env.SWEEP_KEEP) await check('Library', 'delete a video', String(async () => {
  const { w, click } = window.__t
  click(document.querySelector('.card .card-del')); await w(900)
  return { ok: !(await window.knight.projects.list()).length && /No recordings yet/.test(document.body.textContent) }
}))

/* ====================================================================== report */

// What actually arrived at the stand-in databases after the export.
if (!process.env.SWEEP_NEW_ONLY) {
  const n = mock.state.notion.pages.filter(p => !p.archived).at(-1)
  const a = mock.state.airtable.records.at(-1)
  const r = mock.state.supabase.rows.at(-1)
  const f = mock.state.supabase.files.at(-1)
  const okAll = !!n && !!a && !!r && !!f && f.bytes > 100000 && /storage\/v1\/object\/public\/videos\//.test(r.video_url || '') && r.duration_seconds > 0
  results.push({ area: 'Databases', name: 'the export arrived in all three, with the file stored in Supabase', ok: okAll, detail: '' })
  console.log(`${okAll ? 'PASS' : 'FAIL'}  ${'Databases'.padEnd(14)} the export arrived in all three, with the file stored in Supabase  — Notion “${n?.properties ? Object.values(n.properties).find(p => p.title)?.title[0].text.content : ''}”, Airtable “${a?.fields?.Name}”, Supabase ${r?.duration_seconds}s + ${f ? Math.round(f.bytes / 1024) : 0}KB file`)
}


/* ============================================================ the newer features */
// Share pages, view counts, embed, summary and chapters, written SOP, filler words,
// templates and the webhook — on a recording of someone explaining a procedure.

const spoken = makeSpokenProject({ lib, template, ffmpeg })
await send('Page.enable')
await send('Page.reload')
await sleep(3000)
await run(HELPERS)
await run(`() => { window.__t.dbCard = ${dbCard}; return true }`)
const SP = spoken.id
skipping = false
const note = (area, name, ok, detail = '') => { results.push({ area, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${area.padEnd(14)} ${name}${detail ? `  — ${detail}` : ''}`) }

/* ---------------------------------------------------------------------- webhook */

await check('Webhook', 'a bad address is refused with a reason', String(async () => {
  const { w, find, click, setValue, txt, settingsTab } = window.__t
  await settingsTab('Webhook')
  const card = document.querySelector('[data-conn="webhook"]')
  const video = !!card.querySelector('.tutorial video')
  setValue(card.querySelector('[data-field=url]'), 'ftp://example.com/hook'); await w(150)
  click(find('.btn', 'Save', card)); await w(500)
  const err = txt(card.querySelector('.notice.err'))
  return { ok: /https:\/\//.test(err) && video && card.querySelectorAll('.guide li').length === 4, detail: err }
}))

await check('Webhook', 'save, send a test: delivered, signed, marked Working', String(async (url) => {
  const { w, find, click, setValue, txt, waitFor } = window.__t
  const card = () => document.querySelector('[data-conn="webhook"]')
  setValue(card().querySelector('[data-field=url]'), url); setValue(card().querySelector('[data-field=secret]'), 'sweep-secret'); await w(150)
  click(card().querySelector('[data-act=webhook-test]'))
  await waitFor(() => card().querySelector('.notice.ok b, .notice.err b'))
  const st = await window.knight.webhook.status()
  return { ok: /is working/.test(txt(card().querySelector('.notice.ok b'))) && txt(card().querySelector('[data-conn-state]')) === 'Working' && st.hasSecret && st.url === url, detail: txt(card().querySelector('.notice')) }
}), receiver.url)
{
  const got = receiver.state.got.at(-1)
  const v = got?.json?.video || {}
  note('Webhook', 'the test message carries every field and a valid signature',
    got?.json?.event === 'test' && receiver.signed(got, 'sweep-secret') && got.headers['x-knight-event'] === 'test' &&
    ['title', 'folder', 'fileName', 'durationSeconds', 'driveLink', 'shareLink', 'embedCode', 'summary', 'chapters', 'chaptersText', 'transcript'].every(k => k in v) && v.chapters.length === 2,
    `event=${got?.json?.event} fields=${Object.keys(v).length}`)
}

receiver.state.status = 500
await check('Webhook', 'an address that answers with an error is reported, and un-proves the connection', String(async () => {
  const { find, click, txt, waitFor, w } = window.__t
  const card = () => document.querySelector('[data-conn="webhook"]')
  click(card().querySelector('[data-act=webhook-test]')); await w(300)
  await waitFor(() => card().querySelector('.notice.err b'))
  const out = { ok: /HTTP 500/.test(txt(card().querySelector('.notice.err'))) && /not tested yet/.test(txt(card().querySelector('[data-conn-state]'))), detail: txt(card().querySelector('.notice.err')).slice(0, 110) }
  return out
}))
receiver.state.status = 200
await check('Webhook', 'switch off and on, then working again', String(async () => {
  const { w, click, txt, toggle, waitFor } = window.__t
  const card = () => document.querySelector('[data-conn="webhook"]')
  toggle('Tell the webhook about every export', card()); await w(400)
  const off = (await window.knight.webhook.status()).auto === false
  toggle('Tell the webhook about every export', card()); await w(400)
  click(card().querySelector('[data-act=webhook-test]')); await w(300)
  await waitFor(() => card().querySelector('.notice.ok b'))
  return { ok: off && (await window.knight.webhook.status()).auto === true && txt(card().querySelector('[data-conn-state]')) === 'Working' }
}))

/* ------------------------------------------------------------------ share pages */

if (!sb) {
  note('Share', 'local database available for the share page checks', false, 'brew install postgresql@17 postgrest')
} else {
  sb.createBucket('videos', false)        // exists, but not public yet
  const shareTest = (name, expectOk, pattern, extra) => check('Share', name, String(async ({ expectOk, pattern, anonKey }) => {
    const { w, click, setValue, txt, settingsTab, waitFor } = window.__t
    await settingsTab('Share pages')
    const card = () => document.querySelector('[data-conn="share"]')
    if (anonKey) { setValue(card().querySelector('[data-field=anonKey]'), anonKey); await w(150) }
    click(card().querySelector('[data-act=share-test]')); await w(500)
    await waitFor(() => !/Testing/.test(txt(card().querySelector('[data-act=share-test]'))) && card().querySelector('.notice.ok b, .notice.err b'), 40000)
    const ok = !!card().querySelector('.notice.ok b')
    const all = txt(card().querySelector('.notice.ok, .notice.err'))
    const passed = card().querySelectorAll('.notice .perm-dot.on').length
    return { ok: ok === expectOk && new RegExp(pattern).test(all), detail: `${passed} steps passed · ${txt(card().querySelector('[data-conn-state]'))} · ${all.slice(-150)}` }
  }), { expectOk, pattern, ...extra })

  await check('Share', 'setup screen: tutorial video, five steps, table setup to copy', String(async ({ url, key }) => {
    const { w, txt, settingsTab, click } = window.__t
    await window.knight.databases.save('supabase', { url, key, table: 'videos', upload: false, bucket: 'videos' })
    await settingsTab('Databases'); await settingsTab('Share pages')
    const card = document.querySelector('[data-conn="share"]')
    click(card.querySelector('[data-act=share-sql]')); await w(300)
    const sql = (await window.knight.databases.status()).supabase.sql
    return { ok: !!card.querySelector('.tutorial video') && card.querySelectorAll('.guide li').length === 5 && /Done — connected/.test(txt(card)) && /ks_record_view/.test(sql) && /enable row level security/.test(sql), detail: txt(card.querySelector('[data-conn-state]')) }
  }), { url: sb.url, key: sb.serviceKey })

  await shareTest('a bucket that is not public is caught, with the fix', false, 'switch on “Public bucket”')
  sb.setPublic('videos', true)
  await shareTest('a missing public key is caught, with the fix', false, 'Paste the public key')
  await shareTest('a view counter that was never set up is caught, with the fix', false, 'has not been set up', { anonKey: sb.anonKey })
  const SQL = await run(String(async () => (await window.knight.databases.status()).supabase.sql))
  sb.sql(SQL)                              // what the person does in the SQL Editor
  await sleep(900)
  await shareTest('passes once the table setup has been run: all seven steps', true, 'Share pages are working')
  sb.sql('alter table public.video_views disable row level security')
  await sleep(300)
  await shareTest('a public key that could read the view list is caught', false, 'can read the list of views')
  sb.sql(SQL)                              // running the setup again repairs it
  await sleep(900)
  await shareTest('running the table setup again repairs it', true, 'Share pages are working')
  note('Share', 'the test cleaned up after itself', sb.files().length === 0 && sb.sql('select count(*) from public.video_views').trim() === '0', `files=${sb.files().length}`)

  await check('Share', 'a wrong share page address is refused; a custom one saves and resets', String(async () => {
    const { w, find, click, setValue, txt } = window.__t
    const card = () => document.querySelector('[data-conn="share"]')
    click(find('.btn', 'Show advanced', card())); await w(300)
    setValue(card().querySelector('[data-field=viewer]'), 'not a link'); click(find('.btn', 'Save', card())); await w(500)
    const err = txt(card().querySelector('.notice.err'))
    const before = (await window.knight.share.status()).viewer
    await window.knight.share.save({ viewer: 'https://watch.example.com/' })
    const custom = (await window.knight.share.status())
    await window.knight.share.save({ viewer: '' })
    const after = await window.knight.share.status()
    await window.knight.share.test()
    return { ok: /https:\/\//.test(err) && custom.customViewer === 'https://watch.example.com' && after.customViewer === null && after.viewer === before, detail: err }
  }))
}

await check('AI', 'key saved for the write-up', String(async () => {
  const { closeModal } = window.__t
  await window.knight.ai.setKey('anthropic', 'sk-ant-standin-key')
  await closeModal()
  return (await window.knight.ai.status()).anthropic === true
}))

/* ------------------------------------------------------------- the spoken video */

await check('Editor', 'opens the spoken recording', String(async () => {
  const { w, click, closeTours, all, txt, waitFor } = window.__t
  const card = all('.card').find(c => /Setting up a new client/.test(txt(c)))
  click(card)
  await waitFor(() => document.querySelector('.tl-seg'), 25000)
  await w(1500); await closeTours()
  return { ok: !!document.querySelector('.tl-seg') && /Setting up a new client/.test(document.querySelector('.topbar').textContent) }
}))

await check('Filler words', 'transcribe: the “um”s and “uh”s are heard and highlighted', String(async () => {
  const { w, tool, find, click, waitFor } = window.__t
  await tool('Captions')
  click(find('.panel .btn', 'Transcribe this clip'))
  await waitFor(() => document.querySelector('.panel .transcript'), 300000)
  await w(500)
  const words = document.querySelectorAll('.tword').length
  const fillers = [...document.querySelectorAll('.tword.filler')].map(e => e.textContent)
  const label = document.querySelector('[data-act=remove-fillers]').textContent
  return { ok: words > 80 && fillers.length >= 3 && label.includes(`(${fillers.length})`), detail: `${words} words · fillers: ${fillers.join(' ')}` }
}))

await check('Filler words', 'one press cuts them all; captions lose them; ⌘Z brings them back', String(async (pid) => {
  const { w, click, projectOf, key } = window.__t
  const before = await projectOf(pid)
  const n = document.querySelectorAll('.tword.filler').length
  const dur = () => document.querySelector('.panel-sub, .topbar')?.textContent
  click(document.querySelector('[data-act=remove-fillers]')); await w(700)
  const cut = await projectOf(pid)
  const left = document.querySelectorAll('.tword.filler').length
  const toast = document.querySelector('.stage-status, .status')?.textContent || ''
  const label = document.querySelector('[data-act=remove-fillers]').textContent.trim()
  click(document.querySelector('.tbtn[data-tip-title="Undo"]')); await w(700)
  const undone = await projectOf(pid)
  click(document.querySelector('.tbtn[data-tip-title="Redo"]')); await w(700)
  const redone = await projectOf(pid)
  return {
    ok: before.clips[0].cuts.length === 0 && cut.clips[0].cuts.length >= Math.min(n, 3) && left === 0 && label === 'Remove filler words' &&
      undone.clips[0].cuts.length === 0 && redone.clips[0].cuts.length === cut.clips[0].cuts.length,
    detail: `${n} fillers → ${cut.clips[0].cuts.length} cuts → undo ${undone.clips[0].cuts.length} → redo ${redone.clips[0].cuts.length}`
  }
}), SP)

await check('Filler words', 'cut words are gone from the captions and from what is sent on', String(async (pid) => {
  const { projectOf } = window.__t
  const p = await projectOf(pid)
  const t = await window.knight.transcribe.read(p.clips[0].dir)
  const isFiller = w => ['um', 'umm', 'uh', 'uhh', 'erm', 'er', 'ah', 'hmm', 'hm', 'mm'].includes(w.word.toLowerCase().replace(/[^a-z]/g, ''))
  const fillers = t.words.filter(isFiller)
  const covered = fillers.every(f => p.clips[0].cuts.some(c => f.start >= c.start - 0.05 && f.end <= c.end + 0.05))
  const total = p.clips[0].cuts.reduce((n, c) => n + (c.end - c.start), 0)
  return { ok: fillers.length >= 3 && covered && total > 0.5 && total < 8, detail: `${fillers.length} fillers all inside cuts, ${total.toFixed(1)}s removed` }
}), SP)

/* ------------------------------------------------------------------- templates */

await check('Templates', 'save this look, change the video, apply the template: the look comes back', String(async (pid) => {
  const { w, tool, click, setValue, txt, projectOf, find } = window.__t
  await tool('Style')
  click(window.__t.segButton('Gradient')); await w(250)
  click(document.querySelectorAll('.panel .swatch')[8] || document.querySelectorAll('.panel .swatch')[2]); await w(400)
  await tool('Setup')
  const look = await projectOf(pid)
  setValue(document.querySelector('[data-act=template-name]'), 'Sweep look'); await w(150)
  click(document.querySelector('[data-act=template-save]'))
  for (let i = 0; i < 30 && !/saved/.test(txt(document.querySelector('[data-act=template-note]'))); i++) await w(200)
  const saved = txt(document.querySelector('[data-act=template-note]'))
  const list = await window.knight.templates.list()
  // change the look, then bring it back
  await tool('Style'); click(document.querySelectorAll('.panel .swatch')[0]); await w(500)
  const changed = await projectOf(pid)
  await tool('Setup')
  click(document.querySelector('[data-act=template-apply]')); await w(700)
  const back = await projectOf(pid)
  const same = JSON.stringify(back.background) === JSON.stringify(look.background) && JSON.stringify(back.style) === JSON.stringify(look.style)
  return { ok: /saved/.test(saved) && list.templates.length === 1 && JSON.stringify(changed.background) !== JSON.stringify(look.background) && same && back.clips[0].cuts.length === look.clips[0].cuts.length, detail: `${saved} · look restored=${same} · cuts untouched` }
}), SP)

await check('Templates', 'one undo removes an applied template; saving the same name updates it', String(async (pid) => {
  const { w, click, setValue, txt, projectOf } = window.__t
  const applied = await projectOf(pid)
  click(document.querySelector('.tbtn[data-tip-title="Undo"]')); await w(700)
  const undone = await projectOf(pid)
  click(document.querySelector('.tbtn[data-tip-title="Redo"]')); await w(700)
  setValue(document.querySelector('[data-act=template-name]'), 'sweep LOOK'); await w(150)
  click(document.querySelector('[data-act=template-save]'))
  for (let i = 0; i < 30 && !/updated/.test(txt(document.querySelector('[data-act=template-note]'))); i++) await w(200)
  const list = await window.knight.templates.list()
  return { ok: JSON.stringify(undone.background) !== JSON.stringify(applied.background) && list.templates.length === 1 && /updated/.test(txt(document.querySelector('[data-act=template-note]'))), detail: txt(document.querySelector('[data-act=template-note]')) }
}), SP)

await check('Templates', '“Start every new video with this”: a new video gets the look; delete clears it', String(async (pid) => {
  const { w, click, toggle, projectOf } = window.__t
  const look = await projectOf(pid)
  toggle('Start every new video with this'); await w(500)
  const def = (await window.knight.templates.list()).defaultId
  const fresh = await window.knight.projects.create('Template probe')
  const inherits = JSON.stringify(fresh.background) === JSON.stringify(look.background) && JSON.stringify(fresh.subtitles) === JSON.stringify(look.subtitles) && fresh.clips.length === 0
  await window.knight.projects.remove(fresh.id)
  click(document.querySelector('[data-act=template-delete]')); await w(600)
  const after = await window.knight.templates.list()
  const plain = await window.knight.projects.create('Template probe 2')
  const reverted = JSON.stringify(plain.background) !== JSON.stringify(look.background)
  await window.knight.projects.remove(plain.id)
  return { ok: !!def && inherits && after.templates.length === 0 && after.defaultId === null && reverted && !document.querySelector('[data-act=template-apply]'), detail: `new video inherits=${inherits} · after delete, new video is plain=${reverted}` }
}), SP)

/* -------------------------------------------------- summary, chapters, written SOP */

aiModel.state.mode = 'bad-key'
await check('Write-up', 'a rejected AI key is explained in plain words', String(async () => {
  const { w, tool, click, txt, waitFor } = window.__t
  await tool('Export')
  click(document.querySelector('[data-act=writeup]'))
  await waitFor(() => document.querySelector('[data-act=writeup-error]'), 30000)
  return { ok: /does not accept that API key/.test(txt(document.querySelector('[data-act=writeup-error]'))), detail: txt(document.querySelector('[data-act=writeup-error]')) }
}))
aiModel.state.mode = 'no-credit'
await check('Write-up', 'an AI account with no credit is explained in plain words', String(async () => {
  const { w, click, txt, waitFor } = window.__t
  click(document.querySelector('[data-act=writeup]')); await w(400)
  await waitFor(() => !/Reading/.test(txt(document.querySelector('[data-act=writeup]'))), 30000)
  return { ok: /no credit left/.test(txt(document.querySelector('[data-act=writeup-error]'))), detail: txt(document.querySelector('[data-act=writeup-error]')) }
}))
aiModel.state.mode = 'ok'
aiModel.state.calls.length = 0
await check('Write-up', 'writes a summary and chapters; they can be edited and are saved with the video', String(async (pid) => {
  const { w, click, txt, waitFor, setValue, projectOf } = window.__t
  click(document.querySelector('[data-act=writeup]')); await w(400)
  await waitFor(() => document.querySelector('[data-act=chapters]'), 40000)
  const p = await projectOf(pid)
  const rows = document.querySelectorAll('.chapter-row').length
  setValue(document.querySelectorAll('.chapter-row input')[1], 'Creating the client'); await w(700)
  click(document.querySelectorAll('.chapter-row .chapter-time')[1]); await w(400)
  const edited = await projectOf(pid)
  click(document.querySelector('[data-act=copy-chapters]')); await w(300)
  const copied = /Copied/.test(txt(document.querySelector('[data-act=copy-chapters]')))
  return {
    ok: !!p.ai?.summary && rows === 3 && p.ai.chapters[0].start === 0 && p.ai.steps.length >= 3 && edited.ai.chapters[1].title === 'Creating the client' && copied && !document.querySelector('[data-act=writeup-error]'),
    detail: `${rows} chapters, ${p.ai.steps.length} steps · “${p.ai.summary.slice(0, 60)}…”`
  }
}), SP)
{
  const c = aiModel.state.calls.at(-1)
  const sent = String(c?.body?.messages?.at(-1)?.content || '')
  const lines = [...sent.matchAll(/^\[(\d+)\] (.+)$/gm)]
  note('Write-up', 'the request: right model, structured answer, the edited transcript only (no fillers)',
    !!c && c.key === 'sk-ant-standin-key' && c.body.model === 'claude-opus-5-5' && c.body.output_config.format.type === 'json_schema' && c.body.thinking?.type === 'adaptive' &&
    c.body.fallbacks === 'default' && lines.length >= 6 && !/\b(um|uh)\b[,.]?/i.test(lines.map(l => l[2]).join(' ')) && /Setting up a new client/.test(sent),
    `${lines.length} timed lines, model ${c?.body?.model}`)
}

/* ------------------------------------------------------------------ the export */

await check('Export', 'the hand-off switches are offered', String(async () => {
  const { w, toggle, txt, segButton, click, setValue } = window.__t
  click(segButton('30 fps')); setValue(document.querySelector('.panel select'), 'web'); await w(300)
  const t = toggle('Write these on every export'); await w(500)
  const p = await window.knight.prefs.read()
  const panel = txt(document.querySelector('.panel'))
  return { ok: t.after === true && p.ai.writeUpOnExport === true && /Make a share page after export/.test(panel) && /Tell your webhook about this video/.test(panel) && /Add this video to your databases/.test(panel), detail: '' }
}))

receiver.state.got.length = 0
aiModel.state.calls.length = 0
await check('Export', 'one export: write-up, share page, database row and webhook, each reported', String(async () => {
  const { w, find, click, txt } = window.__t
  click(find('.panel .btn', 'Export MP4'))
  let lines = []
  for (let i = 0; i < 900; i++) {
    await w(1000)
    lines = [...document.querySelectorAll('.panel .val')].map(v => v.textContent)
    if (lines.some(l => /Failed/.test(l))) break
    if (lines.some(l => /^(Exported|Exported and uploaded)$/.test(l)) && lines.some(l => /Webhook/.test(l))) break
  }
  await w(1200)
  lines = [...document.querySelectorAll('.panel .val')].map(v => v.textContent)
  const has = re => lines.some(l => re.test(l))
  return {
    ok: has(/^Exported$/) && has(/✓ Summary and \d chapters written/) && has(/✓ Share page ready/) && has(/✓ Added to Supabase/) && has(/✓ Webhook told/),
    detail: lines.filter(l => /✓|:|Failed/.test(l)).join(' · ').slice(0, 300)
  }
}))

const shared = await run(String(async (pid) => (await window.__t.projectOf(pid)).share), SP)
const exportFile = path.join(out, 'export.mp4')
const exportSize = fs.existsSync(exportFile) ? fs.statSync(exportFile).size : 0
const noFillers = text => !/(^|\s)(um+|uh+|erm)[,.]?(\s|$)/i.test(text || '')
const storeUrl = key => `${sb.url}/storage/v1/object/public/videos/${key}`
const getMeta = async id => { const r = await fetch(`${storeUrl(`share/${id}/meta.json`)}?t=${Date.now()}`); return r.ok ? r.json() : null }

if (sb && shared?.url) {
  const meta = await getMeta(shared.id)
  const files = sb.files().filter(f => f.includes(`share/${shared.id}/`))
  const videoBytes = await fetch(meta?.video || 'http://127.0.0.1:1/').then(r => r.arrayBuffer()).then(b => b.byteLength).catch(() => 0)
  note('Share', 'in storage: the video, a poster and the page’s description, with title, summary, chapters, steps and captions',
    files.length === 3 && videoBytes === exportSize && meta.title === 'Setting up a new client' && meta.chapters.length === 3 && meta.steps.length >= 3 && meta.cues.length > 10 &&
    !!meta.summary && !!meta.poster && meta.count?.key === sb.anonKey && !JSON.stringify(meta).includes(sb.serviceKey) && noFillers(meta.cues.map(c => c.t).join(' ')),
    `${files.length} files · video ${(videoBytes / 1e6).toFixed(1)} MB · ${meta?.cues?.length} caption lines · secret key not published`)

  const row = JSON.parse(sb.sql('select row_to_json(v) from public.videos v order by exported_at desc limit 1') || 'null')
  note('Databases', 'the Supabase row carries the share link, summary, chapters and the edited transcript',
    !!row && row.share_url === shared.url && row.title === 'Setting up a new client' && !!row.summary && /^0:00 Getting started\n/.test(row.chapters) && row.duration_seconds > 30 && noFillers(row.transcript) && /dashboard/.test(row.transcript),
    `share_url ✓ · chapters “${String(row?.chapters).split('\n').join(' | ')}”`)

  const hook = receiver.state.got.at(-1)
  const hv = hook?.json?.video || {}
  note('Webhook', 'the export message carries the share link, embed code, summary, chapters and transcript, signed',
    receiver.state.got.length === 1 && hook.json.event === 'video.exported' && receiver.signed(hook, 'sweep-secret') && hv.shareLink === shared.url && /<iframe /.test(hv.embedCode) &&
    hv.title === 'Setting up a new client' && hv.chapters.length === 3 && /^0:00 /.test(hv.chaptersText) && !!hv.summary && hv.durationSeconds > 30 && hv.fileName === 'export.mp4' && noFillers(hv.transcript),
    `event=${hook?.json?.event} · ${Object.keys(hv).length} fields · signature valid`)
  note('Write-up', 'written once, automatically, as part of the export', aiModel.state.calls.length === 1, `${aiModel.state.calls.length} request`)

  /* ----------------------------------------------- watching it, as a viewer would */
  if (!browser) {
    note('Share page', 'a browser to watch the page in', false, 'Google Chrome is not installed')
  } else {
    let page = await browser.open(shared.url)
    await sleep(2500)
    const seen = await page.evaluate(String(async () => {
      const v = document.querySelector('video')
      for (let i = 0; i < 40 && !(v && v.readyState >= 1); i++) await new Promise(r => setTimeout(r, 250))
      return {
        title: document.querySelector('h1')?.textContent, docTitle: document.title, duration: v?.duration,
        chapters: [...document.querySelectorAll('.chapters button')].map(b => b.textContent), steps: document.querySelectorAll('.steps li').length,
        cues: document.querySelectorAll('.transcript span').length, poster: !!v?.poster, tracks: v?.textTracks.length, summary: !!document.querySelector('.summary'),
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), brand: document.querySelector('header.top img')?.alt || '', logo: document.querySelector('header.top img')?.naturalWidth || 0, bg: getComputedStyle(document.body).backgroundColor
      }
    }))
    note('Share page', 'opens in a browser with the video, title, summary, chapters, steps, transcript and captions',
      seen.title === 'Setting up a new client' && seen.docTitle === seen.title && seen.duration > 30 && seen.chapters.length === 3 && /0:00Getting started/.test(seen.chapters[0]) &&
      seen.steps >= 3 && seen.cues > 10 && seen.poster && seen.tracks === 1 && seen.summary && seen.accent.toUpperCase() === '#F5F5F7' && seen.bg === 'rgb(10, 10, 11)' && seen.brand === 'Ainable' && seen.logo > 0,
      `${seen.chapters.length} chapters · ${seen.steps} steps · ${seen.cues} transcript lines · logo “${seen.brand}” ${seen.logo}px · ${seen.accent} on ${seen.bg}`)

    const played = await page.evaluate(String(async () => {
      const v = document.querySelector('video'); const w = ms => new Promise(r => setTimeout(r, ms))
      v.muted = true
      await v.play(); await w(6000); v.pause(); await w(700)
      const first = v.currentTime
      // Jump to the last chapter: skipping ahead must not count as watching.
      const last = [...document.querySelectorAll('.chapters button')].pop()
      last.click(); await w(2500); v.pause(); await w(700)
      const lit = last.classList.contains('on')
      const jumped = v.currentTime
      const target = Number(last.dataset.t)
      // A step's "Watch from" link seeks too.
      const step = document.querySelectorAll('.steps .jump')[1]; step.click(); await w(1500); v.pause(); await w(700)
      return { first, jumped, target, lit, stepAt: Number(step.dataset.t), afterStep: v.currentTime, cueLit: !!document.querySelector('.transcript span.on') }
    }))
    await page.evaluate(String(async () => { scrollTo(0, 0); return true }))
    await page.shot(path.join(root, '.tmp', 'shot-share-page.png'))
    await page.evaluate(String(async () => { document.querySelector('.below').scrollIntoView(); return true }))
    await page.shot(path.join(root, '.tmp', 'shot-share-page-2.png'))
    await page.close()
    await sleep(900)
    const view = JSON.parse(sb.sql(`select row_to_json(v) from public.video_views v where video = '${shared.id}'`) || 'null')
    const realPlay = played.first + (played.jumped - played.target) + (played.afterStep - played.stepAt)
    note('Share page', 'chapters and steps jump to their moment, and the current chapter and line light up',
      played.first > 3.5 && played.jumped >= played.target && played.jumped < played.target + 4 && played.lit && played.afterStep >= played.stepAt && played.afterStep < played.stepAt + 3 && played.cueLit,
      `played to ${played.first.toFixed(1)}s · chapter → ${played.jumped.toFixed(1)}s · step → ${played.afterStep.toFixed(1)}s`)
    note('Metrics', 'one view recorded, counting only time actually played (skipping ahead is not watching)',
      !!view && Math.abs(view.seconds - realPlay) < 1.6 && view.seconds < played.jumped && Math.abs(view.duration - seen.duration) < 1,
      `recorded ${view?.seconds}s watched of ${view?.duration}s · actually played ≈ ${realPlay.toFixed(1)}s`)

    // The embed: paste the code the app gives into a page, and watch from inside it.
    page = await browser.open(`${shared.url}&embed=1`)
    await sleep(2000)
    const emb = await page.evaluate(String(async () => {
      const v = document.querySelector('video'); const w = ms => new Promise(r => setTimeout(r, ms))
      v.muted = true; await v.play(); await w(3000); v.pause(); await w(600)
      const r = v.getBoundingClientRect()
      return { embed: document.body.classList.contains('embed'), below: getComputedStyle(document.querySelector('.below')).display, fills: Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2, t: v.currentTime }
    }))
    await page.close()
    page = await browser.open('about:blank')
    const frame = await page.evaluate(String(async (code) => {
      document.body.style.margin = '0'
      document.body.innerHTML = `<div style="width:800px">${code}</div>`
      const f = document.querySelector('iframe')
      await new Promise(r => { f.addEventListener('load', r); setTimeout(r, 6000) })
      const r = f.getBoundingClientRect()
      return { src: f.src, w: Math.round(r.width), h: Math.round(r.height), allow: f.getAttribute('allow'), full: f.hasAttribute('allowfullscreen') }
    }), shared.embed)
    await page.close()
    note('Embed', 'the embed code shows only the video, filling its frame, at the video’s shape',
      emb.embed && emb.below === 'none' && emb.fills && emb.t > 2 && /embed=1$/.test(frame.src) && frame.w === 800 && Math.abs(frame.h - 450) <= 2 && frame.full && /fullscreen/.test(frame.allow),
      `embedded frame ${frame.w}×${frame.h} · page chrome hidden · played ${emb.t.toFixed(1)}s inside it`)

    await sleep(900)
    await check('Metrics', 'the app shows the numbers: views, average watch time, percent watched', String(async () => {
      const { w, click, txt, waitFor } = window.__t
      click(document.querySelector('[data-act=share-refresh]')); await w(600)
      await waitFor(() => !/Refreshing/.test(txt(document.querySelector('[data-act=share-refresh]'))))
      const cells = [...document.querySelectorAll('[data-act=share-stats] > div')].map(d => txt(d))
      const views = Number(document.querySelector('[data-act=share-stats] b')?.textContent)
      const s = await window.knight.share.stats((await window.knight.projects.load('prj_spoken000000')).share.id)
      return { ok: views === 2 && s.views === 2 && s.avgSeconds > 2 && s.avgSeconds < 12 && s.avgPercent > 3 && s.avgPercent < 40 && cells.length === 3 && /average watch time/.test(cells[1]), detail: cells.join(' · ') }
    }))

    { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(root, '.tmp', 'shot-export-panel.png'), Buffer.from(r.result.data, 'base64')) }
    await run(String(async () => { document.querySelector('.panel').scrollTop = 0; document.querySelector('[data-tour=writeup]').scrollIntoView(); return true }))
    { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(root, '.tmp', 'shot-export-panel-2.png'), Buffer.from(r.result.data, 'base64')) }
    for (const [name, url, pattern] of [
      ['a link to a video that does not exist says so plainly', shared.url.replace(/v=[\w-]+/, 'v=doesnotexist1'), /no longer shared/],
      ['a broken link says so plainly', `${viewer.base}/?p=abc`, /link is incomplete/]
    ]) {
      page = await browser.open(url)
      await sleep(1800)
      const text = await page.evaluate(String(async () => document.querySelector('.state')?.textContent || ''))
      await page.close()
      note('Share page', name, pattern.test(text), text.slice(0, 90))
    }
  }

  /* --------------------------------------------------------------- written SOP */
  await check('Written SOP', 'builds the document, with a screenshot for every step', String(async () => {
    const { w, click, txt, waitFor } = window.__t
    click(document.querySelector('[data-act=sop]')); await w(500)
    await waitFor(() => document.querySelector('[data-act=sop-done], [data-act=sop-error]'), 90000)
    const done = txt(document.querySelector('[data-act=sop-done]')) || txt(document.querySelector('[data-act=sop-error]'))
    return { ok: /✓ \d+ steps, \d+ with a screenshot/.test(done) && !!document.querySelector('[data-act=sop-open]'), detail: done }
  }))
  {
    const html = path.join(out, 'Setting up a new client - SOP.html')
    const pdf = path.join(out, 'Setting up a new client - SOP.pdf')
    const text = fs.existsSync(html) ? fs.readFileSync(html, 'utf8') : ''
    const imgs = [...text.matchAll(/<img src="data:image\/jpeg;base64,([A-Za-z0-9+/=]+)"/g)].map(m => m[1])
    const steps = (text.match(/<section class="step">/g) || []).length
    const pdfBytes = fs.existsSync(pdf) ? fs.readFileSync(pdf) : Buffer.alloc(0)
    const pages = (pdfBytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
    note('Written SOP', 'the files: a web page and a PDF, numbered steps, a different picture per step, a link back to the video',
      steps >= 3 && imgs.length === steps && new Set(imgs.map(i => i.slice(2000, 2400))).size === steps && /<h1>Setting up a new client<\/h1>/.test(text) && text.includes(shared.url.replace(/&/g, '&amp;')) &&
      pdfBytes.subarray(0, 5).toString() === '%PDF-' && pdfBytes.length > 30000 && pages >= 1,
      `${steps} steps · ${imgs.length} screenshots (all different) · PDF ${Math.round(pdfBytes.length / 1024)} KB, ${pages} page${pages === 1 ? '' : 's'}`)
    fs.copyFileSync(pdf, path.join(root, '.tmp', 'sweep-sop.pdf')); fs.copyFileSync(html, path.join(root, '.tmp', 'sweep-sop.html'))
  }

  /* ------------------------------------------------- updating and taking down */
  await check('Share', '“Update page” keeps the same link and carries the new title', String(async (pid) => {
    const { w, tool, click, setValue, txt, waitFor, projectOf } = window.__t
    const before = (await projectOf(pid)).share
    await tool('Setup'); setValue(document.querySelector('.panel input.input'), 'Setting up a client (v2)'); await w(700)
    await tool('Export')
    click(document.querySelector('[data-act=share-republish]')); await w(600)
    await waitFor(() => /^Update page$/.test(txt(document.querySelector('[data-act=share-republish]'))), 60000)
    const after = (await projectOf(pid)).share
    return { ok: after.id === before.id && after.url === before.url && after.videoKey !== before.videoKey && !document.querySelector('[data-act=share-error]'), detail: after.url.slice(-40) }
  }), SP)
  {
    const meta = await getMeta(shared.id)
    const files = sb.files().filter(f => f.includes(`share/${shared.id}/`))
    note('Share', 'the old copy of the video is removed from storage; nothing piles up', meta?.title === 'Setting up a client (v2)' && files.length === 3, `${files.length} files · title “${meta?.title}”`)
  }

  sb.setFileLimit(Math.round(exportSize * 0.6))
  await check('Share', 'a video too large for the storage plan is shared as a smaller copy instead of failing', String(async (pid) => {
    const { w, click, txt, waitFor, projectOf } = window.__t
    click(document.querySelector('[data-act=share-republish]')); await w(600)
    await waitFor(() => /^Update page$/.test(txt(document.querySelector('[data-act=share-republish]'))), 120000)
    const s = (await projectOf(pid)).share
    return { ok: s.reduced === true && /smaller copy/.test(txt(document.querySelector('[data-tour=share]'))) && !document.querySelector('[data-act=share-error]'), detail: txt(document.querySelector('[data-act=share-reduced]')) }
  }), SP)
  {
    const meta = await getMeta(shared.id)
    const bytes = await fetch(meta.video).then(r => r.arrayBuffer()).then(b => b.byteLength)
    let plays = null
    if (browser) {
      const page = await browser.open(shared.url)
      await sleep(2000)
      plays = await page.evaluate(String(async () => { const v = document.querySelector('video'); v.muted = true; await v.play(); await new Promise(r => setTimeout(r, 2000)); v.pause(); return { t: v.currentTime, h: v.videoHeight } }))
      await page.close()
    }
    note('Share', 'the smaller copy fits the limit and plays', bytes < exportSize * 0.6 && bytes > 20000 && (!browser || (plays.t > 1 && plays.h === 720)), `${(bytes / 1e6).toFixed(2)} MB (limit ${(exportSize * 0.6 / 1e6).toFixed(2)} MB) · ${plays ? `${plays.h}p, played ${plays.t.toFixed(1)}s` : ''}`)
  }
  sb.setFileLimit(8000)
  await check('Share', 'when even the smaller copy will not fit, it says why and the existing page is left working', String(async (pid) => {
    const { w, click, txt, waitFor, projectOf } = window.__t
    const before = (await projectOf(pid)).share
    click(document.querySelector('[data-act=share-republish]')); await w(600)
    await waitFor(() => document.querySelector('[data-act=share-error]'), 120000)
    const after = (await projectOf(pid)).share
    return { ok: /Even a smaller copy/.test(txt(document.querySelector('[data-act=share-error]'))) && after.videoKey === before.videoKey, detail: txt(document.querySelector('[data-act=share-error]')).slice(0, 110) }
  }), SP)
  note('Share', '…the page from before still loads', !!(await getMeta(shared.id))?.video && (await fetch((await getMeta(shared.id)).video, { method: 'HEAD' })).ok)
  sb.setFileLimit(1e9)

  await check('Share', '“Take down” removes the page; the link is offered again', String(async (pid) => {
    const { w, click, txt, waitFor, projectOf, toggle } = window.__t
    click(document.querySelector('[data-act=share-remove]')); await w(900)
    await waitFor(() => document.querySelector('[data-act=share-now]'))
    const p = await projectOf(pid)
    const off = toggle('Make a share page after export'); await w(500)
    const p2 = await projectOf(pid)
    toggle('Make a share page after export'); await w(400)
    return { ok: !p.share && !!document.querySelector('[data-act=share-now]') && !document.querySelector('[data-act=share-link]') && off.after === false && p2.sharePage === false }
  }), SP)
  {
    const gone = sb.files().filter(f => f.includes(`share/${shared.id}/`))
    const kept = Number(sb.sql(`select count(*) from public.video_views where video = '${shared.id}'`).trim())
    let text = ''
    if (browser) { const page = await browser.open(shared.url); await sleep(1800); text = await page.evaluate(String(async () => document.querySelector('.state')?.textContent || '')); await page.close() }
    note('Share', 'after taking down: files gone, the link says so, the view history is kept', gone.length === 0 && kept >= 2 && (!browser || /no longer shared/.test(text)), `${gone.length} files left · ${kept} views kept · “${text.slice(0, 40)}”`)
  }
  await check('Share', '“Share the last export now” makes a fresh page without exporting again', String(async (pid) => {
    const { w, click, waitFor, projectOf, txt } = window.__t
    click(document.querySelector('[data-act=share-now]')); await w(600)
    await waitFor(() => document.querySelector('[data-act=share-link]'), 60000)
    const s = (await projectOf(pid)).share
    await w(800)
    return { ok: !!s?.url && /^0$/.test(document.querySelector('[data-act=share-stats] b')?.textContent || '') , detail: txt(document.querySelector('[data-act=share-stats]')) }
  }), SP)
}

/* ====================================================== sharing with people */
// Drive-style sharing through the sharing service: sign in, share by email, the viewer's
// side in a real browser, completion tracking, and the admin and member views.
if (!cloud) {
  note('Sharing', 'local database available for the sharing checks', false, 'brew install postgresql@17 postgrest')
} else {
  const cloudFiles = () => cloud.files().filter(f => f.startsWith('videos/') && !f.includes('/brand/'))
  const pressAndWait = (sel, ms = 600) => run(String(async ({ sel, ms }) => { window.__t.click(document.querySelector(sel)); await window.__t.w(ms); return true }), { sel, ms })

  await check('Account', 'an address that is not an email is refused; a code is sent to a real one', String(async () => {
    const { w, click, setValue, txt, settingsTab, waitFor, find } = window.__t
    if (!document.querySelector('.modal')) { click(find('.tools .tool', 'Settings')); await w(500) }
    await settingsTab('Account')
    const card = () => document.querySelector('[data-conn="account"]')
    setValue(card().querySelector('[data-field=email]'), 'not-an-email'); await w(100)
    click(card().querySelector('[data-act=account-send]'))
    await waitFor(() => card().querySelector('[data-act=account-msg]'))
    const err = txt(card().querySelector('[data-act=account-msg]'))
    setValue(card().querySelector('[data-field=email]'), 'Ollie@SweepCo.com'); await w(100)
    click(card().querySelector('[data-act=account-send]'))
    await waitFor(() => card().querySelector('[data-field=code]'))
    return { ok: /does not look like an email/.test(err) && /ollie@sweepco\.com/.test(txt(card())), detail: err }
  }))
  await check('Account', 'a wrong code is refused; the right one signs in and makes you admin of a new workspace', String(async (code) => {
    const { w, click, setValue, txt, waitFor } = window.__t
    const card = () => document.querySelector('[data-conn="account"]')
    setValue(card().querySelector('[data-field=code]'), '000000'); await w(100)
    click(card().querySelector('[data-act=account-verify]'))
    await waitFor(() => card().querySelector('[data-act=account-msg]'))
    const err = txt(card().querySelector('[data-act=account-msg]'))
    setValue(card().querySelector('[data-field=code]'), code); await w(100)
    click(card().querySelector('[data-act=account-verify]'))
    await waitFor(() => card().querySelector('[data-conn-state]'))
    const st = await window.knight.cloud.status()
    return { ok: /not right/.test(err) && st.signedIn && st.role === 'admin' && st.email === 'ollie@sweepco.com' && /Admin of Sweepco videos/.test(txt(card().querySelector('[data-conn-state]'))), detail: txt(card().querySelector('[data-conn-state]')) }
  }), cloud.codeFor('ollie@sweepco.com'))
  await check('Account', 'the workspace can be renamed; the sign-in is kept in the private store, not in settings', String(async () => {
    const { w, click, setValue, txt, waitFor, closeModal } = window.__t
    const card = () => document.querySelector('[data-conn="account"]')
    setValue(card().querySelector('[data-field=workspace]'), 'Sweep Co'); await w(100)
    click(card().querySelector('[data-act=account-rename]'))
    await waitFor(() => /Sweep Co$/.test(txt(card().querySelector('[data-conn-state]'))))
    const p = await window.knight.prefs.read()
    await closeModal()
    return { ok: p.cloud.workspace === 'Sweep Co' && !/access|refresh|eyJ/.test(JSON.stringify(p.cloud)), detail: txt(document.querySelector('[data-tour=cloud-share]'))?.slice(0, 60) }
  }))

  await check('Sharing', '“Share…” uploads the last export and opens the Share box', String(async (pid) => {
    const { w, tool, click, txt, waitFor, projectOf } = window.__t
    await tool('Export')
    click(window.__t.must('[data-act=cloud-share]'))
    await waitFor(() => document.querySelector('[data-act=share-dialog] [data-act=cloud-link]'), 90000)
    const p = await projectOf(pid)
    const link = txt(document.querySelector('[data-act=cloud-link]'))
    return { ok: !!p.cloud?.id && link === p.cloud.url && /\/watch\?v=/.test(link) && /Only people you have added/.test(txt(document.querySelector('[data-act=share-access]'))) && !document.querySelector('[data-act=cloud-embed]'), detail: link.slice(-28) }
  }), SP)
  const cv = await run(String(async (pid) => (await window.__t.projectOf(pid)).cloud), SP)
  note('Sharing', 'the video and its poster are stored under a long random path in your workspace', cloudFiles().length === 2 && cloudFiles().every(f => f.split('/')[2].length >= 20), cloudFiles()[0]?.slice(0, 70))

  await check('Sharing', 'a bad address is refused; two people are added as required viewers', String(async () => {
    const { w, click, setValue, txt, waitFor, toggle } = window.__t
    const d = () => document.querySelector('[data-act=share-dialog]')
    setValue(d().querySelector('[data-field=share-emails]'), 'nonsense'); await w(100)
    click(d().querySelector('[data-act=share-add]'))
    await waitFor(() => d().querySelector('[data-act=share-msg]'))
    const err = txt(d().querySelector('[data-act=share-msg]'))
    setValue(d().querySelector('[data-field=share-emails]'), 'Client@Acme.com, hire@acme.com'); await w(100)
    toggle('Required viewing', d()); await w(150)
    click(d().querySelector('[data-act=share-add]'))
    await waitFor(() => d().querySelectorAll('[data-act=share-people] .sh-row').length === 2)
    const rows = [...d().querySelectorAll('[data-act=share-people] .sh-row')].map(txt)
    return { ok: /at least one email/.test(err) && rows.every(r => /Required/.test(r) && /Not opened yet/.test(r)) && /0 of 2 required viewers finished/.test(txt(d())) && !!d().querySelector('[data-act=cloud-mail]'), detail: rows.join(' | ').slice(0, 140) }
  }))

  /* ---------------------------------------------------- the viewer's side */
  const link = cv.url
  const webSignIn = async (page, email) => {
    await page.evaluate(String(async (email) => { for (let i = 0; i < 60 && !document.querySelector('#e'); i++) await new Promise(r => setTimeout(r, 150)); const e = document.querySelector('#e'); if (!e) throw new Error('no sign-in form: ' + document.querySelector('#app').innerText.slice(0, 80)); e.value = email; document.querySelector('#g').requestSubmit(); for (let i = 0; i < 40 && !document.querySelector('#c'); i++) await new Promise(r => setTimeout(r, 150)); return true }), email)
    await page.evaluate(String(async (code) => { document.querySelector('#c').value = code; document.querySelector('#g').requestSubmit(); return true }), cloud.codeFor(email))
    await sleep(2200)
  }
  const pageText = page => page.evaluate(String(async () => document.querySelector('#app').innerText.replace(/\s+/g, ' ').slice(0, 400)))
  if (browser) {
    let page = await browser.open(link)
    await sleep(2000)
    const gate = await pageText(page)
    note('Viewer', 'an invited-only link asks a visitor to sign in and reveals nothing about the video', /Sign in to watch/.test(gate) && !/Setting up/.test(gate) && !(await page.evaluate(String(async () => !!document.querySelector('video')))), gate.slice(0, 70))
    await webSignIn(page, 'stranger@else.com')
    const denied = await pageText(page)
    note('Viewer', 'someone it was not shared with is told so, and still sees nothing', /do not have access/.test(denied) && /stranger@else\.com/.test(denied) && !/Setting up/.test(denied), denied.slice(0, 90))
    await page.evaluate(String(async () => { document.querySelector('#other').click(); await new Promise(r => setTimeout(r, 1500)); return true }))
    await webSignIn(page, 'client@acme.com')
    const seen = await page.evaluate(String(async () => {
      const v = document.querySelector('video')
      for (let i = 0; i < 40 && !(v && v.readyState >= 1); i++) await new Promise(r => setTimeout(r, 250))
      return { title: document.querySelector('h1')?.textContent, status: document.querySelector('#status')?.innerText, bar: document.querySelector('.bar')?.innerText, chapters: document.querySelectorAll('.chapters button').length, steps: document.querySelectorAll('.steps li').length, dur: v?.duration }
    }))
    note('Viewer', 'an invited person signs in with an emailed code and gets the video, marked as required viewing',
      /Setting up/.test(seen.title) && /Required viewing/.test(seen.status) && /client@acme\.com/.test(seen.bar) && /Sweep/.test(seen.bar) && seen.chapters === 3 && seen.steps >= 3 && seen.dur > 30, `${seen.title} · ${seen.status?.replace(/\n/g, ' ')}`)

    const part = await page.evaluate(String(async () => {
      const v = document.querySelector('video'); const w = ms => new Promise(r => setTimeout(r, ms))
      v.muted = true; await v.play(); await w(6000); v.pause(); await w(1500)
      return { t: v.currentTime, status: document.querySelector('#status').innerText }
    }))
    await page.shot(path.join(root, '.tmp', 'shot-watch-required.png'))
    const pct1 = Number(cloud.sql(`select public.ks_percent(coverage) from public.progress where video_id = '${cv.id}' and email = 'client@acme.com'`).trim())
    note('Viewer', 'watching part of it is recorded against their name, and the page shows their progress', part.t > 4 && pct1 >= 10 && pct1 <= 35 && new RegExp(`${pct1}% watched so far`).test(part.status), `played ${part.t.toFixed(1)}s → ${pct1}% · “${part.status.replace(/\n/g, ' ')}”`)

    // Skipping to the end must not finish it.
    const skip = await page.evaluate(String(async () => {
      const v = document.querySelector('video'); const w = ms => new Promise(r => setTimeout(r, ms))
      v.currentTime = v.duration - 3; await v.play(); await w(4500); await w(1500)
      return document.querySelector('#status').innerText
    }))
    const pct2 = Number(cloud.sql(`select public.ks_percent(coverage) from public.progress where video_id = '${cv.id}' and email = 'client@acme.com'`).trim())
    note('Completion', 'skipping to the end does not count as finishing', pct2 < 60 && !/Completed/.test(skip), `${pct2}% after jumping to the last 3 seconds`)
    await page.close()

    // Come back later and watch the rest (sped up): progress adds up across visits.
    page = await browser.open(link)
    await sleep(2500)
    const fin = await page.evaluate(String(async () => {
      const v = document.querySelector('video'); const w = ms => new Promise(r => setTimeout(r, ms))
      const before = document.querySelector('#status').innerText
      v.muted = true; v.currentTime = 0; v.playbackRate = 4; await v.play()
      for (let i = 0; i < 80 && !v.ended; i++) await w(250)
      await w(2000)
      return { before, after: document.querySelector('#status').innerText, signedInStill: !!document.querySelector('.bar .who') }
    }))
    await page.close()
    const done = cloud.sql(`select public.ks_percent(coverage) || '|' || (completed_at is not null) from public.progress where video_id = '${cv.id}' and email = 'client@acme.com'`).trim()
    note('Completion', 'coming back and watching the rest completes it; they stayed signed in between visits', /% watched so far/.test(fin.before) && /Completed/.test(fin.after) && fin.signedInStill && /^(9\d|100)\|true$/.test(done), `“${fin.before.replace(/\n/g, ' ')}” → “${fin.after.replace(/\n/g, ' ')}” · stored ${done}`)

    page = await browser.open(`${viewer.base}/shared`)
    await sleep(2200)
    const mine = await page.evaluate(String(async () => ({ tiles: document.querySelectorAll('.tile').length, text: document.querySelector('#app').innerText.replace(/\s+/g, ' ').slice(0, 200), href: document.querySelector('.tile')?.getAttribute('href') })))
    await page.shot(path.join(root, '.tmp', 'shot-shared-with-me.png'))
    note('Viewer', '“Shared with me” lists their videos with progress, and links to each', mine.tiles === 1 && /Completed/.test(mine.text) && /client@acme\.com/.test(mine.text) && /^watch\?v=/.test(mine.href), mine.text.slice(0, 110))
    await page.evaluate(String(async () => { document.querySelector('#out').click(); await new Promise(r => setTimeout(r, 800)); return true }))
    await webSignIn(page, 'hire@acme.com')
    const todo = await pageText(page)
    note('Viewer', 'a person who has not watched their required video sees it under “To watch”', /To watch · 1 required/.test(todo) && /Required/.test(todo) && !/Completed/.test(todo), todo.slice(0, 110))
    await page.evaluate(String(async () => { document.querySelector('#out').click(); await new Promise(r => setTimeout(r, 600)); return true }))
    const out = await pageText(page)
    await page.close()
    note('Viewer', 'signing out returns to the sign-in page', /Sign in with your email address/.test(out))
  }

  await check('Sharing', 'the Share box shows who watched, how much, and who has finished the required viewing', String(async () => {
    const { w, click, txt, waitFor } = window.__t
    const d = () => document.querySelector('[data-act=share-dialog]')
    click(d().querySelector('[data-act=share-reload]')); await w(1200)
    const row = e => txt(d().querySelector(`.sh-row[data-email="${e}"]`))
    const totals = [...d().querySelectorAll('[data-act=share-totals] b')].map(b => b.textContent)
    return { ok: /Completed/.test(row('client@acme.com')) && /Not opened yet/.test(row('hire@acme.com')) && /1 of 2 required viewers finished/.test(txt(d())) && Number(totals[0]) >= 2, detail: `${row('client@acme.com').slice(0, 60)} · views ${totals.join(' / ')}` }
  }))

  await check('Sharing', '“Anyone with the link” turns on the embed code', String(async () => {
    const { w, setValue, txt, waitFor } = window.__t
    const d = () => document.querySelector('[data-act=share-dialog]')
    await waitFor(() => !d().querySelector('[data-act=share-access]').disabled)
    window.__t.pick(d().querySelector('[data-act=share-access]'), 'link')
    await waitFor(() => d().querySelector('[data-act=cloud-embed]'))
    return { ok: !!d().querySelector('[data-act=cloud-embed]'), detail: txt(d().querySelector('[data-act=share-msg]')) || d().querySelector('[data-act=share-access]').value }
  }))
  if (browser) {
    let page = await browser.open(link)
    await sleep(1500)
    await page.evaluate(String(async () => { localStorage.clear(); return true }))
    await page.close()
    page = await browser.open(`${link}&embed=1`)
    await sleep(2200)
    const anon = await page.evaluate(String(async () => {
      const v = document.querySelector('video'); const w = ms => new Promise(r => setTimeout(r, ms))
      if (!v) return { gate: document.querySelector('#app').innerText.slice(0, 60) }
      v.muted = true; await v.play(); await w(2500); v.pause(); await w(900)
      const r = v.getBoundingClientRect()
      return { t: v.currentTime, embed: document.body.classList.contains('embed'), fills: Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2 }
    }))
    await page.close()
    const anonViews = Number(cloud.sql(`select count(*) from public.views where video_id = '${cv.id}' and viewer_email is null`).trim())
    note('Sharing', 'with the link open, anyone can watch (embedded too) without signing in, counted anonymously', anon.t > 1.5 && anon.embed && anon.fills && anonViews === 1, anon.gate || `played ${anon.t?.toFixed(1)}s embedded · ${anonViews} anonymous view`)
  }

  await check('Sharing', 'back to invited-only; removing a person stops them watching', String(async () => {
    const { w, click, setValue, txt, waitFor } = window.__t
    const d = () => document.querySelector('[data-act=share-dialog]')
    await waitFor(() => !d().querySelector('[data-act=share-access]').disabled)
    window.__t.pick(d().querySelector('[data-act=share-access]'), 'invited')
    await waitFor(() => !d().querySelector('[data-act=cloud-embed]'))
    await waitFor(() => !d().querySelector('[data-act=share-access]').disabled)
    click(d().querySelector('.sh-row[data-email="hire@acme.com"] [data-act=share-remove-person]'))
    await waitFor(() => d().querySelectorAll('[data-act=share-people] .sh-row').length === 1)
    return { ok: /1 of 1 required viewers finished/.test(txt(d())) }
  }))
  if (browser) {
    const page = await browser.open(link)
    await sleep(1500)
    const gate = await pageText(page)
    await webSignIn(page, 'hire@acme.com')
    const denied = await pageText(page)
    await page.evaluate(String(async () => { localStorage.clear(); return true }))
    await page.close()
    note('Viewer', 'after the link is closed again and a person removed, they are refused', /Sign in to watch/.test(gate) && /do not have access/.test(denied), denied.slice(0, 70))
  }

  /* -------------------------------------------------------------- folders */
  await check('Sharing', 'a video in a folder can be shared as “everything in the folder”', String(async (pid) => {
    const { w, click, setValue, txt, waitFor, find } = window.__t
    click(window.__t.must('[data-act=share-close]')); await w(400)
    // Videos are filed into folders from the library, so do it there.
    click(find('.topbar .btn', '← Library')); await w(900)
    const { folder } = await window.knight.library.createFolder('Onboarding')
    await window.knight.library.moveProject(pid, folder.id)
    click(window.__t.all('.card').find(c => /Setting up/.test(txt(c))))
    await waitFor(() => document.querySelector('.tl-seg'), 25000)
    await w(1200); await window.__t.closeTours(); await window.__t.tool('Export')
    click(window.__t.must('[data-act=cloud-update]')); await w(800)
    await waitFor(() => { const b = document.querySelector('[data-act=cloud-update]'); return b && !b.disabled }, 90000)
    click(window.__t.must('[data-act=cloud-share]'))
    await waitFor(() => document.querySelector('[data-act=share-scope]'), 20000)
    const d = () => document.querySelector('[data-act=share-dialog]')
    click(find('[data-act=share-scope] button', /Everything in/, d())); await w(150)
    setValue(d().querySelector('[data-field=share-emails]'), 'team@acme.com'); await w(100)
    click(d().querySelector('[data-act=share-add]'))
    await waitFor(() => d().querySelector('.sh-row[data-email="team@acme.com"]'))
    const row = txt(d().querySelector('.sh-row[data-email="team@acme.com"]'))
    click(window.__t.must('[data-act=share-close]')); await w(400)
    return { ok: /Through the folder “Onboarding”/.test(row), detail: row.slice(0, 80) }
  }), SP)
  note('Sharing', 'updating keeps the same link and replaces the stored file rather than piling up',
    (await run(String(async (pid) => (await window.__t.projectOf(pid)).cloud.id), SP)) === cv.id && cloudFiles().length === 2, `${cloudFiles().length} files`)

  await check('Export', 'exporting again puts the new version behind the same link, and says so', String(async (pid) => {
    const { w, find, click, txt, projectOf } = window.__t
    const before = (await projectOf(pid)).cloud
    click(find('.panel .btn', 'Export MP4'))
    let lines = []
    for (let i = 0; i < 600; i++) {
      await w(1000)
      lines = [...document.querySelectorAll('.panel .val')].map(v => v.textContent)
      if (lines.some(l => /Failed/.test(l)) || (lines.some(l => /^Exported/.test(l)) && lines.some(l => /Webhook/.test(l)))) break
    }
    const after = (await projectOf(pid)).cloud
    return { ok: lines.some(l => /✓ Ready to share/.test(l)) && after.id === before.id && after.url === before.url && after.updatedAt !== before.updatedAt, detail: lines.filter(l => /✓/.test(l)).join(' · ').slice(0, 200) }
  }), SP)
  {
    const hook = receiver.state.got.at(-1)?.json?.video || {}
    note('Export', 'the webhook and the databases now carry the sharing link', hook.shareLink === cv.url && /watch\?v=/.test(hook.embedCode), hook.shareLink?.slice(-26))
  }

  /* ------------------------------------------------ admin view and user view */
  await check('Admin view', 'Sharing screen: every video with its numbers; People with required progress and details', String(async () => {
    const { w, find, click, txt, waitFor } = window.__t
    click(find('.topbar .btn', '← Library')); await w(900)
    click(window.__t.must('[data-act=open-sharing]'))
    await waitFor(() => document.querySelector('[data-act=sharing-videos] .sh-row'), 20000)
    const role = txt(document.querySelector('[data-act=sharing-role]'))
    const tabs = [...document.querySelectorAll('[data-sharing-tab]')].map(txt)
    const video = txt(document.querySelector('[data-act=sharing-videos] .sh-row'))
    click(window.__t.must('[data-sharing-tab=people]'))
    await waitFor(() => document.querySelector('[data-act=sharing-people] .sh-row'))
    const client = () => document.querySelector('[data-act=sharing-people] .sh-row[data-email="client@acme.com"]')
    const line = txt(client())
    click(client().querySelector('[data-act=people-expand]')); await w(300)
    const detail = txt(document.querySelector('[data-act=people-detail]'))
    return {
      ok: /Admin view/.test(role) && /Sweep Co/.test(role) && tabs.join() === 'Videos,People,Team' && /Setting up/.test(video) && /1\/1 finished/.test(video) && /Onboarding/.test(video) &&
        /1\/1 required finished/.test(line) && /Completed/.test(detail) && !!document.querySelector('.sh-row[data-email="team@acme.com"]'),
      detail: `${role} · ${video.slice(0, 80)} · ${line.slice(0, 60)}`
    }
  }))
  { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(root, '.tmp', 'shot-sharing-admin.png'), Buffer.from(r.result.data, 'base64')) }

  await check('Admin view', '“Remove access” takes a person off everything at once', String(async () => {
    const { w, click, waitFor } = window.__t
    click(window.__t.must('.sh-row[data-email="team@acme.com"] [data-act=people-remove]'))
    await waitFor(() => !document.querySelector('.sh-row[data-email="team@acme.com"]'))
    return { ok: !!document.querySelector('.sh-row[data-email="client@acme.com"]') }
  }))
  note('Admin view', '…including what they had through a folder', cloud.sql("select count(*) from public.folder_grants where email = 'team@acme.com'").trim() === '0')

  await check('Admin view', 'Team: add a member, change a role, and the last admin cannot be removed', String(async () => {
    const { w, click, setValue, txt, waitFor } = window.__t
    click(window.__t.must('[data-sharing-tab=team]')); await w(400)
    setValue(document.querySelector('[data-field=team-email]'), 'Josh@SweepCo.com'); await w(100)
    click(window.__t.must('[data-act=team-add]'))
    await waitFor(() => document.querySelector('[data-act=sharing-team] .sh-row[data-email="josh@sweepco.com"]'))
    const invited = txt(document.querySelector('.sh-row[data-email="josh@sweepco.com"]'))
    window.__t.pick(document.querySelector('.sh-row[data-email="ollie@sweepco.com"] [data-act=team-role]'), 'member')
    await waitFor(() => document.querySelector('[data-act=sharing-msg]'))
    const refused = txt(document.querySelector('[data-act=sharing-msg]'))
    const self = document.querySelector('.sh-row[data-email="ollie@sweepco.com"] [data-act=team-remove]').disabled
    return { ok: /has not signed in yet/.test(invited) && /at least one admin/.test(refused) && self, detail: `${invited.slice(0, 60)} · ${refused}` }
  }))
  { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(root, '.tmp', 'shot-sharing-team.png'), Buffer.from(r.result.data, 'base64')) }

  // The other side: a team member signs in on their copy of the app.
  cloud.setAccessTtl(2)       // their sign-in also has to renew itself quietly
  await check('User view', 'sign out; a team member signs in and joins the workspace as a member', String(async () => {
    const { w, click, setValue, txt, waitFor, settingsTab } = window.__t
    click(window.__t.must('[data-act=sharing-screen] .modal-close')); await w(400)
    try { await settingsTab('Account') } catch (e) { return { ok: false, detail: `modal=${!!document.querySelector('.modal')} sharing=${!!document.querySelector('[data-act=sharing-screen]')} foot=${[...document.querySelectorAll('.lib-foot .folder')].map(b => b.textContent).join(',')} tools=${document.querySelectorAll('.tools .tool').length} body=${document.body.innerText.slice(0, 80)}` } }
    const card = () => document.querySelector('[data-conn="account"]')
    click(card().querySelector('[data-act=account-signout]'))
    await waitFor(() => card().querySelector('[data-field=email]'))
    const out = (await window.knight.cloud.status()).signedIn === false
    setValue(card().querySelector('[data-field=email]'), 'josh@sweepco.com'); await w(100)
    click(card().querySelector('[data-act=account-send]'))
    await waitFor(() => card().querySelector('[data-field=code]'))
    return { ok: out }
  }))
  await check('User view', '…and sees “Your view”: only their own videos, no People or Team', String(async (code) => {
    const { w, click, setValue, txt, waitFor, closeModal } = window.__t
    const card = () => document.querySelector('[data-conn="account"]')
    setValue(card().querySelector('[data-field=code]'), code); await w(100)
    click(card().querySelector('[data-act=account-verify]'))
    await waitFor(() => card().querySelector('[data-conn-state]'))
    const state = txt(card().querySelector('[data-conn-state]'))
    await closeModal()
    await w(3200)             // long enough for the sign-in to run out
    click(window.__t.must('[data-act=open-sharing]'))
    await waitFor(() => document.querySelector('[data-act=sharing-role]'), 20000)
    await w(800)
    const role = txt(document.querySelector('[data-act=sharing-role]'))
    const tabs = [...document.querySelectorAll('[data-sharing-tab]')].map(txt)
    const empty = txt(document.querySelector('[data-act=sharing-empty]'))
    const rows = document.querySelectorAll('[data-act=sharing-videos] .sh-row').length
    let blocked = 0
    for (const fn of ['people', 'team']) { try { await window.knight.cloud[fn]() } catch { blocked++ } }
    return { ok: /Member of Sweep Co/.test(state) && /Your view/.test(role) && tabs.join() === 'My videos' && rows === 0 && /Nothing here yet/.test(empty) && blocked === 2 && !document.querySelector('[data-act=sharing-msg]'), detail: `${state} · ${role} · tabs: ${tabs.join()}` }
  }), await (async () => { for (let i = 0; i < 40 && !cloud.codeFor('josh@sweepco.com'); i++) await sleep(150); return cloud.codeFor('josh@sweepco.com') })())
  { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(root, '.tmp', 'shot-sharing-member.png'), Buffer.from(r.result.data, 'base64')) }
  cloud.setAccessTtl(3600)

  await check('Admin view', 'sign back in as the admin; “Take down” removes the video for everyone', String(async () => {
    const { w, click, setValue, waitFor, settingsTab } = window.__t
    click(window.__t.must('[data-act=sharing-screen] .modal-close')); await w(400)
    await settingsTab('Account')
    const card = () => document.querySelector('[data-conn="account"]')
    click(card().querySelector('[data-act=account-signout]'))
    await waitFor(() => card().querySelector('[data-field=email]'))
    setValue(card().querySelector('[data-field=email]'), 'ollie@sweepco.com'); await w(100)
    click(card().querySelector('[data-act=account-send]'))
    await waitFor(() => card().querySelector('[data-field=code]'))
    return true
  }))
  await check('Admin view', '…the list empties and the member who joined is shown as joined', String(async (code) => {
    const { w, click, setValue, txt, waitFor, closeModal } = window.__t
    const card = () => document.querySelector('[data-conn="account"]')
    setValue(card().querySelector('[data-field=code]'), code); await w(100)
    click(card().querySelector('[data-act=account-verify]'))
    await waitFor(() => card().querySelector('[data-conn-state]'))
    await closeModal()
    click(window.__t.must('[data-act=open-sharing]'))
    await waitFor(() => document.querySelector('[data-act=sharing-videos] .sh-row'), 20000)
    click(window.__t.must('[data-sharing-tab=team]')); await w(500)
    const josh = txt(document.querySelector('.sh-row[data-email="josh@sweepco.com"]'))
    click(window.__t.must('[data-sharing-tab=videos]')); await w(300)
    click(window.__t.must('[data-act=sharing-videos] [data-act=sharing-delete]'))
    await waitFor(() => document.querySelector('[data-act=sharing-empty]'))
    click(window.__t.must('[data-act=sharing-screen] .modal-close')); await w(400)
    return { ok: /0 videos shared/.test(josh) && !/has not signed in/.test(josh), detail: josh.slice(0, 60) }
  }), await (async () => { for (let i = 0; i < 40 && !cloud.codeFor('ollie@sweepco.com'); i++) await sleep(150); return cloud.codeFor('ollie@sweepco.com') })())
  {
    let text = ''
    if (browser) { const page = await browser.open(link); await sleep(1800); text = await pageText(page); await page.close() }
    note('Admin view', 'after taking down: the files are gone from storage and the link says it is no longer shared', cloudFiles().length === 0 && (!browser || /no longer shared/.test(text)), `${cloudFiles().length} files · “${text.slice(0, 40)}”`)
  }
  /* ------------------------------------------- the Share button on a video in the library */
  await check('Library', 'Share on a video: uploads its last export and opens the Share box, without opening the editor', String(async (pid) => {
    const { w, txt, waitFor, projectOf, must } = window.__t
    const btn = () => must(`[data-act=card-share][data-project="${pid}"]`)
    const before = txt(btn())
    btn().click()
    await w(400)
    const during = txt(btn())
    await waitFor(() => document.querySelector('[data-act=share-dialog] [data-act=cloud-link]'), 90000)
    const p = await projectOf(pid)
    const title = txt(document.querySelector('[data-act=share-dialog] h3'))
    const stillLibrary = !!document.querySelector('.lib-side') && !document.querySelector('.tl-seg')
    return { ok: before === 'Shared' || before === 'Share' ? !!p.cloud?.id && /Setting up/.test(title) && stillLibrary && txt(document.querySelector('[data-act=cloud-link]')) === p.cloud.url : false, detail: `button “${before}” → “${during}” → box “${title}”` }
  }), SP)
  {
    const id = await run(String(async (pid) => (await window.__t.projectOf(pid)).cloud.id), SP)
    const cues = Number(cloud.sql(`select jsonb_array_length(meta -> 'cues') from public.videos where id = '${id}'`).trim())
    note('Library', '…the upload carries the captions, chapters and shape saved at export', cloudFiles().length === 2 && cues > 10 && cloud.sql(`select meta ->> 'aspect' from public.videos where id = '${id}'`).trim().startsWith('1.7'), `${cues} caption lines · ${cloudFiles().length} files`)
  }
  await check('Library', 'share from the card: add a person there and then; the card now says “Shared”', String(async (pid) => {
    const { w, click, setValue, txt, waitFor, must } = window.__t
    const d = () => document.querySelector('[data-act=share-dialog]')
    setValue(d().querySelector('[data-field=share-emails]'), 'buyer@acme.com'); await w(100)
    click(must('[data-act=share-add]'))
    await waitFor(() => d().querySelector('.sh-row[data-email="buyer@acme.com"]'))
    click(must('[data-act=share-close]')); await w(700)
    return { ok: txt(must(`[data-act=card-share][data-project="${pid}"]`)) === 'Shared', detail: txt(must(`[data-act=card-share][data-project="${pid}"]`)) }
  }), SP)
  { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(root, '.tmp', 'shot-card-share.png'), Buffer.from(r.result.data, 'base64')) }
  await check('Library', 'pressing Share again opens the box straight away, with no second upload', String(async (pid) => {
    const { w, click, txt, waitFor, must, projectOf } = window.__t
    const before = (await projectOf(pid)).cloud
    const t0 = Date.now()
    must(`[data-act=card-share][data-project="${pid}"]`).click()
    await waitFor(() => document.querySelector('[data-act=share-dialog] .sh-row[data-email="buyer@acme.com"]'), 15000)
    const ms = Date.now() - t0
    const after = (await projectOf(pid)).cloud
    click(must('[data-act=share-close]')); await w(400)
    const empty = await window.knight.projects.create('Never exported')
    const r = await window.knight.share.forProject(empty.id)
    await window.knight.projects.remove(empty.id)
    return { ok: after.id === before.id && after.updatedAt === before.updatedAt && ms < 6000 && r.kind === 'export', detail: `opened in ${ms} ms · a video that was never exported → “${r.kind}”` }
  }), SP)
  note('Library', '…storage still holds one copy', cloudFiles().length === 2, `${cloudFiles().length} files`)

  await check('Account', 'signing out removes the sign-in from this Mac', String(async () => {
    const { w, click, waitFor, settingsTab, closeModal } = window.__t
    await settingsTab('Account')
    click(window.__t.must('[data-conn="account"] [data-act=account-signout]'))
    await waitFor(() => document.querySelector('[data-conn="account"] [data-field=email]'))
    const st = await window.knight.cloud.status(); const p = await window.knight.prefs.read()
    await closeModal()
    return { ok: !st.signedIn && !p.cloud }
  }))
}

await check('Library', 'Share when not signed in: copies the video’s existing share-page link and says so', String(async (pid) => {
  const { w, txt, waitFor, must, projectOf } = window.__t
  const p = await projectOf(pid)
  if (!p.share?.url) return { ok: true, detail: 'no share page on this video — skipped' }
  must(`[data-act=card-share][data-project="${pid}"]`).click()
  await waitFor(() => /copied/.test(txt(document.querySelector('.library .notice'))), 15000)
  return { ok: /Share link copied/.test(txt(document.querySelector('.library .notice'))) && !document.querySelector('.modal'), detail: txt(document.querySelector('.library .notice')).slice(0, 90) }
}), SP)

/* ---------------------------------------------------------------------- updates */
await check('Updates', 'a copy built without an update address says so, and shows its version', String(async () => {
  const { txt, settingsTab, closeModal, find, click, w } = window.__t
  await settingsTab('Updates')
  const card = txt(document.querySelector('[data-conn="updates"]'))
  const st = await window.knight.updates.status()
  window.__shots = true
  return { ok: /not switched on in this copy/.test(card) && new RegExp(`Version ${st.current.replace(/\./g, '\\.')}`).test(card) && st.enabled === false, detail: `version ${st.current}` }
}))

for (const tab of ['Share pages', 'Webhook', 'Updates']) {
  await run(String(async (tab) => { await window.__t.settingsTab(tab); document.querySelector('.modal-body').scrollTop = 0; return true }), tab)
  const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(root, '.tmp', `shot-settings-${tab.split(' ')[0].toLowerCase()}.png`), Buffer.from(r.result.data, 'base64'))
}
await run(String(async () => { await window.__t.closeModal(); return true }))
await run(String(async (pid) => { await window.knight.projects.remove(pid); return true }), SP)
if (browser) await browser.close()
if (sb) await sb.close()
if (cloud) await cloud.close()
aiModel.close(); receiver.close(); viewer.close()


const exported = fs.existsSync(path.join(out, 'export.mp4')) ? fs.statSync(path.join(out, 'export.mp4')).size : 0
const srt = fs.readdirSync(out).filter(f => f.endsWith('.srt'))
console.log(`\nfiles written: export.mp4 ${(exported / 1e6).toFixed(1)} MB${srt.length ? `, ${srt.join(', ')}` : ''}`)
if (pageErrors.length) console.log(`page errors:\n  ${[...new Set(pageErrors)].join('\n  ')}`)
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`)
mock.close()
if (process.env.SWEEP_KEEP) { console.log(`kept open: port ${port}, home ${home}`); process.exit(0) }
child.kill()
await sleep(500)
fs.rmSync(home, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
