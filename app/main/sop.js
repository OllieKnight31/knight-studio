'use strict'
/**
 * Written SOP: turns a recording into a document someone can follow without watching.
 *
 * The steps come from the transcript (see ai.js). Each one gets a screenshot taken
 * from the finished video at the moment the speaker reaches it, so the picture shows
 * what was on screen while that step was being explained. The result is one HTML file
 * with the pictures inside it, and a PDF of the same thing.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { tool } = require('./tools')

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const clock = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

function frame (videoPath, at, out) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool('ffmpeg'), ['-hide_banner', '-v', 'error', '-y', '-ss', at.toFixed(2), '-i', videoPath,
      '-frames:v', '1', '-vf', 'scale=1400:-2', '-q:v', '3', out], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', code => code === 0 && fs.existsSync(out) ? resolve(out) : reject(new Error('no frame')))
  })
}

// Ainable's logo, in ink, for the top of the page.
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-107 24 392 88" role="img" aria-label="Ainable"><title>Ainable</title><g transform="translate(-99 32.5)"><defs><mask id="ainable-k7"><rect width="71" height="71" fill="#fff"/><g transform="translate(35.5 36.609375) scale(0.8875000000000001) translate(-32 -32)"><circle cx="32" cy="39" r="15" fill="none" stroke="#000" stroke-width="7.5"/><path d="M47 24V54" fill="none" stroke="#000" stroke-width="7.5" stroke-linecap="round"/><circle cx="47" cy="11.5" r="5.5" fill="#000"/></g></mask></defs><rect width="71" height="71" rx="16.640625" fill="#0E0E10" mask="url(#ainable-k7)"/></g><circle cx="20" cy="80" r="16.5" stroke="#0E0E10" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M36.5 63.5V100" stroke="#0E0E10" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M53.5 63.5V100" stroke="#0E0E10" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M69.5 63.5V100M69.5 100V80a16.5 16.5 0 0 1 33 0v20" stroke="#0E0E10" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="135" cy="80" r="16.5" stroke="#0E0E10" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M151.5 63.5V100" stroke="#0E0E10" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M167.5 38V100" stroke="#0E0E10" stroke-width="7" fill="none" stroke-linecap="round"/><circle cx="184" cy="80" r="16.5" stroke="#0E0E10" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M216.5 38V100" stroke="#0E0E10" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M232.5 80H265.5A16.5 16.5 0 1 0 261.64 90.61" stroke="#0E0E10" stroke-width="7" fill="none" stroke-linecap="round"/><circle cx="53.5" cy="45" r="5.5" fill="#0E0E10"/></svg>'

function page ({ title, summary, steps, shareUrl, made }) {
  const accent = '#0E0E10'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --accent: ${accent}; --ink: #16161a; --soft: #5d5d68; --line: #e4e4ea; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: var(--ink); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif; }
  main { max-width: 820px; margin: 0 auto; padding: 56px 28px 80px; }
  header { border-bottom: 3px solid var(--accent); padding-bottom: 22px; margin-bottom: 30px; }
  .brand { margin-bottom: 20px; }
  .brand svg { height: 26px; width: auto; display: block; }
  h1 { font-size: 32px; line-height: 1.2; margin: 0 0 12px; letter-spacing: -.01em; }
  .summary { color: var(--soft); font-size: 17px; margin: 0; }
  .meta { margin-top: 14px; font-size: 13px; color: var(--soft); }
  .meta a { color: inherit; }
  ol.contents { margin: 0 0 34px; padding: 16px 20px 16px 40px; background: #f6f6f8; border-radius: 10px; font-size: 15px; }
  ol.contents li { margin: 3px 0; }
  section.step { break-inside: avoid; page-break-inside: avoid; margin: 0 0 34px; }
  .step h2 { display: flex; gap: 14px; align-items: baseline; font-size: 20px; line-height: 1.3; margin: 0 0 8px; }
  .num { flex: none; width: 32px; height: 32px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 15px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; transform: translateY(4px); }
  .step p { margin: 0 0 14px 46px; }
  .step figure { margin: 0 0 0 46px; }
  .step img { width: 100%; border: 1px solid var(--line); border-radius: 8px; display: block; }
  .step figcaption { font-size: 12px; color: var(--soft); margin-top: 6px; }
  footer { margin-top: 44px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--soft); }
  @media print { main { padding: 0; max-width: none; } }
  @page { size: A4; margin: 18mm 16mm; }
</style></head>
<body><main>
<header>
  <div class="brand">${LOGO}</div>
  <h1>${esc(title)}</h1>
  ${summary ? `<p class="summary">${esc(summary)}</p>` : ''}
  <div class="meta">${steps.length} step${steps.length === 1 ? '' : 's'} · written ${esc(made)}${shareUrl ? ` · <a href="${esc(shareUrl)}">Watch the video</a>` : ''}</div>
</header>
${steps.length > 3 ? `<ol class="contents">${steps.map(s => `<li>${esc(s.title)}</li>`).join('')}</ol>` : ''}
${steps.map((s, i) => `<section class="step">
  <h2><span class="num">${i + 1}</span><span>${esc(s.title)}</span></h2>
  ${s.detail ? `<p>${esc(s.detail)}</p>` : ''}
  ${s.image ? `<figure><img src="${s.image}" alt="Screen at step ${i + 1}"><figcaption>${clock(s.at)} in the video</figcaption></figure>` : ''}
</section>`).join('\n')}
<footer>Written from the recording “${esc(title)}”.</footer>
</main></body></html>`
}

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.summary]
 * @param {{at:number,title:string,detail:string}[]} o.steps
 * @param {string} [o.videoPath]   the exported MP4 to take screenshots from
 * @param {number} [o.duration]
 * @param {string} o.outBase       path without extension; ".html" and ".pdf" are added
 * @param {string} [o.shareUrl]
 * @param {(html:string, pdf:string)=>Promise<void>} o.toPdf   renders the HTML file to PDF
 */
async function build ({ title, summary, steps, videoPath, duration, outBase, shareUrl, toPdf }) {
  if (!steps?.length) throw new Error('There are no steps to write up yet.')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-sop-'))
  try {
    const withImages = []
    const haveVideo = videoPath && fs.existsSync(videoPath)
    for (const [i, s] of steps.slice(0, 60).entries()) {
      let image = null
      if (haveVideo) {
        // A moment after the step begins: the speaker names the action, then does it.
        const next = steps[i + 1]?.at ?? (Number(duration) || s.at + 4)
        const at = Math.max(0, Math.min(s.at + Math.min(2, Math.max(0.3, (next - s.at) * 0.5)), (Number(duration) || s.at + 2) - 0.2))
        try {
          const jpg = await frame(videoPath, at, path.join(tmp, `step-${i}.jpg`))
          image = `data:image/jpeg;base64,${fs.readFileSync(jpg).toString('base64')}`
        } catch { /* a step without a picture is still a step */ }
      }
      withImages.push({ ...s, image })
    }

    const html = page({
      title, summary, steps: withImages, shareUrl,
      made: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    })
    const htmlPath = `${outBase}.html`
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true })
    fs.writeFileSync(htmlPath, html)

    let pdfPath = null
    if (toPdf) {
      try { await toPdf(htmlPath, `${outBase}.pdf`); pdfPath = `${outBase}.pdf` } catch { /* the HTML alone is still useful */ }
    }
    return { html: htmlPath, pdf: pdfPath, steps: withImages.length, pictures: withImages.filter(s => s.image).length }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

module.exports = { build }
