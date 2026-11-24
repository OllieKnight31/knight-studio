'use strict'
/**
 * Database connections: Notion, Airtable and Supabase.
 *
 * Each one can receive a row for every exported video — its title, a link to the
 * video, its length, the folder it is filed in, when it was exported and what was
 * said in it — so a team's videos land in the database they already work from.
 *
 * All three follow the same shape:
 *   save(config)   keep the connection details (keys go in the private store)
 *   test()         prove it end to end, step by step: sign in, find the database,
 *                  make sure it has the right columns, add a row, remove it again
 *   send(record)   add one video
 *
 * Nothing here is given to the window except whether a key exists; the keys never
 * leave the main process once saved.
 */
const fs = require('node:fs')
const path = require('node:path')
const prefs = require('./prefs')
const secrets = require('./secrets')

const NOTION_API = process.env.KS_NOTION_API || 'https://api.notion.com/v1'
const AIRTABLE_API = process.env.KS_AIRTABLE_API || 'https://api.airtable.com/v0'

// The columns every database gets. `key` is the name used in a record; the label is
// what the person sees as a column heading in Notion and Airtable.
const COLUMNS = [
  { key: 'link', label: 'Video link', kind: 'url', sql: 'video_url text' },
  { key: 'minutes', label: 'Length (minutes)', kind: 'number', sql: 'duration_seconds numeric' },
  { key: 'folder', label: 'Folder', kind: 'text', sql: 'folder text' },
  { key: 'fileName', label: 'File name', kind: 'text', sql: 'file_name text' },
  { key: 'exportedAt', label: 'Exported', kind: 'date', sql: 'exported_at timestamptz default now()' },
  { key: 'transcript', label: 'Transcript', kind: 'long', sql: 'transcript text' },
  { key: 'share', label: 'Share page', kind: 'url', sql: 'share_url text' },
  { key: 'summary', label: 'Summary', kind: 'long', sql: 'summary text' },
  { key: 'chapters', label: 'Chapters', kind: 'long', sql: 'chapters text' }
]

// Safe to run again at any time: every statement only adds what is missing.
const SUPABASE_SQL = table => `-- 1. The table every exported video is added to
create table if not exists public.${table} (
  id uuid primary key default gen_random_uuid(),
  title text
);
${COLUMNS.map(c => `alter table public.${table} add column if not exists ${c.sql};`).join('\n')}
-- Only this app (which holds the secret key) can read or change it.
alter table public.${table} enable row level security;

-- 2. Share pages: counts each view and how long it was watched
create table if not exists public.video_views (
  id bigint generated always as identity primary key,
  video text not null,
  session text not null,
  seconds numeric not null default 0,
  duration numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (video, session)
);
alter table public.video_views enable row level security;

-- A share page may add to the count, and nothing else.
create or replace function public.ks_record_view(p_video text, p_session text, p_seconds numeric, p_duration numeric)
returns void language sql security definer set search_path = public as $$
  insert into public.video_views (video, session, seconds, duration)
  values (
    left(p_video, 40), left(p_session, 40),
    greatest(0, least(coalesce(p_seconds, 0), case when coalesce(p_duration, 0) > 0 then p_duration else 86400 end)),
    greatest(0, least(coalesce(p_duration, 0), 86400))
  )
  on conflict (video, session) do update
    set seconds = greatest(public.video_views.seconds, excluded.seconds),
        duration = excluded.duration,
        updated_at = now();
$$;
revoke execute on function public.ks_record_view(text, text, numeric, numeric) from public;
grant execute on function public.ks_record_view(text, text, numeric, numeric) to anon, authenticated, service_role;

-- Only this app may read the totals.
create or replace function public.ks_video_stats(p_video text)
returns table (views bigint, avg_seconds numeric, avg_percent numeric)
language sql security definer set search_path = public as $$
  select count(*),
         coalesce(round(avg(seconds), 1), 0),
         coalesce(round(avg(case when duration > 0 then least(1, seconds / duration) end) * 100, 1), 0)
  from public.video_views where video = p_video;
$$;
revoke execute on function public.ks_video_stats(text) from public, anon, authenticated;
grant execute on function public.ks_video_stats(text) to service_role;

notify pgrst, 'reload schema';`

