#!/usr/bin/env node
// Checks the Notion, Airtable and Supabase connections against a stand-in server.
//
//   node build/db-check.mjs
//
// The stand-in answers the same requests the real services do, including their error
// replies, so the whole flow — save, test, add a video, upload a file — is exercised
// without an account. It proves the app sends the right requests and handles the
// answers; it does not prove the real services still behave as documented, which is
// what the "Test connection" button in Settings is for.
import { startMock } from './db-mock.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-db-'))
process.env.HOME = home
const mock = await startMock()
const { state } = mock
const base = mock.base
process.env.KS_NOTION_API = `${base}/notion`
process.env.KS_AIRTABLE_API = `${base}/airtable`

const require = createRequire(import.meta.url)
const db = require('../app/main/databases.js')

let failed = 0
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }
const lastFail = r => r.steps.find(s => !s.ok)?.detail || ''
const record = { title: 'My video', link: 'https://drive.google.com/file/d/abc/view', durationSeconds: 372, folder: 'Sales', fileName: 'My-video.mp4', exportedAt: new Date().toISOString(), transcript: 'word '.repeat(1200) }
const video = path.join(home, 'clip.mp4')
fs.writeFileSync(video, Buffer.alloc(300000, 7))

// ---------------------------------------------------------------- Notion
check('Notion: link parsing', db.notionId('https://www.notion.so/acme/Videos-0123456789abcdef0123456789abcdef?v=1') === '0123456789abcdef0123456789abcdef' && db.notionId('01234567-89ab-cdef-0123-456789abcdef') === '0123456789abcdef0123456789abcdef' && db.notionId('nope') === null)
let threw = ''
try { db.save('notion', { key: 'x', database: 'not a link' }) } catch (e) { threw = e.message }
check('Notion: a bad link is refused with a reason', /does not look like/.test(threw))
db.save('notion', { key: 'notion-bad', database: 'https://www.notion.so/acme/Videos-0123456789abcdef0123456789abcdef' })
let r = await db.test('notion')
check('Notion: wrong secret is explained', !r.ok && /does not accept that secret/.test(lastFail(r)), lastFail(r))
db.save('notion', { key: 'notion-good' })
state.notion.shared = false
r = await db.test('notion')
check('Notion: database not shared is explained', !r.ok && /Connections/.test(lastFail(r)), lastFail(r))
state.notion.shared = true
r = await db.test('notion')
check('Notion: full test passes and creates the columns', r.ok && r.steps.length === 5 && db.COLUMNS.every(c => state.notion.properties[c.label]), r.steps.map(s => s.name).join(' → '))
check('Notion: test row was removed', state.notion.pages.every(p => p.archived))
let sent = await db.send(record)
const page = state.notion.pages.at(-1)
check('Notion: video added with every column and the transcript', sent[0]?.ok && page.properties['Video link'].url === record.link && page.properties['Length (minutes)'].number === 6.2 && page.properties.Folder.rich_text[0].text.content === 'Sales' && page.children.length === 4, `${page.children?.length} transcript blocks`)
state.notion.properties.Folder = { type: 'select' }
r = await db.test('notion')
check('Notion: a column of the wrong type is explained', !r.ok && /wrong type/.test(lastFail(r)), lastFail(r))
state.notion.properties.Folder = { type: 'rich_text' }

// --------------------------------------------------------------- Airtable
threw = ''
try { db.save('airtable', { key: 'x', link: 'https://example.com/nothing' }) } catch (e) { threw = e.message }
check('Airtable: a bad link is refused with a reason', /does not look like an Airtable link/.test(threw))
db.save('airtable', { key: 'at-bad', link: 'https://airtable.com/appAAAAAAAAAAAAAA/tblBBBBBBBBBBBBBB/viwCCCCCCCCCCCCCC?blocks=hide' })
r = await db.test('airtable')
check('Airtable: wrong token is explained', !r.ok && /does not accept that token/.test(lastFail(r)), lastFail(r))
db.save('airtable', { key: 'at-good' })
state.airtable.canWriteSchema = false
r = await db.test('airtable')
check('Airtable: missing columns without permission is explained', !r.ok && /schema\.bases:write/.test(lastFail(r)), lastFail(r).slice(0, 90))
state.airtable.canWriteSchema = true
r = await db.test('airtable')
check('Airtable: full test passes and creates the columns', r.ok && r.steps.length === 5 && db.COLUMNS.every(c => state.airtable.fields.some(f => f.name === c.label)))
check('Airtable: test row was removed', state.airtable.records.length === 0)
sent = await db.send(record, { only: ['airtable'] })
const rec = state.airtable.records.at(-1)
check('Airtable: video added with every column', sent[0]?.ok && rec.fields.Name === 'My video' && rec.fields['Video link'] === record.link && rec.fields['Length (minutes)'] === 6.2 && /appA.*tblB.*rec/.test(sent[0].url), sent[0]?.url)

