'use strict'
/**
 * Sharing with people: the app's side of the sharing service.
 *
 * Signing in here gives the app an account on one central service (a Supabase project
 * run by whoever publishes the app — see cloud/schema.sql). With it, a video can be
 * shared the way a Google Drive file is: add people by email, choose "only invited
 * people" or "anyone with the link", and see who watched and how much. Invited people
 * sign in from their browser; they never need this app.
 *
 * Roles: the first person to sign in from a company gets a workspace and is its admin.
 * Admins see every video, viewer and team member in the workspace. Members they add
 * see and manage only their own videos.
 *
 * A copy of the app built without the service's address simply does not offer any of
 * this (`knight.cloud` in package.json).
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const prefs = require('./prefs')
const secrets = require('./secrets')
const share = require('./share')

class CloudError extends Error {}

const pkg = (() => { try { return require('../../package.json') } catch { return {} } })()
const config = () => ({
  url: String(process.env.KS_CLOUD_URL || pkg.knight?.cloud?.url || '').replace(/\/+$/, ''),
  key: process.env.KS_CLOUD_KEY || pkg.knight?.cloud?.key || ''
})
const enabled = () => { const c = config(); return !!(c.url && c.key) }
const BUCKET = 'videos'

/* ------------------------------------------------------------------- http */

async function http (method, url, { token, body, raw, type, timeout = 30000 } = {}) {
  const c = config()
  const headers = { apikey: c.key, Authorization: `Bearer ${token || c.key}` }
  if (body && !raw) headers['Content-Type'] = 'application/json'
  if (raw) { headers['Content-Type'] = type; headers['x-upsert'] = 'true'; headers['cache-control'] = 'max-age=3600' }
  let res
  try {
    res = await fetch(url, { method, headers, body: body ? (raw ? body : JSON.stringify(body)) : undefined, ...(raw && typeof body.getReader === 'function' ? { duplex: 'half' } : {}), signal: AbortSignal.timeout(timeout) })
  } catch (e) {
    throw new CloudError(e.name === 'TimeoutError' ? 'The sharing service took too long to answer.' : 'Could not reach the sharing service — check the internet connection.')
  }
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { ok: res.ok, status: res.status, json, text }
}

/* ---------------------------------------------------------------- session */

const session = () => secrets.get('cloud:session')
const profile = () => prefs.read().cloud || null

function keep (s) {
  secrets.set('cloud:session', { access: s.access_token, refresh: s.refresh_token, expires: Date.now() + (Number(s.expires_in) || 3600) * 1000, email: s.user?.email || session()?.email })
}

function forget () {
  secrets.set('cloud:session', null)
  prefs.write({ cloud: null })
}

let refreshing = null
/** A key that is good right now, renewing it quietly when it is about to run out. */
async function token () {
  const s = session()
  if (!s) throw new CloudError('Sign in first, under Settings → Account.')
  if (s.expires - Date.now() > 60000) return s.access
  if (!refreshing) {
    refreshing = (async () => {
      const res = await http('POST', `${config().url}/auth/v1/token?grant_type=refresh_token`, { body: { refresh_token: s.refresh } })
      if (!res.ok) { forget(); throw new CloudError('You have been signed out. Sign in again under Settings → Account.') }
      keep(res.json)
      return res.json.access_token
    })().finally(() => { refreshing = null })
  }
  return refreshing
}

/** Calls one of the service's functions as the signed-in person. */
async function rpc (fn, body = {}) {
  let res = await http('POST', `${config().url}/rest/v1/rpc/${fn}`, { token: await token(), body })
  if (res.status === 401) {
    // The key ran out between the check and the call: renew once and retry.
    const s = session()
    if (s) secrets.set('cloud:session', { ...s, expires: 0 })
    res = await http('POST', `${config().url}/rest/v1/rpc/${fn}`, { token: await token(), body })
  }
  if (!res.ok) {
    const msg = res.json?.message || res.json?.msg || `HTTP ${res.status}`
    if (res.status === 404 || res.json?.code === 'PGRST202') throw new CloudError('The sharing service is missing part of its setup. Whoever runs it needs to run cloud/schema.sql again.')
    throw new CloudError(msg)
  }
  return res.json
}

