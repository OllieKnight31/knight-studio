import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Brand, Icon } from '../ui.jsx'
import { fileURL } from '../theme.js'
import { requestTour } from '../tour.jsx'

const when = iso => {
  if (!iso) return ''
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return d.toLocaleDateString()
}

const clock = s => {
  const t = Math.max(0, Math.round(s || 0))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

const ALL = '__all'
const UNFILED = '__unfiled'

/**
 * A card that shows a still frame, and flips through snapshots taken further into the
 * video while the pointer is over it — so you can tell what a recording is without
 * opening it. Drag it onto a folder in the sidebar to file it.
 */
function ProjectCard ({ project, folderName, onOpen, onDelete, onMoveMenu, onShare, sharing }) {
  const [thumbs, setThumbs] = useState(null)
  const [frame, setFrame] = useState(-1)      // -1 = poster
  const timer = useRef(null)

  useEffect(() => {
    let alive = true
    if (!project.firstClipDir) return
    window.knight.projects.thumbs(project.firstClipDir)
      .then(t => { if (alive) setThumbs(t) })
      .catch(() => {})
    return () => { alive = false }
  }, [project.firstClipDir])

  const previews = thumbs?.previews || []

  const enter = () => {
    if (!previews.length) return
    let i = 0
    setFrame(0)
    timer.current = setInterval(() => {
      i = (i + 1) % previews.length
      setFrame(i)
    }, 900)
  }
  const leave = () => {
    clearInterval(timer.current)
    timer.current = null
    setFrame(-1)
  }
  useEffect(() => () => clearInterval(timer.current), [])

  const shown = frame >= 0 && previews[frame] ? previews[frame].path : thumbs?.poster
  const label = frame >= 0 && previews[frame] ? `${clock(previews[frame].t)}` : null

  return (
    <button className="card" draggable onClick={() => onOpen(project.id)} onMouseEnter={enter} onMouseLeave={leave}
      onDragStart={e => {
        e.dataTransfer.setData('text/knight-project', project.id)
        e.dataTransfer.effectAllowed = 'move'
      }}>
      <div className="card-thumb">
        {shown
          ? <img src={fileURL(shown)} alt="" draggable={false} />
          : <span className="card-thumb-fallback">◉</span>}
        {project.duration > 0 && <span className="card-time">{clock(project.duration)}</span>}
        {label && <span className="card-scrub">{label}</span>}
        {previews.length > 0 && (
          <span className="card-dots">
            {previews.map((_, i) => <i key={i} className={i === frame ? 'on' : ''} />)}
          </span>
        )}
      </div>
      <div className="card-body">
        <div className="card-text">
          <div className="card-title">{project.name}</div>
          <div className="card-meta muted">
            {project.clips} clip{project.clips === 1 ? '' : 's'} · {when(project.updatedAt)}
            {folderName && <> · <span className="card-folder">{folderName}</span></>}
          </div>
        </div>
        <span className={`card-share ${project.shared ? 'on' : ''}`} role="button" data-act="card-share" data-project={project.id}
          data-tip={project.shared ? 'Open sharing for this video: who has it, the link, who has watched' : 'Share this video'} data-tip-title="Share"
          onClick={e => { e.stopPropagation(); if (!sharing) onShare(project) }}>
          <Icon name="link" />{sharing ? (typeof sharing === 'string' ? sharing : 'Sharing…') : project.shared ? 'Shared' : 'Share'}
        </span>
      </div>
      <span className="card-move" data-tip="Move this video to a folder"
        onClick={e => { e.stopPropagation(); onMoveMenu(e, project) }}><Icon name="folder" /></span>
      <span className="card-del" data-tip="Delete this recording for good"
        onClick={e => onDelete(e, project.id)}>✕</span>
    </button>
  )
}

/** One row in the sidebar: a folder you can open, drop videos on, rename or remove. */
function FolderRow ({ icon, name, count, active, synced, onClick, onDropProject, onRename, onDelete, onCheck }) {
  const [over, setOver] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  const commit = () => {
    setEditing(false)
    if (draft.trim() && draft.trim() !== name) onRename(draft.trim())
    else setDraft(name)
  }

  return (
    <button className={`folder ${active ? 'on' : ''} ${over ? 'drop' : ''}`} onClick={onClick}
      onDragOver={e => { if (onDropProject) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        setOver(false)
        const id = e.dataTransfer.getData('text/knight-project')
        if (id && onDropProject) { e.preventDefault(); onDropProject(id) }
      }}>
      <Icon name={icon} />
      {editing
        ? <input autoFocus value={draft} onClick={e => e.stopPropagation()}
            onChange={e => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') { setDraft(name); setEditing(false) }
            }} />
        : <span className="folder-name">{name}</span>}
      {synced && !editing && <i className="drive-dot" data-tip="This folder also exists in Google Drive" />}
      {!editing && <span className="folder-count">{count}</span>}
      {onRename && !editing && (
        <span className="folder-actions">
          {onCheck && <span data-tip="Check this folder exists in Google Drive" onClick={e => { e.stopPropagation(); onCheck() }}><Icon name="drive" /></span>}
          <span data-tip="Rename" onClick={e => { e.stopPropagation(); setDraft(name); setEditing(true) }}><Icon name="pencil" /></span>
          <span data-tip="Delete the folder — its videos are kept" onClick={e => { e.stopPropagation(); onDelete() }}><Icon name="trash" /></span>
        </span>
      )}
    </button>
  )
}

