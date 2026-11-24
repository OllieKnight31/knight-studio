// Stand-ins and fixtures for checking the write-up, share page, webhook and filler-word
// features without real accounts: a model that answers like Claude, an address that
// receives webhooks, a place the share page is served from, a real browser to watch a
// share page in, and a recording of someone talking (with "um"s) to work on.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)))
const readBody = async req => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Answers the Messages API the way Claude would, building its answer from the transcript it was sent. */
export async function startModel () {
  const state = { calls: [], mode: 'ok' }
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString() || '{}')
    const reply = (code, json) => { res.writeHead(code, { 'Content-Type': 'application/json', 'request-id': 'req_standin' }); res.end(JSON.stringify(json)) }
    state.calls.push({ url: req.url, key: req.headers['x-api-key'], beta: req.headers['anthropic-beta'] || '', body })
    if (!req.url.startsWith('/v1/messages')) return reply(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } })
    if (state.mode === 'bad-key' || !req.headers['x-api-key']) return reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    if (state.mode === 'no-credit') return reply(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } })
    // Refuse a request the real API would refuse, so a malformed one cannot pass here.
    const bad = why => reply(400, { type: 'error', error: { type: 'invalid_request_error', message: why } })
    if (body.model !== 'claude-opus-5-5') return bad(`unexpected model ${body.model}`)
    if (body.thinking && body.thinking.type !== 'adaptive') return bad('thinking must be adaptive on this model')
    if (body.temperature !== undefined || body.top_p !== undefined) return bad('sampling parameters are not supported on this model')
    if (body.output_config?.format?.type !== 'json_schema' || !body.output_config.format.schema) return bad('output_config.format must be a json_schema')
    if (body.fallbacks !== undefined && !(body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(req.headers['anthropic-beta'] || ''))) return bad('fallbacks needs its beta header')
    if (body.messages?.at(-1)?.role !== 'user') return bad('the last message must be from the user')

    const text = String(body.messages.at(-1).content)
    const lines = [...text.matchAll(/^\[(\d+)\] (.+)$/gm)].map(m => ({ t: Number(m[1]), text: m[2] }))
    const third = Math.max(1, Math.floor(lines.length / 3))
    const answer = {
      summary: `This video walks through ${lines.length} points, starting with: ${lines[0]?.text.slice(0, 80) || ''}`,
      chapters: [lines[0], lines[third], lines[third * 2]].filter(Boolean).map((l, i) => ({ start: i === 0 ? 0 : l.t, title: ['Getting started', 'The main steps', 'Finishing up'][i] })),
      steps: lines.filter((_, i) => i % 2 === 0).slice(0, 6).map((l, i) => ({ at: l.t, title: `Step ${i + 1}: ${l.text.split(' ').slice(0, 5).join(' ')}`, detail: l.text }))
    }
    reply(200, {
      id: 'msg_standin', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: JSON.stringify(answer) }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 400, output_tokens: 200 }
    })
  })
  return { base: await listen(server), state, close: () => server.close() }
}

/** An address that receives webhooks and remembers what arrived. */
export async function startReceiver () {
  const state = { got: [], status: 200 }
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req)
    let json = null
    try { json = JSON.parse(raw.toString()) } catch {}
    state.got.push({ method: req.method, path: req.url, headers: req.headers, raw: raw.toString(), json })
    res.writeHead(state.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: state.status === 200 ? 'success' : 'error' }))
  })
  const base = await listen(server)
  const signed = (entry, secret) => entry.headers['x-knight-signature'] === 'sha256=' + crypto.createHmac('sha256', secret).update(entry.raw).digest('hex')
  return { url: `${base}/hooks/catch/123/abc`, state, signed, close: () => server.close() }
}

