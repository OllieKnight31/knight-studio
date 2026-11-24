// A stand-in for Notion, Airtable and Supabase: answers the requests the app makes,
// including the services' error replies. Used by build/db-check.mjs and the UI sweep,
// so the database connections can be exercised without an account on any of them.
//
//   const mock = await startMock()
//   mock.base    http://127.0.0.1:<port>   (Notion at /notion, Airtable at /airtable, Supabase at /supabase)
//   mock.state   what the stand-in currently holds — flip flags here to provoke errors
//   mock.close()
//
// Accepted keys: "notion-good", "at-good", "sb-good". Anything else is rejected.
import http from 'node:http'

export async function startMock () {
  const state = {
    notion: { properties: { Name: { type: 'title' } }, pages: [], shared: true },
    airtable: { fields: [{ id: 'fld1', name: 'Name' }], records: [], canWriteSchema: true },
    supabase: { table: false, rows: [], files: [], bucket: true }
  }
  const seen = []

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks)
    let body = null
    try { body = JSON.parse(raw.toString() || 'null') } catch {}
    const u = new URL(req.url, 'http://x')
    const reply = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)) }
    const auth = req.headers.authorization || ''
    seen.push(`${req.method} ${u.pathname}`)

    // ---- Notion
    if (u.pathname.startsWith('/notion/')) {
      if (auth !== 'Bearer notion-good') return reply(401, { code: 'unauthorized', message: 'API token is invalid.' })
      if (req.headers['notion-version'] !== '2022-06-28') return reply(400, { message: 'missing version' })
      const p = u.pathname.slice(7)
      if (p === '/users/me') return reply(200, { name: 'Knight Studio', type: 'bot' })
      const db = /^\/databases\/([0-9a-f]{32})$/.exec(p)
      if (db) {
        if (!state.notion.shared) return reply(404, { code: 'object_not_found', message: 'Could not find database.' })
        if (req.method === 'PATCH') for (const [k, v] of Object.entries(body.properties)) state.notion.properties[k] = { type: Object.keys(v)[0] }
        return reply(200, { id: db[1], title: [{ plain_text: 'Videos' }], properties: state.notion.properties })
      }
      if (p === '/pages' && req.method === 'POST') {
        for (const k of Object.keys(body.properties)) if (!state.notion.properties[k]) return reply(400, { code: 'validation_error', message: `${k} is not a property that exists.` })
        const page = { id: `page${state.notion.pages.length + 1}`, url: 'https://notion.so/page', ...body, archived: false }
        state.notion.pages.push(page)
        return reply(200, page)
      }
      const pg = /^\/pages\/(\w+)$/.exec(p)
      if (pg && req.method === 'PATCH') { const page = state.notion.pages.find(x => x.id === pg[1]); page.archived = body.archived; return reply(200, page) }
    }

    // ---- Airtable
    if (u.pathname.startsWith('/airtable/')) {
      if (auth !== 'Bearer at-good') return reply(401, { error: { type: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' } })
      const p = u.pathname.slice(9)
      if (p === '/meta/whoami') return reply(200, { id: 'usr1', email: 'someone@example.com' })
      if (p === '/meta/bases/appAAAAAAAAAAAAAA/tables') return reply(200, { tables: [{ id: 'tblBBBBBBBBBBBBBB', name: 'Videos', primaryFieldId: 'fld1', fields: state.airtable.fields }] })
      if (p === '/meta/bases/appAAAAAAAAAAAAAA/tables/tblBBBBBBBBBBBBBB/fields') {
        if (!state.airtable.canWriteSchema) return reply(403, { error: { type: 'INVALID_PERMISSIONS', message: 'no schema scope' } })
        state.airtable.fields.push({ id: `fld${state.airtable.fields.length + 1}`, name: body.name, type: body.type })
        return reply(200, body)
      }
      if (p === '/appAAAAAAAAAAAAAA/tblBBBBBBBBBBBBBB' && req.method === 'POST') {
        const names = new Set(state.airtable.fields.map(f => f.name))
        const bad = Object.keys(body.records[0].fields).find(k => !names.has(k))
        if (bad) return reply(422, { error: { type: 'UNKNOWN_FIELD_NAME', message: `Unknown field name: "${bad}"` } })
        const rec = { id: `rec${state.airtable.records.length + 1}`, fields: body.records[0].fields }
        state.airtable.records.push(rec)
        return reply(200, { records: [rec] })
      }
      const del = /^\/appAAAAAAAAAAAAAA\/tblBBBBBBBBBBBBBB\/(rec\d+)$/.exec(p)
      if (del && req.method === 'DELETE') { state.airtable.records = state.airtable.records.filter(r => r.id !== del[1]); return reply(200, { deleted: true, id: del[1] }) }
      return reply(404, { error: 'NOT_FOUND' })
    }

    // ---- Supabase
    if (u.pathname.startsWith('/supabase/')) {
      if (req.headers.apikey !== 'sb-good') return reply(401, { message: 'Invalid API key' })
      const p = u.pathname.slice(9)
      if (p === '/rest/v1/') return reply(200, {})
      if (p === '/rest/v1/videos') {
        if (!state.supabase.table) return reply(404, { code: 'PGRST205', message: "Could not find the table 'public.videos' in the schema cache" })
        if (req.method === 'GET') return reply(200, state.supabase.rows.slice(0, 1))
        if (req.method === 'POST') { const row = { id: `row${state.supabase.rows.length + 1}`, ...body }; state.supabase.rows.push(row); return reply(201, [row]) }
        if (req.method === 'DELETE') { const id = u.searchParams.get('id').replace('eq.', ''); state.supabase.rows = state.supabase.rows.filter(r => r.id !== id); return reply(204, null) }
      }
      if (p === '/storage/v1/bucket/videos') return state.supabase.bucket ? reply(200, { id: 'videos', public: true }) : reply(404, { message: 'Bucket not found' })
      if (p.startsWith('/storage/v1/object/videos/') && req.method === 'POST') {
        if (!state.supabase.bucket) return reply(404, { message: 'Bucket not found' })
        state.supabase.files.push({ name: p.split('/').pop(), bytes: raw.length })
        return reply(200, { Key: p })
      }
    }
    reply(404, { message: `stand-in has no answer for ${req.method} ${u.pathname}` })
  })

  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${server.address().port}`, state, seen, close: () => server.close() }
}
