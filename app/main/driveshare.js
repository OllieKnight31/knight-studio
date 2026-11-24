'use strict'
/**
 * Share pages that need nothing but Google Drive.
 *
 * The exported video is already uploaded to the person's Drive. A share page adds two
 * small files beside it — a description (title, summary, chapters, steps, captions,
 * brand colours) and a poster — all readable by anyone with the link. The page people
 * open is the same branded page as every other share link; it reads the description
 * from Drive and plays the video straight out of Drive in its own player.
 *
 * No database and no account beyond the Google one already connected. The price of
 * that simplicity: there is nowhere to count views, and the link is "anyone with the
 * link" — choosing exactly who may watch needs the sharing service instead.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const prefs = require('./prefs')
const drive = require('./drive')
const share = require('./share')

const FOLDER = 'Share pages (keep)'
const linkFor = id => `${share.viewerBase()}/d?m=${encodeURIComponent(id)}`
function embedFor (id, aspect) {
  const pad = (100 / (aspect || 16 / 9)).toFixed(2)
  return `<div style="position:relative;padding-bottom:${pad}%;height:0;overflow:hidden"><iframe src="${linkFor(id)}&embed=1" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`
}

/**
 * Makes (or refreshes) the share page for a video that is in Drive.
 *
 * @param {object} o
 * @param {object} o.project     the saved project
 * @param {string} o.videoId     the Drive id of the uploaded video
 * @param {string} o.parentId    the Drive parent folder chosen in Settings
 * @param {string} [o.filePath]  the exported MP4 on this Mac, for the poster
 */
async function publish ({ project, videoId, parentId, filePath, duration, aspect, cues = [] }) {
  if (!videoId) throw new Error('The video is not in Google Drive yet.')
  const prev = project.driveShare || {}
  const folder = await drive.ensureFolderIn(FOLDER, parentId)
  await drive.shareWithAnyone(videoId).catch(() => {})

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-dshare-'))
  try {
    let posterId = prev.posterId || null
    if (filePath && fs.existsSync(filePath)) {
      try {
        const jpg = await share.makePoster(filePath, duration, path.join(tmp, 'poster.jpg'))
        posterId = (await drive.putSmall({ name: `${project.name || 'video'} - poster.jpg`, bytes: fs.readFileSync(jpg), mimeType: 'image/jpeg', folderId: folder.id, fileId: posterId })).id
      } catch { /* a page works without a poster */ }
    }

    const ai = project.ai || {}
    const meta = {
      v: 1,
      title: project.name || 'Untitled video',
      video: videoId,
      poster: posterId,
      duration: Math.round((Number(duration) || 0) * 10) / 10,
      aspect: aspect || null,
      publishedAt: prev.publishedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary: ai.summary || '',
      chapters: ai.chapters || [],
      steps: (ai.steps || []).map(s => ({ at: s.at, title: s.title, detail: s.detail })),
      cues: (cues || []).map(c => ({ s: +Number(c.start).toFixed(2), e: +Number(c.end).toFixed(2), t: String(c.text || '') })).filter(c => c.t && c.e > c.s)
    }
    // Replacing the description in place keeps the link the same for good.
    const saved = await drive.putSmall({ name: `${project.name || 'video'} - share page.json`, bytes: JSON.stringify(meta), mimeType: 'application/json', folderId: folder.id, fileId: prev.metaId || null })
    return {
      metaId: saved.id, posterId, videoId, url: linkFor(saved.id), embed: embedFor(saved.id, aspect),
      publishedAt: meta.publishedAt, updatedAt: meta.updatedAt
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Takes the page down. The video itself stays in Drive. */
async function unpublish (info) {
  // Blank the description first: Google can keep serving a deleted file for a little
  // while, and a blanked one stops being a share page the moment it is read.
  if (info?.metaId) { try { await drive.putSmall({ name: 'removed.json', bytes: '{"v":0}', mimeType: 'application/json', folderId: null, fileId: info.metaId }) } catch {} }
  for (const id of [info?.metaId, info?.posterId].filter(Boolean)) { try { await drive.deleteFile(id) } catch {} }
  return true
}

module.exports = { publish, unpublish, linkFor, embedFor, FOLDER }
