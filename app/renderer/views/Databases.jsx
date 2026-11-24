import React, { useEffect, useState, useCallback } from 'react'
import { Icon, Toggle } from '../ui.jsx'

// Settings → Databases: Notion, Airtable and Supabase.
//
// Each connection is one card with the same five parts, in the order someone needs
// them: a tutorial video, the written steps (with a link for each place they have to
// go), the boxes to fill in, a test that proves it works, and the switch that decides
// whether every export is sent there.
//
// The written steps must match the video (tools/walkthroughs/scenes.js). Change one,
// change the other, and rebuild the videos.

const clean = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
const open = url => window.knight.shell.openExternal(url)

const GUIDES = {
  notion: {
    name: 'Notion',
    blurb: 'Every exported video becomes a row in a Notion database, with its link, length, folder and transcript.',
    steps: [
      ['Create an integration', 'Press “New integration”, name it, pick your workspace and Save.', 'https://www.notion.so/profile/integrations', 'Open Notion integrations'],
      ['Copy its secret', 'Press Show, then Copy, next to “Internal Integration Secret”. Paste it into Integration secret below.'],
      ['Open your database as a full page', 'Any table works, new or existing. The columns the app needs are added for you.'],
      ['Share the database with the integration', 'In Notion press ••• (top right) → Connections → choose your integration. This is the step people miss.'],
      ['Copy the database link', 'Press ••• → Copy link, paste it into Database link below, then Save and Test.']
    ]
  },
  airtable: {
    name: 'Airtable',
    blurb: 'Every exported video becomes a record in an Airtable table, with a link to the video.',
    steps: [
      ['Create a token', 'Press “Create new token” and give it a name.', 'https://airtable.com/create/tokens', 'Open Airtable tokens'],
      ['Add three scopes', 'data.records:write, schema.bases:read and schema.bases:write. The last lets the app create the columns for you.'],
      ['Add your base under Access', 'The token only works for the bases you add there.'],
      ['Create and copy the token', 'It is shown once. Paste it into Access token below.'],
      ['Copy your table’s address', 'Open the table and copy the whole address from your browser. Paste it into Table link, then Save and Test.']
    ]
  },
  supabase: {
    name: 'Supabase',
    blurb: 'Every exported video becomes a row in your own Supabase database. The video file can be stored there too.',
    steps: [
      ['Open your project’s API settings', 'Project Settings → API.', 'https://supabase.com/dashboard/project/_/settings/api', 'Open Supabase API settings'],
      ['Copy the Project URL', 'Paste it into Project address below.'],
      ['Copy the service_role key', 'Press Reveal, then Copy. Paste it into Key below and press Save. It is kept only on this Mac.'],
      ['Create the table', 'Press “Copy the table setup” below, paste it into Supabase → SQL Editor and press Run.', 'https://supabase.com/dashboard/project/_/sql/new', 'Open the SQL Editor'],
      ['Test the connection', 'Optional: to store the video file too, create a public Storage bucket and switch it on below.']
    ]
  }
}

/** The tutorial video for a connection, with captions. Hidden if the file is missing. */
export function Tutorial ({ id, label }) {
  const [missing, setMissing] = useState(false)
  if (missing) return null
  return (
    <div className="tutorial">
      <video controls preload="none" poster={`./walkthroughs/${id}.jpg`} onError={() => setMissing(true)}>
        <source src={`./walkthroughs/${id}.mp4`} type="video/mp4" onError={() => setMissing(true)} />
        <track kind="captions" src={`./walkthroughs/${id}.vtt`} srcLang="en" label="English" />
      </video>
      <span className="set-help">{label || 'Watch it done, step by step. Captions are available from the player.'}</span>
    </div>
  )
}

