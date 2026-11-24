'use strict'
/**
 * Google Drive: sign-in, folders and uploads.
 *
 * Where the sign-in comes from, in order:
 *
 *   1. The app's own sign-in ("Connect Google Drive" in Settings). The person
 *      approves access in their browser and the grant is kept in the app's private
 *      store. This is what every downloaded copy of the app uses.
 *   2. A sign-in already on this Mac from other Drive tooling
 *      (~/.drive-mcp, or KS_DRIVE_CONFIG_DIR). Only used when (1) is absent.
 *
 * The app's sign-in asks Google for the narrowest access that does the job
 * (`drive.file`): it can see and change only the files and folders it created
 * itself — never the rest of the person's Drive.
 *
 * Signing in needs an OAuth client (an id and secret Google issues to the app's
 * publisher). It is read from `drive-client.json` shipped inside the app, or from a
 * client the person enters themselves in Settings.
 *
 * Deliberately dependency-free: talks to the Drive v3 REST API over node:https.
 * Uploads use a resumable session, which is what makes a 500 MB MP4 survive a
 * flaky connection.
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const { once } = require('node:events')
const secrets = require('./secrets')

const LEGACY_DIR = process.env.KS_DRIVE_CONFIG_DIR || path.join(os.homedir(), '.drive-mcp')
const CREDENTIALS_PATH = path.join(LEGACY_DIR, 'credentials.json')
const OAUTH_KEYS_PATH = path.join(LEGACY_DIR, 'gcp-oauth.keys.json')

const AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URI = 'https://oauth2.googleapis.com/token'
const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email']
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'

// Google requires every chunk but the last to be a multiple of 256 KiB.
const CHUNK = 8 * 1024 * 1024
const SLICE = 256 * 1024      // socket write size, so the progress bar moves smoothly
const MAX_ATTEMPTS = 5

class DriveError extends Error {
  constructor (message, code, status) {
    super(message)
    this.name = 'DriveError'
    this.code = code || 'DRIVE_ERROR'
    if (status) this.status = status
  }
}

const notConfigured = detail => new DriveError(
  `Google Drive is not connected. ${detail}`.trim(),
  'DRIVE_NOT_CONFIGURED'
)

/* ----------------------------------------------------------------- client */

/** The OAuth client this copy of the app signs in with, or null if it has none. */
function oauthClient () {
  const own = secrets.get('googleClient')
  if (own?.client_id && own?.client_secret) return { ...own, source: 'custom' }
  const places = [
    process.resourcesPath && path.join(process.resourcesPath, 'drive-client.json'),
    path.join(__dirname, '..', '..', 'build', 'drive-client.json')
  ].filter(Boolean)
  for (const file of places) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      const c = j.installed || j.web || j
      if (c.client_id && c.client_secret) return { client_id: c.client_id, client_secret: c.client_secret, source: 'bundled' }
    } catch { /* not there */ }
  }
  return null
}

function setOwnClient ({ clientId, clientSecret } = {}) {
  const id = String(clientId || '').trim()
  const secret = String(clientSecret || '').trim()
  if (!id && !secret) { secrets.set('googleClient', null); return true }
  if (!/\.apps\.googleusercontent\.com$/.test(id) || !secret) {
    throw new DriveError('That does not look like a Google OAuth client. The ID ends in .apps.googleusercontent.com.', 'DRIVE_BAD_ARGS')
  }
  secrets.set('googleClient', { client_id: id, client_secret: secret })
  return true
}

/* ------------------------------------------------------------------ creds */

