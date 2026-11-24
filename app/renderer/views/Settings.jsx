import React, { useEffect, useState, useCallback } from 'react'
import { Icon, Toggle, Slider } from '../ui.jsx'
import DatabasesTab, { Tutorial, TestResult } from './Databases.jsx'
import { ShareTab, WebhookTab, UpdatesTab } from './Connections.jsx'
import { AccountTab } from './Sharing.jsx'

const TABS = [
  ['account', 'Account', 'inbox'],
  ['files', 'Files', 'files'],
  ['drive', 'Google Drive', 'drive'],
  ['databases', 'Databases', 'grid'],
  ['share', 'Share pages', 'link'],
  ['webhook', 'Webhook', 'send'],
  ['captions', 'Captions & titles', 'subtitles'],
  ['recording', 'Recording', 'record'],
  ['system', 'System check', 'check'],
  ['updates', 'Updates', 'restore']
]

/**
 * App-wide settings, opened from the cog at the bottom left of the library and of
 * the editor. `prefs` is the saved settings object and `savePrefs(patch)` writes a
 * change.
 */
export default function Settings ({ prefs, savePrefs, setPrefs, onClose, onLibraryChanged, initialTab = 'files' }) {
  const [tab, setTab] = useState(initialTab)

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <nav className="modal-nav">
          <h2>Settings</h2>
          {TABS.map(([id, label, icon]) => (
            <button key={id} className={`folder ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
              <Icon name={icon} /><span className="folder-name">{label}</span>
            </button>
          ))}
          <button className="btn modal-close" onClick={onClose}>Done</button>
        </nav>
        <div className="modal-body">
          {tab === 'files' && <FilesTab prefs={prefs} savePrefs={savePrefs} setPrefs={setPrefs} onLibraryChanged={onLibraryChanged} />}
          {tab === 'drive' && <DriveTab prefs={prefs} savePrefs={savePrefs} setPrefs={setPrefs} onLibraryChanged={onLibraryChanged} />}
          {tab === 'databases' && <DatabasesTab />}
          {tab === 'account' && <AccountTab onChanged={() => savePrefs({})} />}
          {tab === 'share' && <ShareTab setTab={setTab} />}
          {tab === 'webhook' && <WebhookTab />}
          {tab === 'updates' && <UpdatesTab />}
          {tab === 'captions' && <CaptionsTab prefs={prefs} savePrefs={savePrefs} />}
          {tab === 'recording' && <RecordingTab prefs={prefs} savePrefs={savePrefs} />}
          {tab === 'system' && <SystemTab setTab={setTab} prefs={prefs} savePrefs={savePrefs} />}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- files */

function FilesTab ({ prefs, savePrefs, setPrefs, onLibraryChanged }) {
  const [lib, setLib] = useState(null)
  const [move, setMove] = useState(true)
  const [busy, setBusy] = useState(null)       // null | { fraction }
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  const refresh = useCallback(() => window.knight.settings.libraryDir().then(setLib), [])
  useEffect(() => { refresh() }, [refresh])

  const change = async dir => {
    setError(null); setDone(null)
    setBusy({ fraction: 0 })
    const stop = window.knight.settings.onMoveProgress(({ fraction }) => setBusy({ fraction }))
    try {
      const res = await window.knight.settings.setLibraryDir({ dir, move })
      setPrefs(res.prefs)
      setDone(move && res.moved ? `Moved ${res.moved} item${res.moved === 1 ? '' : 's'} to the new location.` : 'Location updated.')
      await refresh()
      onLibraryChanged?.()
    } catch (e) {
      setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally { stop(); setBusy(null) }
  }

  return (
    <>
      <section>
        <h3>Recordings folder</h3>
        <p className="set-help">Where every recording and its edits are kept on this Mac.</p>
        <div className="path">{lib?.dir || '…'}</div>
        <Toggle label="Move existing recordings to the new location" checked={move} onChange={setMove} />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" disabled={!!busy} onClick={async () => {
            const dir = await window.knight.settings.pickDirectory({ title: 'Choose where recordings are kept', defaultPath: lib?.dir })
            if (dir) change(dir)
          }}>Change location…</button>
          {lib && !lib.isDefault && (
            <button className="btn sm ghost" disabled={!!busy} onClick={() => change(null)}>Use the default (Movies)</button>
          )}
          <button className="btn sm ghost" onClick={() => lib && window.knight.shell.open(lib.dir)}>Show in Finder</button>
        </div>
        {busy && <div className="progress"><i style={{ width: `${Math.round((busy.fraction || 0) * 100)}%` }} /></div>}
        {done && <div className="notice ok">{done}</div>}
        {error && <div className="notice err">{error}</div>}
      </section>

      <section>
        <h3>Export folder</h3>
        <p className="set-help">Where exported videos go.</p>
        <div className="path">{prefs.exportDir || '~/Downloads'}</div>
        <div className="row">
          <button className="btn sm" onClick={async () => {
            const dir = await window.knight.settings.pickDirectory({ title: 'Choose where exports are saved', defaultPath: prefs.exportDir || undefined })
            if (dir) savePrefs({ exportDir: dir })
          }}>Change location…</button>
          {prefs.exportDir && <button className="btn sm ghost" onClick={() => savePrefs({ exportDir: null })}>Use Downloads</button>}
        </div>
        <Toggle label="Save exports here without asking each time" checked={!!prefs.exportDirect}
          onChange={v => savePrefs({ exportDirect: v })} />
        <p className="set-help">
          {prefs.exportDirect
            ? 'Export saves straight into this folder under the video’s name. If a file with that name is already there, the new one gets a number rather than replacing it.'
            : 'Each export opens a window, starting in this folder, where you choose the name and place.'}
        </p>
      </section>
    </>
  )
}

/* ------------------------------------------------------------------- drive */

const clean = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

function DriveTab ({ prefs, savePrefs, setPrefs, onLibraryChanged }) {
  const [status, setStatus] = useState(null)
  const [link, setLink] = useState('')
  const [name, setName] = useState('Knight Studio')
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)   // browser sign-in in progress
  const [msg, setMsg] = useState(null)            // { kind, text }
  const [ownClient, setOwnClient] = useState({ open: false, id: '', secret: '' })
  const [test, setTest] = useState(null)          // null | 'running' | { ok, steps }

  const runTest = async () => {
    setTest('running')
    try { setTest(await window.knight.drive.test()) } catch (e) { setTest({ ok: false, steps: [{ name: 'Run the test', ok: false, detail: clean(e) }] }) }
  }

  const refresh = useCallback(() => window.knight.drive.status().then(setStatus), [])
  useEffect(() => { refresh() }, [refresh])

  const run = async (fn, okText) => {
    setBusy(true); setMsg(null)
    try {
      const res = await fn()
      setPrefs(await window.knight.prefs.read())
      await refresh()
      onLibraryChanged?.()
      const problems = res?.errors?.length ? ` Some folders could not be created: ${res.errors.join('; ')}` : ''
      setMsg({ kind: problems ? 'warn' : 'ok', text: (typeof okText === 'function' ? okText(res) : okText) + problems })
      setLink('')
    } catch (e) {
      setMsg({ kind: 'err', text: clean(e) })
    } finally { setBusy(false) }
  }

  const connect = async () => {
    setWaiting(true); setMsg(null)
    try {
      const res = await window.knight.drive.signIn()
      setPrefs(await window.knight.prefs.read())
      await refresh()
      onLibraryChanged?.()
      setMsg({ kind: 'ok', text: `Connected${res.email ? ` as ${res.email}` : ''}. Now choose the parent folder below.` })
    } catch (e) {
      if (!/cancelled/i.test(clean(e))) setMsg({ kind: 'err', text: clean(e) })
    } finally { setWaiting(false) }
  }

  if (!status) return <section><h3>Google Drive</h3><p className="set-help">Checking…</p></section>

  const acct = status.account || {}
  const parent = status.parent

  const clientForm = (
    <div className="field">
      <span className="label">Google OAuth client</span>
      <p className="set-help">
        Google only allows sign-in through a client registered with them. In the Google Cloud console,
        create a project, enable the Google Drive API, then create an OAuth client of type
        “Desktop app” and paste its ID and secret here. It is free and takes a few minutes.
      </p>
      <input className="input" placeholder="Client ID — ends in .apps.googleusercontent.com"
        value={ownClient.id} onChange={e => setOwnClient(c => ({ ...c, id: e.target.value }))} />
      <input className="input" placeholder="Client secret" type="password"
        value={ownClient.secret} onChange={e => setOwnClient(c => ({ ...c, secret: e.target.value }))} />
      <div className="row">
        <button className="btn sm" disabled={!ownClient.id.trim() || !ownClient.secret.trim()}
          onClick={async () => {
            try {
              await window.knight.drive.setClient({ clientId: ownClient.id, clientSecret: ownClient.secret })
              setOwnClient({ open: false, id: '', secret: '' })
              await refresh()
              setMsg({ kind: 'ok', text: 'Client saved. You can now connect Google Drive.' })
            } catch (e) { setMsg({ kind: 'err', text: clean(e) }) }
          }}>Save client</button>
        <button className="btn sm ghost" onClick={() => window.knight.shell.openExternal('https://console.cloud.google.com/apis/credentials')}>Open Google Cloud console</button>
      </div>
    </div>
  )

  if (!acct.connected) {
    return (
      <section>
        <h3>Google Drive</h3>
        <p className="set-help">
          Connect a Google account and exported videos upload themselves, filed in Drive the same way
          they are filed here. The app can only see the folders and files it creates — never the rest
          of your Drive.
        </p>
        <Tutorial id="drive" />
        {acct.canSignIn
          ? (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={waiting} onClick={connect}>
                <Icon name="drive" width="15" height="15" />{waiting ? 'Waiting for you in the browser…' : 'Connect Google Drive'}
              </button>
              {waiting && <button className="btn ghost" onClick={() => window.knight.drive.cancelSignIn()}>Cancel</button>}
            </div>
            )
          : <div className="notice warn">This copy of the app has no Google sign-in built in yet. Add a client below to switch Drive on.</div>}
        {waiting && <p className="set-help">Your browser has opened Google's sign-in page. Approve access there and come back.</p>}
        {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
        {(!acct.canSignIn || ownClient.open)
          ? clientForm
          : <div><button className="btn sm ghost" onClick={() => setOwnClient(c => ({ ...c, open: true }))}>Use my own Google client instead</button></div>}
      </section>
    )
  }

  return (
    <>
      <section>
        <h3>Account</h3>
        <div className="notice ok">
          <div className="row between">
            <span>
              {acct.source === 'app'
                ? <>Connected{acct.email ? <> as <b>{acct.email}</b></> : ''}</>
                : <>Using the Google sign-in already on this Mac</>}
            </span>
            {acct.source === 'app'
              ? <button className="btn sm" disabled={busy} onClick={() => run(() => window.knight.drive.signOut(), 'Disconnected on this Mac. Nothing in Drive was deleted.')}>Disconnect</button>
              : acct.canSignIn && <button className="btn sm" disabled={waiting} onClick={connect}>{waiting ? 'Waiting…' : 'Sign in with a different account'}</button>}
          </div>
        </div>
      </section>

      <section>
        <h3>How it works</h3>
        <Tutorial id="drive" label="A two-minute tutorial: connecting, the parent folder, and testing." />
      </section>

      <section>
        <h3>Parent folder</h3>
        <p className="set-help">
          Everything goes inside one folder in your Google Drive. Each folder you make in the library
          becomes a folder inside it, and exported videos are uploaded into the matching one.
        </p>
        {parent
          ? (
            <div className="notice ok">
              <div className="row between">
                <span>Uploading into <b>{parent.name}</b></span>
                <button className="btn sm" onClick={() => window.knight.shell.openExternal(parent.link)}>Open in Drive</button>
              </div>
            </div>
            )
          : <div className="notice warn">No parent folder chosen yet. Videos stay on this Mac until you pick one.</div>}

        <div className="field">
          <span className="label">{parent ? 'Make a different one' : 'Create it in My Drive'}</span>
          <div className="set-row">
            <input className="input grow" value={name} onChange={e => setName(e.target.value)} placeholder="Folder name" />
            <button className={`btn sm ${parent ? '' : 'primary'}`} disabled={busy || !name.trim()}
              onClick={() => run(() => window.knight.drive.createParent(name), r => `“${r.parent.name}” is now the parent folder.`)}>
              {parent ? 'Create folder' : 'Create parent folder'}
            </button>
          </div>
          <span className="set-help">Once created you can move or rename it anywhere in your Drive; the app keeps following it.</span>
        </div>

        <div className="field">
          <span className="label">Or use a folder link</span>
          <div className="set-row">
            <input className="input grow" placeholder="Paste the folder's Google Drive link" value={link}
              onChange={e => setLink(e.target.value)} />
            <button className="btn sm" disabled={busy || !link.trim()}
              onClick={() => run(() => window.knight.drive.setParent(link), r => `Now uploading into “${r.parent.name}”.`)}>
              Use this folder
            </button>
          </div>
          {acct.limited && (
            <span className="set-help">Only works for a folder this app created — Google does not let it see folders it did not make.</span>
          )}
        </div>
        {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
      </section>

      <section>
        <h3>Test the connection</h3>
        <p className="set-help">
          Does for real what an export does: signs in, creates a folder inside the parent folder,
          uploads a file into it, reads it back, then removes both. Takes a few seconds and leaves
          nothing behind in your Drive.
        </p>
        <div>
          <button className="btn sm primary" disabled={test === 'running' || !parent} onClick={runTest}>
            {test === 'running' ? 'Testing…' : 'Test Google Drive now'}
          </button>
        </div>
        {!parent && <span className="set-help">Choose a parent folder first.</span>}
        <TestResult test={test} working="Google Drive is working." failing="Google Drive is not working yet." />
      </section>

      <section>
        <h3>Uploads</h3>
        <Toggle label="Upload every export to Drive automatically"
          checked={prefs.drive.autoUpload !== false}
          onChange={v => savePrefs({ drive: { autoUpload: v } })} />
        <p className="set-help">Each video can still opt out in its Export panel.</p>
        {parent && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn sm" disabled={busy}
              onClick={() => run(() => window.knight.drive.sync(), 'Library folders and Drive folders now match.')}>
              {busy ? 'Working…' : 'Sync folders now'}
            </button>
            <button className="btn sm ghost" disabled={busy}
              onClick={() => run(() => window.knight.drive.clearParent(), 'Drive parent folder removed. Nothing in Drive was deleted.')}>
              Stop using this folder
            </button>
          </div>
        )}
      </section>
    </>
  )
}

/* ----------------------------------------------------------- captions + AI */

function CaptionsTab ({ prefs, savePrefs }) {
  const [st, setSt] = useState(null)
  const [progress, setProgress] = useState({})    // model name -> 0..1
  const [error, setError] = useState(null)
  const [ai, setAi] = useState(null)
  const [keys, setKeys] = useState({ anthropic: '', gemini: '' })

  const refresh = useCallback(() => {
    window.knight.captions.status().then(setSt).catch(() => {})
    window.knight.ai.status().then(setAi).catch(() => {})
  }, [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => window.knight.captions.onModelProgress(({ name, fraction }) =>
    setProgress(p => ({ ...p, [name]: fraction }))), [])

  const download = async name => {
    setError(null)
    setProgress(p => ({ ...p, [name]: 0.001 }))
    try {
      const next = await window.knight.captions.downloadModel(name)
      setSt(s => ({ ...s, ...next, chosen: name }))
      savePrefs({ captions: { model: name } })
    } catch (e) { setError(clean(e)) } finally { setProgress(p => { const n = { ...p }; delete n[name]; return n }) }
  }

  const saveKey = async which => {
    await window.knight.ai.setKey(which, keys[which])
    setKeys(k => ({ ...k, [which]: '' }))
    refresh()
  }

  return (
    <>
      <section>
        <h3>Captions</h3>
        <p className="set-help">
          Speech is turned into text on this Mac — your audio is never uploaded. That needs a speech
          model, downloaded once.
        </p>
        {st && !st.ok && <div className="notice err">The speech engine is missing from this copy of the app.</div>}
        {st?.engine === 'faster-whisper' && (
          <div className="notice ok">Using the Whisper installation already on this Mac. No download needed.</div>
        )}
        {st?.engine === 'whisper.cpp' && st.models.map(m => {
          const active = progress[m.name] !== undefined
          return (
            <div key={m.name} className="notice">
              <div className="row between">
                <span>
                  <b>{m.label}</b> — {m.mb} MB
                  {m.downloaded && (prefs.captions?.model === m.name || st.models.filter(x => x.downloaded).length === 1) ? ' · in use' : ''}
                </span>
                {m.downloaded
                  ? (
                    <span className="row" style={{ gap: 6 }}>
                      {prefs.captions?.model !== m.name && (
                        <button className="btn sm" onClick={() => savePrefs({ captions: { model: m.name } })}>Use this one</button>
                      )}
                      <button className="btn sm ghost" onClick={async () => { const next = await window.knight.captions.removeModel(m.name); setSt(cur => ({ ...cur, ...next })) }}>Remove</button>
                    </span>
                    )
                  : <button className="btn sm" disabled={active} onClick={() => download(m.name)}>{active ? `Downloading… ${Math.round(progress[m.name] * 100)}%` : 'Download'}</button>}
              </div>
              {active && <div className="progress" style={{ marginTop: 8 }}><i style={{ width: `${Math.round(progress[m.name] * 100)}%` }} /></div>}
            </div>
          )
        })}
        {st?.engine === 'whisper.cpp' && !st.models.some(m => m.downloaded) && (
          <p className="set-help">Nothing downloaded yet. The standard model also downloads by itself the first time you transcribe a video.</p>
        )}
        {error && <div className="notice err">{error}</div>}
      </section>

      <section>
        <h3>Automatic titles</h3>
        <p className="set-help">
          New recordings are named from their opening words. Add an AI key and they are named properly —
          a short title written from what was said, or from what was on screen when nothing was. The key
          is yours, stays on this Mac, and each title costs a fraction of a penny.
        </p>
        {[['anthropic', 'Anthropic (Claude) API key', 'https://console.anthropic.com/settings/keys'],
          ['gemini', 'Google Gemini API key', 'https://aistudio.google.com/apikey']].map(([which, label, url]) => (
          <div className="field" key={which}>
            <span className="label">{label}{ai?.[which] ? ' — saved' : ''}</span>
            <div className="set-row">
              <input className="input grow" type="password" value={keys[which]}
                placeholder={ai?.[which] ? '••••••••  (paste a new key to replace it)' : 'Paste a key'}
                onChange={e => setKeys(k => ({ ...k, [which]: e.target.value }))} />
              <button className="btn sm" disabled={!keys[which].trim()} onClick={() => saveKey(which)}>Save</button>
              {ai?.[which] && <button className="btn sm ghost" onClick={async () => { await window.knight.ai.setKey(which, ''); refresh() }}>Remove</button>}
              <button className="btn sm ghost" onClick={() => window.knight.shell.openExternal(url)}>Get one</button>
            </div>
          </div>
        ))}
        {ai?.any && !ai.anthropic && !ai.gemini && (
          <div className="notice ok">A key is already available on this Mac, so titles are being written by AI.</div>
        )}
      </section>
    </>
  )
}

/* ------------------------------------------------------------ system check */

function SystemTab ({ setTab, prefs, savePrefs }) {
  const [info, setInfo] = useState(null)
  const refresh = useCallback(() => { setInfo(null); window.knight.system.check().then(setInfo).catch(() => setInfo({ failed: true })) }, [])
  useEffect(() => { refresh() }, [refresh])

  if (!info) return <section><h3>System check</h3><p className="set-help">Checking everything the app relies on…</p></section>
  if (info.failed) return <section><h3>System check</h3><div className="notice err">The check could not run.</div></section>

  const p = info.permissions || {}
  const Line = ({ ok, optional, label, detail, action }) => (
    <div className="set-row">
      <i className={`perm-dot ${ok ? 'on' : optional ? 'optional' : ''}`} />
      <div className="grow">
        <div style={{ fontSize: 12.5 }}>{label}</div>
        <div className="set-help">{detail}</div>
      </div>
      {action}
    </div>
  )
  const open = which => <button className="btn sm" onClick={() => window.knight.system.openPrivacy(which)}>Open System Settings</button>

  return (
    <>
      <section>
        <div className="row between"><h3>System check</h3><button className="btn sm ghost" onClick={refresh}>Check again</button></div>
        <p className="set-help">
          Everything the app relies on. A red dot means something will not work until it is fixed; grey is
          optional. macOS asks for each permission once — after allowing one, press “Check again”.
        </p>
        <Line ok={info.engine} label="Recording engine" detail={info.engine ? 'Built in and ready.' : 'Missing from this copy of the app — download it again.'} />
        <Line ok={info.ffmpeg} label="Video and audio processing" detail={info.ffmpeg ? 'Built in and ready.' : 'Missing from this copy of the app — exports and thumbnails will fail.'} />
        <Line ok={info.captions.ok && (info.captions.engine !== 'whisper.cpp' || !!info.captions.model)} optional={info.captions.ok}
          label="Captions"
          detail={!info.captions.ok ? 'The speech engine is missing.'
            : info.captions.engine === 'whisper.cpp' && !info.captions.model ? 'Ready — the speech model downloads the first time you transcribe.'
              : 'Ready.'}
          action={info.captions.ok && <button className="btn sm ghost" onClick={() => setTab('captions')}>Manage</button>} />
      </section>

      <section>
        <h3>Permissions</h3>
        <Line ok={p.screenRecording} label="Screen & System Audio Recording" detail={p.screenRecording ? 'Allowed.' : 'Needed to record anything at all.'} action={!p.screenRecording && open('screenRecording')} />
        <Line ok={p.accessibility} label="Accessibility" detail={p.accessibility ? 'Allowed.' : 'Needed for click tracking — without it automatic zoom produces nothing.'} action={!p.accessibility && open('accessibility')} />
        <Line ok={p.camera} optional label="Camera" detail={p.camera ? `Allowed. ${info.cameras} camera${info.cameras === 1 ? '' : 's'} found.` : 'Optional — only needed to appear on camera.'} action={!p.camera && open('camera')} />
        <Line ok={p.microphone} optional label="Microphone" detail={p.microphone ? `Allowed. ${info.microphones} microphone${info.microphones === 1 ? '' : 's'} found.` : 'Optional — only needed for voiceover.'} action={!p.microphone && open('microphone')} />
      </section>

      <section>
        <h3>Connections</h3>
        <Line ok={info.drive.connected} optional label="Google Drive"
          detail={info.drive.connected ? (info.drive.email ? `Connected as ${info.drive.email}.` : 'Connected.') : 'Not connected — exports stay on this Mac.'}
          action={<button className="btn sm ghost" onClick={() => setTab('drive')}>{info.drive.connected ? 'Manage' : 'Connect'}</button>} />
      </section>

      <section>
        <h3>Walkthroughs</h3>
        <p className="set-help">
          Each screen and each editing tool shows a short walkthrough the first time it is opened.
          “Show me around” and the ? button replay them at any time.
        </p>
        <Toggle label="Start walkthroughs automatically" checked={!prefs?.tours?.disabled}
          onChange={v => savePrefs({ tours: { disabled: !v } })} />
        <div>
          <button className="btn sm" onClick={() => savePrefs({ toursReset: true, tours: {} })}>Show them all again</button>
        </div>
      </section>

      <section>
        <h3>About</h3>
        <p className="set-help">
          Version {info.version} · macOS {info.macos} · {info.arch === 'arm64' ? 'Apple silicon' : info.arch === 'x64' ? 'Intel' : info.arch}
        </p>
        <div className="path">{info.libraryDir}</div>
      </section>
    </>
  )
}

/* --------------------------------------------------------------- recording */

function RecordingTab ({ prefs, savePrefs }) {
  return (
    <>
      <section>
        <h3>Quick access</h3>
        <Toggle label="Keep running after login" checked={prefs.openAtLogin !== false}
          onChange={v => savePrefs({ openAtLogin: v })} />
        <Slider label="Countdown before recording" value={prefs.countdown ?? 3} min={0} max={10} step={1}
          format={v => (v ? `${Math.round(v)}s` : 'none')}
          onChange={v => savePrefs({ countdown: Math.round(v) })} />
        <p className="set-help">
          Right-click the Dock icon to record without opening the app.
          ⌘⇧7 records the screen. ⌘⇧8 records screen and camera, or stops.
        </p>
      </section>
      <section>
        <h3>Camera timing</h3>
        <p className="set-help">
          The camera is lined up with your voice automatically. If one particular webcam always looks
          slightly early or late, correct it here and every video follows. A single video can also be
          adjusted on its own under Layout in the editor.
        </p>
        <Slider label="Camera delay" value={prefs.cameraDelayMs || 0} min={-300} max={300} step={5}
          format={v => (v === 0 ? 'none' : `${v > 0 ? '+' : ''}${Math.round(v)} ms — camera ${v > 0 ? 'later' : 'earlier'}`)}
          onChange={v => savePrefs({ cameraDelayMs: Math.round(v) })} />
      </section>
    </>
  )
}