class DbError extends Error {}

/* ------------------------------------------------------------------- http */

async function call (method, url, { headers = {}, body, raw = false } = {}) {
  let res
  try {
    res = await fetch(url, {
      method,
      headers: body && !raw ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body ? (raw ? body : JSON.stringify(body)) : undefined,
      ...(raw ? { duplex: 'half' } : {}),
      signal: AbortSignal.timeout(raw ? 30 * 60 * 1000 : 30000)
    })
  } catch (e) {
    throw new DbError(e.name === 'TimeoutError' ? 'It took too long to answer.' : `Could not reach it — check the internet connection. (${e.message})`)
  }
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text }
}

/** Runs the steps of a test in order, stopping at the first failure. */
async function runSteps (steps) {
  const out = []
  for (const [name, fn] of steps) {
    try {
      const detail = await fn()
      out.push({ name, ok: true, detail: detail || '' })
    } catch (e) {
      out.push({ name, ok: false, detail: String(e.message || e) })
      break
    }
  }
  return { ok: out.length === steps.length && out.every(s => s.ok), steps: out }
}

const settings = which => (prefs.read().databases || {})[which] || {}
const key = which => secrets.get(`db:${which}`)
const minutes = seconds => Math.round((Number(seconds) || 0) / 6) / 10

/* ------------------------------------------------------------------ notion */

/** A Notion database id from a pasted link, or the id itself. */
function notionId (input) {
  const text = String(input || '').trim()
  const m = /([0-9a-f]{32})(?:[?&#/]|$)/i.exec(text.replace(/-/g, '')) || /([0-9a-f]{32})/i.exec(text.replace(/-/g, ''))
  return m ? m[1].toLowerCase() : null
}

const notionHeaders = () => ({ Authorization: `Bearer ${key('notion')}`, 'Notion-Version': '2022-06-28' })

function notionProblem (res, what) {
  const code = res.json?.code
  if (res.status === 401) return new DbError('Notion does not accept that secret. Copy the “Internal Integration Secret” again.')
  if (res.status === 404 || code === 'object_not_found') {
    return new DbError('Notion cannot see that database. Open it in Notion, press ••• → Connections, and add your integration.')
  }
  return new DbError(`Notion could not ${what}: ${res.json?.message || `HTTP ${res.status}`}`)
}

async function notionDatabase () {
  const id = settings('notion').databaseId
  if (!id) throw new DbError('No Notion database has been chosen yet.')
  const res = await call('GET', `${NOTION_API}/databases/${id}`, { headers: notionHeaders() })
  if (!res.ok) throw notionProblem(res, 'open the database')
  return res.json
}

const notionType = kind => ({ url: { url: {} }, number: { number: { format: 'number' } }, text: { rich_text: {} }, long: { rich_text: {} }, date: { date: {} } })[kind]
const notionKind = kind => ({ url: 'url', number: 'number', text: 'rich_text', long: 'rich_text', date: 'date' })[kind]

/** Adds whichever of our columns the database does not have yet. */
async function notionColumns (db) {
  const missing = {}
  for (const c of COLUMNS) {
    const have = db.properties?.[c.label]
    if (!have) missing[c.label] = notionType(c.kind)
    else if (have.type !== notionKind(c.kind)) {
      throw new DbError(`The “${c.label}” column in Notion is the wrong type (${have.type}). Rename or delete it and test again — the right one is created for you.`)
    }
  }
  const names = Object.keys(missing)
  if (!names.length) return 'All the columns are there.'
  const res = await call('PATCH', `${NOTION_API}/databases/${db.id}`, { headers: notionHeaders(), body: { properties: missing } })
  if (!res.ok) throw notionProblem(res, 'add the columns')
  return `Added: ${names.join(', ')}.`
}

const notionText = text => [{ type: 'text', text: { content: String(text || '').slice(0, 1900) } }]

async function notionAdd (record, db) {
  const titleProp = Object.entries(db.properties || {}).find(([, p]) => p.type === 'title')?.[0] || 'Name'
  const properties = {
    [titleProp]: { title: notionText(record.title) },
    'Length (minutes)': { number: minutes(record.durationSeconds) },
    Exported: { date: { start: record.exportedAt } }
  }
  if (record.link) properties['Video link'] = { url: record.link }
  if (record.folder) properties.Folder = { rich_text: notionText(record.folder) }
  if (record.fileName) properties['File name'] = { rich_text: notionText(record.fileName) }
  if (record.transcript) properties.Transcript = { rich_text: notionText(record.transcript) }
  if (record.share) properties['Share page'] = { url: record.share }
  if (record.summary) properties.Summary = { rich_text: notionText(record.summary) }
  if (record.chapters) properties.Chapters = { rich_text: notionText(record.chapters) }

  // The whole transcript goes in the page body, in pieces Notion will accept.
  const children = []
  const words = String(record.transcript || '')
  for (let i = 0; i < words.length && children.length < 90; i += 1900) {
    children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: notionText(words.slice(i, i + 1900)) } })
  }
  const res = await call('POST', `${NOTION_API}/pages`, {
    headers: notionHeaders(),
    body: { parent: { database_id: db.id }, properties, ...(children.length ? { children } : {}) }
  })
  if (!res.ok) throw notionProblem(res, 'add the video')
  return { id: res.json.id, url: res.json.url }
}