// --------------------------------------------------------------- Supabase
threw = ''
try { db.save('supabase', { key: 'x', url: `${base}/supabase`, table: 'bad name!' }) } catch (e) { threw = e.message }
check('Supabase: a bad table name is refused', /letters, numbers and underscores/.test(threw))
db.save('supabase', { key: 'sb-bad', url: `${base}/supabase/`, table: 'videos' })
r = await db.test('supabase')
check('Supabase: wrong key is explained', !r.ok && /does not accept that key/.test(lastFail(r)), lastFail(r))
db.save('supabase', { key: 'sb-good' })
r = await db.test('supabase')
check('Supabase: missing table points at the setup', !r.ok && /Copy the table setup/.test(lastFail(r)), lastFail(r).slice(0, 80))
check('Supabase: table setup lists every column', db.COLUMNS.every(c => db.status().supabase.sql.includes(c.sql.split(' ')[0])) && /create table if not exists public\.videos/.test(db.status().supabase.sql))
state.supabase.table = true
r = await db.test('supabase')
check('Supabase: full test passes', r.ok && r.steps.length === 4, r.steps.map(s => s.name).join(' → '))
check('Supabase: test row was removed', state.supabase.rows.length === 0)
sent = await db.send(record, { only: ['supabase'] })
check('Supabase: video added as a row', sent[0]?.ok && state.supabase.rows.at(-1).video_url === record.link && state.supabase.rows.at(-1).duration_seconds === 372)
db.save('supabase', { upload: true, bucket: 'videos' })
r = await db.test('supabase')
check('Supabase: with file storage on, the bucket is checked', r.ok && r.steps.length === 5 && /public/.test(r.steps[4].detail))
sent = await db.send(record, { only: ['supabase'], filePath: video })
check('Supabase: the video file is uploaded and the row points at it', sent[0]?.ok && sent[0].stored && state.supabase.files.at(-1)?.bytes === 300000 && /storage\/v1\/object\/public\/videos\//.test(state.supabase.rows.at(-1).video_url), `${state.supabase.files.at(-1)?.bytes} bytes`)
state.supabase.bucket = false
sent = await db.send(record, { only: ['supabase'], filePath: video })
check('Supabase: a missing bucket is explained', !sent[0].ok && /no storage bucket/.test(sent[0].detail), sent[0].detail?.slice(0, 70))
state.supabase.bucket = true

// ------------------------------------------------------------------ shared
sent = await db.send(record, { filePath: video })
check('All three receive an export at once', sent.length === 3 && sent.every(s => s.ok), sent.map(s => `${s.name}:${s.ok}`).join(' '))
db.save('airtable', { auto: false })
sent = await db.send(record)
check('“Add every export” off skips that one only', sent.length === 2 && !sent.some(s => s.which === 'airtable'))
state.notion.shared = false
sent = await db.send(record)
check('One failing does not stop the others', sent.find(s => s.which === 'notion').ok === false && sent.find(s => s.which === 'supabase').ok === true)
const st = db.status()
check('Keys are never handed back', !JSON.stringify(st).includes('notion-good') && !JSON.stringify(st).includes('sb-good') && st.notion.hasKey === true)
const mode = (fs.statSync(path.join(home, 'Library/Application Support/Knight Studio/secrets.json')).mode & 0o777).toString(8)
check('Keys are stored readable only by the user', mode === '600', mode)
db.disconnect('notion')
check('Disconnect forgets the key and the database', db.status().notion.hasKey === false && !db.status().notion.databaseId)

mock.close()
fs.rmSync(home, { recursive: true, force: true })
console.log(`\n${failed ? `${failed} FAILED` : 'all database checks passed'}`)
process.exit(failed ? 1 : 0)
