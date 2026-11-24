#!/usr/bin/env node
// Runs a real export through the built app, driven over the DevTools protocol,
// and reports how long it took. This is the "test harness" KS_EXPORT_TO exists for.
//
//   npm run build:renderer
//   node build/export-run.mjs "<project name>" /tmp/out.mp4 [timeoutSeconds]
//
// Drive upload is disabled for the run (KS_DRIVE_CONFIG_DIR points nowhere), the
// native save panel is skipped (KS_EXPORT_TO), and the app is closed afterwards.
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const [name, out, timeoutArg] = process.argv.slice(2)
const timeout = Number(timeoutArg || 7200) * 1000
const cwd = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const port = 9300 + Math.floor(Math.random() * 500)
try { fs.unlinkSync(out) } catch {}

const child = spawn(`${cwd}/node_modules/.bin/electron`, ['.', `--remote-debugging-port=${port}`, '-ApplePersistenceIgnoreState', 'YES'], {
  cwd,
  env: { ...process.env, KS_DIST: '1', KS_DEBUG: '1', KS_EXPORT_TO: out, KS_DRIVE_CONFIG_DIR: '/nonexistent' },
  stdio: ['ignore', 'pipe', 'pipe']
})
const logs = []
child.stdout.on('data', d => logs.push(String(d)))
child.stderr.on('data', d => logs.push(String(d)))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const finish = code => { try { child.kill() } catch {} ; process.exit(code) }

async function targets () { try { return await (await fetch(`http://127.0.0.1:${port}/json`)).json() } catch { return [] } }
let page
for (let i = 0; i < 200 && !page; i++) {
  await sleep(250)
  page = (await targets()).find(t => t.type === 'page' && /dist\/index\.html$/.test(t.url))
}
if (!page) { console.error('no page target\n' + logs.join('')); finish(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
async function evaluate (expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails))
  return r.result.result.value
}
async function waitFor (expression, ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = await evaluate(expression); if (v) return v; await sleep(250) }
  throw new Error('timeout waiting for: ' + expression)
}

try {
  const q = JSON.stringify(name)
  await waitFor(`[...document.querySelectorAll('.card .card-title')].some(el => el.textContent === ${q})`)
  await evaluate(`[...document.querySelectorAll('.card')].find(c => c.querySelector('.card-title')?.textContent === ${q}).click(); true`)
  await waitFor(`!![...document.querySelectorAll('button.btn.primary')].find(b => b.textContent === 'Export')`)
  await waitFor(`(() => { const v = [...document.querySelectorAll('video')]; return v.length > 0 && v.every(x => x.readyState >= 1) })()`, 120000)
  await sleep(1500)
  await evaluate(`[...document.querySelectorAll('button.btn.primary')].find(b => b.textContent === 'Export').click(); true`)
  await waitFor(`!![...document.querySelectorAll('button.btn.primary')].find(b => b.textContent === 'Export MP4')`)
  const t0 = Date.now()
  await evaluate(`[...document.querySelectorAll('button.btn.primary')].find(b => b.textContent === 'Export MP4').click(); true`)
  console.log('export started')
  let lastLog = 0
  for (;;) {
    await sleep(1000)
    const st = await evaluate(`(() => {
      const bar = [...document.querySelectorAll('i')].find(i => i.style.width)
      const p = document.querySelector('.progress')
      const line = p ? (p.parentElement.querySelector('.val')?.textContent || '') : ''
      return { bar: bar ? bar.style.width : '', line }
    })()`)
    const elapsed = (Date.now() - t0) / 1000
    if (elapsed - lastLog >= 10 || /^Exported|^Failed/.test(st.line)) {
      console.log(`${elapsed.toFixed(0).padStart(5)}s  ${st.bar.padStart(4)}  ${st.line}`)
      lastLog = elapsed
    }
    if (/^Failed/.test(st.line)) { console.error('EXPORT FAILED: ' + st.line); throw new Error(st.line) }
    if (/^Exported/.test(st.line)) { console.log(`EXPORT DONE in ${elapsed.toFixed(1)}s -> ${out}`); break }
    if (elapsed * 1000 > timeout) throw new Error('timed out')
  }
  await sleep(500)
  const errs = logs.join('').split('\n').filter(l => /renderer:(error|2)|Error|error/.test(l) && !/GPU|gpu|shortcut|dbus|Autofill/.test(l))
  if (errs.length) console.log('log lines mentioning errors:\n' + errs.slice(0, 20).join('\n'))
  finish(0)
} catch (e) {
  console.error('HARNESS ERROR:', e.message)
  console.error(logs.join('').split('\n').slice(-40).join('\n'))
  finish(1)
}