/** The sign-in in force: the app's own, else one already on this Mac. */
function readCredentials () {
  const own = secrets.get('google')
  if (own?.refresh_token) {
    return {
      source: 'app',
      email: own.email || null,
      limited: true,
      accessToken: null,
      refreshToken: own.refresh_token,
      tokenUri: TOKEN_URI,
      clientId: own.client_id,
      clientSecret: own.client_secret
    }
  }

  let tokens
  try {
    tokens = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'))
  } catch {
    throw notConfigured('Connect it in Settings.')
  }

  let client = { client_id: tokens.client_id, client_secret: tokens.client_secret }
  if (!client.client_id || !client.client_secret) {
    // MCP shape: tokens hold only the grant, the client lives in the keys file.
    try {
      const keys = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, 'utf8'))
      const installed = keys.installed || keys.web || {}
      client = { client_id: installed.client_id, client_secret: installed.client_secret }
      if (installed.token_uri) tokens.token_uri = tokens.token_uri || installed.token_uri
    } catch { /* fall through to the check below */ }
  }

  if (!tokens.refresh_token || !client.client_id || !client.client_secret) {
    throw notConfigured('Connect it in Settings.')
  }

  return {
    source: 'legacy',
    email: null,
    limited: false,
    accessToken: tokens.token || tokens.access_token || null,
    refreshToken: tokens.refresh_token,
    tokenUri: tokens.token_uri || TOKEN_URI,
    clientId: client.client_id,
    clientSecret: client.client_secret
  }
}

