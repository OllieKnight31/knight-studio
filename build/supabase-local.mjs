// A local Supabase, close enough to prove share pages and view counting.
//
// The database half is the real thing: a throwaway Postgres with the same roles
// Supabase creates (anon, authenticated, service_role), fronted by PostgREST — the same
// server Supabase runs — checking the same kind of signed keys. So the table setup the
// app hands people is really executed, and "can the public key read this table?" gets
// a real answer rather than an assumed one.
//
// The storage half is a small imitation: it stores files, serves public buckets to
// anyone (with byte ranges, so video can seek) and refuses the things Supabase refuses.
//
// Needs:  brew install postgresql@17 postgrest
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'

const PG = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin'].find(d => fs.existsSync(path.join(d, 'initdb')))
const POSTGREST = ['/opt/homebrew/bin/postgrest', '/usr/local/bin/postgrest'].find(p => fs.existsSync(p))
export const available = () => !!(PG && POSTGREST)

const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const b64 = v => Buffer.from(v).toString('base64url')
const sign = (payload, secret) => {
  const head = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}`
  return `${head}.${crypto.createHmac('sha256', secret).update(head).digest('base64url')}`
}
const roleOf = (token, secret) => {
  const [h, p, sig] = String(token || '').split('.')
  if (!sig || crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url') !== sig) return null
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).role || null } catch { return null }
}
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { try { if (await fn()) return } catch {} if (Date.now() > end) throw new Error('timed out starting the local database'); await new Promise(r => setTimeout(r, 150)) } }

export async function startSupabase ({ fileLimit = 50 * 1024 * 1024 } = {}) {
  if (!available()) throw new Error('postgresql@17 and postgrest are not installed (brew install postgresql@17 postgrest)')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-sb-'))
  const data = path.join(dir, 'pg')
  const files = path.join(dir, 'storage')
  fs.mkdirSync(files)
  const secret = crypto.randomBytes(32).toString('hex')
  const pgPort = await freePort()
  const restPort = await freePort()
  const env = { ...process.env, LC_ALL: 'C' }

  execFileSync(path.join(PG, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-sync'], { env, stdio: 'ignore' })
  const pg = spawn(path.join(PG, 'postgres'), ['-D', data, '-p', String(pgPort), '-c', 'listen_addresses=127.0.0.1', '-c', `unix_socket_directories=${dir}`, '-c', 'fsync=off'], { env, stdio: 'ignore' })
  const psql = (sql, { quiet = false } = {}) => execFileSync(path.join(PG, 'psql'), ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', sql], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'] })
  await waitFor(() => { psql('select 1', { quiet: true }); return true })

  // The roles and default permissions a fresh Supabase project has. Note that tables
  // are readable by `anon` unless row level security is switched on — exactly the trap
  // the app's table setup has to close.
  psql(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create role authenticator noinherit login password 'x';
    grant anon, authenticated, service_role to authenticator;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    -- What Supabase Auth provides to SQL: who is asking.
    create schema auth;
    grant usage on schema auth to anon, authenticated, service_role;
    create function auth.jwt() returns jsonb language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
    create function auth.uid() returns uuid language sql stable as $f$ select nullif(auth.jwt() ->> 'sub', '')::uuid $f$;
  `)

  const rest = spawn(POSTGREST, [], {
    env: {
      ...env,
      PGRST_DB_URI: `postgres://authenticator:x@127.0.0.1:${pgPort}/postgres`,
      PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: secret,
      PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(restPort), PGRST_DB_CHANNEL_ENABLED: 'true', PGRST_LOG_LEVEL: 'crit'
    },
    stdio: 'ignore'
  })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${restPort}/`)).status < 500)

  const anonKey = sign({ role: 'anon', iss: 'supabase', exp: 4102444800 }, secret)
  const serviceKey = sign({ role: 'service_role', iss: 'supabase', exp: 4102444800 }, secret)
  const buckets = new Map()     // name -> { public }
  // Sign-in by emailed code, the way Supabase Auth does it. Codes are kept where a
  // check can read them, standing in for the person opening their email.
  const users = new Map()       // email -> { id }
  const codes = new Map()       // email -> code
  const refresh = new Map()     // refresh token -> email
  const sessionFor = email => {
    if (!users.has(email)) users.set(email, { id: crypto.randomUUID() })
    const user = users.get(email)
    const token = crypto.randomBytes(18).toString('hex')
    refresh.set(token, email)
    return {
      access_token: sign({ sub: user.id, email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + accessTtl }, secret),
      token_type: 'bearer', expires_in: accessTtl, expires_at: Math.floor(Date.now() / 1000) + accessTtl, refresh_token: token,
      user: { id: user.id, email, aud: 'authenticated', role: 'authenticated' }
    }
  }
  const claimsOf = token => { try { const [h, p, sig] = String(token || '').split('.'); if (crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url') !== sig) return null; const c = JSON.parse(Buffer.from(p, 'base64url').toString()); return c.exp && c.exp < Date.now() / 1000 ? null : c } catch { return null } }
  let accessTtl = 3600
  const requests = []

  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges', 'Access-Control-Allow-Private-Network': 'true' }
  const types = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const reply = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors, ...headers }); res.end(body === null ? '' : JSON.stringify(body)) }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
    requests.push(`${req.method} ${u.pathname}`)

    // ---- a public file: no key needed, byte ranges honoured
    const pub = /^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/.exec(u.pathname)
    if (pub && (req.method === 'GET' || req.method === 'HEAD')) {
      const bucket = buckets.get(decodeURIComponent(pub[1]))
      if (!bucket || !bucket.public) return reply(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' })
      const file = path.join(files, decodeURIComponent(pub[1]), decodeURIComponent(pub[2]))
      if (!file.startsWith(files) || !fs.existsSync(file)) return reply(400, { statusCode: '404', error: 'not_found', message: 'Object not found' })
      const size = fs.statSync(file).size
      const type = types[path.extname(file)] || 'application/octet-stream'
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
      if (range) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
        res.writeHead(206, { ...cors, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
        return req.method === 'HEAD' ? res.end() : fs.createReadStream(file, { start, end }).pipe(res)
      }
      res.writeHead(200, { ...cors, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size })
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res)
    }

    // Everything else goes through the gateway, which wants a valid key.
    const keyRole = roleOf(req.headers.apikey, secret)
    if (!keyRole) return reply(401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' })
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '')
    const claims = claimsOf(bearer)
    const role = claims?.role || keyRole

    // ---- sign-in
    if (u.pathname.startsWith('/auth/v1/')) {
      const chunks = []
      for await (const c of req) chunks.push(c)
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch {}
      const email = String(body.email || '').trim().toLowerCase()
      if (u.pathname === '/auth/v1/otp' && req.method === 'POST') {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply(400, { code: 400, error_code: 'validation_failed', msg: 'Unable to validate email address: invalid format' })
        codes.set(email, String(crypto.randomInt(100000, 1000000)))
        return reply(200, {})
      }
      if (u.pathname === '/auth/v1/verify' && req.method === 'POST') {
        if (!codes.has(email) || codes.get(email) !== String(body.token || '').trim()) return reply(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' })
        codes.delete(email)
        return reply(200, sessionFor(email))
      }
      if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token' && req.method === 'POST') {
        const who = refresh.get(body.refresh_token)
        if (!who) return reply(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' })
        refresh.delete(body.refresh_token)
        return reply(200, sessionFor(who))
      }
      if (u.pathname === '/auth/v1/user' && req.method === 'GET') return claims?.sub ? reply(200, { id: claims.sub, email: claims.email }) : reply(401, { code: 401, msg: 'invalid JWT' })
      if (u.pathname === '/auth/v1/logout') return reply(204, null)
      return reply(404, { msg: 'not found' })
    }
    // A signed-in person's key that has expired is refused, as the real gateway does.
    if (bearer && bearer !== req.headers.apikey && !claims) return reply(401, { code: 'PGRST301', message: 'JWT expired' })

    // ---- database: handed to the real PostgREST
    if (u.pathname.startsWith('/rest/v1')) {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const headers = { Authorization: `Bearer ${sign(claims?.sub ? { role, sub: claims.sub, email: claims.email } : { role }, secret)}` }
      for (const h of ['content-type', 'prefer', 'accept', 'range']) if (req.headers[h]) headers[h] = req.headers[h]
      const out = await fetch(`http://127.0.0.1:${restPort}${u.pathname.slice(8) || '/'}${u.search}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) })
      const text = await out.text()
      res.writeHead(out.status, { 'Content-Type': out.headers.get('content-type') || 'application/json', ...cors })
      return res.end(text)
    }

    // ---- storage
    const info = /^\/storage\/v1\/bucket\/([^/]+)$/.exec(u.pathname)
    if (info && req.method === 'GET') {
      if (role !== 'service_role') return reply(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' })
      const b = buckets.get(decodeURIComponent(info[1]))
      return b ? reply(200, { id: decodeURIComponent(info[1]), name: decodeURIComponent(info[1]), public: b.public }) : reply(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' })
    }
    const obj = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(u.pathname)
    if (obj && (req.method === 'POST' || req.method === 'PUT')) {
      const name = decodeURIComponent(obj[1])
      if (!buckets.has(name)) return reply(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' })
      if (role !== 'service_role') {
        // The storage rule from cloud/schema.sql: a signed-in team member, inside their own workspace's folder.
        let mine = []
        if (claims?.sub) { try { mine = await (await fetch(`http://127.0.0.1:${restPort}/rpc/ks_my_workspaces`, { method: 'POST', headers: { Authorization: `Bearer ${sign({ role: 'authenticated', sub: claims.sub, email: claims.email }, secret)}`, 'Content-Type': 'application/json' }, body: '{}' })).json() } catch {} }
        if (!Array.isArray(mine) || !mine.includes(decodeURIComponent(obj[2]).split('/')[0])) return reply(400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' })
      }
      if (Number(req.headers['content-length']) > fileLimit) { req.resume(); return reply(413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' }) }
      const file = path.join(files, name, decodeURIComponent(obj[2]))
      if (!file.startsWith(files)) return reply(400, { message: 'bad key' })
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const out = fs.createWriteStream(file)
      let got = 0
      for await (const c of req) { got += c.length; if (got > fileLimit) { out.destroy(); fs.rmSync(file, { force: true }); return reply(413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' }) } out.write(c) }
      await new Promise(r => out.end(r))
      return reply(200, { Key: `${name}/${decodeURIComponent(obj[2])}`, Id: crypto.randomUUID() })
    }
    const del = /^\/storage\/v1\/object\/([^/]+)$/.exec(u.pathname)
    if (del && req.method === 'DELETE') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      const gone = []
      let own = null
      if (role !== 'service_role') { try { own = claims?.sub ? await (await fetch(`http://127.0.0.1:${restPort}/rpc/ks_my_workspaces`, { method: 'POST', headers: { Authorization: `Bearer ${sign({ role: 'authenticated', sub: claims.sub, email: claims.email }, secret)}`, 'Content-Type': 'application/json' }, body: '{}' })).json() : [] } catch { own = [] } }
      for (const k of body.prefixes || []) { if (own && !own.includes(String(k).split('/')[0])) continue; const f = path.join(files, decodeURIComponent(del[1]), k); if (f.startsWith(files) && fs.existsSync(f)) { fs.rmSync(f); gone.push({ name: k }) } }
      return reply(200, gone)
    }
    reply(404, { message: `the local Supabase has no answer for ${req.method} ${u.pathname}` })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))

  const list = (d = files, out = []) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) list(p, out); else out.push(path.relative(files, p)) } return out }
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    anonKey,
    serviceKey,
    requests,
    /** What a person does in the SQL Editor. */
    sql: text => psql(text),
    createBucket: (name, isPublic = true) => { buckets.set(name, { public: isPublic }); fs.mkdirSync(path.join(files, name), { recursive: true }) },
    setPublic: (name, isPublic) => { buckets.get(name).public = isPublic },
    setFileLimit: n => { fileLimit = n },
    /** The code "emailed" to someone who asked to sign in. */
    codeFor: email => codes.get(String(email).toLowerCase()) || null,
    /** How long a sign-in lasts before it must be renewed (seconds). */
    setAccessTtl: n => { accessTtl = n },
    files: () => list(),
    close: async () => {
      server.close()
      rest.kill('SIGTERM')
      pg.kill('SIGINT')
      await new Promise(r => { pg.once('exit', r); setTimeout(r, 4000) })
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}