function status () {
  const p = profile()
  return {
    enabled: enabled(),
    signedIn: !!(session() && p),
    email: p?.email || null,
    workspace: p?.workspace || null,
    workspaceId: p?.workspaceId || null,
    role: p?.role || null,
    auto: prefs.read().cloudShare?.auto !== false
  }
}

const cleanEmail = e => String(e || '').trim().toLowerCase()

/** Step one of signing in: emails a six-digit code. */
async function requestCode (email) {
  if (!enabled()) throw new CloudError('Sharing with people is not switched on in this copy of the app.')
  const e = cleanEmail(email)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new CloudError('That does not look like an email address.')
  const res = await http('POST', `${config().url}/auth/v1/otp`, { body: { email: e, create_user: true } })
  if (!res.ok) {
    if (res.status === 429) throw new CloudError('Too many codes have been asked for. Wait a minute and try again.')
    throw new CloudError(res.json?.msg || res.json?.message || 'The code could not be sent.')
  }
  return { sent: true, email: e }
}

/** Step two: checks the code and signs in. */
async function verify (email, code) {
  const e = cleanEmail(email)
  const res = await http('POST', `${config().url}/auth/v1/verify`, { body: { type: 'email', email: e, token: String(code || '').replace(/\D/g, '') } })
  if (!res.ok || !res.json?.access_token) throw new CloudError('That code is not right, or it has expired. Check the newest email, or ask for another code.')
  keep(res.json)
  const me = await rpc('ks_me', {})
  prefs.write({ cloud: { email: me.email, workspace: me.workspace, workspaceId: me.workspaceId, role: me.role } })
  return status()
}

/** Re-reads the role and workspace, in case an admin changed them. */
async function refreshProfile () {
  if (!session()) return status()
  const me = await rpc('ks_me', {})
  prefs.write({ cloud: { email: me.email, workspace: me.workspace, workspaceId: me.workspaceId, role: me.role } })
  return status()
}

async function signOut () {
  const s = session()
  if (s) await http('POST', `${config().url}/auth/v1/logout`, { token: s.access }).catch(() => {})
  forget()
  return status()
}

function save (patch = {}) {
  if (patch.auto !== undefined) prefs.write({ cloudShare: { ...(prefs.read().cloudShare || {}), auto: !!patch.auto } })
  return status()
}

/* ---------------------------------------------------------------- publish */

const fileUrl = key => `${config().url}/storage/v1/object/public/${BUCKET}/${key}`
const linkFor = id => `${share.viewerBase()}/watch?v=${encodeURIComponent(id)}`
function embedFor (id, aspect) {
  const pad = (100 / (aspect || 16 / 9)).toFixed(2)
  return `<div style="position:relative;padding-bottom:${pad}%;height:0;overflow:hidden"><iframe src="${linkFor(id)}&embed=1" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`
}

async function put (key, body, type, size) {
  const res = await http('POST', `${config().url}/storage/v1/object/${BUCKET}/${key}`, { token: await token(), body, raw: true, type, timeout: 30 * 60 * 1000 })
  if (res.ok) return key
  const msg = res.json?.message || res.json?.error || res.text || `HTTP ${res.status}`
  if (res.status === 413 || /exceeded the maximum allowed size|too large/i.test(msg)) { const e = new CloudError('too large'); e.tooLarge = true; throw e }
  if (/row-level security|Unauthorized/i.test(msg)) throw new CloudError('The sharing service would not accept the file for your account. Sign out and in again; if it keeps happening, tell whoever runs the service.')
  throw new CloudError(`The video could not be uploaded: ${msg}`)
}
const putFile = (key, file, type) => put(key, require('node:stream').Readable.toWeb(fs.createReadStream(file)), type)
async function removeFiles (keys) {
  const list = (keys || []).filter(Boolean)
  if (!list.length) return
  await http('DELETE', `${config().url}/storage/v1/object/${BUCKET}`, { token: await token(), body: { prefixes: list } }).catch(() => {})
}

/**
 * Uploads (or replaces) a video on the sharing service. The same recording always
 * keeps the same link; who it is shared with is untouched by re-uploading.
 */