/** Writes a refreshed access token back to a legacy store, preserving every other field. */
async function persistAccessToken (token) {
  if (secrets.get('google')?.refresh_token) return     // the app's own store keeps no access token
  try {
    const raw = JSON.parse(await fsp.readFile(CREDENTIALS_PATH, 'utf8'))
    if (!('token' in raw) && !('access_token' in raw)) return
    if ('access_token' in raw) raw.access_token = token
    if ('token' in raw) raw.token = token
    const tmp = `${CREDENTIALS_PATH}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 })
    await fsp.rename(tmp, CREDENTIALS_PATH)          // atomic: never a half-written store
  } catch { /* the token still works in memory; a stale file is not fatal */ }
}

let cachedToken = null   // { value, expiresAt, refreshToken }

async function getAccessToken ({ force = false } = {}) {
  const creds = readCredentials()
  if (!force && cachedToken && cachedToken.refreshToken === creds.refreshToken &&
      cachedToken.expiresAt - Date.now() > 60_000) return cachedToken.value

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: 'refresh_token'
  }).toString()

  const res = await withRetry(() => request('POST', creds.tokenUri, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  }), 'token refresh')

  if (res.status !== 200) {
    throw new DriveError(
      `Google no longer accepts the saved sign-in (${describe(res)}). Reconnect Google Drive in Settings.`,
      'DRIVE_AUTH_FAILED', res.status
    )
  }

  const json = JSON.parse(res.body)
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000, refreshToken: creds.refreshToken }
  await persistAccessToken(json.access_token)
  return cachedToken.value
}

/* ---------------------------------------------------------------- sign-in */

let pendingSignIn = null

/**
 * Signs in to Google from the app.
 *
 * Opens the person's browser on Google's own consent page and waits for Google to
 * send them back to a one-off address on this Mac (the "loopback" flow Google
 * prescribes for desktop apps, with PKCE). The app never sees their password.
 *
 * @param {(url:string)=>void} openBrowser  how to open the consent page
 * @returns {Promise<{email:string|null}>}
 */
function signIn (openBrowser) {
  if (pendingSignIn) pendingSignIn.cancel()
  const client = oauthClient()
  if (!client) {
    return Promise.reject(new DriveError('This copy of the app has no Google sign-in set up. Add an OAuth client in Settings.', 'DRIVE_NO_CLIENT'))
  }

  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const state = crypto.randomBytes(16).toString('hex')

  return new Promise((resolve, reject) => {
    let redirect = ''
    let done = false
    const finish = (fn, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      pendingSignIn = null
      server.close()
      fn(value)
    }
    const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      '<body style="font:16px -apple-system,system-ui,sans-serif;background:#0A0A0C;color:#EDEDF0;display:grid;place-items:center;height:100vh;margin:0">' +
      `<div style="text-align:center;max-width:420px;padding:24px"><h2 style="font-weight:650">${title}</h2><p style="color:#8A8A96;line-height:1.5">${body}</p></div>`

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, redirect)
      if (u.pathname !== '/') { res.writeHead(404); res.end(); return }
      const fail = message => {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(page('Google Drive was not connected', message))
        finish(reject, new DriveError(message, 'DRIVE_AUTH_FAILED'))
      }
      if (u.searchParams.get('error')) return fail(u.searchParams.get('error') === 'access_denied' ? 'Access was not approved.' : `Google reported: ${u.searchParams.get('error')}`)
      if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) return fail('The reply from Google did not match this sign-in. Please try again.')

      try {
        const tok = await request('POST', TOKEN_URI, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: u.searchParams.get('code'),
            client_id: client.client_id,
            client_secret: client.client_secret,
            redirect_uri: redirect,
            grant_type: 'authorization_code',
            code_verifier: verifier
          }).toString()
        })
        if (tok.status !== 200) return fail(`Google would not complete the sign-in (${describe(tok)}).`)
        const json = JSON.parse(tok.body)
        if (!json.refresh_token) return fail('Google did not return a lasting sign-in. Remove the app under myaccount.google.com → Security → Third-party access, then try again.')
        if (!String(json.scope || '').includes('drive.file')) return fail('Drive access was not ticked on the consent page. Try again and allow it.')

        let email = null
        try {
          const who = await request('GET', 'https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${json.access_token}` } })
          if (who.status === 200) email = JSON.parse(who.body).email || null
        } catch { /* the address is only for display */ }

        secrets.set('google', {
          refresh_token: json.refresh_token,
          client_id: client.client_id,
          client_secret: client.client_secret,
          email,
          connectedAt: new Date().toISOString()
        })
        cachedToken = null
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(page('Google Drive is connected', 'You can close this tab and go back to the app.'))
        finish(resolve, { email })
      } catch (e) {
        fail(`The sign-in could not be completed: ${e.message}`)
      }
    })

    const timer = setTimeout(() => finish(reject, new DriveError('The sign-in was not finished in time. Try again.', 'DRIVE_AUTH_TIMEOUT')), 5 * 60 * 1000)
    pendingSignIn = { cancel: () => finish(reject, new DriveError('Sign-in cancelled.', 'DRIVE_AUTH_CANCELLED')) }

    server.on('error', e => finish(reject, new DriveError(`Could not start the sign-in: ${e.message}`, 'DRIVE_AUTH_FAILED')))
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}`
      const url = `${AUTH_URI}?${new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: 'code',
        scope: SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        state
      })}`
      try { openBrowser(url) } catch (e) { finish(reject, new DriveError(`Could not open the browser: ${e.message}`, 'DRIVE_AUTH_FAILED')) }
    })
  })
}

function cancelSignIn () { if (pendingSignIn) pendingSignIn.cancel() }

/**
 * Forgets the app's sign-in on this Mac.
 *
 * It deliberately does not ask Google to revoke the grant: Google revokes per person
 * and per app, not per computer, so that would also sign the same person out on any
 * other Mac where they use the app. Access can be withdrawn for good at
 * myaccount.google.com → Security → Third-party access.
 */
async function signOut () {
  secrets.set('google', null)
  cachedToken = null
  return true
}

/** What Settings shows about the connection. Never throws. */
function account () {
  const client = oauthClient()
  try {
    const c = readCredentials()
    return { connected: true, source: c.source, email: c.email, limited: c.limited, canSignIn: !!client, clientSource: client?.source || null }
  } catch {
    return { connected: false, source: null, email: null, limited: true, canSignIn: !!client, clientSource: client?.source || null }
  }
}

/* ------------------------------------------------------------------- http */

function request (method, url, { headers = {}, body = null, onWrite = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      method,
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('error', reject)
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    req.setTimeout(120_000, () => req.destroy(new Error('request timed out')))
    req.on('error', reject)

    if (body && onWrite) {
      // Hand the socket the payload in slices so upload progress is reported
      // as it drains, not in one jump when the chunk completes.
      ;(async () => {
        for (let i = 0; i < body.length; i += SLICE) {
          const slice = body.subarray(i, Math.min(i + SLICE, body.length))
          if (!req.write(slice)) await once(req, 'drain')
          onWrite(slice.length)
        }
        req.end()
      })().catch(reject)
    } else {
      if (body) req.write(body)
      req.end()
    }
  })
}

const retryableStatus = s => s === 408 || s === 429 || (s >= 500 && s < 600)
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Retries network blips and Google's transient statuses with jittered backoff. */
async function withRetry (fn, label, attempts = MAX_ATTEMPTS) {
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fn()
      if (!retryableStatus(res.status) || i === attempts - 1) return res
      last = new DriveError(`${label}: ${describe(res)}`, 'DRIVE_HTTP_ERROR', res.status)
    } catch (err) {
      last = err
      if (i === attempts - 1) break
    }
    await sleep(Math.min(30_000, 2 ** i * 1000) + Math.random() * 500)
  }
  throw last instanceof DriveError ? last : new DriveError(`${label}: ${last.message}`, 'DRIVE_NETWORK')
}

function describe (res) {
  try {
    const j = JSON.parse(res.body)
    return `HTTP ${res.status} ${j.error?.message || j.error_description || j.error || ''}`.trim()
  } catch {
    return `HTTP ${res.status} ${res.body.slice(0, 200)}`.trim()
  }
}

/** JSON call against the Drive API, refreshing the token once on a 401. */
async function api (method, url, { body = null, retryLabel = 'drive api' } = {}) {
  const call = async token => request(method, url, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(body) } : {})
    },
    body
  })

  let res = await withRetry(async () => call(await getAccessToken()), retryLabel)
  if (res.status === 401) res = await withRetry(async () => call(await getAccessToken({ force: true })), retryLabel)

  if (res.status < 200 || res.status >= 300) {
    throw new DriveError(`${retryLabel} failed: ${describe(res)}`, 'DRIVE_HTTP_ERROR', res.status)
  }
  return res.body ? JSON.parse(res.body) : {}
}

/* ---------------------------------------------------------------- helpers */

const quote = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.gif': 'image/gif'
}
const mimeFor = f => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FOLDER_FIELDS = encodeURIComponent('id,name,mimeType,webViewLink,trashed,capabilities(canAddChildren)')

/** Pulls a folder id out of a pasted Drive link, or returns the id as given. */
function parseFolderId (input) {
  const text = String(input || '').trim()
  if (!text) return null
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(text) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(text)
  if (m) return m[1]
  return /^[A-Za-z0-9_-]{10,}$/.test(text) ? text : null
}

/**
 * Looks a folder up and checks it can actually hold uploads. This is what turns a
 * pasted link into the parent folder everything else is created inside.
 */
async function getFolder (idOrLink) {
  const id = parseFolderId(idOrLink)
  if (!id) throw new DriveError('That does not look like a Google Drive folder link.', 'DRIVE_BAD_ARGS')
  let meta
  try {
    meta = await api('GET', `${API}/files/${id}?fields=${FOLDER_FIELDS}&supportsAllDrives=true`, { retryLabel: 'look up folder' })
  } catch (e) {
    if (e.status === 404) {
      throw new DriveError(account().limited
        ? 'Google only lets the app use folders it created itself, so it cannot see this one. Create the parent folder here instead — you can then move or rename it anywhere in your Drive and it keeps working.'
        : 'Drive cannot find that folder — check the link, and that this Google account can open it.',
      'DRIVE_NOT_FOUND', 404)
    }
    throw e
  }
  if (meta.mimeType !== FOLDER_MIME) throw new DriveError('That link is a file, not a folder.', 'DRIVE_BAD_ARGS')
  if (meta.trashed) throw new DriveError('That folder is in the Drive bin.', 'DRIVE_BAD_ARGS')
  if (meta.capabilities && meta.capabilities.canAddChildren === false) {
    throw new DriveError('This Google account can view that folder but cannot add files to it.', 'DRIVE_FORBIDDEN')
  }
  return { id: meta.id, name: meta.name, link: meta.webViewLink || `https://drive.google.com/drive/folders/${meta.id}` }
}

