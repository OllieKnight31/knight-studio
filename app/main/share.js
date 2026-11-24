'use strict'
/**
 * Share pages.
 *
 * A share page is a link anyone can open to watch a video, with its chapters, summary
 * and transcript beside it, that can also be embedded in another page. It counts how
 * many times the video was watched and for how long.
 *
 * Nothing here runs on a server of ours. The video, its poster and a small description
 * file are stored in the person's own Supabase storage bucket; views are counted in
 * their own Supabase database. The page itself is one static file, the same for
 * everybody, which reads that description file and plays the video — so whoever owns
 * the Supabase project owns the videos and the numbers, and a share link keeps working
 * for as long as their project does.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const prefs = require('./prefs')
const databases = require('./databases')
const { tool } = require('./tools')
const { DbError, runSteps } = databases

// The page every share link opens. One static file; see share-viewer/ in the source.
// Set your own: host share-viewer/ anywhere static, then put its address in Settings or KS_SHARE_VIEWER.
const DEFAULT_VIEWER = 'https://share.example.com'
const viewerBase = () => String(process.env.KS_SHARE_VIEWER || prefs.read().share?.viewer || DEFAULT_VIEWER).replace(/\/+$/, '')

const settings = () => ({ auto: true, ...(prefs.read().share || {}) })
const newId = () => crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10)

function status () {
  const sb = databases.supabaseCtx()
  const s = settings()
  return {
    ready: !!(sb.ready && sb.bucket),          // can a share page be made at all
    connected: sb.ready,
    bucket: sb.bucket || null,
    counting: !!sb.anonKey,                    // will views be counted
    auto: s.auto !== false,
    tested: s.tested === true,
    viewer: viewerBase(),
    customViewer: prefs.read().share?.viewer || null
  }
}

function save (patch = {}) {
  const next = { ...(prefs.read().share || {}) }
  if (patch.auto !== undefined) next.auto = !!patch.auto
  if (patch.viewer !== undefined) {
    const v = String(patch.viewer || '').trim().replace(/\/+$/, '')
    if (v && !/^https?:\/\/[^\s/]+/.test(v)) throw new DbError('The share page address should start with https://')
    next.viewer = v || null
    next.tested = false
  }
  prefs.write({ share: next })
  return status()
}

/* --------------------------------------------------------------- storage */

const objectUrl = (sb, key) => `${sb.base}/storage/v1/object/${encodeURIComponent(sb.bucket)}/${key}`
const publicUrl = (sb, key) => `${sb.base}/storage/v1/object/public/${encodeURIComponent(sb.bucket)}/${key}`

function storageProblem (res, sb, what) {
  const msg = res.json?.message || res.json?.error || res.text || `HTTP ${res.status}`
  if (res.status === 401 || /invalid api key|jwt|signature/i.test(msg)) return new DbError('Supabase does not accept the saved key. Copy the “service_role” key again in Settings → Databases.')
  if (res.status === 404 || /bucket not found/i.test(msg)) return new DbError(`There is no storage bucket called “${sb.bucket}”. Create it in Supabase → Storage and make it public.`)
  if (res.status === 413 || /exceeded the maximum allowed size|too large/i.test(msg)) {
    const e = new DbError('The video is larger than this Supabase project allows for one file.')
    e.tooLarge = true
    return e
  }
  return new DbError(`Supabase could not ${what}: ${msg}`)
}

async function putBytes (sb, key, bytes, type, cache = 'max-age=60') {
  const res = await sb.call('POST', objectUrl(sb, key), {
    headers: sb.headers({ 'Content-Type': type, 'Content-Length': String(bytes.length), 'x-upsert': 'true', 'cache-control': cache }),
    body: bytes, raw: true
  })
  if (!res.ok) throw storageProblem(res, sb, 'store a file')
  return publicUrl(sb, key)
}

