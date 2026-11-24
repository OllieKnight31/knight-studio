import React, { useEffect, useState, useCallback } from 'react'
import { Toggle, Icon } from '../ui.jsx'

const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const clean = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/** A button that says "Copied ✓" for a moment after copying. */
function CopyButton ({ text, label, act, tip }) {
  const [done, setDone] = useState(false)
  return (
    <button className="btn sm" data-act={act} data-tip={tip} onClick={async () => {
      await window.knight.shell.copy(text)
      setDone(true)
      setTimeout(() => setDone(false), 1800)
    }}>{done ? 'Copied ✓' : label}</button>
  )
}

/* -------------------------------------------------------------- templates */

/** Saved looks: put one on this video, save this video's look, choose the one new videos start with. */
export function Templates ({ project, onApply }) {
  const [list, setList] = useState({ templates: [], defaultId: null })
  const [picked, setPicked] = useState('')
  const [name, setName] = useState('')
  const [note, setNote] = useState(null)
  const refresh = useCallback(next => {
    if (next) setList(next)
    else window.knight.templates.list().then(setList).catch(() => {})
  }, [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    if (!list.templates.some(t => t.id === picked)) setPicked(list.defaultId || list.templates[0]?.id || '')
  }, [list])

  const current = list.templates.find(t => t.id === picked) || null
  return (
    <div className="group" data-tour="templates">
      <span className="label">Templates</span>
      <p className="panel-sub muted">
        A template is a saved look: canvas shape, background, camera bubble, cursor and caption style. It never changes your cuts or text.
      </p>
      {list.templates.length > 0 && (
        <>
          <select className="select" data-act="template-pick" value={picked} onChange={e => setPicked(e.target.value)}>
            {list.templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' — used for new videos' : ''}</option>)}
          </select>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn sm" data-act="template-apply" disabled={!current}
              data-tip="Puts this look on the video you have open. Undo with ⌘Z."
              onClick={async () => { if (await onApply(picked)) setNote(`“${current.name}” applied.`) }}>Apply to this video</button>
            <button className="btn sm ghost" data-act="template-delete" disabled={!current}
              onClick={async () => { refresh(await window.knight.templates.remove(picked)); setNote('Template deleted.') }}>Delete</button>
          </div>
          {current && (
            <Toggle label="Start every new video with this"
              tip="New recordings open with this look already applied."
              checked={list.defaultId === picked}
              onChange={async v => refresh(await window.knight.templates.setDefault(v ? picked : null))} />
          )}
        </>
      )}
      <div className="row">
        <input className="input" data-act="template-name" placeholder="Name this look, e.g. Client walkthrough" value={name}
          onChange={e => setName(e.target.value)} />
        <button className="btn sm" data-act="template-save" disabled={!name.trim()}
          data-tip="Saves how this video looks right now as a template you can reuse."
          onClick={async () => {
            try {
              // The template is read from the saved project, so save first.
              await new Promise(r => setTimeout(r, 400))
              const res = await window.knight.templates.save(name, project.id)
              refresh(res)
              setPicked(res.saved)
              setNote(res.replaced ? `“${name.trim()}” updated.` : `“${name.trim()}” saved.`)
              setName('')
            } catch (e) { setNote(clean(e)) }
          }}>Save</button>
      </div>
      {note && <span className="val" data-act="template-note">{note}</span>}
    </div>
  )
}

/* ------------------------------------------- summary, chapters, written SOP */