/** Folders directly inside `parentId`. */
async function listFolders (parentId) {
  const q = [`mimeType = '${FOLDER_MIME}'`, 'trashed = false', `'${quote(parentId)}' in parents`].join(' and ')
  const out = []
  let pageToken = ''
  do {
    const res = await api('GET',
      `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(id,name)')}` +
      `&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`,
      { retryLabel: 'list folders' })
    out.push(...(res.files || []))
    pageToken = res.nextPageToken || ''
  } while (pageToken)
  return out
}

/** Creates a folder inside `parentId` ('root' for the top of My Drive). */
async function createFolder (name, parentId = 'root') {
  const made = await api('POST', `${API}/files?fields=${encodeURIComponent('id,name,webViewLink')}&supportsAllDrives=true`, {
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    retryLabel: `create folder "${name}"`
  })
  return { id: made.id, name: made.name, link: made.webViewLink || `https://drive.google.com/drive/folders/${made.id}` }
}

/** The named folder inside `parentId`, created only if it is not already there. */
async function ensureFolderIn (name, parentId) {
  const existing = (await listFolders(parentId)).find(f => f.name === name)
  if (existing) return { id: existing.id, name: existing.name, link: `https://drive.google.com/drive/folders/${existing.id}`, existed: true }
  return createFolder(name, parentId)
}

