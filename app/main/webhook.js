'use strict'
/**
 * Webhook: tells another tool that a video has been exported.
 *
 * After an export the app sends one small JSON message to an address the person
 * chooses. Zapier, Make, n8n and most other tools can receive it and carry on from
 * there — post in Slack, add a CRM note, email a client. Nothing is sent until an
 * address has been saved.
 */
const crypto = require('node:crypto')
const prefs = require('./prefs')
const secrets = require('./secrets')

class HookError extends Error {}

const settings = () => ({ url: null, auto: true, ...(prefs.read().webhook || {}) })
const version = () => { try { return require('../../package.json').version } catch { return '' } }

function status () {
  const s = settings()
  return { url: s.url, configured: !!s.url, auto: s.auto !== false, tested: s.tested === true, hasSecret: secrets.has('webhook:secret'), lastSentAt: s.lastSentAt || null }
}

function save (patch = {}) {
  const next = { ...settings() }
  if (patch.url !== undefined) {
    const url = String(patch.url || '').trim()
    if (url) {
      let u
      try { u = new URL(url) } catch { throw new HookError('That is not a web address. It should start with https://') }
      const local = ['127.0.0.1', 'localhost'].includes(u.hostname)
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new HookError('The address has to start with https://')
    }
    if (url !== next.url) next.tested = false
    next.url = url || null
  }
  if (patch.secret !== undefined) { secrets.set('webhook:secret', String(patch.secret || '').trim() || null); next.tested = false }
  if (patch.auto !== undefined) next.auto = !!patch.auto
  prefs.write({ webhook: next })
  return status()
}

function disconnect () {
  secrets.set('webhook:secret', null)
  prefs.write({ webhook: {} })
  return status()
}

/** What is sent for one video. Every field is always present, so a Zap never meets a gap. */
function payload (event, video = {}) {
  return {
    event,                                   // "video.exported" or "test"
    sentAt: new Date().toISOString(),
    app: { name: 'Knight Studio', version: version() },
    video: {
      id: video.id || '',
      title: video.title || '',
      folder: video.folder || '',
      fileName: video.fileName || '',
      durationSeconds: Math.round((Number(video.durationSeconds) || 0) * 10) / 10,
      exportedAt: video.exportedAt || new Date().toISOString(),
      driveLink: video.driveLink || '',
      shareLink: video.shareLink || '',
      embedCode: video.embedCode || '',
      summary: video.summary || '',
      chapters: video.chapters || [],       // [{ start: seconds, title }]
      chaptersText: video.chaptersText || '',
      transcript: video.transcript || ''
    }
  }
}

async function post (body) {
  const { url } = settings()
  if (!url) throw new HookError('No webhook address has been saved.')
  const text = JSON.stringify(body)
  const headers = { 'Content-Type': 'application/json', 'User-Agent': `KnightStudio/${version()}`, 'X-Knight-Event': body.event }
  const secret = secrets.get('webhook:secret')
  // Lets the receiving end prove the message really came from this app.
  if (secret) headers['X-Knight-Signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(text).digest('hex')
  let res
  try {
    res = await fetch(url, { method: 'POST', headers, body: text, signal: AbortSignal.timeout(20000), redirect: 'follow' })
  } catch (e) {
    throw new HookError(e.name === 'TimeoutError' ? 'The address took too long to answer.' : `Could not reach that address — check it and the internet connection. (${e.cause?.code || e.message})`)
  }
  if (!res.ok) {
    if (res.status === 404 || res.status === 410) throw new HookError(`Nothing is listening at that address (HTTP ${res.status}). In Zapier or Make, check the webhook is switched on and copy its address again.`)
    if (res.status === 401 || res.status === 403) throw new HookError(`The address refused the message (HTTP ${res.status}). It may need a different address or a signing secret.`)
    throw new HookError(`The address answered with an error (HTTP ${res.status}).`)
  }
  return { status: res.status }
}

/** Sends a sample video so the other tool has real field names to map. */
async function test () {
  try {
    const r = await post(payload('test', {
      id: 'test', title: 'Connection test — sample video', folder: 'Client onboarding', fileName: 'connection-test.mp4',
      durationSeconds: 92, driveLink: 'https://drive.google.com/file/d/example/view', shareLink: 'https://example.com/watch?v=example',
      embedCode: '<iframe src="https://example.com/watch?v=example&embed=1"></iframe>',
      summary: 'A sample summary, so you can see where it arrives.',
      chapters: [{ start: 0, title: 'Introduction' }, { start: 45, title: 'Setting it up' }],
      chaptersText: '0:00 Introduction\n0:45 Setting it up',
      transcript: 'This is a sample transcript sent by the connection test.'
    }))
    prefs.write({ webhook: { ...settings(), tested: true } })
    return { ok: true, steps: [{ name: 'Send a sample video', ok: true, detail: `Delivered — the address answered HTTP ${r.status}. Check it arrived in the other tool.` }] }
  } catch (e) {
    prefs.write({ webhook: { ...settings(), tested: false } })
    return { ok: false, steps: [{ name: 'Send a sample video', ok: false, detail: String(e.message || e) }] }
  }
}

/** Sends one exported video. */
async function send (video) {
  try {
    await post(payload('video.exported', video))
    prefs.write({ webhook: { ...settings(), lastSentAt: new Date().toISOString() } })
    return { which: 'webhook', name: 'Webhook', ok: true }
  } catch (e) {
    return { which: 'webhook', name: 'Webhook', ok: false, detail: String(e.message || e) }
  }
}

module.exports = { status, save, disconnect, test, send, payload, HookError }