async function putFile (sb, key, filePath, type) {
  const size = fs.statSync(filePath).size
  const res = await sb.call('POST', objectUrl(sb, key), {
    headers: sb.headers({ 'Content-Type': type, 'Content-Length': String(size), 'x-upsert': 'true', 'cache-control': 'max-age=3600' }),
    body: require('node:stream').Readable.toWeb(fs.createReadStream(filePath)), raw: true
  })
  if (!res.ok) throw storageProblem(res, sb, 'store the video')
  return publicUrl(sb, key)
}

async function removeObjects (sb, keys) {
  if (!keys.length) return
  await sb.call('DELETE', `${sb.base}/storage/v1/object/${encodeURIComponent(sb.bucket)}`, {
    headers: sb.headers(), body: { prefixes: keys }
  }).catch(() => {})
}

/* ---------------------------------------------------------------- ffmpeg */

function ffmpeg (args, { onTime } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool('ffmpeg'), ['-hide_banner', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let tail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', d => {
      tail = (tail + d).slice(-1500)
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(d)
      if (m && onTime) onTime(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]))
    })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${tail.slice(-300)}`)))
  })
}

/** A still from the video, for the page to show before it is played. */
async function makePoster (filePath, duration, out) {
  const at = Math.max(0, Math.min((Number(duration) || 0) * 0.1, 8))
  await ffmpeg(['-ss', at.toFixed(2), '-i', filePath, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '4', out])
  return out
}

/** A smaller copy, for a project whose storage will not take the full-size file. */
async function makeSmaller (filePath, out, duration, onProgress) {
  await ffmpeg(['-i', filePath, '-vf', 'scale=-2:720', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
    '-r', '30', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out],
  { onTime: t => onProgress && duration && onProgress(Math.min(0.99, t / duration)) })
  return out
}

/* --------------------------------------------------------------- publish */

function linkFor (sb, id) {
  const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co$/i.exec(sb.base)?.[1]
  const q = new URLSearchParams(ref ? { p: ref } : { u: sb.base })
  q.set('b', sb.bucket)
  q.set('v', id)
  return `${viewerBase()}/?${q}`
}

function embedCode (url, aspect = 16 / 9) {
  const pad = (100 / (aspect || 16 / 9)).toFixed(2)
  return `<div style="position:relative;padding-bottom:${pad}%;height:0;overflow:hidden"><iframe src="${url}&embed=1" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`
}

/**
 * Publishes (or re-publishes) one video's share page. A video keeps the same link for
 * life: exporting again replaces the video behind it.
 *
 * @param {object} o
 * @param {object} o.project      the saved project
 * @param {string} o.filePath     the exported MP4
 * @param {number} o.duration     seconds
 * @param {number} [o.aspect]     width / height
 * @param {{start:number,end:number,text:string}[]} [o.cues]  captions, timed on the finished video
 * @param {(phase:string, fraction:number)=>void} [o.onProgress]
 */
async function publish ({ project, filePath, duration, aspect, cues = [], onProgress }) {
  const sb = databases.supabaseCtx()
  if (!sb.ready) throw new DbError('Connect Supabase in Settings → Databases to make share pages.')
  if (!sb.bucket) throw new DbError('Name a storage bucket in Settings → Databases → Supabase — the video for a share page is stored there.')
  if (!filePath || !fs.existsSync(filePath)) throw new DbError('The exported video could not be found. Export it again.')

  const id = project.share?.id || newId()
  const dir = `share/${id}`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-share-'))
  const report = (phase, f) => { try { onProgress && onProgress(phase, f) } catch {} }
  // A new file name each time, so a browser never plays a stale copy from its cache.
  const stamp = Date.now().toString(36)
  let reduced = false
  try {
    report('uploading', 0.05)
    let video
    try {
      video = await putFile(sb, `${dir}/video-${stamp}.mp4`, filePath, 'video/mp4')
    } catch (e) {
      if (!e.tooLarge) throw e
      // Free Supabase projects stop at 50 MB a file. Rather than fail, share a lighter copy.
      report('making a smaller copy', 0)
      const small = await makeSmaller(filePath, path.join(tmp, 'small.mp4'), duration, f => report('making a smaller copy', f))
      report('uploading', 0.5)
      try {
        video = await putFile(sb, `${dir}/video-${stamp}.mp4`, small, 'video/mp4')
      } catch (e2) {
        if (e2.tooLarge) throw new DbError('Even a smaller copy of this video is larger than this Supabase project allows for one file. Raise the limit under Storage → Settings in Supabase, or share a shorter video.')
        throw e2
      }
      reduced = true
    }

    report('uploading', 0.8)
    let poster = null
    try {
      const jpg = await makePoster(filePath, duration, path.join(tmp, 'poster.jpg'))
      poster = await putBytes(sb, `${dir}/poster-${stamp}.jpg`, fs.readFileSync(jpg), 'image/jpeg', 'max-age=3600')
    } catch { /* a share page works without a poster */ }

    const ai = project.ai || {}
    const meta = {
      v: 1,
      id,
      title: project.name || 'Untitled video',
      video,
      poster,
      duration: Math.round((Number(duration) || 0) * 10) / 10,
      aspect: aspect || null,
      publishedAt: project.share?.publishedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary: ai.summary || '',
      chapters: ai.chapters || [],
      steps: (ai.steps || []).map(s => ({ at: s.at, title: s.title, detail: s.detail })),
      cues: (cues || []).map(c => ({ s: +Number(c.start).toFixed(2), e: +Number(c.end).toFixed(2), t: String(c.text || '') })).filter(c => c.t && c.e > c.s),
      // The public key lets the page add one to the view count, and nothing else.
      count: sb.anonKey ? { url: sb.base, key: sb.anonKey } : null
    }
    await putBytes(sb, `${dir}/meta.json`, Buffer.from(JSON.stringify(meta)), 'application/json', 'max-age=30')

    // Earlier copies of the video are no longer linked from anywhere.
    const old = [project.share?.videoKey, project.share?.posterKey].filter(k => k && !k.includes(stamp))
    await removeObjects(sb, old)

    report('done', 1)
    const url = linkFor(sb, id)
    return {
      id,
      url,
      embed: embedCode(url, aspect),
      publishedAt: meta.publishedAt,
      updatedAt: meta.updatedAt,
      videoKey: `${dir}/video-${stamp}.mp4`,
      posterKey: poster ? `${dir}/poster-${stamp}.jpg` : null,
      counting: !!sb.anonKey,
      reduced
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Takes a share page down. The link stops working; the numbers are kept. */
async function unpublish (share) {
  const sb = databases.supabaseCtx()
  if (!sb.ready || !sb.bucket || !share?.id) return false
  await removeObjects(sb, [`share/${share.id}/meta.json`, share.videoKey, share.posterKey].filter(Boolean))
  return true
}

/** Views and watch time for one share page. */
async function stats (id) {
  const sb = databases.supabaseCtx()
  if (!sb.ready) throw new DbError('Supabase is not connected.')
  const res = await sb.call('POST', `${sb.base}/rest/v1/rpc/ks_video_stats`, { headers: sb.headers(), body: { p_video: id } })
  if (!res.ok) throw countProblem(res)
  const row = Array.isArray(res.json) ? res.json[0] : res.json
  return {
    views: Number(row?.views) || 0,
    avgSeconds: Number(row?.avg_seconds) || 0,
    avgPercent: Number(row?.avg_percent) || 0,
    counting: !!sb.anonKey
  }
}

function countProblem (res) {
  const msg = res.json?.message || res.text || `HTTP ${res.status}`
  if (res.status === 404 || res.json?.code === 'PGRST202' || /could not find the function/i.test(msg)) {
    return new DbError('The view counter has not been set up in this Supabase project yet. Press “Copy the table setup” in Settings → Databases → Supabase, paste it into the SQL Editor and run it — it now includes the share page part.')
  }
  if (res.status === 401 || /invalid api key|jwt/i.test(msg)) return new DbError('Supabase does not accept that key.')
  return new DbError(`Supabase could not count views: ${msg}`)
}

/* ------------------------------------------------------------------ test */

const TEST_ID = 'ks-connection-test'

/** Proves, step by step, that a share page made now would work and would be counted. */
async function test () {
  const sb = databases.supabaseCtx()
  const key = `share/${TEST_ID}/check.json`
  const result = await runSteps([
    ['Supabase connection', async () => {
      if (!sb.ready) throw new DbError('Connect Supabase above first: project address and key.')
      if (!sb.bucket) throw new DbError('Name a storage bucket above — share pages keep their video in it.')
      return `Using the “${sb.bucket}” bucket.`
    }],
    ['Store a file anyone can open', async () => {
      const url = await putBytes(sb, key, Buffer.from(JSON.stringify({ ok: true, at: Date.now() })), 'application/json', 'max-age=0')
      let res
      try { res = await fetch(`${url}?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) }) } catch (e) { throw new DbError(`The file was stored but could not be opened: ${e.message}`) }
      if (!res.ok) throw new DbError(`The file was stored, but it cannot be opened without signing in (HTTP ${res.status}). Open the “${sb.bucket}” bucket in Supabase → Storage and switch on “Public bucket”.`)
      return 'Stored and opened without signing in.'
    }],
    ['Count a view', async () => {
      if (!sb.anonKey) throw new DbError('Paste the public key (called “anon” or “publishable”) above. Share pages work without it, but views cannot be counted.')
      const session = `test-${Date.now()}`
      const res = await sb.call('POST', `${sb.base}/rest/v1/rpc/ks_record_view`, {
        headers: { apikey: sb.anonKey, Authorization: `Bearer ${sb.anonKey}` },
        body: { p_video: TEST_ID, p_session: session, p_seconds: 30, p_duration: 60 }
      })
      if (!res.ok) throw countProblem(res)
      return 'A test view was counted using the public key.'
    }],
    ['Read the numbers back', async () => {
      const s = await stats(TEST_ID)
      if (s.views < 1) throw new DbError('The view was sent but did not show up in the totals.')
      return `${s.views} view, ${Math.round(s.avgPercent)}% watched.`
    }],
    ['Check the public key is safe to publish', async () => {
      // The public key appears on every share page. It must not be able to read the views.
      const res = await sb.call('GET', `${sb.base}/rest/v1/video_views?select=id&limit=1`, {
        headers: { apikey: sb.anonKey, Authorization: `Bearer ${sb.anonKey}` }
      })
      if (res.ok && Array.isArray(res.json) && res.json.length) {
        throw new DbError('The public key can read the list of views. Run the table setup again in the SQL Editor — it locks the table so only this app can read it.')
      }
      const table = (prefs.read().databases?.supabase?.table || 'videos').trim()
      const vids = await sb.call('GET', `${sb.base}/rest/v1/${table}?select=id&limit=1`, {
        headers: { apikey: sb.anonKey, Authorization: `Bearer ${sb.anonKey}` }
      })
      if (vids.ok && Array.isArray(vids.json) && vids.json.length) {
        throw new DbError(`The public key can read your “${table}” table, so anyone with a share link could too. Run the table setup again in the SQL Editor — it locks the table so only this app can read it.`)
      }
      return 'It can add to the count and nothing else.'
    }],
    ['Remove the test', async () => {
      await sb.call('DELETE', `${sb.base}/rest/v1/video_views?video=eq.${TEST_ID}`, { headers: sb.headers() })
      await removeObjects(sb, [key])
      return 'Removed.'
    }],
    ['Open the share page', async () => {
      let res
      try { res = await fetch(viewerBase() + '/', { signal: AbortSignal.timeout(20000) }) } catch (e) { throw new DbError(`The share page at ${viewerBase()} could not be reached: ${e.message}`) }
      if (!res.ok) throw new DbError(`The share page at ${viewerBase()} answered HTTP ${res.status}.`)
      return `${viewerBase().replace(/^https?:\/\//, '')} is up.`
    }]
  ])
  prefs.write({ share: { ...(prefs.read().share || {}), tested: result.ok } })
  return result
}

module.exports = { status, save, publish, unpublish, stats, test, linkFor, embedCode, DEFAULT_VIEWER, makePoster, makeSmaller, viewerBase }