async function renameItem (id, name) {
  await api('PATCH', `${API}/files/${id}?fields=id&supportsAllDrives=true`, {
    body: JSON.stringify({ name }), retryLabel: 'rename'
  })
  return true
}

/** Moves a file or folder so that `toParentId` is its only parent. */
async function moveItem (id, toParentId) {
  const meta = await api('GET', `${API}/files/${id}?fields=parents&supportsAllDrives=true`, { retryLabel: 'read parents' })
  const from = (meta.parents || []).filter(p => p !== toParentId)
  if (!from.length && (meta.parents || []).includes(toParentId)) return true
  const params = `addParents=${encodeURIComponent(toParentId)}${from.length ? `&removeParents=${encodeURIComponent(from.join(','))}` : ''}`
  await api('PATCH', `${API}/files/${id}?${params}&fields=id&supportsAllDrives=true`, { body: '{}', retryLabel: 'move' })
  return true
}

/** The "Knight Studio" folder older versions uploaded into, if this account has one. */
async function findLegacyFolder () {
  const q = [`mimeType = '${FOLDER_MIME}'`, "name = 'Knight Studio'", 'trashed = false', "'root' in parents"].join(' and ')
  const found = await api('GET',
    `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name,webViewLink)')}&pageSize=5&spaces=drive`,
    { retryLabel: 'look up folder' })
  const f = found.files?.[0]
  return f ? { id: f.id, name: f.name, link: f.webViewLink || `https://drive.google.com/drive/folders/${f.id}` } : null
}

/* -------------------------------------------------------------- resumable */

async function startSession ({ name, folderId, mimeType, size }) {
  const url = `${UPLOAD_API}?uploadType=resumable&supportsAllDrives=true&fields=${encodeURIComponent('id,name,size,webViewLink,mimeType')}`
  const body = JSON.stringify({ name, parents: [folderId] })

  const call = async token => request('POST', url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'Content-Length': Buffer.byteLength(body),
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(size)
    },
    body
  })

  let res = await withRetry(async () => call(await getAccessToken()), 'start upload')
  if (res.status === 401) res = await withRetry(async () => call(await getAccessToken({ force: true })), 'start upload')

  const location = res.headers.location
  if (res.status !== 200 || !location) {
    throw new DriveError(`Could not start the Drive upload: ${describe(res)}`, 'DRIVE_UPLOAD_FAILED', res.status)
  }
  return location
}

/** Asks Google how much of the session it already holds (after a failure). */
async function sessionOffset (sessionUrl, total) {
  const res = await withRetry(async () => request('PUT', sessionUrl, {
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      'Content-Length': '0',
      'Content-Range': `bytes */${total}`
    }
  }), 'resume upload')

  if (res.status === 200 || res.status === 201) return { done: true, file: JSON.parse(res.body) }
  if (res.status === 308) {
    const range = res.headers.range
    return { done: false, offset: range ? Number(range.split('-')[1]) + 1 : 0 }
  }
  if (res.status === 404) return { gone: true }
  throw new DriveError(`Could not resume the Drive upload: ${describe(res)}`, 'DRIVE_UPLOAD_FAILED', res.status)
}