const notion = {
  async test () {
    let db = null
    let page = null
    return runSteps([
      ['Sign in to Notion', async () => {
        if (!key('notion')) throw new DbError('No integration secret has been saved yet.')
        const res = await call('GET', `${NOTION_API}/users/me`, { headers: notionHeaders() })
        if (!res.ok) throw notionProblem(res, 'sign in')
        return `Signed in as the “${res.json?.name || 'unnamed'}” integration.`
      }],
      ['Find the database', async () => {
        db = await notionDatabase()
        const title = (db.title || []).map(t => t.plain_text).join('') || 'Untitled'
        prefs.write({ databases: { ...prefs.read().databases, notion: { ...settings('notion'), databaseName: title } } })
        return `“${title}” is there.`
      }],
      ['Check its columns', async () => notionColumns(db)],
      ['Add a test video', async () => {
        db = await notionDatabase()
        page = await notionAdd(testRecord(), db)
        return 'Added.'
      }],
      ['Remove the test video', async () => {
        const res = await call('PATCH', `${NOTION_API}/pages/${page.id}`, { headers: notionHeaders(), body: { archived: true } })
        if (!res.ok) throw notionProblem(res, 'remove the test row')
        return 'Nothing was left behind.'
      }]
    ])
  },
  async send (record) {
    const db = await notionDatabase()
    await notionColumns(db)
    const page = await notionAdd(record, await notionDatabase())
    return { id: page.id, url: page.url, where: settings('notion').databaseName || 'Notion' }
  }
}

/* ---------------------------------------------------------------- airtable */

/** Base and table from a pasted Airtable link: airtable.com/appXXXX/tblYYYY/… */
function airtableIds (input) {
  const text = String(input || '')
  return { baseId: (/(app[A-Za-z0-9]{14})/.exec(text) || [])[1] || null, tableId: (/(tbl[A-Za-z0-9]{14})/.exec(text) || [])[1] || null }
}

const airtableHeaders = () => ({ Authorization: `Bearer ${key('airtable')}` })

function airtableProblem (res, what) {
  const err = res.json?.error
  const type = typeof err === 'string' ? err : err?.type
  if (res.status === 401) return new DbError('Airtable does not accept that token. Create a new personal access token and paste it again.')
  if (res.status === 403 || type === 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND') {
    return new DbError('The token cannot reach that base. Edit the token in Airtable and add this base under “Access”, with the scopes in the guide.')
  }
  if (res.status === 404) return new DbError('Airtable cannot find that base or table. Paste the link from your browser’s address bar while the table is open.')
  return new DbError(`Airtable could not ${what}: ${err?.message || type || `HTTP ${res.status}`}`)
}

