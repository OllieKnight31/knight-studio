import React, { useEffect, useState, useCallback } from 'react'
import { Icon, Toggle } from '../ui.jsx'
import { Tutorial, TestResult } from './Databases.jsx'

const clean = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
const open = url => window.knight.shell.openExternal(url)

function Guide ({ steps }) {
  return (
    <ol className="guide">
      {steps.map(([title, body, url, label, action], i) => (
        <li key={i}>
          <b>{title}</b>
          <span>{body}</span>
          {url && <button className="btn sm" onClick={() => open(url)}>{label} ↗</button>}
          {action}
        </li>
      ))}
    </ol>
  )
}

/* ------------------------------------------------------------ share pages */

export function ShareTab ({ setTab }) {
  const [st, setSt] = useState(null)
  const [db, setDb] = useState(null)
  const [form, setForm] = useState({ bucket: '', anonKey: '', viewer: '' })
  const [msg, setMsg] = useState(null)
  const [test, setTest] = useState(null)
  const [copied, setCopied] = useState(false)
  const [advanced, setAdvanced] = useState(false)

  const refresh = useCallback(async () => {
    setSt(await window.knight.share.status())
    setDb((await window.knight.databases.status()).supabase)
  }, [])
  useEffect(() => { refresh().catch(() => {}) }, [refresh])
  if (!st || !db) return null

  const dirty = !!(form.bucket.trim() || form.anonKey.trim() || form.viewer.trim())
  const save = async () => {
    setMsg(null)
    try {
      const patch = {}
      if (form.bucket.trim()) patch.bucket = form.bucket.trim()
      if (form.anonKey.trim()) patch.anonKey = form.anonKey.trim()
      if (Object.keys(patch).length) await window.knight.databases.save('supabase', patch)
      if (form.viewer.trim()) await window.knight.share.save({ viewer: form.viewer.trim() })
      setForm({ bucket: '', anonKey: '', viewer: '' })
      await refresh()
      setMsg({ kind: 'ok', text: 'Saved. Now press Test share pages.' })
      return true
    } catch (e) { setMsg({ kind: 'err', text: clean(e) }); return false }
  }
  const runTest = async () => {
    if (dirty && !(await save())) return
    setMsg(null)
    setTest('running')
    try { setTest(await window.knight.share.test()) } catch (e) { setTest({ ok: false, steps: [{ name: 'Run the test', ok: false, detail: clean(e) }] }) }
    refresh().catch(() => {})
  }

  const proven = st.ready && st.tested
  return (
    <>
      <section>
        <h3>Share pages</h3>
        <p className="set-help">
          A share page is a link anyone can open to watch a video, with its chapters, summary and transcript beside it.
          It can be embedded in another page, and it counts how many times the video was watched and for how long.
        </p>
      </section>

      <section className="db-card" data-conn="share">
        <div className="row" style={{ gap: 9 }}>
          <i className={`perm-dot ${proven ? 'on' : 'optional'}`} />
          <h3>Share pages</h3>
          <span className="set-help" data-conn-state>
            {proven ? (st.counting ? 'Working, and counting views' : 'Working — views are not being counted') : st.ready ? 'Saved — not tested yet' : 'Not set up'}
          </span>
        </div>
        <p className="set-help">
          The videos and the view counts live in your own Supabase project, so they are yours: nothing is stored with us, and a link keeps working for as long as your project does.
        </p>

        <Tutorial id="share" />
        <Guide steps={[
          ['Connect Supabase', db.configured
            ? `Done — connected to ${String(db.url || '').replace(/^https?:\/\//, '')}.`
            : 'Share pages use your Supabase project. Connect it under Databases first, then come back here.',
          null, null,
          !db.configured && <button key="go" className="btn sm" onClick={() => setTab('databases')}>Open Databases</button>],
          ['Create a public storage bucket', 'In Supabase open Storage, press “New bucket”, call it videos, and switch on “Public bucket”. Type its name below.',
            'https://supabase.com/dashboard/project/_/storage/buckets', 'Open Supabase Storage'],
          ['Copy the public key', 'Project Settings → API. Copy the key labelled “anon public” (newer projects call it “Publishable key”) and paste it below. This is the key that is meant to be public.',
            'https://supabase.com/dashboard/project/_/settings/api', 'Open Supabase API settings'],
          ['Run the table setup', 'It now includes the view counter. Copy it, paste it into the SQL Editor and press Run. It is safe to run again if you ran an earlier version.',
            'https://supabase.com/dashboard/project/_/sql/new', 'Open the SQL Editor',
            <button key="copy" className="btn sm" data-act="share-sql" onClick={async () => { await window.knight.shell.copy(db.sql); setCopied(true); setTimeout(() => setCopied(false), 1800) }}>
              <Icon name={copied ? 'check' : 'files'} width="14" height="14" />{copied ? 'Copied' : 'Copy the table setup'}
            </button>],
          ['Test it', 'Press “Test share pages” below. It stores a file, counts a test view, reads the numbers back, and cleans up after itself.']
        ]} />

        <div className="field">
          <span className="label">Storage bucket{st.bucket ? ' — saved' : ''}</span>
          <input className="input" data-field="bucket" value={form.bucket} placeholder={st.bucket || 'videos'}
            onChange={e => setForm(f => ({ ...f, bucket: e.target.value }))} />
        </div>
        <div className="field">
          <span className="label">Public key{db.anonKey ? ' — saved' : ''}</span>
          <input className="input" data-field="anonKey" value={form.anonKey}
            placeholder={db.anonKey ? `${db.anonKey.slice(0, 14)}…  (paste a new one to replace it)` : 'The “anon public” or “Publishable” key'}
            onChange={e => setForm(f => ({ ...f, anonKey: e.target.value }))} />
          <span className="set-help">
            Needed to count views. It appears on every share page, which is what it is for — never paste the service_role key here.
          </span>
        </div>

        <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setAdvanced(a => !a)}>{advanced ? 'Hide' : 'Show'} advanced</button>
        {advanced && (
          <div className="field">
            <span className="label">Share page address{st.customViewer ? ' — saved' : ''}</span>
            <div className="row">
              <input className="input" data-field="viewer" value={form.viewer} placeholder={st.viewer}
                onChange={e => setForm(f => ({ ...f, viewer: e.target.value }))} />
              {st.customViewer && <button className="btn sm ghost" onClick={async () => { await window.knight.share.save({ viewer: '' }); refresh() }}>Reset</button>}
            </div>
            <span className="set-help">
              Links open on {st.viewer.replace(/^https?:\/\//, '')}. To use your own domain, host the page from the app’s “share-viewer” folder there and put its address here.
            </span>
          </div>
        )}

        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" disabled={!dirty} onClick={save}>Save</button>
          <button className="btn sm primary" data-act="share-test" disabled={test === 'running' || !db.configured} onClick={runTest}>
            {test === 'running' ? 'Testing…' : 'Test share pages'}
          </button>
        </div>
        {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
        <TestResult test={test} working="Share pages are working." failing="Share pages are not working yet." />

        {st.ready && (
          <Toggle label="Make a share page for every export" checked={st.auto !== false}
            onChange={async v => setSt(await window.knight.share.save({ auto: v }))}
            tip="Each video can still be switched off on its own, in the Export panel." />
        )}
      </section>
    </>
  )
}

/* ---------------------------------------------------------------- webhook */

const SAMPLE = `{
  "event": "video.exported",
  "sentAt": "2026-10-08T09:30:00.000Z",
  "video": {
    "title": "How to set up a new client",
    "folder": "Client onboarding",
    "fileName": "How-to-set-up-a-new-client.mp4",
    "durationSeconds": 92,
    "driveLink": "https://drive.google.com/file/d/…",
    "shareLink": "https://…/?p=…&v=…",
    "embedCode": "<div …><iframe …></iframe></div>",
    "summary": "…",
    "chapters": [{ "start": 0, "title": "Introduction" }],
    "chaptersText": "0:00 Introduction",
    "transcript": "…"
  }
}`

export function WebhookTab () {
  const [st, setSt] = useState(null)
  const [form, setForm] = useState({ url: '', secret: '' })
  const [msg, setMsg] = useState(null)
  const [test, setTest] = useState(null)
  const [showSample, setShowSample] = useState(false)
  useEffect(() => { window.knight.webhook.status().then(setSt).catch(() => {}) }, [])
  if (!st) return null

  const dirty = !!(form.url.trim() || form.secret.trim())
  const save = async () => {
    setMsg(null)
    try {
      const patch = {}
      if (form.url.trim()) patch.url = form.url.trim()
      if (form.secret.trim()) patch.secret = form.secret.trim()
      setSt(await window.knight.webhook.save(patch))
      setForm({ url: '', secret: '' })
      setMsg({ kind: 'ok', text: 'Saved. Now press Send a test.' })
      return true
    } catch (e) { setMsg({ kind: 'err', text: clean(e) }); return false }
  }
  const runTest = async () => {
    if (dirty && !(await save())) return
    setMsg(null)
    setTest('running')
    try { setTest(await window.knight.webhook.test()) } catch (e) { setTest({ ok: false, steps: [{ name: 'Send a sample video', ok: false, detail: clean(e) }] }) }
    setSt(await window.knight.webhook.status())
  }
  const proven = st.configured && st.tested

  return (
    <>
      <section>
        <h3>Webhook</h3>
        <p className="set-help">
          A webhook tells another tool the moment a video is exported, so it can carry on from there: post it in Slack, add it to your CRM, email it to a client.
          It works with Zapier, Make, n8n and anything else that can receive a webhook.
        </p>
      </section>

      <section className="db-card" data-conn="webhook">
        <div className="row" style={{ gap: 9 }}>
          <i className={`perm-dot ${proven ? 'on' : 'optional'}`} />
          <h3>Webhook</h3>
          <span className="set-help" data-conn-state>{proven ? 'Working' : st.configured ? 'Saved — not tested yet' : 'Not connected'}</span>
        </div>

        <Tutorial id="webhook" />
        <Guide steps={[
          ['Create a webhook in your automation tool', 'In Zapier: Create Zap → choose “Webhooks by Zapier” → “Catch Hook”. In Make: add a “Custom webhook”. In n8n: add a “Webhook” node set to POST.',
            'https://zapier.com/app/zaps', 'Open Zapier'],
          ['Copy the address it gives you', 'It starts with https:// — for Zapier it looks like hooks.zapier.com/hooks/catch/… Paste it below and press Save.'],
          ['Send a test', 'Press “Send a test” below. A sample video arrives in your tool, so you can see every field and choose what to do with each one.'],
          ['Build the rest in your tool', 'Add the steps you want after the webhook — a Slack message with the share link, a CRM note with the summary — and switch it on.']
        ]} />

        <div className="field">
          <span className="label">Webhook address{st.url ? ' — saved' : ''}</span>
          <input className="input" data-field="url" value={form.url} placeholder={st.url || 'https://hooks.zapier.com/hooks/catch/…'}
            onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
        </div>
        <div className="field">
          <span className="label">Signing secret (optional){st.hasSecret ? ' — saved' : ''}</span>
          <input className="input" type="password" data-field="secret" value={form.secret}
            placeholder={st.hasSecret ? '••••••••  (type a new one to replace it)' : 'Leave empty unless your tool asks for one'}
            onChange={e => setForm(f => ({ ...f, secret: e.target.value }))} />
          <span className="set-help">If set, each message carries an X-Knight-Signature header (HMAC-SHA256 of the body) so the other end can prove it came from this app.</span>
        </div>

        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" disabled={!dirty} onClick={save}>Save</button>
          <button className="btn sm primary" data-act="webhook-test" disabled={test === 'running' || !(st.configured || form.url.trim())} onClick={runTest}>
            {test === 'running' ? 'Sending…' : 'Send a test'}
          </button>
          {st.configured && (
            <button className="btn sm ghost" data-act="webhook-disconnect" onClick={async () => { setTest(null); setMsg(null); setSt(await window.knight.webhook.disconnect()) }}>Disconnect</button>
          )}
          <button className="btn sm ghost" onClick={() => setShowSample(s => !s)}>{showSample ? 'Hide' : 'See'} what is sent</button>
        </div>
        {showSample && <pre className="code-box">{SAMPLE}</pre>}
        {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
        <TestResult test={test} working="The webhook is working." failing="The webhook is not working yet." />

        {st.configured && (
          <Toggle label="Tell the webhook about every export" checked={st.auto !== false}
            onChange={async v => setSt(await window.knight.webhook.save({ auto: v }))} />
        )}
      </section>
    </>
  )
}

/* ---------------------------------------------------------------- updates */

export function UpdatesTab () {
  const [st, setSt] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    window.knight.updates.status().then(setSt).catch(() => {})
    return window.knight.updates.onChange(setSt)
  }, [])
  if (!st) return null
  const act = fn => async () => { setErr(null); try { const r = await fn(); if (r && typeof r === 'object') setSt(r) } catch (e) { setErr(clean(e)) } }
  const busy = st.phase === 'checking' || st.phase === 'downloading'

  return (
    <>
      <section>
        <h3>Updates</h3>
        <p className="set-help">New versions arrive here. Your recordings, settings and connections are kept outside the app, so an update never touches them.</p>
      </section>

      <section className="db-card" data-conn="updates">
        <div className="row" style={{ gap: 9 }}>
          <i className={`perm-dot ${st.phase === 'available' || st.phase === 'ready' ? 'optional' : 'on'}`} />
          <h3>Version {st.current}</h3>
          <span className="set-help" data-conn-state>
            {!st.enabled ? 'Updates are not switched on in this copy'
              : st.phase === 'checking' ? 'Checking…'
                : st.phase === 'available' ? `Version ${st.version} is available`
                  : st.phase === 'downloading' ? `Downloading version ${st.version}… ${Math.round((st.progress || 0) * 100)}%`
                    : st.phase === 'ready' ? `Version ${st.version} is ready to install`
                      : st.phase === 'current' ? 'This is the newest version'
                        : st.phase === 'error' ? 'The last check did not work'
                          : st.lastCheckedAt ? `Last checked ${new Date(st.lastCheckedAt).toLocaleString()}` : 'Not checked yet'}
          </span>
        </div>

        {!st.enabled && (
          <p className="set-help">
            This copy of the app was built without an update address, so it cannot fetch new versions by itself. Download the newest copy from whoever gave you the app.
          </p>
        )}
        {st.enabled && (
          <>
            {st.notes && ['available', 'downloading', 'ready'].includes(st.phase) && <div className="notice ok"><b>What is new in {st.version}</b><div style={{ marginTop: 6 }}>{st.notes}</div></div>}
            {st.phase === 'downloading' && <div className="progress"><i style={{ width: `${Math.round((st.progress || 0) * 100)}%` }} /></div>}
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {st.phase !== 'ready' && st.phase !== 'available' && st.phase !== 'downloading' && (
                <button className="btn sm primary" data-act="update-check" disabled={busy} onClick={act(() => window.knight.updates.check())}>
                  {st.phase === 'checking' ? 'Checking…' : 'Check for updates'}
                </button>
              )}
              {st.phase === 'available' && <button className="btn sm primary" data-act="update-download" onClick={act(() => window.knight.updates.download())}>Download version {st.version}</button>}
              {st.phase === 'ready' && (
                <button className="btn sm primary" data-act="update-install" disabled={!st.canInstall} onClick={act(() => window.knight.updates.install())}>Restart and update</button>
              )}
            </div>
            {st.phase === 'ready' && !st.canInstall && <span className="set-help">This copy is running from source, so it cannot replace itself.</span>}
            {st.phase === 'ready' && (
              <span className="set-help">
                The app closes, swaps itself for the new version and opens again. macOS may ask once more for permission to record the screen, camera and microphone.
              </span>
            )}
            {(err || (st.phase === 'error' && st.message)) && <div className="notice err">{err || st.message}</div>}
            <Toggle label="Check for updates automatically" checked={st.auto !== false}
              onChange={async v => setSt(await window.knight.updates.save({ auto: v }))}
              tip="Looks once when the app opens and once a day after that. Nothing is installed without you pressing the button." />
          </>
        )}
      </section>
    </>
  )
}