async function pushChunks ({ sessionUrl, filePath, total, report }) {
  const fh = await fsp.open(filePath, 'r')
  try {
    let offset = 0
    let attempt = 0

    while (offset < total) {
      const length = Math.min(CHUNK, total - offset)
      const buf = Buffer.allocUnsafe(length)
      await fh.read(buf, 0, length, offset)

      let res
      try {
        let sent = 0
        res = await request('PUT', sessionUrl, {
          headers: {
            Authorization: `Bearer ${await getAccessToken()}`,
            'Content-Length': String(length),
            'Content-Range': `bytes ${offset}-${offset + length - 1}/${total}`
          },
          body: buf,
          onWrite: n => { sent += n; report(offset + sent) }
        })
      } catch (err) {
        if (++attempt >= MAX_ATTEMPTS) {
          throw new DriveError(`Upload stalled after ${MAX_ATTEMPTS} attempts: ${err.message}`, 'DRIVE_UPLOAD_FAILED')
        }
        await sleep(Math.min(30_000, 2 ** attempt * 1000) + Math.random() * 500)
        const state = await sessionOffset(sessionUrl, total)
        if (state.gone) return null                      // caller restarts the whole upload
        if (state.done) return state.file
        offset = state.offset
        report(offset)
        continue
      }

      if (res.status === 200 || res.status === 201) return JSON.parse(res.body)

      if (res.status === 308) {
        const range = res.headers.range
        offset = range ? Number(range.split('-')[1]) + 1 : offset + length
        report(offset)
        attempt = 0
        continue
      }

      if (res.status === 404) return null                // session expired; restart

      if (res.status === 401) {
        if (++attempt >= MAX_ATTEMPTS) {
          throw new DriveError('Drive kept rejecting the access token mid-upload.', 'DRIVE_AUTH_FAILED', 401)
        }
        await getAccessToken({ force: true })
        continue
      }

      if (retryableStatus(res.status)) {
        if (++attempt >= MAX_ATTEMPTS) {
          throw new DriveError(`Upload failed: ${describe(res)}`, 'DRIVE_UPLOAD_FAILED', res.status)
        }
        await sleep(Math.min(30_000, 2 ** attempt * 1000) + Math.random() * 500)
        const state = await sessionOffset(sessionUrl, total)
        if (state.gone) return null
        if (state.done) return state.file
        offset = state.offset
        report(offset)
        continue
      }

      throw new DriveError(`Upload failed: ${describe(res)}`, 'DRIVE_UPLOAD_FAILED', res.status)
    }

    // Every byte is in and Google never sent the final object — ask for it.
    const state = await sessionOffset(sessionUrl, total)
    if (state.done) return state.file
    return null
  } finally {
    await fh.close()
  }
}

/* ---------------------------------------------------------------- exports */

/**
 * True when Drive credentials exist and Google still accepts them, so the UI
 * can hide the feature rather than surfacing a dead button. Being offline
 * counts as configured — the credentials are fine, the network is not.
 */
async function isConfigured () {
  try {
    readCredentials()
  } catch {
    return false
  }
  try {
    await getAccessToken()
    return true
  } catch (err) {
    return err.code !== 'DRIVE_AUTH_FAILED' && err.code !== 'DRIVE_NOT_CONFIGURED'
  }
}

/**
 * Uploads an exported video to Drive and returns a shareable link.
 *
 * @param {object}   opts
 * @param {string}   opts.filePath    local file to upload
 * @param {string}  [opts.name]       name in Drive (defaults to the basename)
 * @param {string}   opts.folderId   Drive folder the file is created inside
 * @param {(f:number)=>void} [opts.onProgress] called with 0..1 as bytes land
 * @returns {Promise<{id:string,name:string,webViewLink:string,size:number}>}
 */