async function airtableTable () {
  const { baseId, table } = settings('airtable')
  if (!baseId || !table) throw new DbError('No Airtable table has been chosen yet.')
  const res = await call('GET', `${AIRTABLE_API}/meta/bases/${baseId}/tables`, { headers: airtableHeaders() })
  if (!res.ok) throw airtableProblem(res, 'read the base')
  const found = (res.json.tables || []).find(t => t.id === table || t.name === table)
  if (!found) throw new DbError(`There is no table called “${table}” in that base.`)
  return found
}

const airtableField = c => ({
  url: { type: 'url' },
  number: { type: 'number', options: { precision: 1 } },
  text: { type: 'singleLineText' },
  long: { type: 'multilineText' },
  date: { type: 'dateTime', options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'client' } }
})[c.kind]

async function airtableColumns (table) {
  const { baseId } = settings('airtable')
  const have = new Set((table.fields || []).map(f => f.name))
  const added = []
  for (const c of COLUMNS) {
    if (have.has(c.label)) continue
    const res = await call('POST', `${AIRTABLE_API}/meta/bases/${baseId}/tables/${table.id}/fields`, {
      headers: airtableHeaders(), body: { name: c.label, ...airtableField(c) }
    })
    if (!res.ok) {
      if (res.status === 403 || res.status === 401) {
        throw new DbError(`The table is missing the “${c.label}” column and the token is not allowed to add it. Add the scope “schema.bases:write” to the token, or add the columns yourself: ${COLUMNS.map(x => x.label).join(', ')}.`)
      }
      throw airtableProblem(res, `add the “${c.label}” column`)
    }
    added.push(c.label)
  }
  return added.length ? `Added: ${added.join(', ')}.` : 'All the columns are there.'
}

async function airtableAdd (record, table) {
  const { baseId } = settings('airtable')
  const primary = (table.fields || []).find(f => f.id === table.primaryFieldId)?.name || 'Name'
  const fields = {
    [primary]: record.title,
    'Length (minutes)': minutes(record.durationSeconds),
    Exported: record.exportedAt
  }
  if (record.link) fields['Video link'] = record.link
  if (record.folder) fields.Folder = record.folder
  if (record.fileName) fields['File name'] = record.fileName
  if (record.transcript) fields.Transcript = String(record.transcript).slice(0, 95000)
  if (record.share) fields['Share page'] = record.share
  if (record.summary) fields.Summary = record.summary
  if (record.chapters) fields.Chapters = record.chapters
  const res = await call('POST', `${AIRTABLE_API}/${baseId}/${table.id}`, { headers: airtableHeaders(), body: { records: [{ fields }], typecast: true } })
  if (!res.ok) throw airtableProblem(res, 'add the video')
  return res.json.records[0].id
}

const airtable = {
  async test () {
    let table = null
    let id = null
    return runSteps([
      ['Sign in to Airtable', async () => {
        if (!key('airtable')) throw new DbError('No access token has been saved yet.')
        const res = await call('GET', `${AIRTABLE_API}/meta/whoami`, { headers: airtableHeaders() })
        if (!res.ok) throw airtableProblem(res, 'sign in')
        return res.json?.email ? `Signed in as ${res.json.email}.` : 'Token accepted.'
      }],
      ['Find the table', async () => {
        table = await airtableTable()
        prefs.write({ databases: { ...prefs.read().databases, airtable: { ...settings('airtable'), tableName: table.name } } })
        return `“${table.name}” is there.`
      }],
      ['Check its columns', async () => airtableColumns(table)],
      ['Add a test video', async () => {
        table = await airtableTable()
        id = await airtableAdd(testRecord(), table)
        return 'Added.'
      }],
      ['Remove the test video', async () => {
        const res = await call('DELETE', `${AIRTABLE_API}/${settings('airtable').baseId}/${table.id}/${id}`, { headers: airtableHeaders() })
        if (!res.ok) throw airtableProblem(res, 'remove the test row')
        return 'Nothing was left behind.'
      }]
    ])
  },
  async send (record) {
    let table = await airtableTable()
    await airtableColumns(table)
    table = await airtableTable()
    const id = await airtableAdd(record, table)
    const s = settings('airtable')
    return { id, url: `https://airtable.com/${s.baseId}/${table.id}/${id}`, where: table.name }
  }
}

