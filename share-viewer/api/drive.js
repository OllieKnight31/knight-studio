// Reads a share page's small files out of Google Drive on the page's behalf.
//
// Google does not let a web page read a Drive file directly, so the page asks this
// instead. It hands back only two things: a share page's description (must look like
// one, and be small), and small images (its poster and logo). It will not relay videos
// or anything else, so it cannot be used as a way to pull arbitrary files from Drive.
//
//   /api/drive?m=<file id>     the description, as JSON
//   /api/drive?img=<file id>   a poster or logo
const ID = /^[\w-]{10,80}$/
const from = id => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`

async function read (id, limit) {
  const res = await fetch(from(id), { redirect: 'follow', signal: AbortSignal.timeout(15000) })
  if (!res.ok) return { status: res.status === 404 || res.status === 403 ? 404 : 502 }
  const len = Number(res.headers.get('content-length')) || 0
  if (len > limit) return { status: 413 }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > limit) return { status: 413 }
  return { status: 200, buf, type: res.headers.get('content-type') || '' }
}

module.exports = async function handler (req, res) {
  const q = new URL(req.url, 'http://x').searchParams
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  const send = (code, body, type = 'application/json') => { res.statusCode = code; res.setHeader('Content-Type', type); res.end(body) }
  try {
    const m = q.get('m'); const img = q.get('img')
    if (m && ID.test(m)) {
      const r = await read(m, 600 * 1024)
      if (r.status !== 200) return send(r.status, '{"error":"not found"}')
      let meta
      try { meta = JSON.parse(r.buf.toString('utf8')) } catch { return send(404, '{"error":"not a share page"}') }
      if (!meta || meta.v !== 1 || typeof meta.video !== 'string' || !ID.test(meta.video)) return send(404, '{"error":"not a share page"}')
      res.setHeader('Cache-Control', 'no-store')
      return send(200, JSON.stringify(meta))
    }
    if (img && ID.test(img)) {
      const r = await read(img, 3 * 1024 * 1024)
      if (r.status !== 200) return send(r.status, '{"error":"not found"}')
      // Decide what it is from its first bytes, never from what the file claims to be.
      const b = r.buf
      const type = b[0] === 0xFF && b[1] === 0xD8 ? 'image/jpeg'
        : b.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n' ? 'image/png'
          : b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp'
            : b.subarray(0, 3).toString('latin1') === 'GIF' ? 'image/gif' : null
      if (!type) return send(404, '{"error":"not an image"}')
      res.setHeader('Cache-Control', 'public, max-age=3600')
      return send(200, b, type)
    }
    send(400, '{"error":"bad request"}')
  } catch {
    send(502, '{"error":"could not reach Google Drive"}')
  }
}