async function uploadVideo ({ filePath, name, folderId, onProgress, share = true } = {}) {
  if (!filePath) throw new DriveError('uploadVideo needs a filePath.', 'DRIVE_BAD_ARGS')
  if (!folderId) {
    throw new DriveError('Choose a Google Drive parent folder in Settings before uploading.', 'DRIVE_NO_PARENT')
  }

  let stat
  try {
    stat = await fsp.stat(filePath)
  } catch {
    throw new DriveError(`No such file to upload: ${filePath}`, 'DRIVE_BAD_ARGS')
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new DriveError(`Nothing to upload — ${filePath} is empty or not a file.`, 'DRIVE_BAD_ARGS')
  }

  await getAccessToken()                                  // fails loudly if unconfigured
  const total = stat.size
  const title = name || path.basename(filePath)

  // A UI error must never kill an upload, and the bar only moves forward even
  // when a retry rewinds the offset.
  const emit = f => { if (onProgress) { try { onProgress(f) } catch { /* ignore */ } } }
  let peak = 0
  const report = sent => {
    if (sent <= peak) return
    peak = sent
    emit(Math.min(1, sent / total))
  }
  emit(0)

  let file = null
  for (let round = 0; round < 2 && !file; round++) {
    const sessionUrl = await startSession({ name: title, folderId, mimeType: mimeFor(filePath), size: total })
    peak = 0
    file = await pushChunks({ sessionUrl, filePath, total, report })
  }
  if (!file) throw new DriveError('Drive kept expiring the upload session.', 'DRIVE_UPLOAD_FAILED')

  emit(1)

  // Anyone with the link can watch it; nobody can change it.
  if (share) {
    await api('POST', `${API}/files/${file.id}/permissions?fields=id&supportsAllDrives=true`, {
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
      retryLabel: 'share file'
    })
  }

  // Re-read: webViewLink is only meaningful once sharing is applied.
  const meta = await api('GET',
    `${API}/files/${file.id}?fields=${encodeURIComponent('id,name,size,webViewLink')}&supportsAllDrives=true`,
    { retryLabel: 'read file metadata' })

  return {
    id: meta.id,
    name: meta.name,
    webViewLink: meta.webViewLink,
    folderId,
    size: Number(meta.size ?? total)
  }
}

/**
 * Proves the connection end to end by doing, for real, everything an export does:
 * sign in, reach the parent folder, create a folder in it, upload a file into that,
 * read it back, then remove both again. Each step reports on its own, so a failure
 * says exactly which part is not working. Nothing is left behind in Drive.
 *
 * @returns {Promise<{ok:boolean, steps:Array<{name:string, ok:boolean, detail:string}>}>}
 */