/* ---------------------------------------------------------------- supabase */

const supabaseBase = () => String(settings('supabase').url || '').trim().replace(/\/+$/, '')
const supabaseHeaders = extra => ({ apikey: key('supabase'), Authorization: `Bearer ${key('supabase')}`, ...extra })
const supabaseTable = () => (settings('supabase').table || 'videos').trim()

function supabaseProblem (res, what) {
  const msg = res.json?.message || res.json?.error || res.json?.msg || ''
  if (res.status === 401 || /invalid api key|jwt/i.test(msg)) return new DbError('Supabase does not accept that key. Copy the “service_role” key again from Project Settings → API.')
  if (res.status === 404 || res.json?.code === 'PGRST205' || res.json?.code === '42P01') {
    return new DbError(`There is no “${supabaseTable()}” table yet. Press “Copy the table setup”, paste it into Supabase → SQL Editor, run it, and test again.`)
  }
  if (res.json?.code === 'PGRST204' || res.json?.code === '42703') {
    return new DbError(`The “${supabaseTable()}” table is missing a column (${msg}). Run the table setup again in the SQL Editor — it only adds what is missing.`)
  }
  if (res.status === 403 || res.json?.code === '42501') {
    return new DbError('The key is not allowed to write to that table. Use the “service_role” key, which is kept only on this Mac.')
  }
  return new DbError(`Supabase could not ${what}: ${msg || `HTTP ${res.status}`}`)
}

function supabaseRow (record) {
  return {
    title: record.title,
    video_url: record.link || null,
    duration_seconds: Math.round((Number(record.durationSeconds) || 0) * 10) / 10,
    folder: record.folder || null,
    file_name: record.fileName || null,
    exported_at: record.exportedAt,
    transcript: record.transcript || null,
    share_url: record.share || null,
    summary: record.summary || null,
    chapters: record.chapters || null
  }
}

async function supabaseInsert (record) {
  const res = await call('POST', `${supabaseBase()}/rest/v1/${supabaseTable()}`, {
    headers: supabaseHeaders({ Prefer: 'return=representation' }), body: supabaseRow(record)
  })
  if (!res.ok) throw supabaseProblem(res, 'add the video')
  return res.json?.[0] || {}
}

/** Uploads the video file itself to a storage bucket and returns its address. */
async function supabaseUpload (filePath, name) {
  const bucket = (settings('supabase').bucket || '').trim()
  if (!bucket) throw new DbError('No storage bucket has been named.')
  const safe = `${Date.now()}-${String(name || path.basename(filePath)).replace(/[^\w.-]+/g, '-')}`
  const size = fs.statSync(filePath).size
  const res = await call('POST', `${supabaseBase()}/storage/v1/object/${encodeURIComponent(bucket)}/${safe}`, {
    headers: supabaseHeaders({ 'Content-Type': 'video/mp4', 'Content-Length': String(size), 'x-upsert': 'true' }),
    body: require('node:stream').Readable.toWeb(fs.createReadStream(filePath)),
    raw: true
  })
  if (!res.ok) {
    const msg = res.json?.message || res.json?.error || `HTTP ${res.status}`
    if (res.status === 404 || /bucket not found/i.test(msg)) throw new DbError(`There is no storage bucket called “${bucket}”. Create it in Supabase → Storage and make it public.`)
    if (res.status === 413 || /exceeded the maximum allowed size/i.test(msg)) throw new DbError('The video is larger than this Supabase project allows for one file. Raise the limit under Storage → Settings, or switch the upload off and store the Google Drive link instead.')
    throw new DbError(`Supabase could not store the video file: ${msg}`)
  }
  return `${supabaseBase()}/storage/v1/object/public/${encodeURIComponent(bucket)}/${safe}`
}