/** Serves the share page exactly as the hosting does: one static file at "/". */
export async function startViewer (root, cloud = null) {
  const dir = path.join(root, 'share-viewer')
  const driveApi = (await import('node:module')).createRequire(import.meta.url)(path.join(dir, 'api', 'drive.js'))
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
  const state = { cloud }
  const server = http.createServer((req, res) => {
    let p = new URL(req.url, 'http://x').pathname
    if (p === '/') p = '/index.html'
    // The hosting serves /watch and /shared without the .html, and config.js says where the service is.
    if (!path.extname(p)) p += '.html'
    if (p === '/api/drive.html' || p === '/api/drive') { return driveApi(req, res) }
    if (p === '/config.js') { res.writeHead(200, { 'Content-Type': types['.js'] }); return res.end(`window.KS_CLOUD = ${JSON.stringify(state.cloud || { url: '', key: '' })}`) }
    const file = p.startsWith('/brand/') ? path.join(dir, 'brand', path.basename(p)) : path.join(dir, path.basename(p))
    if (!types[path.extname(file)] || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store' })
    fs.createReadStream(file).pipe(res)
  })
  return { base: await listen(server), state, close: () => server.close() }
}

/** A real, separate, invisible Chrome — to watch a share page the way a viewer would. */
export async function startBrowser () {
  const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (!fs.existsSync(exe)) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-chrome-'))
  const port = 9900 + Math.floor(Math.random() * 90)
  const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', ...(process.env.SWEEP_LIVE_VIEWER ? ['--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks', '--allow-running-insecure-content'] : []), '--mute-audio', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 80; i++) { await sleep(250); try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break } catch {} }

  async function open (url) {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let id = 0
    const pending = new Map()
    const errors = []
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description?.split('\n')[0])
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text)
    }
    const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable')
    const evaluate = async (fn, arg) => {
      const r = await send('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true })
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description?.split('\n')[0] || 'evaluation failed')
      return r.result?.result?.value
    }
    const shot = async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')) }
    const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }) }
    const close = async () => { try { await send('Page.close') } catch {} ws.close() }
    return { evaluate, shot, click, close, errors }
  }
  return { open, close: async () => { child.kill(); await sleep(400); fs.rmSync(dir, { recursive: true, force: true }) } }
}

export const SCRIPT = 'Hey team. Um, in this video I am going to show you how we set up a new client in the dashboard. ' +
  'First, uh, go to the left sidebar and click Clients, then press the New client button. ' +
  'Type in the company name and the main contact email. Um, make sure the email is right because the invite goes there. ' +
  'Next, under Plan, choose Growth. We never use Starter for new clients because it does not include reporting. ' +
  'Then, uh, scroll down to Team and add yourself as the account manager. ' +
  'Now turn on the weekly report toggle and set the day to Monday at nine. ' +
  'Press Save, and you will see a green banner that says client created. ' +
  'Last thing. Um, copy the onboarding link from that banner and paste it into the client Slack channel. That is it.'

/**
 * Builds a recording of someone explaining a procedure, fillers and all, and files it
 * in a library as its own project. Returns the project id.
 */
export function makeSpokenProject ({ lib, template, ffmpeg, id = 'prj_spoken000000' }) {
  const clipId = 'clip_spoken00000'
  const dir = path.join(lib, id)
  const clipDir = path.join(dir, 'clips', clipId)
  fs.mkdirSync(clipDir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'exports'), { recursive: true })
  const aiff = path.join(clipDir, 'voice.aiff')
  execFileSync('/usr/bin/say', ['-o', aiff, SCRIPT])
  // A screen that visibly changes over time, so each step's screenshot is a different picture.
  execFileSync(ffmpeg, ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-i', aiff, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-shortest',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', path.join(clipDir, 'screen.mov')])
  fs.rmSync(aiff)
  return finish()

  function finish () {
    let duration = 0
    try { execFileSync(ffmpeg, ['-hide_banner', '-i', path.join(clipDir, 'screen.mov')], { stdio: 'pipe' }) } catch (e) {
      const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(e.stderr))
      if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    }
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', '1', '-i', path.join(clipDir, 'screen.mov'), '-frames:v', '1', '-vf', 'scale=640:-2', path.join(clipDir, 'poster.jpg')])
    fs.writeFileSync(path.join(clipDir, 'events.jsonl'), '')
    fs.writeFileSync(path.join(clipDir, 'manifest.json'), JSON.stringify({
      audio: { microphone: true, system: true }, audioOrder: ['microphone', 'system'], codec: 'h264', createdAt: new Date().toISOString(),
      cursorBakedIn: true, display: 1, duration, events: 'events.jsonl', fps: 30, frames: Math.round(duration * 30), height: 1080, width: 1920,
      keepaliveFrames: 0, screen: 'screen.mov', version: 1
    }, null, 2))
    const p = JSON.parse(JSON.stringify(template))
    p.id = id
    p.name = 'Setting up a new client'
    p.folderId = null
    p.overlays = []
    delete p.drive; delete p.share; delete p.ai
    p.canvas = { preset: 'auto', width: 1920, height: 1080 }
    p.clips = [{
      id: clipId, dir: clipDir, createdAt: new Date().toISOString(), duration, width: 1920, height: 1080,
      hasCamera: false, hasSystemAudio: true, hasMic: true, layout: 'screen', trim: { in: 0, out: duration }, cuts: [], zooms: [],
      autoZoomApplied: true, poster: path.join(clipDir, 'poster.jpg'), previews: [], title: p.name
    }]
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p, null, 2))
    return { id, duration }
  }
}