async function publish ({ project, filePath, duration, aspect, cues = [], folder = '', onProgress }) {
  const st = status()
  if (!st.signedIn) throw new CloudError('Sign in first, under Settings → Account.')
  if (!filePath || !fs.existsSync(filePath)) throw new CloudError('The exported video could not be found. Export it again.')
  const report = (phase, f) => { try { onProgress && onProgress(phase, f) } catch {} }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cloud-'))
  // A long random folder: the file's address cannot be guessed, only handed out.
  const slot = project.cloud?.slot || crypto.randomBytes(18).toString('base64url')
  const stamp = Date.now().toString(36)
  const base = `${st.workspaceId}/${slot}`
  let reduced = false
  try {
    report('uploading', 0.05)
    let file
    try {
      file = await putFile(`${base}/video-${stamp}.mp4`, filePath, 'video/mp4')
    } catch (e) {
      if (!e.tooLarge) throw e
      report('making a smaller copy', 0)
      const small = await share.makeSmaller(filePath, path.join(tmp, 'small.mp4'), duration, f => report('making a smaller copy', f))
      report('uploading', 0.5)
      try { file = await putFile(`${base}/video-${stamp}.mp4`, small, 'video/mp4') } catch (e2) {
        if (e2.tooLarge) throw new CloudError('This video is too large to share, even as a smaller copy. Share a shorter video, or ask whoever runs the service to raise the file size limit.')
        throw e2
      }
      reduced = true
    }
    report('uploading', 0.85)
    let poster = null
    try {
      const jpg = await share.makePoster(filePath, duration, path.join(tmp, 'poster.jpg'))
      poster = await put(`${base}/poster-${stamp}.jpg`, fs.readFileSync(jpg), 'image/jpeg')
    } catch { /* a page works without a poster */ }

    const ai = project.ai || {}
    const meta = {
      aspect: aspect || null,
      summary: ai.summary || '',
      chapters: ai.chapters || [],
      steps: (ai.steps || []).map(s => ({ at: s.at, title: s.title, detail: s.detail })),
      cues: (cues || []).map(c => ({ s: +Number(c.start).toFixed(2), e: +Number(c.end).toFixed(2), t: String(c.text || '') })).filter(c => c.t && c.e > c.s)
    }
    const saved = await rpc('ks_save_video', {
      p_project: project.id, p_title: project.name || 'Untitled video', p_folder: folder || '',
      p_duration: Math.round((Number(duration) || 0) * 10) / 10, p_file: file, p_poster: poster, p_meta: meta
    })
    await removeFiles(saved.replaced)
    report('done', 1)
    return { id: saved.id, slot, url: linkFor(saved.id), embed: embedFor(saved.id, aspect), reduced, updatedAt: new Date().toISOString(), workspaceId: st.workspaceId }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Takes a video off the service: files, shares and history. */
async function remove (videoId) {
  const files = await rpc('ks_delete_video', { p_video: videoId })
  await removeFiles(files)
  return true
}

const splitEmails = text => String(text || '').split(/[\s,;]+/).map(cleanEmail).filter(Boolean)

module.exports = {
  status, save, requestCode, verify, refreshProfile, signOut, publish, remove, enabled, linkFor, embedFor, fileUrl, splitEmails, CloudError,
  sharing: id => rpc('ks_video_sharing', { p_video: id }),
  share: (id, emails, { required = false, folder = false } = {}) => rpc('ks_share', { p_video: id, p_emails: Array.isArray(emails) ? emails : splitEmails(emails), p_required: !!required, p_folder: !!folder }),
  unshare: (id, email, folder = false) => rpc('ks_unshare', { p_video: id, p_email: email, p_folder: !!folder }),
  setAccess: (id, access) => rpc('ks_set_access', { p_video: id, p_access: access }),
  videos: () => rpc('ks_videos'),
  people: () => rpc('ks_people'),
  removePerson: email => rpc('ks_remove_person', { p_email: email }),
  team: () => rpc('ks_team'),
  setMember: (email, role) => rpc('ks_set_member', { p_email: email, p_role: role }),
  removeMember: email => rpc('ks_remove_member', { p_email: email }),
  renameWorkspace: name => rpc('ks_rename_workspace', { p_name: name })
}
