import { startSupabase } from './supabase-local.mjs'
import fs from 'node:fs'
const sb = await startSupabase()
let fail = 0
const check = (n, ok, d = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }
try {
  const sql = fs.readFileSync(new URL('../cloud/schema.sql', import.meta.url), 'utf8')
  sb.sql(sql); sb.sql(sql); sb.createBucket('videos', true)
  await new Promise(r => setTimeout(r, 900))
  const post = (p, body, tok) => fetch(sb.url + p, { method: 'POST', headers: { apikey: sb.anonKey, Authorization: `Bearer ${tok || sb.anonKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))
  const signIn = async email => { await post('/auth/v1/otp', { email }); return (await post('/auth/v1/verify', { type: 'email', email, token: sb.codeFor(email) })).json.access_token }
  const rpc = (fn, body, tok) => post(`/rest/v1/rpc/${fn}`, body, tok)
  const admin = await signIn('owner@studioco.com'), josh = await signIn('josh@studioco.com'), client = await signIn('client@acme.com'), stranger = await signIn('stranger@else.com')
  const me = (await rpc('ks_me', {}, admin)).json
  check('first sign-in creates a workspace and makes you its admin', me.role === 'admin' && /Studioco/.test(me.workspace), me.workspace)
  check('wrong sign-in code is refused', (await post('/auth/v1/verify', { type: 'email', email: 'x@y.com', token: '000000' })).status === 403)
  await rpc('ks_set_member', { p_email: 'Josh@StudioCo.com', p_role: 'member' }, admin)
  const jm = (await rpc('ks_me', {}, josh)).json
  check('an invited team member joins that workspace as a member', jm.workspaceId === me.workspaceId && jm.role === 'member')
  check('a member cannot see or change the team', (await rpc('ks_team', {}, josh)).status >= 400 && (await rpc('ks_set_member', { p_email: 'x@y.com', p_role: 'admin' }, josh)).status >= 400)
  check('the last admin cannot be demoted or removed', (await rpc('ks_set_member', { p_email: 'owner@studioco.com', p_role: 'member' }, admin)).status >= 400 && (await rpc('ks_remove_member', { p_email: 'owner@studioco.com' }, admin)).status >= 400)
  const save = (tok, project, title, folder, ws) => rpc('ks_save_video', { p_project: project, p_title: title, p_folder: folder, p_duration: 100, p_file: `${ws}/abc/${project}.mp4`, p_poster: null, p_meta: { summary: 's' } }, tok)
  const v1 = (await save(admin, 'p1', 'Admin video', 'Onboarding', me.workspaceId)).json.id
  const v2 = (await save(josh, 'p2', 'Josh video', '', me.workspaceId)).json.id
  const again = (await save(admin, 'p1', 'Admin video v2', 'Onboarding', me.workspaceId)).json.id
  check('saving the same recording again keeps its id', v1 === again && !!v2)
  check('a file path outside your workspace is refused', (await save(josh, 'p9', 'x', '', '00000000-0000-0000-0000-000000000000')).status >= 400)
  check('a stranger cannot save into anything without first getting their own workspace', (await rpc('ks_save_video', { p_project: 'z', p_title: 'z', p_folder: '', p_duration: 1, p_file: null, p_poster: null, p_meta: {} }, stranger)).status >= 400)
  check('admin sees every video; a member sees only their own', (await rpc('ks_videos', {}, admin)).json.length === 2 && (await rpc('ks_videos', {}, josh)).json.length === 1)
  check('a member cannot manage someone else’s video', (await rpc('ks_share', { p_video: v1, p_emails: ['a@b.com'] }, josh)).status >= 400 && (await rpc('ks_video_sharing', { p_video: v1 }, josh)).status >= 400 && (await rpc('ks_delete_video', { p_video: v1 }, josh)).status >= 400)
  check('an admin can manage a member’s video', (await rpc('ks_video_sharing', { p_video: v2 }, admin)).status === 200)
  // watching
  check('not signed in + invited-only → asked to sign in, nothing revealed', JSON.stringify((await rpc('ks_watch', { p_video: v1 })).json) === '{"need":"signin","email":null}')
  check('signed in but not invited → no access, nothing revealed', (await rpc('ks_watch', { p_video: v1 }, client)).json.need === 'access' && !(await rpc('ks_watch', { p_video: v1 }, client)).json.title)
  check('unknown video → gone', (await rpc('ks_watch', { p_video: 'nope' })).json.need === 'gone')
  check('bad emails are refused; good ones are cleaned', (await rpc('ks_share', { p_video: v1, p_emails: ['not an email'] }, admin)).status >= 400 && (await rpc('ks_share', { p_video: v1, p_emails: [' Client@ACME.com ', 'client@acme.com'], p_required: true }, admin)).json === 1)
  const w = (await rpc('ks_watch', { p_video: v1 }, client)).json
  check('once invited, the person can watch, and is told it is required', w.title === 'Admin video v2' && w.required === true && /p1\.mp4$/.test(w.file))
  check('…the stranger still cannot', (await rpc('ks_watch', { p_video: v1 }, stranger)).json.need === 'access')
  check('views cannot be recorded by someone without access', (await rpc('ks_view', { p_video: v1, p_session: 's', p_seconds: 5, p_duration: 100, p_bits: '1'.repeat(20) }, stranger)).json.ok === false && (await rpc('ks_view', { p_video: v1, p_session: 's', p_seconds: 5, p_duration: 100 })).json.ok === false)
  const bits = (a, b) => Array.from({ length: 20 }, (_, i) => i >= a && i < b ? '1' : '0').join('')
  let r = (await rpc('ks_view', { p_video: v1, p_session: 's1', p_seconds: 50, p_duration: 100, p_bits: bits(0, 10) }, client)).json
  check('watching the first half is 50%', r.percent === 50 && r.completed === false, JSON.stringify(r))
  r = (await rpc('ks_view', { p_video: v1, p_session: 's2', p_seconds: 50, p_duration: 100, p_bits: bits(0, 10) }, client)).json
  check('watching the first half again is still 50%', r.percent === 50)
  r = (await rpc('ks_view', { p_video: v1, p_session: 's3', p_seconds: 5, p_duration: 100, p_bits: bits(19, 20) }, client)).json
  check('skipping to the end does not complete it', r.percent === 55 && !r.completed)
  r = (await rpc('ks_view', { p_video: v1, p_session: 's4', p_seconds: 45, p_duration: 100, p_bits: bits(10, 19) }, client)).json
  check('watching the rest completes it', r.percent === 100 && r.completed === true)
  check('the owner previewing is not counted as a viewer', (await rpc('ks_view', { p_video: v1, p_session: 'own', p_seconds: 30, p_duration: 100, p_bits: bits(0, 6) }, admin)).json.counted === false)
  const sh = (await rpc('ks_video_sharing', { p_video: v1 }, admin)).json
  check('the share box shows who watched and how much', sh.people.length === 1 && sh.people[0].email === 'client@acme.com' && sh.people[0].percent === 100 && sh.people[0].completed && sh.people[0].required && sh.totals.views === 4, JSON.stringify(sh.totals))
  // folders
  await rpc('ks_share', { p_video: v1, p_emails: ['newhire@acme.com'], p_required: true, p_folder: true }, admin)
  const v3 = (await save(admin, 'p3', 'Second onboarding video', 'Onboarding', me.workspaceId)).json.id
  const hire = await signIn('newhire@acme.com')
  const list = (await rpc('ks_shared_with_me', {}, hire)).json
  check('sharing a folder covers videos added to it later', list.length === 2 && list.every(x => x.required) && (await rpc('ks_watch', { p_video: v3 }, hire)).json.title === 'Second onboarding video')
  check('…but not videos outside it', (await rpc('ks_watch', { p_video: v2 }, hire)).json.need === 'access')
  check('“Shared with me” lists only what that person was given', (await rpc('ks_shared_with_me', {}, client)).json.length === 1 && (await rpc('ks_shared_with_me', {}, stranger)).json.length === 0 && (await rpc('ks_shared_with_me', {})).status >= 400)
  // link access
  await rpc('ks_set_access', { p_video: v2, p_access: 'link' }, josh)
  check('“anyone with the link” plays without signing in and is counted anonymously', (await rpc('ks_watch', { p_video: v2 })).json.title === 'Josh video' && (await rpc('ks_view', { p_video: v2, p_session: 'anon1', p_seconds: 20, p_duration: 100 })).json.counted === true)
  // admin people view
  const ppl = (await rpc('ks_people', {}, admin)).json
  if (!Array.isArray(ppl)) console.log('people:', JSON.stringify(ppl))
  const c = ppl.find(p => p.email === 'client@acme.com'), h = ppl.find(p => p.email === 'newhire@acme.com')
  check('admin “People” shows each person’s required and completed counts', ppl.length === 2 && c.required === 1 && c.completed === 1 && h.videos === 2 && h.required === 2 && h.completed === 0, JSON.stringify(ppl.map(p => [p.email, p.videos, p.required, p.completed])))
  check('a member cannot open the People view', (await rpc('ks_people', {}, josh)).status >= 400)
  const vids = (await rpc('ks_videos', {}, admin)).json.find(x => x.id === v1)
  check('video list totals: people, required, completed', vids.people === 2 && vids.required === 2 && vids.completed === 1, JSON.stringify(vids))
  check('removing a person takes them off everything', (await rpc('ks_remove_person', { p_email: 'newhire@acme.com' }, admin)).json === 1 && (await rpc('ks_watch', { p_video: v1 }, hire)).json.need === 'access' && (await rpc('ks_shared_with_me', {}, hire)).json.length === 0)
  await rpc('ks_unshare', { p_video: v1, p_email: 'client@acme.com' }, admin)
  check('unsharing stops access at once; watch history is kept', (await rpc('ks_watch', { p_video: v1 }, client)).json.need === 'access' && Number(sb.sql("select count(*) from public.views where viewer_email='client@acme.com'").trim()) === 4)
  // direct table access
  const get = (t, tok) => fetch(`${sb.url}/rest/v1/${t}?select=*`, { headers: { apikey: sb.anonKey, Authorization: `Bearer ${tok || sb.anonKey}` } }).then(async r => (await r.json()))
  let leak = 0
  for (const t of ['workspaces', 'members', 'videos', 'grants', 'folder_grants', 'views', 'progress']) for (const tok of [null, client, josh, admin]) { const rows = await get(t, tok); if (Array.isArray(rows) && rows.length) leak++ }
  check('no table can be read directly, by anyone, signed in or not', leak === 0, `${leak} leaks`)
  check('internal helpers are not callable from outside', (await rpc('ks_granted', { p_video: v1, p_email: 'client@acme.com' }, stranger)).status >= 400 && (await rpc('ks_required', { p_video: v1, p_email: 'x' })).status >= 400)
  // storage rule
  const up = (path, tok) => fetch(`${sb.url}/storage/v1/object/videos/${path}`, { method: 'POST', headers: { apikey: sb.anonKey, Authorization: `Bearer ${tok || sb.anonKey}`, 'Content-Type': 'video/mp4' }, body: 'x' }).then(r => r.status)
  check('files: a member can upload into their workspace only; viewers and strangers cannot upload at all', await up(`${me.workspaceId}/k/a.mp4`, josh) === 200 && await up(`00000000-0000-0000-0000-000000000000/k/a.mp4`, josh) !== 200 && await up(`${me.workspaceId}/k/b.mp4`, client) !== 200 && await up(`${me.workspaceId}/k/c.mp4`) !== 200)
  const del = (await rpc('ks_delete_video', { p_video: v2 }, admin)).json
  check('deleting a video returns its files for removal and removes its shares and history', del.length === 1 && (await rpc('ks_watch', { p_video: v2 })).json.need === 'gone')
} catch (e) { check('ran to the end', false, e.stack) } finally { await sb.close() }
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0)
