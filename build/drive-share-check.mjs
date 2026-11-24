#!/usr/bin/env node
// Proves Drive-only share pages end to end, against the REAL Google Drive.
//
//   node build/drive-share-check.mjs [app executable]
//
// Uses the Google sign-in already on this Mac, but works inside a temporary folder it
// creates in Drive and deletes again, and inside a throwaway home folder, so no real
// recording, setting or Drive file is touched. The app exports a spoken test recording;
// it uploads to Drive and gets a share page; a separate invisible Chrome opens that page
// and actually plays the video out of Drive. SWEEP_LIVE_VIEWER=1 opens the page on the
// hosted site instead of a local copy of it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { startViewer, startBrowser, makeSpokenProject } from './feature-stubs.mjs'

const require = createRequire(import.meta.url)
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const appExe = process.argv[2]
const sleep = ms => new Promise(r => setTimeout(r, ms))
const creds = process.env.KS_DRIVE_CONFIG_DIR || path.join(os.homedir(), '.drive-mcp')
process.env.KS_DRIVE_CONFIG_DIR = creds
const drive = require('../app/main/drive.js')
if (!(await drive.isConfigured())) { console.error('Google Drive is not connected on this Mac.'); process.exit(2) }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-dshare-'))
const lib = path.join(home, 'Movies', 'Knight Studio')
const settingsDir = path.join(home, 'Library', 'Application Support', 'Knight Studio')
const out = path.join(home, 'out')
for (const d of [lib, settingsDir, out]) fs.mkdirSync(d, { recursive: true })
const model = path.join(os.homedir(), 'Library', 'Application Support', 'Knight Studio', 'models', 'ggml-base.bin')
if (fs.existsSync(model)) { fs.mkdirSync(path.join(settingsDir, 'models'), { recursive: true }); try { fs.linkSync(model, path.join(settingsDir, 'models', 'ggml-base.bin')) } catch { fs.copyFileSync(model, path.join(settingsDir, 'models', 'ggml-base.bin')) } }

const folder = await drive.createFolder(`Knight Studio share test ${Date.now()} (safe to delete)`)
fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
  welcomed: true, tours: { disabled: true }, openAtLogin: false, exportDirect: false,
  brand: { name: 'Acme Training', accent: '#3B82F6', surface: '#0B1020' },   // an older version's saved brand: must be ignored
  drive: { parent: { id: folder.id, name: folder.name, link: folder.webViewLink || '' }, autoUpload: true }
}))
// A project shaped like the app's own, to build the test recording from.
const template = { version: 1, canvas: { preset: 'auto', width: 1920, height: 1080 }, background: { type: 'gradient', colors: ['#0B0B0F', '#1C1F2B'], angle: 135, image: null, blur: 0 },
  style: { padding: 0.06, radius: 18, shadow: 0.45, borderWidth: 0, borderColor: '#FFFFFF33', screenFit: 'fill' },
  camera: { shape: 'circle', size: 0.22, position: 'bottom-right', offset: { x: 0.04, y: 0.04 }, mirrored: true, borderWidth: 0, borderColor: '#FFFFFF' },
  cursor: { animated: false, style: 'macos', size: 1, smoothing: 0.55, tilt: 0.25, clickSpring: 0.6, clickRipple: 0.5, hideWhenInactive: false, returnToStart: false },
  autoZoom: { style: 'adaptive', applyOnRecord: false },
  subtitles: { enabled: false, font: 'Inter', size: 46, weight: 800, color: '#FFFFFF', highlight: '#C8A24A', background: 'rgba(0,0,0,0.55)', position: 0.86, oneWordAtATime: false, uppercase: false },
  audio: { micGain: 1, systemGain: 0.6, music: null, musicGain: 0.15 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), overlays: [], clips: [] }
const ffmpeg = fs.existsSync(path.join(root, 'vendor/bin/ffmpeg')) ? path.join(root, 'vendor/bin/ffmpeg') : 'ffmpeg'
const spoken = makeSpokenProject({ lib, template, ffmpeg })
const PID = spoken.id