export default function Library ({ prefs, onNew, onOpen, onOpenSettings, onOpenSharing, onOpenShare }) {
  const [projects, setProjects] = useState([])
  const [folders, setFolders] = useState([])
  const [loading, setLoading] = useState(true)
  const [current, setCurrent] = useState(ALL)
  const [menu, setMenu] = useState(null)          // { x, y, project }
  const [drive, setDrive] = useState(null)
  const [notice, setNotice] = useState(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  const refresh = useCallback(async () => {
    const [list, lib] = await Promise.all([window.knight.projects.list(), window.knight.library.get()])
    setProjects(list)
    setFolders(lib.folders)
    setLoading(false)
  }, [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { window.knight.drive.status().then(setDrive).catch(() => {}) }, [])

  // A recording that finishes titling or thumbnailing in the background should show up
  // without needing a manual refresh.
  useEffect(() => window.knight.projects.onFinalise(({ phase }) => {
    if (phase === 'done' || phase === 'thumbnails-done') refresh()
  }), [refresh])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const remove = async (e, id) => {
    e.stopPropagation()
    await window.knight.projects.remove(id)
    refresh()
  }

  /** The Share button on a card. */
  const [sharingId, setSharingId] = useState(null)
  const [sharePhase, setSharePhase] = useState(null)
  const shareVideo = async project => {
    setSharingId(project.id); setSharePhase(null)
    const stop = window.knight.share.onProgress(({ projectId, phase }) => {
      if (projectId === project.id) setSharePhase(phase === 'making a smaller copy' ? 'Shrinking…' : 'Uploading…')
    })
    try {
      const r = await window.knight.share.forProject(project.id)
      if (r.kind === 'box') { onOpenShare && onOpenShare(r.id); refresh() }
      else if (r.kind === 'copied') { say({ kind: 'ok', text: `${r.what} copied — paste it wherever you want to send “${project.name}”.` }, 7000); refresh() }
      else if (r.kind === 'export') say(`“${project.name}” has not been exported yet. Open it, press Export, and then it can be shared.`)
      else if (r.kind === 'signin') { say('Sign in to share videos with people.', 5000); onOpenSettings('account') }
      else { say('Set up share pages first — it takes a few minutes, once.', 6000); onOpenSettings('share') }
    } catch (e) {
      say(String(e.message || e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''))
    } finally {
      stop(); setSharingId(null); setSharePhase(null)
    }
  }

  // A notice is plain text (a warning) or { kind, text, link } for a confirmation.
  const say = (note, ms = 9000) => {
    setNotice(note)
    if (note) setTimeout(() => setNotice(n => (n === note ? null : n)), ms)
  }

  const reportDrive = (name, d) => {
    if (!d || !d.connected) return
    if (d.ok) {
      say({
        kind: 'ok',
        text: d.recreated
          ? `“${name}” had gone from Google Drive, so it has been created again inside “${d.parent}”.`
          : `“${name}” is in Google Drive, inside “${d.parent}”. Checked just now.`,
        link: d.link
      })
    } else {
      say(`Google Drive could not confirm “${name}”: ${d.detail}`)
    }
  }

  const checkFolder = async f => {
    say({ kind: 'plain', text: `Checking “${f.name}” in Google Drive…` }, 30000)
    try {
      const d = await window.knight.library.verifyFolder(f.id)
      if (!d.connected) say('Google Drive is not connected, so there is nothing to check. Connect it in Settings.')
      else reportDrive(f.name, d)
      setFolders((await window.knight.library.get()).folders)
    } catch (e) { say(`Google Drive could not be reached: ${e.message}`) }
  }

  const move = async (projectId, folderId) => {
    setProjects(list => list.map(p => (p.id === projectId ? { ...p, folderId } : p)))
    const res = await window.knight.library.moveProject(projectId, folderId)
    if (res?.driveError) say(`Moved here, but Google Drive could not move the uploaded copy: ${res.driveError}`)
    refresh()
  }

  const createFolder = async () => {
    const name = newName.trim()
    setAdding(false); setNewName('')
    if (!name) return
    const res = await window.knight.library.createFolder(name)
    setFolders(res.library.folders)
    if (res.folder) setCurrent(res.folder.id)
    if (res.driveError) say(`Folder created here, but not in Google Drive: ${res.driveError}`)
    else reportDrive(name, res.drive)
  }

  const renameFolder = async (id, name) => {
    const res = await window.knight.library.renameFolder(id, name)
    setFolders(res.library.folders)
    if (res.driveError) say(`Renamed here, but not in Google Drive: ${res.driveError}`)
  }

  const deleteFolder = async id => {
    const res = await window.knight.library.deleteFolder(id)
    setFolders(res.library.folders)
    if (current === id) setCurrent(ALL)
    refresh()
  }

  const known = new Set(folders.map(f => f.id))
  const folderOf = p => (p.folderId && known.has(p.folderId) ? p.folderId : null)
  const shown = projects.filter(p =>
    current === ALL ? true : current === UNFILED ? !folderOf(p) : folderOf(p) === current)
  const currentFolder = folders.find(f => f.id === current) || null
  const heading = current === ALL ? 'All videos' : current === UNFILED ? 'Not in a folder' : currentFolder?.name || 'All videos'
  const newInto = currentFolder ? currentFolder.id : null

  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <div className="spacer drag" />
        <button className="btn ghost" data-tour="help" onClick={() => requestTour('library', true)}
          data-tip="A short walkthrough of this screen">Show me around</button>
        <button className="btn primary" onClick={() => onNew(newInto)}
          data-tip={currentFolder ? `Starts a recording filed in “${currentFolder.name}”` : 'Record your screen, with or without the camera'}>
          New recording
        </button>
      </header>

      <div className="lib-layout">
        <aside className="lib-side">
          <div className="lib-side-scroll">
            <FolderRow icon="grid" name="All videos" count={projects.length} active={current === ALL}
              onClick={() => setCurrent(ALL)} />
            <FolderRow icon="inbox" name="Not in a folder" count={projects.filter(p => !folderOf(p)).length}
              active={current === UNFILED} onClick={() => setCurrent(UNFILED)}
              onDropProject={id => move(id, null)} />

            <span className="label">Folders</span>
            {folders.map(f => (
              <FolderRow key={f.id} icon="folder" name={f.name} synced={!!f.driveId}
                count={projects.filter(p => folderOf(p) === f.id).length}
                active={current === f.id} onClick={() => setCurrent(f.id)}
                onDropProject={id => move(id, f.id)}
                onCheck={drive?.configured && drive.parent ? () => checkFolder(f) : null}
                onRename={name => renameFolder(f.id, name)}
                onDelete={() => deleteFolder(f.id)} />
            ))}
            {adding
              ? (
                <div className="folder on">
                  <Icon name="folder" />
                  <input autoFocus placeholder="Folder name" value={newName}
                    onChange={e => setNewName(e.target.value)} onBlur={createFolder}
                    onKeyDown={e => {
                      if (e.key === 'Enter') createFolder()
                      if (e.key === 'Escape') { setAdding(false); setNewName('') }
                    }} />
                </div>
                )
              : (
                <button className="folder" onClick={() => setAdding(true)}
                  data-tip={drive?.parent ? `Also creates the folder inside “${drive.parent.name}” in Google Drive` : 'Group videos by area of the business'}>
                  <Icon name="folderPlus" /><span className="folder-name">New folder</span>
                </button>
                )}
          </div>

          <div className="lib-foot">
            {drive && !drive.configured && (
              <div className="lib-drive">
                Back up exports automatically. <a style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => onOpenSettings('drive')}>Connect Google Drive</a>
              </div>
            )}
            {drive?.configured && (
              <div className="lib-drive">
                {drive.parent
                  ? <>Folders sync to <b>{drive.parent.name}</b> in Google Drive.</>
                  : <>Google Drive needs a parent folder before anything uploads. <a style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => onOpenSettings('drive')}>Choose one</a></>}
              </div>
            )}
            <button className="folder" data-act="open-sharing" onClick={() => onOpenSharing && onOpenSharing()}
              data-tip="Who your videos are shared with, and who has watched them. Admins see the whole team’s." data-tip-title="Sharing">
              <Icon name="link" /><span className="folder-name">Sharing</span>
            </button>
            <button className="folder" onClick={() => onOpenSettings('files')}
              data-tip="Where files are kept, Google Drive, sharing, captions and recording options" data-tip-title="Settings">
              <Icon name="settings" /><span className="folder-name">Settings</span>
            </button>
          </div>
        </aside>

        <main className="library">
          {notice && (typeof notice === 'string'
            ? <div className="notice warn" style={{ marginBottom: 14 }}>{notice}</div>
            : (
              <div className={`notice ${notice.kind === 'ok' ? 'ok' : ''}`} style={{ marginBottom: 14 }}>
                <div className="row between">
                  <span>{notice.kind === 'ok' ? '✓ ' : ''}{notice.text}</span>
                  {notice.link && <button className="btn sm" onClick={() => window.knight.shell.openExternal(notice.link)}>Open in Drive</button>}
                </div>
              </div>
              ))}
          {loading
            ? <div className="empty muted">Loading…</div>
            : projects.length === 0
              ? (
                <div className="empty">
                  <div className="empty-mark">◉</div>
                  <h2>No recordings yet</h2>
                  <p className="muted">Record your screen and camera, then zoom, style and export.</p>
                  <button className="btn primary" onClick={() => onNew(newInto)} style={{ marginTop: 18 }}>Start recording</button>
                </div>
                )
              : (
                <>
                  <div className="lib-head">
                    <h2>{heading}</h2>
                    <span className="muted">{shown.length} video{shown.length === 1 ? '' : 's'}</span>
                  </div>
                  {shown.length === 0
                    ? (
                      <div className="empty">
                        <h2>Nothing in here yet</h2>
                        <p className="muted">Drag a video onto this folder in the sidebar, or record a new one into it.</p>
                        <button className="btn primary" onClick={() => onNew(newInto)} style={{ marginTop: 18 }}>Record into this folder</button>
                      </div>
                      )
                    : (
                      <div className="grid">
                        {shown.map(p => (
                          <ProjectCard key={p.id} project={p}
                            folderName={current === ALL ? folders.find(f => f.id === folderOf(p))?.name : null}
                            onOpen={onOpen} onDelete={remove}
                            onShare={shareVideo} sharing={sharingId === p.id ? sharePhase || true : false}
                            onMoveMenu={(e, project) => {
                              const r = e.currentTarget.getBoundingClientRect()
                              setMenu({ x: Math.min(r.left, window.innerWidth - 210), y: r.bottom + 6, project })
                            }} />
                        ))}
                      </div>
                      )}
                </>
                )}
        </main>
      </div>

      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y }} onMouseDown={e => e.stopPropagation()}>
          <div className="menu-note">Move “{menu.project.name.slice(0, 28)}” to</div>
          {folders.map(f => (
            <button key={f.id} onClick={() => { move(menu.project.id, f.id); setMenu(null) }}>
              <Icon name={folderOf(menu.project) === f.id ? 'check' : 'folder'} />{f.name}
            </button>
          ))}
          {!folders.length && <div className="menu-note">No folders yet — add one in the sidebar.</div>}
          {folderOf(menu.project) && (
            <button onClick={() => { move(menu.project.id, null); setMenu(null) }}>
              <Icon name="inbox" />Take out of its folder
            </button>
          )}
        </div>
      )}
    </div>
  )
}