/** The outcome of a test, one line per step. */
export function TestResult ({ test, working, failing }) {
  if (!test || test === 'running') return null
  return (
    <div className={`notice ${test.ok ? 'ok' : 'err'}`}>
      <b>{test.ok ? working : failing}</b>
      <div className="col" style={{ gap: 6, marginTop: 8 }}>
        {test.steps.map(s => (
          <div key={s.name} className="set-row" style={{ alignItems: 'flex-start', gap: 9 }}>
            <i className={`perm-dot ${s.ok ? 'on' : ''}`} style={{ marginTop: 5 }} />
            <div className="grow"><div>{s.name}</div><div className="set-help">{s.detail}</div></div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Card ({ which, status, onChanged, children, fields, canSave }) {
  const g = GUIDES[which]
  const st = status[which]
  const [openCard, setOpenCard] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [test, setTest] = useState(null)

  const save = async () => {
    setBusy(true); setMsg(null)
    try {
      onChanged(await window.knight.databases.save(which, fields()))
      setMsg({ kind: 'ok', text: 'Saved. Now press Test connection.' })
      return true
    } catch (e) { setMsg({ kind: 'err', text: clean(e) }); return false } finally { setBusy(false) }
  }

  const runTest = async () => {
    setMsg(null)
    // Anything typed but not yet saved is saved first, so the test checks what is on screen.
    if (canSave && !(await save())) return
    setMsg(null)
    setTest('running')
    try {
      setTest(await window.knight.databases.test(which))
      onChanged(await window.knight.databases.status())
    } catch (e) { setTest({ ok: false, steps: [{ name: 'Run the test', ok: false, detail: clean(e) }] }) }
  }

  // The setup stays open until a test has passed: a connection that is filled in but
  // not proven is not finished, and its boxes should not disappear.
  const proven = st.configured && st.tested === true
  const expanded = openCard || !proven

  return (
    <section className="db-card" data-db={which}>
      <div className="row between">
        <div className="row" style={{ gap: 9 }}>
          <i className={`perm-dot ${proven ? 'on' : 'optional'}`} />
          <h3>{g.name}</h3>
          <span className="set-help">{st.configured && !proven ? 'Saved — not tested yet' : st.configured ? `Connected${which === 'notion' && st.databaseName ? ` to “${st.databaseName}”` : which === 'airtable' && st.tableName ? ` to “${st.tableName}”` : which === 'supabase' ? ` to “${st.table || 'videos'}”` : ''}` : 'Not connected'}</span>
        </div>
        {proven && <button className="btn sm ghost" onClick={() => setOpenCard(o => !o)}>{expanded ? 'Hide setup' : 'Show setup'}</button>}
      </div>
      <p className="set-help">{g.blurb}</p>

      {expanded && (
        <>
          <Tutorial id={which} />
          <ol className="guide">
            {g.steps.map(([title, body, url, label], i) => (
              <li key={i}>
                <b>{title}</b>
                <span>{body}</span>
                {url && <button className="btn sm" onClick={() => open(url)}>{label} ↗</button>}
              </li>
            ))}
          </ol>
          {children}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn sm" disabled={busy || !canSave} onClick={save}>Save</button>
            <button className="btn sm primary" disabled={busy || test === 'running' || !(st.hasKey || canSave)} onClick={runTest}>
              {test === 'running' ? 'Testing…' : 'Test connection'}
            </button>
            {st.hasKey && (
              <button className="btn sm ghost" disabled={busy} onClick={async () => { setTest(null); setMsg(null); onChanged(await window.knight.databases.disconnect(which)) }}>
                Disconnect
              </button>
            )}
          </div>
        </>
      )}
      {!expanded && (
        <div><button className="btn sm primary" disabled={test === 'running'} onClick={runTest}>{test === 'running' ? 'Testing…' : 'Test connection'}</button></div>
      )}

      {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
      <TestResult test={test} working={`${g.name} is working.`} failing={`${g.name} is not working yet.`} />

      {st.configured && (
        <Toggle label={`Add every exported video to ${g.name}`} checked={st.auto !== false}
          onChange={async v => onChanged(await window.knight.databases.save(which, { auto: v }))} />
      )}
    </section>
  )
}

export default function DatabasesTab () {
  const [status, setStatus] = useState(null)
  const [notion, setNotion] = useState({ key: '', database: '' })
  const [airtable, setAirtable] = useState({ key: '', link: '' })
  const [supabase, setSupabase] = useState({ key: '', url: '', table: '', bucket: '' })
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(() => window.knight.databases.status().then(setStatus).catch(() => {}), [])
  useEffect(() => { refresh() }, [refresh])

  if (!status) return <section><h3>Databases</h3><p className="set-help">Checking…</p></section>

  const sb = status.supabase
  // Only send what was actually typed, so an empty box never wipes a saved value.
  const typed = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => String(v).trim() !== ''))
  const done = next => {
    setStatus(next)
    setNotion({ key: '', database: '' }); setAirtable({ key: '', link: '' }); setSupabase({ key: '', url: '', table: '', bucket: '' })
  }

  return (
    <>
      <section>
        <h3>Databases</h3>
        <p className="set-help">
          Send every exported video to the database your team already works from. Connect one, two or all
          three; each gets its own row for every export. Keys are stored on this Mac only and are never
          shown again once saved.
        </p>
      </section>

      <Card which="notion" status={status} onChanged={done} fields={() => typed(notion)}
        canSave={!!(notion.key.trim() || notion.database.trim())}>
        <div className="field">
          <span className="label">Integration secret{status.notion.hasKey ? ' — saved' : ''}</span>
          <input className="input" type="password" value={notion.key}
            placeholder={status.notion.hasKey ? '••••••••  (paste a new one to replace it)' : 'Starts with ntn_ or secret_'}
            onChange={e => setNotion(n => ({ ...n, key: e.target.value }))} />
        </div>
        <div className="field">
          <span className="label">Database link{status.notion.databaseId ? ' — saved' : ''}</span>
          <input className="input" value={notion.database}
            placeholder={status.notion.databaseId ? `Connected${status.notion.databaseName ? ` to “${status.notion.databaseName}”` : ''}. Paste another link to change it.` : 'https://www.notion.so/…'}
            onChange={e => setNotion(n => ({ ...n, database: e.target.value }))} />
        </div>
      </Card>

      <Card which="airtable" status={status} onChanged={done} fields={() => typed(airtable)}
        canSave={!!(airtable.key.trim() || airtable.link.trim())}>
        <div className="field">
          <span className="label">Access token{status.airtable.hasKey ? ' — saved' : ''}</span>
          <input className="input" type="password" value={airtable.key}
            placeholder={status.airtable.hasKey ? '••••••••  (paste a new one to replace it)' : 'Starts with pat'}
            onChange={e => setAirtable(a => ({ ...a, key: e.target.value }))} />
        </div>
        <div className="field">
          <span className="label">Table link{status.airtable.baseId ? ' — saved' : ''}</span>
          <input className="input" value={airtable.link}
            placeholder={status.airtable.baseId ? `Connected${status.airtable.tableName ? ` to “${status.airtable.tableName}”` : ''}. Paste another address to change it.` : 'https://airtable.com/app…/tbl…'}
            onChange={e => setAirtable(a => ({ ...a, link: e.target.value }))} />
        </div>
      </Card>

      <Card which="supabase" status={status} onChanged={done}
        fields={() => typed({ key: supabase.key, url: supabase.url, table: supabase.table, bucket: supabase.bucket })}
        canSave={!!(supabase.key.trim() || supabase.url.trim() || supabase.table.trim() || supabase.bucket.trim())}>
        <div className="field">
          <span className="label">Project address{sb.url ? ' — saved' : ''}</span>
          <input className="input" value={supabase.url} placeholder={sb.url || 'https://abcdefgh.supabase.co'}
            onChange={e => setSupabase(s => ({ ...s, url: e.target.value }))} />
        </div>
        <div className="field">
          <span className="label">Key{sb.hasKey ? ' — saved' : ''}</span>
          <input className="input" type="password" value={supabase.key}
            placeholder={sb.hasKey ? '••••••••  (paste a new one to replace it)' : 'The service_role key'}
            onChange={e => setSupabase(s => ({ ...s, key: e.target.value }))} />
        </div>
        <div className="field">
          <span className="label">Table name</span>
          <input className="input" value={supabase.table} placeholder={sb.table || 'videos'}
            onChange={e => setSupabase(s => ({ ...s, table: e.target.value }))} />
        </div>
        <div className="field">
          <span className="label">Table setup</span>
          <pre className="code-box">{sb.sql}</pre>
          <div className="row">
            <button className="btn sm" onClick={async () => { await window.knight.shell.copy(sb.sql); setCopied(true); setTimeout(() => setCopied(false), 1800) }}>
              <Icon name={copied ? 'check' : 'files'} width="14" height="14" />{copied ? 'Copied' : 'Copy the table setup'}
            </button>
            <span className="set-help">Paste it into Supabase → SQL Editor and press Run. Safe to run again — it only adds what is missing.</span>
          </div>
        </div>
        <Toggle label="Store the video file in Supabase too" checked={!!sb.upload}
          onChange={async v => setStatus(await window.knight.databases.save('supabase', { upload: v }))}
          tip="Uploads the MP4 itself into a Storage bucket and puts its address in the row." />
        {sb.upload && (
          <div className="field">
            <span className="label">Storage bucket{sb.bucket ? ' — saved' : ''}</span>
            <input className="input" value={supabase.bucket} placeholder={sb.bucket || 'videos'}
              onChange={e => setSupabase(s => ({ ...s, bucket: e.target.value }))} />
            <span className="set-help">Create it under Storage in Supabase and make it public, so the links open for other people.</span>
          </div>
        )}
      </Card>
    </>
  )
}