const supabase = {
  sql: () => SUPABASE_SQL(supabaseTable()),
  async test () {
    let row = null
    return runSteps([
      ['Reach the project', async () => {
        if (!/^https:\/\/.+/.test(supabaseBase()) && !/^http:\/\/127\.0\.0\.1/.test(supabaseBase())) throw new DbError('The project address should look like https://abcdefgh.supabase.co')
        if (!key('supabase')) throw new DbError('No key has been saved yet.')
        const res = await call('GET', `${supabaseBase()}/rest/v1/`, { headers: supabaseHeaders() })
        if (res.status === 401) throw supabaseProblem(res, 'sign in')
        if (!res.ok && res.status !== 404) throw supabaseProblem(res, 'reach the project')
        return 'The project answered and accepted the key.'
      }],
      ['Find the table', async () => {
        const res = await call('GET', `${supabaseBase()}/rest/v1/${supabaseTable()}?select=id,title,${COLUMNS.map(c => c.sql.split(' ')[0]).join(',')}&limit=1`, { headers: supabaseHeaders() })
        if (!res.ok) throw supabaseProblem(res, 'open the table')
        return `“${supabaseTable()}” is there.`
      }],
      ['Add a test video', async () => {
        row = await supabaseInsert(testRecord())
        if (!row.id) throw new DbError('The row was added but Supabase did not hand it back, so it cannot be checked. Use the table setup provided, which includes an “id” column.')
        return 'Added — every column was accepted.'
      }],
      ['Remove the test video', async () => {
        const res = await call('DELETE', `${supabaseBase()}/rest/v1/${supabaseTable()}?id=eq.${encodeURIComponent(row.id)}`, { headers: supabaseHeaders() })
        if (!res.ok) throw supabaseProblem(res, 'remove the test row')
        return 'Nothing was left behind.'
      }],
      ...(settings('supabase').upload
        ? [['Check the storage bucket', async () => {
            const bucket = (settings('supabase').bucket || '').trim()
            if (!bucket) throw new DbError('“Store the video file too” is on, but no bucket is named.')
            const res = await call('GET', `${supabaseBase()}/storage/v1/bucket/${encodeURIComponent(bucket)}`, { headers: supabaseHeaders() })
            if (!res.ok) throw new DbError(`There is no storage bucket called “${bucket}”. Create it in Supabase → Storage and make it public.`)
            return res.json?.public ? `“${bucket}” is there and public.` : `“${bucket}” is there, but it is private — links to videos in it will not open for other people.`
          }]]
        : [])
    ])
  },
  async send (record, filePath) {
    let stored = null
    if (settings('supabase').upload && filePath) stored = await supabaseUpload(filePath, record.fileName)
    const row = await supabaseInsert({ ...record, link: stored || record.link })
    return { id: row.id, url: stored || null, where: supabaseTable(), stored: !!stored }
  }
}

/* ------------------------------------------------------------------ shared */

const CONNECTORS = { notion, airtable, supabase }
const NAMES = { notion: 'Notion', airtable: 'Airtable', supabase: 'Supabase' }

function testRecord () {
  return {
    title: 'Connection test — safe to delete',
    link: 'https://example.com/connection-test',
    durationSeconds: 90,
    folder: 'Connection test',
    fileName: 'connection-test.mp4',
    exportedAt: new Date().toISOString(),
    transcript: 'This row was added by the connection test and is removed straight away.'
  }
}

function isConfigured (which) {
  const s = settings(which)
  if (!key(which)) return false
  if (which === 'notion') return !!s.databaseId
  if (which === 'airtable') return !!(s.baseId && s.table)
  return !!s.url
}

/** What Settings shows. Keys are reported only as present or absent. */
function status () {
  const out = {}
  for (const which of Object.keys(CONNECTORS)) {
    const s = settings(which)
    out[which] = { ...s, hasKey: !!key(which), configured: isConfigured(which), auto: s.auto !== false }
  }
  out.supabase.sql = SUPABASE_SQL((out.supabase.table || 'videos').trim())
  return out
}