const viewer = await startViewer(root)
const browser = await startBrowser()
const port = 9100 + Math.floor(Math.random() * 150)
const child = spawn(appExe || path.join(root, 'node_modules/.bin/electron'), [...(appExe ? [] : ['.']), `--remote-debugging-port=${port}`, '-ApplePersistenceIgnoreState', 'YES', `--user-data-dir=${path.join(home, 'ud')}`], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, HOME: home, KS_DIST: '1', KNIGHT_STUDIO_STT: 'builtin', KS_DRIVE_CONFIG_DIR: creds, KS_EXPORT_TO: path.join(out, 'export.mp4'), KS_DRIVE_POLL_MS: '3000', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', ...(process.env.SWEEP_LIVE_VIEWER ? {} : { KS_SHARE_VIEWER: viewer.base }) }
})
let failed = 0
const note = (area, name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${area.padEnd(12)} ${name}${detail ? `  — ${detail}` : ''}`) }
const finish = async () => {
  try { child.kill() } catch {}
  try { if (browser) await browser.close() } catch {}
  viewer.close()
  try { await drive.deleteFile(folder.id); console.log('\ntemporary Drive folder deleted') } catch (e) { console.log(`\nCOULD NOT delete the temporary Drive folder “${folder.name}”: ${e.message}`) }
  await sleep(500)
  fs.rmSync(home, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, async e => { note('Run', 'ran to the end', false, String(e?.stack || e).slice(0, 300)); await finish() })

let pageInfo
for (let i = 0; i < 160 && !pageInfo; i++) { await sleep(250); try { pageInfo = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url) && !/#overlay/.test(t.url)) } catch {} }
if (!pageInfo) throw new Error('the app did not start')
const ws = new WebSocket(pageInfo.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const run = async (fn, arg) => {
  const r = await send('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description?.split('\n').slice(0, 3).join(' | '))
  return r.result?.result?.value
}
await sleep(2500)
await run(String(() => {
  const w = ms => new Promise(r => setTimeout(r, ms))
  const txt = el => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  const must = sel => { const el = document.querySelector(sel); if (!el) throw new Error(`not on screen: ${sel}`); return el }
  const byText = (sel, re) => [...document.querySelectorAll(sel)].find(e => re.test(txt(e)))
  const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await w(200) } }
  const tool = async name => { byText('.tools .tool', new RegExp(`^${name}$`)).click(); await w(500) }
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
  window.__d = { w, txt, must, byText, waitFor, tool, setValue }
  return true
}))

const step = async (area, name, fn, arg) => { try { const r = await run(fn, arg); note(area, name, r === true || r?.ok === true, r?.detail || '') ; return r } catch (e) { note(area, name, false, e.message); return null } }

await step('App', 'Drive is connected and the Export panel offers a share page without any other setup', String(async () => {
  const { w, txt, byText, waitFor, tool } = window.__d
  byText('.card', /Setting up a new client/).click()
  await waitFor(() => document.querySelector('.tl-seg'), 30000); await w(1500)
  await tool('Captions')
  byText('.panel .btn', /Transcribe this clip/).click()
  await waitFor(() => document.querySelector('.panel .transcript'), 300000)
  await tool('Export')
  const panel = txt(document.querySelector('.panel'))
  const st = await window.knight.drive.status()
  return { ok: !!st.configured && /Make a share page after export/.test(panel) && /Upload this video after export/.test(panel) && !/Set up share pages/.test(panel), detail: `signed in as ${st.account?.email || 'a Google account'} · configured=${st.configured} parent=${!!st.parent} · words=${document.querySelectorAll('.tword').length} · panel: ${panel.slice(0, 260)}` }
}))

await step('Export', 'one export: uploads to Drive and makes the share page', String(async () => {
  const { w, txt, byText } = window.__d
  const sel = document.querySelector('.panel select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'web'); sel.dispatchEvent(new Event('change', { bubbles: true })); await w(300)
  byText('.panel .btn', /^Export MP4$/).click()
  let lines = []
  for (let i = 0; i < 900; i++) {
    await w(1000)
    lines = [...document.querySelectorAll('.panel .val')].map(v => v.textContent)
    if (lines.some(l => /Failed|Share page:|Drive:/.test(l)) || lines.some(l => /✓ Share page ready/.test(l))) break
  }
  await w(800)
  return { ok: lines.some(l => /Exported and uploaded/.test(l)) && lines.some(l => /✓ Share page ready/.test(l)) && !!document.querySelector('[data-act=drive-share-link]'), detail: lines.filter(l => /Exported|✓|:/.test(l)).join(' · ').slice(0, 200) }
}))
const share = await run(String(async (pid) => { await window.__d.w(600); const p = await window.knight.projects.load(pid); return { ...p.driveShare, drive: p.drive } }), PID)
note('Export', 'the link is short and stable, and the embed code is offered', /\/d\?m=[\w-]{20,}$/.test(share?.url || '') && /<iframe /.test(share?.embed || ''), share?.url)

const metaOf = async url => (await fetch(`${new URL(url).origin}/api/drive?m=${new URL(url).searchParams.get('m')}&t=${Date.now()}`)).json().catch(() => null)
const first = await step('App', 'the app says when Google has finished preparing the video for playback', String(async () => {
  const { txt, waitFor } = window.__d
  const before = txt(document.querySelector('[data-act=drive-share-wait], [data-act=drive-share-ready]'))
  const t0 = Date.now()
  await waitFor(() => document.querySelector('[data-act=drive-share-ready]'), 600000)
  return { ok: !!document.querySelector('[data-act=drive-share-ready]') && /preparing|Ready/.test(before), detail: `“${before.slice(0, 60)}” → “✓ Ready to watch” after ${Math.round((Date.now() - t0) / 1000)}s` }
}))

const look = async (url, label, wait = 4000) => {
  const page = await browser.open(url)
  await sleep(wait)
  const r = await page.evaluate(String(async () => {
    const f = document.querySelector('#frame')
    if (!f) return { text: document.querySelector('#app').innerText.slice(0, 120) }
    const fr = f.getBoundingClientRect()
    const logo = document.querySelector('header.top img')
    return {
      title: document.querySelector('h1')?.textContent, brand: document.querySelector('header.top img')?.alt || '', accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      surface: getComputedStyle(document.body).backgroundColor, frame: f.src, fw: Math.round(fr.width), fh: Math.round(fr.height), logo: logo ? logo.naturalWidth : 0,
      cues: document.querySelectorAll('.transcript span').length, video: !!document.querySelector('video'), meta: document.querySelector('.meta')?.textContent,
      embed: document.body.classList.contains('embed'), fills: Math.abs(fr.width - innerWidth) < 2 && Math.abs(fr.height - innerHeight) < 2, below: getComputedStyle(document.querySelector('.below')).display
    }
  }))
  await page.shot(path.join(root, '.tmp', `shot-drive-share-${label}.png`))
  await page.close()
  return r
}
if (browser && share?.url) {
  const r = await look(share.url, 'page', 9000)
  note('Browser', 'the page opens in the app’s design: the Ainable logo and colours, title and transcript', /Setting up a new client/.test(r.title || '') && r.brand === 'Ainable' && r.accent?.toUpperCase() === '#F5F5F7' && r.surface === 'rgb(10, 10, 11)' && r.logo > 0 && r.cues > 10,
    `${r.title || r.text} · “${(r.brand || '').trim()}” · logo ${r.logo}px · accent ${r.accent} · background ${r.surface} · ${r.cues} transcript lines`)
  note('Browser', 'the video is shown by Google Drive’s player, framed inside the page', r.frame === `https://drive.google.com/file/d/${share.videoId}/preview` && r.fw > 600 && Math.abs(r.fw / r.fh - 16 / 9) < 0.05 && !r.video, `${r.fw}×${r.fh} · ${r.frame}`)
  // Google's side: the framed player page really is there for this file, and is allowed to be framed.
  const g = await fetch(`https://drive.google.com/file/d/${share.videoId}/preview`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' } })
  const html = await g.text()
  note('Browser', 'Google serves that player to anyone, without signing in, and allows it inside another page', g.status === 200 && !g.headers.get('x-frame-options') && !/accounts\.google\.com\/(v3\/)?signin|ServiceLogin/.test(g.url) && /export\.mp4|video|drive-viewer/i.test(html), `HTTP ${g.status} · x-frame-options: ${g.headers.get('x-frame-options') || 'none'}`)
  {
    const page = await browser.open(share.url)
    await sleep(7000)
    const box = await page.evaluate(String(async () => { const r = document.querySelector('#frame').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }))
    await page.click(box.x, box.y)
    await sleep(6000)
    await page.shot(path.join(root, '.tmp', 'shot-drive-share-playing.png'))
    const j = await page.evaluate(String(async () => {
      document.querySelector('details').open = true
      const span = document.querySelectorAll('.transcript span')[14]
      span.click(); await new Promise(r => setTimeout(r, 800))
      return { t: Math.floor(Number(span.dataset.t)), src: document.querySelector('#frame').src, hint: document.querySelector('#status').innerText }
    }))
    await sleep(5000)
    const box2 = await page.evaluate(String(async () => { const r = document.querySelector('#frame').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }))
    await page.click(box2.x, box2.y)
    await sleep(5000)
    await page.shot(path.join(root, '.tmp', 'shot-drive-share-jumped.png'))
    await page.close()
    note('Browser', 'clicking a transcript line reopens the player at that moment', j.t > 5 && j.src.endsWith(`/preview?t=${j.t}`) && /Press play/.test(j.hint), `line at ${j.t}s → ${j.src.slice(-22)} · “${j.hint.replace(/\n/g, ' ')}”`)
  }
  const e = await look(`${share.url}&embed=1`, 'embed')
  note('Browser', 'the embed code shows only the player, filling its frame', e.embed && e.fills && e.below === 'none', `${e.fw}×${e.fh}`)
} else {
  note('Browser', 'a browser and a share link to test with', false, browser ? 'no link' : 'Google Chrome is not installed')
}

// Export again: a new copy goes to Drive. The page must keep playing the old copy until
// Google has prepared the new one, and then switch — on the same link.
await step('Export', 'exporting again: the page keeps the previous version until the new one is ready', String(async (pid) => {
  const { w, txt, byText, waitFor } = window.__d
  const before = (await window.knight.projects.load(pid)).driveShare
  byText('.panel .btn', /^Export MP4$/).click()
  let lines = []
  for (let i = 0; i < 900; i++) { await w(1000); lines = [...document.querySelectorAll('.panel .val')].map(v => v.textContent); if (lines.some(l => /Failed|Share page:|Drive:/.test(l)) || lines.some(l => /✓ Share page ready/.test(l))) break }
  await w(700)
  const mid = (await window.knight.projects.load(pid)).driveShare
  const midMeta = await (await fetch(`${new URL(mid.url).origin}/api/drive?m=${mid.metaId}&t=${Date.now()}`)).json()
  const held = !!mid.pendingVideoId && midMeta.video === before.videoId
  await waitFor(() => document.querySelector('[data-act=drive-share-ready]') && !/previous version/.test(txt(document.querySelector('[data-tour=drive-share]'))), 600000)
  await w(1500)
  const after = (await window.knight.projects.load(pid)).driveShare
  const afterMeta = await (await fetch(`${new URL(after.url).origin}/api/drive?m=${after.metaId}&t=${Date.now()}`)).json()
  return { ok: after.url === before.url && after.videoId !== before.videoId && afterMeta.video === after.videoId && !after.pendingVideoId && (held || mid.videoId === after.videoId), detail: `${held ? 'held the old copy, then switched' : 'new copy was ready straight away'} · same link` }
}), PID)

await step('App', '“Update page” keeps the same link and carries a new title', String(async (pid) => {
  const { w, txt, must, waitFor, tool, setValue } = window.__d
  const before = (await window.knight.projects.load(pid)).driveShare
  await tool('Setup'); setValue(must('.panel input.input'), 'Setting up a client — updated'); await w(700)
  await tool('Export')
  must('[data-act=drive-share-update]').click(); await w(600)
  await waitFor(() => /^Update page$/.test(txt(document.querySelector('[data-act=drive-share-update]'))), 90000)
  await w(700)
  const after = (await window.knight.projects.load(pid)).driveShare
  return { ok: after.url === before.url && after.metaId === before.metaId && after.updatedAt !== before.updatedAt && !document.querySelector('[data-act=drive-share-error]'), detail: after.url.slice(-30) }
}), PID)
if (browser && share?.url) {
  const page = await browser.open(share.url)
  await sleep(4000)
  const title = await page.evaluate(String(async () => document.querySelector('h1')?.textContent || ''))
  await page.close()
  note('Browser', 'the same link now shows the new title', /updated/.test(title), title)
}

await step('Library', 'the Share button on the video copies its link', String(async (pid) => {
  const { w, txt, must, byText, waitFor } = window.__d
  byText('.topbar .btn', /Library/).click(); await w(1000)
  const btn = must(`[data-act=card-share][data-project="${pid}"]`)
  const label = txt(btn)
  btn.click()
  await waitFor(() => /copied/.test(txt(document.querySelector('.library .notice'))), 15000)
  return { ok: label === 'Shared' && /Share link copied/.test(txt(document.querySelector('.library .notice'))), detail: `button “${label}” · ${txt(document.querySelector('.library .notice')).slice(0, 60)}` }
}), PID)

await step('Library', 'Share on a video with no page yet makes one from the copy already in Drive', String(async (pid) => {
  const { w, txt, must, waitFor } = window.__d
  await window.knight.driveShare.unpublish(pid)
  const gone = !(await window.knight.projects.load(pid)).driveShare
  const r = await window.knight.share.forProject(pid)
  const p = await window.knight.projects.load(pid)
  return { ok: gone && r.kind === 'copied' && r.made === true && p.driveShare?.url === r.url, detail: `${r.what} · new page made` }
}), PID)
const second = await run(String(async (pid) => (await window.knight.projects.load(pid)).driveShare), PID)
if (browser && share?.url && second?.url) {
  let page = await browser.open(share.url)
  await sleep(4000)
  const old = await page.evaluate(String(async () => document.querySelector('#app').innerText.slice(0, 80)))
  await page.close()
  page = await browser.open(second.url)
  await sleep(4000)
  const fresh = await page.evaluate(String(async () => ({ title: document.querySelector('h1')?.textContent || '', frame: !!document.querySelector('#frame') })))
  await page.close()
  note('Browser', 'a page that was taken down says so; the new page works', /no longer shared/.test(old) && fresh.frame && /updated/.test(fresh.title), `old link: “${old.slice(0, 32)}” · new link: ${fresh.title}`)
}
await finish()