export function WriteUp ({ project, prefs, savePrefs, set, seek, aiState, onWriteUp, sopState, onBuildSop, exportedPath, onOpenSettings }) {
  const [hasKey, setHasKey] = useState(null)
  useEffect(() => { window.knight.ai.status().then(s => setHasKey(!!s.any)).catch(() => setHasKey(false)) }, [prefs])
  const ai = project.ai || null
  const setAi = patch => set({ ai: { ...ai, ...patch } })
  const chapterLines = (ai?.chapters || []).map(c => `${mmss(c.start)} ${c.title}`).join('\n')

  return (
    <div className="group" data-tour="writeup">
      <span className="label">Summary, chapters and written SOP</span>
      {hasKey === false
        ? (
          <>
            <p className="panel-sub muted">Have the summary, chapters and a step-by-step document written for you from what was said. It needs an AI key.</p>
            <button className="btn sm" onClick={() => onOpenSettings('captions')}><Icon name="settings" width="14" height="14" />Add an AI key</button>
          </>
          )
        : (
          <>
            <p className="panel-sub muted">
              Written from the transcript of the finished video. Only the words are sent — never the video.
            </p>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn sm" data-act="writeup" disabled={aiState?.busy}
                data-tip="Reads the transcript and writes a summary, chapters and the steps of the procedure."
                onClick={() => onWriteUp()}>
                {aiState?.busy ? 'Reading the transcript…' : ai ? 'Write it again' : 'Write summary and chapters'}
              </button>
              {ai?.chapters?.length > 0 && <CopyButton text={chapterLines} label="Copy chapters" act="copy-chapters" tip="In the form YouTube understands: 0:00 Title" />}
            </div>
            {aiState?.error && <span className="val" data-act="writeup-error" style={{ color: 'var(--rec)' }}>{aiState.error}</span>}

            {ai && (
              <>
                <textarea className="input writeup-summary" data-act="summary" rows={4} value={ai.summary || ''}
                  placeholder="Summary" onChange={e => setAi({ summary: e.target.value })} />
                {ai.chapters?.length > 0 && (
                  <div className="chapter-list" data-act="chapters">
                    {ai.chapters.map((c, i) => (
                      <div key={i} className="chapter-row">
                        <button className="chapter-time" data-tip="Jump to this chapter" onClick={() => seek(c.start)}>{mmss(c.start)}</button>
                        <input className="input" value={c.title}
                          onChange={e => setAi({ chapters: ai.chapters.map((x, j) => j === i ? { ...x, title: e.target.value } : x) })} />
                        <button className="btn sm ghost" style={{ padding: '2px 7px' }} data-tip="Remove this chapter" disabled={i === 0}
                          onClick={() => setAi({ chapters: ai.chapters.filter((_, j) => j !== i) })}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            <Toggle label="Write these on every export"
              tip="After each export the summary and chapters are written first, so the share page, your databases and your webhook all get them."
              checked={!!prefs.ai?.writeUpOnExport}
              onChange={v => savePrefs({ ai: { writeUpOnExport: v } })} />

            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn sm" data-act="sop" disabled={sopState?.busy || aiState?.busy}
                data-tip={exportedPath
                  ? 'Turns the video into a numbered document, with a screenshot of your screen at each step. Saved beside the exported video.'
                  : 'Turns the video into a numbered document. Export the video first and each step gets a screenshot.'}
                data-tip-title="Written SOP"
                onClick={() => onBuildSop(exportedPath)}>
                {sopState?.busy ? 'Writing the SOP…' : 'Create written SOP'}
              </button>
              {sopState?.pdf && <button className="btn sm" data-act="sop-open" onClick={() => window.knight.shell.open(sopState.pdf)}>Open PDF</button>}
              {sopState?.html && !sopState.pdf && <button className="btn sm" onClick={() => window.knight.shell.open(sopState.html)}>Open</button>}
              {sopState?.html && <button className="btn sm ghost" onClick={() => window.knight.shell.reveal(sopState.pdf || sopState.html)}>Show in Finder</button>}
            </div>
            {sopState?.error && <span className="val" data-act="sop-error" style={{ color: 'var(--rec)' }}>{sopState.error}</span>}
            {sopState?.html && (
              <span className="val" data-act="sop-done" style={{ color: 'var(--ok)' }}>
                ✓ {sopState.steps} step{sopState.steps === 1 ? '' : 's'}{sopState.pictures ? `, ${sopState.pictures} with a screenshot` : ', no screenshots — export the video first to include them'}
              </span>
            )}
          </>
          )}
    </div>
  )
}

/* ------------------------------------------------------------ share page */

export function SharePage ({ project, set, status, state, onPublish, onUnpublish, onOpenSettings, busy }) {
  const [stats, setStats] = useState(null)
  const [statsError, setStatsError] = useState(null)
  const [loading, setLoading] = useState(false)
  const share = project.share || null

  const loadStats = useCallback(async () => {
    if (!share?.id) return
    setLoading(true)
    try { setStats(await window.knight.share.stats(share.id)); setStatsError(null) } catch (e) { setStatsError(clean(e)) } finally { setLoading(false) }
  }, [share?.id])
  useEffect(() => { setStats(null); loadStats() }, [share?.id, share?.updatedAt])

  if (!status) return null
  if (!status.ready) {
    return (
      <div className="group" data-tour="share">
        <span className="label">Share page</span>
        <p className="panel-sub muted">
          Give people a link to watch this video, with its chapters and transcript — and see how many watched and for how long. It can be embedded in any page too.
        </p>
        <button className="btn sm" data-act="share-setup" onClick={() => onOpenSettings('share')}><Icon name="link" width="14" height="14" />Set up share pages</button>
      </div>
    )
  }

  const on = project.sharePage !== false && status.auto !== false
  return (
    <div className="group" data-tour="share">
      <span className="label">Share page</span>
      <Toggle label="Make a share page after export" checked={on} onChange={v => set({ sharePage: v })}
        tip="A link anyone can open to watch the video. Exporting again updates the same link." />
      {status.auto === false && <p className="panel-sub muted">Share pages are switched off in Settings.</p>}

      {share
        ? (
          <>
            <div className="share-link" data-act="share-link" data-tip="The link to send people">{share.url}</div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <CopyButton text={share.url} label="Copy link" act="share-copy" />
              <CopyButton text={share.embed} label="Copy embed code" act="share-embed"
                tip="Paste this into a web page, Notion, GHL or any site builder to show the video there." />
              <button className="btn sm" data-act="share-open" onClick={() => window.knight.shell.openExternal(share.url)}>Open</button>
            </div>
            {share.reduced && <span className="val" data-act="share-reduced">A smaller copy is shared, because the full-size file is larger than your Supabase storage allows.</span>}
            <div className="share-stats" data-act="share-stats">
              {statsError
                ? <span className="val" style={{ color: 'var(--rec)' }}>{statsError}</span>
                : !status.counting
                    ? <span className="val">Views are not being counted — add the public key in Settings → Share pages.</span>
                    : stats
                      ? (
                        <>
                          <div><b>{stats.views}</b><span>view{stats.views === 1 ? '' : 's'}</span></div>
                          <div><b>{mmss(stats.avgSeconds)}</b><span>average watch time</span></div>
                          <div><b>{Math.round(stats.avgPercent)}%</b><span>of the video watched</span></div>
                        </>
                        )
                      : <span className="val">Loading the numbers…</span>}
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn sm ghost" data-act="share-refresh" disabled={loading} onClick={loadStats}>{loading ? 'Refreshing…' : 'Refresh numbers'}</button>
              <button className="btn sm ghost" data-act="share-republish" disabled={busy || state?.busy || !project.lastExport?.path}
                data-tip="Uploads the last export again, with the current title, summary and chapters. The link stays the same."
                onClick={() => onPublish()}>{state?.busy ? 'Updating…' : 'Update page'}</button>
              <button className="btn sm ghost" data-act="share-remove" disabled={state?.busy}
                data-tip="The link stops working. The video on your Mac is untouched."
                onClick={() => onUnpublish()}>Take down</button>
            </div>
          </>
          )
        : project.lastExport?.path && (
          <button className="btn sm" data-act="share-now" disabled={busy || state?.busy} onClick={() => onPublish()}>
            {state?.busy ? `${state.phase === 'making a smaller copy' ? 'Making a smaller copy' : 'Uploading'}…` : 'Share the last export now'}
          </button>
          )}
      {state?.busy && share && <span className="val">{state.phase}…</span>}
      {state?.error && <span className="val" data-act="share-error" style={{ color: 'var(--rec)' }}>{state.error}</span>}
    </div>
  )
}

/* ------------------------------------------------------ sharing with people */

/** The Export panel's "Share with people" group: Drive-style sharing through the sharing service. */
export function CloudShare ({ project, set, status, state, busy, onOpenShare, onPublish, onRemove, onOpenSettings }) {
  if (!status?.enabled) return null
  const cloud = project.cloud || null
  if (!status.signedIn) {
    return (
      <div className="group" data-tour="cloud-share">
        <span className="label">Share with people</span>
        <p className="panel-sub muted">Share this video by email, the way you would a file in Google Drive, and see who has watched it and how much.</p>
        <button className="btn sm" data-act="cloud-signin" onClick={() => onOpenSettings('account')}><Icon name="inbox" width="14" height="14" />Sign in to share</button>
      </div>
    )
  }
  const on = project.cloudShare !== false && status.auto !== false
  return (
    <div className="group" data-tour="cloud-share">
      <span className="label">Share with people</span>
      <Toggle label="Keep the shared copy up to date" checked={on} onChange={v => set({ cloudShare: v })}
        tip="After each export the new version replaces the old one behind the same link. Nobody can see it until you share it." />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn sm primary" data-act="cloud-share" disabled={busy || state?.busy || (!cloud && !project.lastExport?.path)}
          data-tip="Add people by email, choose who can open the link, and see who has watched."
          onClick={() => onOpenShare()}>
          <Icon name="link" width="14" height="14" />{state?.busy ? `${state.phase === 'making a smaller copy' ? 'Making a smaller copy' : 'Uploading'}…` : 'Share…'}
        </button>
        {cloud && <CopyButton text={cloud.url} label="Copy link" act="cloud-copy-link" />}
        {cloud && project.lastExport?.path && (
          <button className="btn sm ghost" data-act="cloud-update" disabled={busy || state?.busy} data-tip="Uploads the last export again, with the current title, summary and chapters."
            onClick={() => onPublish()}>Update</button>
        )}
        {cloud && <button className="btn sm ghost" data-act="cloud-remove" disabled={state?.busy} data-tip="Takes it off the sharing service. The link stops working for everyone."
          onClick={() => onRemove()}>Take down</button>}
      </div>
      {!cloud && !project.lastExport?.path && <p className="panel-sub muted">Export the video first, then share it.</p>}
      {cloud?.reduced && <span className="val">A smaller copy is shared, because the full-size file is over the size limit.</span>}
      {state?.error && <span className="val" data-act="cloud-error" style={{ color: 'var(--rec)' }}>{state.error}</span>}
      <p className="panel-sub muted">Signed in as {status.email}{status.role === 'admin' ? ' · admin' : ''} of {status.workspace}.</p>
    </div>
  )
}

/* ------------------------------------------------ share page in Google Drive */

/** A branded page to send people, made from the copy of the video already in Google Drive. */
export function DriveSharePage ({ project, set, state, busy, onPublish, onUnpublish, uploadsOff }) {
  const page = project.driveShare || null
  const canMake = !!(project.drive?.fileId || project.lastExport?.path)
  return (
    <div className="group" data-tour="drive-share">
      <span className="label">Share page</span>
      <Toggle label="Make a share page after export" checked={project.drivePage !== false && !uploadsOff} onChange={v => set({ drivePage: v })}
        tip="A link that opens the video on a page in your colours, with its chapters and transcript. The video plays from your Google Drive. Exporting again updates the same link." />
      {uploadsOff && <p className="panel-sub muted">Switch on “Upload this video after export” above — the share page plays the copy in Google Drive.</p>}
      {page
        ? (
          <>
            <div className="share-link" data-act="drive-share-link">{page.url}</div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <CopyButton text={page.url} label="Copy link" act="drive-share-copy" />
              <CopyButton text={page.embed} label="Copy embed code" act="drive-share-embed" tip="Paste into any web page, Notion or site builder to show the video there." />
              <button className="btn sm" data-act="drive-share-open" onClick={() => window.knight.shell.openExternal(page.url)}>Open</button>
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn sm ghost" data-act="drive-share-update" disabled={busy || state?.busy}
                data-tip="Refreshes the page with the current title, summary and chapters. The link stays the same."
                onClick={() => onPublish()}>{state?.busy ? 'Updating…' : 'Update page'}</button>
              <button className="btn sm ghost" data-act="drive-share-remove" disabled={state?.busy}
                data-tip="The link stops working. The video stays in your Google Drive."
                onClick={() => onUnpublish()}>Take down</button>
            </div>
            {page.ready === false
              ? <span className="val" data-act="drive-share-wait">Google Drive is still preparing the video for playback. The link works now; the video will play in a few minutes.</span>
              : page.pendingVideoId
                ? <span className="val" data-act="drive-share-wait">The page is showing the previous version until Google Drive finishes preparing the new one — usually a few minutes.</span>
                : <span className="val" data-act="drive-share-ready" style={{ color: 'var(--ok)' }}>✓ Ready to watch</span>}
            <p className="panel-sub muted">Anyone with the link can watch. Views are not counted on Drive share pages.</p>
          </>
          )
        : canMake && (
          <button className="btn sm" data-act="drive-share-now" disabled={busy || state?.busy} onClick={() => onPublish()}>
            {state?.busy ? (state.phase === 'uploading' ? 'Uploading to Drive…' : 'Making the page…') : 'Make the share page now'}
          </button>
          )}
      {!page && !canMake && <p className="panel-sub muted">Export the video and its share page is made for you.</p>}
      {state?.error && <span className="val" data-act="drive-share-error" style={{ color: 'var(--rec)' }}>{state.error}</span>}
    </div>
  )
}