/** Saves one connection. An empty key field leaves the saved key alone. */
function save (which, config = {}) {
  if (!CONNECTORS[which]) throw new DbError('Unknown database.')
  const secret = String(config.key || '').trim()
  if (secret) secrets.set(`db:${which}`, secret)
  const cur = settings(which)
  let next = { ...cur }
  if (which === 'notion') {
    if (config.database !== undefined) {
      const id = notionId(config.database)
      if (config.database && !id) throw new DbError('That does not look like a Notion database link. Open the database as a full page and copy the link from your browser.')
      next = { ...next, databaseId: id, databaseName: id === cur.databaseId ? cur.databaseName : null }
    }
  } else if (which === 'airtable') {
    if (config.link !== undefined) {
      const ids = airtableIds(config.link)
      if (config.link && !ids.baseId) throw new DbError('That does not look like an Airtable link. Open the table and copy the address from your browser — it contains “app…” and “tbl…”.')
      next = { ...next, baseId: ids.baseId, table: ids.tableId || String(config.table || cur.table || '').trim() || null, tableName: null }
    }
    if (config.table) next.table = String(config.table).trim()
  } else {
    if (config.url !== undefined) next.url = String(config.url || '').trim().replace(/\/+$/, '')
    if (config.table !== undefined) {
      const t = String(config.table || 'videos').trim()
      if (!/^[a-z_][a-z0-9_]*$/i.test(t)) throw new DbError('A table name can only use letters, numbers and underscores.')
      next.table = t
    }
    if (config.bucket !== undefined) next.bucket = String(config.bucket || '').trim()
    if (config.upload !== undefined) next.upload = !!config.upload
    // The public ("anon") key. It is published on share pages by design, so it lives
    // with the settings rather than with the secrets.
    if (config.anonKey !== undefined) next.anonKey = String(config.anonKey || '').trim() || null
  }
  if (config.auto !== undefined) next.auto = !!config.auto
  // New details have not been proven yet.
  const changed = secret || ['database', 'link', 'table', 'url', 'bucket', 'upload', 'anonKey'].some(k => config[k] !== undefined)
  if (changed) next.tested = false
  prefs.write({ databases: { ...prefs.read().databases, [which]: next } })
  return status()
}

function disconnect (which) {
  secrets.set(`db:${which}`, null)
  const all = { ...prefs.read().databases }
  delete all[which]
  prefs.write({ databases: all })
  return status()
}

async function test (which) {
  if (!CONNECTORS[which]) return { ok: false, steps: [{ name: 'Test', ok: false, detail: 'Unknown database.' }] }
  const result = await CONNECTORS[which].test()
  // Remember whether it has ever been proven to work, so Settings can say "connected"
  // only when that is true rather than merely filled in.
  prefs.write({ databases: { ...prefs.read().databases, [which]: { ...settings(which), tested: result.ok } } })
  return result
}

/**
 * Adds a video to every connected database that has "add every export" on (or to
 * the ones named). One failing never stops the others; each reports for itself.
 */
async function send (record, { filePath = null, only = null } = {}) {
  const results = []
  for (const which of Object.keys(CONNECTORS)) {
    if (only ? !only.includes(which) : !(isConfigured(which) && settings(which).auto !== false)) continue
    try {
      const r = await CONNECTORS[which].send(record, filePath)
      results.push({ which, name: NAMES[which], ok: true, ...r })
    } catch (e) {
      results.push({ which, name: NAMES[which], ok: false, detail: String(e.message || e) })
    }
  }
  return results
}

/** What the share pages need from the Supabase connection. */
const supabaseCtx = () => ({
  base: supabaseBase(),
  headers: supabaseHeaders,
  bucket: (settings('supabase').bucket || '').trim(),
  anonKey: settings('supabase').anonKey || null,
  ready: isConfigured('supabase'),
  call
})

module.exports = { status, save, disconnect, test, send, isConfigured, notionId, airtableIds, COLUMNS, NAMES, supabaseCtx, runSteps, DbError }