async function testConnection (parent) {
  const steps = []
  const step = async (name, fn) => {
    try {
      const detail = await fn()
      steps.push({ name, ok: true, detail: detail || '' })
      return true
    } catch (e) {
      steps.push({ name, ok: false, detail: String(e.message || e) })
      return false
    }
  }
  let folder = null
  let file = null
  const tmp = path.join(os.tmpdir(), `connection-test-${Date.now()}.txt`)

  const signedIn = await step('Sign in to Google', async () => {
    await getAccessToken({ force: true })
    const a = account()
    return a.email ? `Signed in as ${a.email}.` : 'Sign-in accepted.'
  })
  if (signedIn) {
    const reachable = await step('Find the parent folder', async () => {
      if (!parent?.id) throw new Error('No parent folder has been chosen yet.')
      const f = await getFolder(parent.id)
      return `“${f.name}” is there and can be written to.`
    })
    if (reachable) {
      const made = await step('Create a folder inside it', async () => {
        folder = await createFolder(`Connection test ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, parent.id)
        return 'Created.'
      })
      if (made) {
        const uploaded = await step('Upload a file into that folder', async () => {
          fs.writeFileSync(tmp, 'Connection test file. Safe to delete.\n')
          file = await uploadVideo({ filePath: tmp, name: 'connection-test.txt', folderId: folder.id, share: false })
          return 'Uploaded.'
        })
        if (uploaded) {
          await step('Read it back from Drive', async () => {
            const meta = await api('GET', `${API}/files/${file.id}?fields=${encodeURIComponent('id,name,size,parents')}&supportsAllDrives=true`, { retryLabel: 'read file' })
            if (!(meta.parents || []).includes(folder.id)) throw new Error('The file is not in the folder it was uploaded to.')
            return `Drive has it (${meta.size} bytes).`
          })
        }
      }
    }
  }
  // Always tidy up whatever was created, pass or fail.
  if (file || folder) {
    await step('Remove the test folder and file', async () => {
      if (file) await deleteFile(file.id)
      if (folder) await deleteFile(folder.id)
      return 'Nothing was left behind.'
    })
  }
  try { fs.unlinkSync(tmp) } catch {}
  return { ok: steps.length >= 6 && steps.every(s => s.ok), steps }
}

/**
 * Creates a small file anyone with the link can read, or replaces the contents of one
 * made earlier (same id, so links to it keep working). Used for a share page's
 * description, poster and logo.
 */
async function putSmall ({ name, bytes, mimeType, folderId, fileId = null }) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const send = async (method, url, headers, body) => {
    const call = async token => request(method, url, { headers: { Authorization: `Bearer ${token}`, ...headers, 'Content-Length': body.length }, body })
    let res = await withRetry(async () => call(await getAccessToken()), 'store file')
    if (res.status === 401) res = await withRetry(async () => call(await getAccessToken({ force: true })), 'store file')
    return res
  }
  if (fileId) {
    const res = await send('PATCH', `${UPLOAD_API}/${fileId}?uploadType=media&supportsAllDrives=true&fields=id`, { 'Content-Type': mimeType }, data)
    if (res.status >= 200 && res.status < 300) return { id: fileId, replaced: true }
    // Deleted in Drive by hand: fall through and make it again.
    if (res.status !== 404) throw new DriveError(`store file failed: ${describe(res)}`, 'DRIVE_HTTP_ERROR', res.status)
  }
  const boundary = `ks${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId], mimeType })}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`)
  ])
  const res = await send('POST', `${UPLOAD_API}?uploadType=multipart&supportsAllDrives=true&fields=id`, { 'Content-Type': `multipart/related; boundary=${boundary}` }, body)
  if (res.status < 200 || res.status >= 300) throw new DriveError(`store file failed: ${describe(res)}`, 'DRIVE_HTTP_ERROR', res.status)
  const id = JSON.parse(res.body).id
  await api('POST', `${API}/files/${id}/permissions?fields=id&supportsAllDrives=true`, { body: JSON.stringify({ role: 'reader', type: 'anyone' }), retryLabel: 'share file' })
  return { id, replaced: false }
}

/** Makes sure anyone with the link can read a file this app uploaded. */
async function shareWithAnyone (fileId) {
  await api('POST', `${API}/files/${fileId}/permissions?fields=id&supportsAllDrives=true`, { body: JSON.stringify({ role: 'reader', type: 'anyone' }), retryLabel: 'share file' })
  return true
}

/** Whether a file still exists in Drive (not deleted, not in the bin). */
async function exists (fileId) {
  try { const f = await api('GET', `${API}/files/${fileId}?fields=id,trashed&supportsAllDrives=true`, { retryLabel: 'read file' }); return !f.trashed } catch { return false }
}

/**
 * Whether Google has finished preparing an uploaded video for playback in its player.
 * A new upload plays nowhere for the first few minutes; this is how to tell.
 */
async function playable (fileId) {
  try {
    const f = await api('GET', `${API}/files/${fileId}?fields=${encodeURIComponent('id,trashed,videoMediaMetadata')}&supportsAllDrives=true`, { retryLabel: 'read file' })
    return !f.trashed && !!(f.videoMediaMetadata && f.videoMediaMetadata.durationMillis)
  } catch { return false }
}

/** Removes a Drive file — used to undo an upload the user did not want. */
async function deleteFile (fileId) {
  if (!fileId) throw new DriveError('deleteFile needs a fileId.', 'DRIVE_BAD_ARGS')
  await api('DELETE', `${API}/files/${fileId}?supportsAllDrives=true`, { retryLabel: 'delete file' })
  return true
}

module.exports = {
  isConfigured,
  account,
  oauthClient,
  setOwnClient,
  signIn,
  cancelSignIn,
  signOut,
  uploadVideo,
  deleteFile,
  putSmall,
  playable,
  shareWithAnyone,
  exists,
  parseFolderId,
  getFolder,
  listFolders,
  createFolder,
  ensureFolderIn,
  renameItem,
  moveItem,
  findLegacyFolder,
  testConnection,
  DriveError,
  CREDENTIALS_PATH
}
