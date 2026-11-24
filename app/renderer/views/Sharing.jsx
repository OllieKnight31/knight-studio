import React, { useEffect, useState, useCallback } from 'react'
import { Icon, Toggle } from '../ui.jsx'

const clean = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const ago = t => {
  if (!t) return ''
  const d = (Date.now() - new Date(t).getTime()) / 1000
  if (d < 90) return 'just now'
  if (d < 3600) return `${Math.round(d / 60)} min ago`
  if (d < 86400) return `${Math.round(d / 3600)} h ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function CopyButton ({ text, label, act, tip }) {
  const [done, setDone] = useState(false)
  return (
    <button className="btn sm" data-act={act} data-tip={tip} onClick={async () => { await window.knight.shell.copy(text); setDone(true); setTimeout(() => setDone(false), 1800) }}>
      {done ? 'Copied ✓' : label}
    </button>
  )
}

/** How far someone has got with a video, in a few words and a bar. */
function Progress ({ p }) {
  const label = p.completed ? 'Completed' : p.opened ? `${p.percent}% watched` : 'Not opened yet'
  return (
    <div className="sh-progress" data-state={p.completed ? 'done' : p.opened ? 'part' : 'none'}>
      <div className="sh-bar"><i style={{ width: `${p.completed ? 100 : p.percent || 0}%` }} /></div>
      <span>{label}{p.lastWatched ? ` · ${ago(p.lastWatched)}` : ''}</span>
    </div>
  )
}

/* ------------------------------------------------------------- account tab */

/** Settings → Account: sign in with an emailed code. */
export function AccountTab ({ onChanged }) {
  const [st, setSt] = useState(null)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [name, setName] = useState('')
  useEffect(() => { window.knight.cloud.status().then(setSt).catch(() => {}) }, [])
  if (!st) return null
  const run = async fn => { setBusy(true); setMsg(null); try { await fn() } catch (e) { setMsg({ kind: 'err', text: clean(e) }) } finally { setBusy(false) } }
  const done = next => { setSt(next); onChanged && onChanged(next) }

  return (
    <>
      <section>
        <h3>Account</h3>
        <p className="set-help">
          Sign in to share videos with people the way you would share a file in Google Drive: add them by email, and see who has watched and how much.
          The people you share with sign in from their browser — they never need this app.
        </p>
      </section>

      <section className="db-card" data-conn="account">
        <div className="row" style={{ gap: 9 }}>
          <i className={`perm-dot ${st.signedIn ? 'on' : 'optional'}`} />
          <h3>{st.signedIn ? st.email : 'Not signed in'}</h3>
          {st.signedIn && <span className="set-help" data-conn-state>{st.role === 'admin' ? 'Admin' : 'Member'} of {st.workspace}</span>}
        </div>

        {!st.enabled && <p className="set-help" data-act="account-off">Sharing with people is not switched on in this copy of the app.</p>}

        {st.enabled && !st.signedIn && !sentTo && (
          <>
            <div className="field">
              <span className="label">Your email</span>
              <input className="input" data-field="email" type="email" value={email} placeholder="you@company.com"
                onChange={e => setEmail(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && email.trim()) e.currentTarget.nextSibling?.click() }} />
            </div>
            <div><button className="btn sm primary" data-act="account-send" disabled={busy || !email.trim()}
              onClick={() => run(async () => { const r = await window.knight.cloud.requestCode(email); setSentTo(r.email) })}>
              {busy ? 'Sending…' : 'Email me a sign-in code'}
            </button></div>
            <span className="set-help">No password. A six-digit code is emailed to you; type it here.</span>
          </>
        )}

        {st.enabled && !st.signedIn && sentTo && (
          <>
            <div className="notice ok">A six-digit code is on its way to <b>{sentTo}</b>. It can take a minute; check spam if it does not arrive.</div>
            <div className="field">
              <span className="label">Sign-in code</span>
              <input className="input" data-field="code" inputMode="numeric" value={code} placeholder="123456" style={{ letterSpacing: '0.3em', maxWidth: 180 }}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))} />
            </div>
            <div className="row">
              <button className="btn sm primary" data-act="account-verify" disabled={busy || code.length < 6}
                onClick={() => run(async () => { done(await window.knight.cloud.verify(sentTo, code)); setSentTo(null); setCode(''); setEmail('') })}>
                {busy ? 'Checking…' : 'Sign in'}
              </button>
              <button className="btn sm ghost" disabled={busy} onClick={() => { setSentTo(null); setCode(''); setMsg(null) }}>Use a different email</button>
            </div>
          </>
        )}

        {st.signedIn && (
          <>
            <p className="set-help">
              {st.role === 'admin'
                ? 'As an admin you see every shared video, every viewer and every team member in this workspace. Open Sharing from the library to manage them.'
                : `You see and manage the videos you share. Admins of ${st.workspace} can see everyone’s.`}
            </p>
            {st.role === 'admin' && (
              <div className="field">
                <span className="label">Workspace name — shown to people you share with</span>
                <div className="row">
                  <input className="input" data-field="workspace" value={name} placeholder={st.workspace} onChange={e => setName(e.target.value)} />
                  <button className="btn sm" data-act="account-rename" disabled={busy || !name.trim()}
                    onClick={() => run(async () => { await window.knight.cloud.renameWorkspace(name); setName(''); done(await window.knight.cloud.refresh()) })}>Save</button>
                </div>
              </div>
            )}
            <Toggle label="Add each export to my shared videos" checked={st.auto !== false}
              tip="Uploads every export so it is ready to share. Nobody can see it until you share it. Each video can be switched off on its own in the Export panel."
              onChange={async v => done(await window.knight.cloud.save({ auto: v }))} />
            <div><button className="btn sm ghost" data-act="account-signout" onClick={() => run(async () => done(await window.knight.cloud.signOut()))}>Sign out</button></div>
          </>
        )}
        {msg && <div className={`notice ${msg.kind}`} data-act="account-msg">{msg.text}</div>}
      </section>
    </>
  )
}

/* ------------------------------------------------------------- share dialog */

/**
 * The Share box, for one video. Add people, choose who can open the link, see who has
 * watched. `videoId` is the video's id on the sharing service.
 */
export function ShareDialog ({ videoId, onClose }) {
  const [info, setInfo] = useState(null)
  const [emails, setEmails] = useState('')
  const [required, setRequired] = useState(false)
  const [scope, setScope] = useState('video')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [links, setLinks] = useState(null)

  const load = useCallback(async () => {
    try { setInfo(await window.knight.cloud.sharing(videoId)) } catch (e) { setMsg({ kind: 'err', text: clean(e) }) }
  }, [videoId])
  useEffect(() => { load() }, [load])
  useEffect(() => { window.knight.cloud.links(videoId).then(setLinks).catch(() => {}) }, [videoId])
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const run = async fn => { setBusy(true); setMsg(null); try { await fn(); await load() } catch (e) { setMsg({ kind: 'err', text: clean(e) }) } finally { setBusy(false) } }
  const add = () => run(async () => {
    const n = await window.knight.cloud.share(videoId, emails, { required, folder: scope === 'folder' })
    setEmails('')
    setMsg({ kind: 'ok', text: `Shared with ${n} ${n === 1 ? 'person' : 'people'}. Send them the link below — they sign in with their email to watch.` })
  })

  const people = info?.people || []
  const req = people.filter(p => p.required)
  const mail = links && people.length
    ? `mailto:${people.map(p => p.email).join(',')}?subject=${encodeURIComponent(info.title)}&body=${encodeURIComponent(`I've shared a video with you: ${info.title}\n\n${links.url}\n\nOpen the link and sign in with this email address to watch it.`)}`
    : null

  return (
    <div className="modal-back" data-act="share-dialog" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal sheet">
        <div className="modal-body">
          <div className="row between">
            <h3>Share “{info?.title || '…'}”</h3>
            <button className="btn sm ghost" data-act="share-close" onClick={onClose}>Done</button>
          </div>

          {info && (
            <>
              <section>
                <div className="field">
                  <span className="label">Add people</span>
                  <textarea className="input" data-field="share-emails" rows={2} value={emails} placeholder="Email addresses, separated by commas or spaces"
                    onChange={e => setEmails(e.target.value)} />
                </div>
                {info.folder && (
                  <div className="seg" data-act="share-scope">
                    <button className={scope === 'video' ? 'on' : ''} onClick={() => setScope('video')}>Just this video</button>
                    <button className={scope === 'folder' ? 'on' : ''} data-tip="They get every video you share from this folder, including ones you add later."
                      onClick={() => setScope('folder')}>Everything in “{info.folder}”</button>
                  </div>
                )}
                <Toggle label="Required viewing" checked={required} onChange={setRequired}
                  tip="Marks it as something they must watch, and tracks who has finished. It counts as finished at 90% watched — skipping ahead does not count." />
                <div><button className="btn sm primary" data-act="share-add" disabled={busy || !emails.trim()} onClick={add}>Share</button></div>
              </section>

              <section>
                <div className="field">
                  <span className="label">Who can open the link</span>
                  <select className="select" data-act="share-access" value={info.access} disabled={busy}
                    onChange={e => run(() => window.knight.cloud.setAccess(videoId, e.target.value))}>
                    <option value="invited">Only people you have added — they sign in with their email</option>
                    <option value="link">Anyone with the link — no sign-in</option>
                  </select>
                </div>
                {links && (
                  <>
                    <div className="share-link" data-act="cloud-link">{links.url}</div>
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      <CopyButton text={links.url} label="Copy link" act="cloud-copy" />
                      {info.access === 'link' && <CopyButton text={links.embed} label="Copy embed code" act="cloud-embed" tip="Paste into any web page to show the video there." />}
                      {mail && <button className="btn sm" data-act="cloud-mail" data-tip="Opens your email app with the link and everyone’s address filled in." onClick={() => window.knight.shell.openExternal(mail)}>Email them the link</button>}
                      <button className="btn sm ghost" onClick={() => window.knight.shell.openExternal(links.url)}>Open</button>
                    </div>
                    {info.access === 'invited' && <span className="set-help">Embedding is available when the link is open to anyone.</span>}
                  </>
                )}
              </section>

              <section>
                <div className="row between">
                  <span className="label">People with access ({people.length})</span>
                  {req.length > 0 && <span className="set-help" data-act="share-required-count">{req.filter(p => p.completed).length} of {req.length} required viewers finished</span>}
                </div>
                {!people.length && <p className="set-help">Nobody yet. {info.access === 'link' ? 'Anyone with the link can watch.' : 'Only you can watch until you add someone.'}</p>}
                <div className="sh-list" data-act="share-people">
                  {people.map(p => (
                    <div key={p.email} className="sh-row" data-email={p.email}>
                      <div className="sh-who">
                        <b>{p.email}</b>
                        <span>{p.via === 'folder' ? `Through the folder “${info.folder}”` : 'This video'}{p.required ? ' · Required' : ''}</span>
                      </div>
                      <Progress p={p} />
                      <button className="btn sm ghost" data-act="share-remove-person" disabled={busy} data-tip={p.via === 'folder' ? 'Removes them from the whole folder' : 'Stops them watching this video'}
                        onClick={() => run(() => window.knight.cloud.unshare(videoId, p.email, p.via === 'folder'))}>Remove</button>
                    </div>
                  ))}
                </div>
                <div className="sh-totals" data-act="share-totals">
                  <div><b>{info.totals.views}</b><span>view{info.totals.views === 1 ? '' : 's'}</span></div>
                  <div><b>{mmss(info.totals.avgSeconds)}</b><span>average watch time</span></div>
                  <div><b>{info.totals.avgPercent}%</b><span>of the video watched</span></div>
                </div>
                <div><button className="btn sm ghost" data-act="share-reload" disabled={busy} onClick={() => run(async () => {})}>Refresh</button></div>
              </section>
            </>
          )}
          {msg && <div className={`notice ${msg.kind}`} data-act="share-msg">{msg.text}</div>}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------- sharing (admin / user) */

/**
 * The Sharing screen. A member sees the videos they have shared. An admin sees the
 * whole workspace: every video, every person anything is shared with, and the team.
 */
export function SharingScreen ({ onClose, onOpenSettings }) {
  const [st, setSt] = useState(null)
  const [tab, setTab] = useState('videos')
  const [videos, setVideos] = useState(null)
  const [people, setPeople] = useState(null)
  const [team, setTeam] = useState(null)
  const [open, setOpen] = useState(null)          // video id whose share box is open
  const [expanded, setExpanded] = useState(null)  // person email
  const [invite, setInvite] = useState({ email: '', role: 'member' })
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')

  const load = useCallback(async () => {
    setMsg(null)
    try {
      const s = await window.knight.cloud.refresh()
      setSt(s)
      if (!s.signedIn) return
      setVideos(await window.knight.cloud.videos())
      if (s.role === 'admin') { setPeople(await window.knight.cloud.people()); setTeam(await window.knight.cloud.team()) }
    } catch (e) {
      setSt(await window.knight.cloud.status())
      setMsg({ kind: 'err', text: clean(e) })
    }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && !open) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, open])

  const run = async fn => { setBusy(true); setMsg(null); try { await fn(); await load() } catch (e) { setMsg({ kind: 'err', text: clean(e) }) } finally { setBusy(false) } }
  const admin = st?.role === 'admin'
  const tabs = admin ? [['videos', 'Videos', 'grid'], ['people', 'People', 'inbox'], ['team', 'Team', 'brand']] : [['videos', 'My videos', 'grid']]
  const shown = (videos || []).filter(v => !filter || `${v.title} ${v.owner} ${v.folder}`.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="modal-back" data-act="sharing-screen" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <nav className="modal-nav">
          <h2>Sharing</h2>
          {tabs.map(([id, label, icon]) => (
            <button key={id} className={`folder ${tab === id ? 'on' : ''}`} data-sharing-tab={id} onClick={() => setTab(id)}>
              <Icon name={icon} /><span className="folder-name">{label}</span>
            </button>
          ))}
          {st?.signedIn && <div className="sh-role" data-act="sharing-role"><b>{admin ? 'Admin view' : 'Your view'}</b><span>{st.workspace}</span><span>{st.email}</span></div>}
          <button className="btn modal-close" onClick={onClose}>Done</button>
        </nav>
        <div className="modal-body">
          {st && !st.enabled && <section><h3>Sharing</h3><p className="set-help">Sharing with people is not switched on in this copy of the app.</p></section>}
          {st?.enabled && !st.signedIn && (
            <section>
              <h3>Sign in to share</h3>
              <p className="set-help">Share videos with people by email, and see who has watched and how much.</p>
              <div><button className="btn sm primary" data-act="sharing-signin" onClick={() => { onClose(); onOpenSettings('account') }}>Sign in</button></div>
            </section>
          )}

          {st?.signedIn && tab === 'videos' && (
            <section>
              <div className="row between">
                <h3>{admin ? 'Every shared video in the workspace' : 'Videos you have shared'}</h3>
                <input className="input" style={{ maxWidth: 200 }} placeholder="Search" value={filter} onChange={e => setFilter(e.target.value)} />
              </div>
              {!admin && <p className="set-help">Admins of {st.workspace} can see everyone’s videos. You see your own.</p>}
              {videos && !videos.length && <p className="set-help" data-act="sharing-empty">Nothing here yet. Export a video and press Share in the Export panel.</p>}
              <div className="sh-list" data-act="sharing-videos">
                {shown.map(v => (
                  <div key={v.id} className="sh-row video" data-video={v.id}>
                    <div className="sh-who">
                      <b>{v.title}</b>
                      <span>
                        {admin && !v.mine ? `${v.owner} · ` : ''}{v.folder ? `${v.folder} · ` : ''}{mmss(v.duration)} · {v.access === 'link' ? 'Anyone with the link' : `${v.people} ${v.people === 1 ? 'person' : 'people'}`}
                      </span>
                    </div>
                    <div className="sh-nums">
                      <span><b>{v.views}</b> view{v.views === 1 ? '' : 's'}</span>
                      <span><b>{v.avgPercent}%</b> watched</span>
                      {v.required > 0 && <span data-required><b>{v.completed}/{v.required}</b> finished</span>}
                    </div>
                    <button className="btn sm" data-act="sharing-open" onClick={() => setOpen(v.id)}>Share</button>
                    <button className="btn sm ghost" data-act="sharing-delete" disabled={busy} data-tip="Takes it off the sharing service. Every link to it stops working. The video on your Mac is untouched."
                      onClick={() => run(() => window.knight.cloud.remove(v.id))}>Take down</button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {st?.signedIn && admin && tab === 'people' && (
            <section>
              <h3>Everyone something is shared with</h3>
              <p className="set-help">Each person, what they can watch, and how far they have got. Removing someone takes them off every video and folder at once.</p>
              {people && !people.length && <p className="set-help">Nobody yet.</p>}
              <div className="sh-list" data-act="sharing-people">
                {(people || []).map(p => (
                  <React.Fragment key={p.email}>
                    <div className="sh-row" data-email={p.email}>
                      <div className="sh-who">
                        <b>{p.email}</b>
                        <span>{p.videos} video{p.videos === 1 ? '' : 's'} · opened {p.opened}{p.lastWatched ? ` · last watched ${ago(p.lastWatched)}` : ''}</span>
                      </div>
                      <div className="sh-nums">
                        {p.required > 0
                          ? <span data-required data-state={p.completed === p.required ? 'done' : 'part'}><b>{p.completed}/{p.required}</b> required finished</span>
                          : <span>Nothing required</span>}
                      </div>
                      <button className="btn sm" data-act="people-expand" onClick={() => setExpanded(expanded === p.email ? null : p.email)}>{expanded === p.email ? 'Hide' : 'Details'}</button>
                      <button className="btn sm ghost" data-act="people-remove" disabled={busy} onClick={() => run(() => window.knight.cloud.removePerson(p.email))}>Remove access</button>
                    </div>
                    {expanded === p.email && (
                      <div className="sh-detail" data-act="people-detail">
                        {p.items.map(i => (
                          <div key={i.id} className="sh-row sub">
                            <div className="sh-who"><b>{i.title}</b><span>{i.required ? 'Required' : 'Optional'}</span></div>
                            <Progress p={{ ...i, opened: i.percent > 0 || i.completed }} />
                          </div>
                        ))}
                      </div>
                    )}
                  </React.Fragment>
                ))}
              </div>
            </section>
          )}

          {st?.signedIn && admin && tab === 'team' && (
            <section>
              <h3>Your team</h3>
              <p className="set-help">
                People who record and share videos from this workspace. They sign in to the app with the email you add here.
                A <b>member</b> sees and manages only their own videos. An <b>admin</b> sees and manages everything, including this page.
              </p>
              <div className="sh-list" data-act="sharing-team">
                {(team || []).map(m => (
                  <div key={m.email} className="sh-row" data-email={m.email}>
                    <div className="sh-who">
                      <b>{m.email}{m.you ? ' (you)' : ''}</b>
                      <span>{m.joined ? `${m.videos} video${m.videos === 1 ? '' : 's'} shared` : 'Invited — has not signed in yet'}</span>
                    </div>
                    <select className="select" data-act="team-role" style={{ maxWidth: 120 }} value={m.role} disabled={busy}
                      onChange={e => run(() => window.knight.cloud.setMember(m.email, e.target.value))}>
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                    </select>
                    <button className="btn sm ghost" data-act="team-remove" disabled={busy || m.you} onClick={() => run(() => window.knight.cloud.removeMember(m.email))}>Remove</button>
                  </div>
                ))}
              </div>
              <div className="row">
                <input className="input" data-field="team-email" type="email" placeholder="teammate@company.com" value={invite.email}
                  onChange={e => setInvite(i => ({ ...i, email: e.target.value }))} />
                <select className="select" data-field="team-role" style={{ maxWidth: 120 }} value={invite.role} onChange={e => setInvite(i => ({ ...i, role: e.target.value }))}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <button className="btn sm primary" data-act="team-add" disabled={busy || !invite.email.trim()}
                  onClick={() => run(async () => { await window.knight.cloud.setMember(invite.email, invite.role); setInvite({ email: '', role: 'member' }) })}>Add</button>
              </div>
              <span className="set-help">Tell them to install the app and sign in under Settings → Account with that email. They join this workspace automatically.</span>
            </section>
          )}
          {msg && <div className={`notice ${msg.kind}`} data-act="sharing-msg">{msg.text}</div>}
        </div>
      </div>
      {open && <ShareDialog videoId={open} onClose={() => { setOpen(null); load() }} />}
    </div>
  )
}
