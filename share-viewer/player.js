// The watch page itself: video, title, summary, chapters, steps, transcript, captions —
// and the bookkeeping of what has actually been watched. Used by every kind of link.
window.KSPlayer = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const clock = t => { t = Math.max(0, Math.floor(t)); const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); const s = String(t % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}` }
  const BUCKET = 5   // seconds of video per "watched" mark

  // Every page wears the same brand: Ainable's logo, in the colours set in site.css.
  const LOGO = '<img src="brand/logo-lockup-horizontal-dark.svg" alt="Ainable">'

  /**
   * @param {HTMLElement} app
   * @param {object} m      { title, video, poster, duration, publishedAt, summary, chapters, steps, cues }
   * @param {object} o      { embed, top (html above the player), status (html under the title),
   *                          record({ seconds, duration, bits }, final), startAt }
   */
  function render (app, m, o = {}) {
    document.title = m.title || 'Video'
    const chapters = Array.isArray(m.chapters) ? m.chapters.filter(c => c && c.title) : []
    const steps = Array.isArray(m.steps) ? m.steps.filter(s => s && s.title) : []
    const cues = Array.isArray(m.cues) ? m.cues : []
    const when = m.publishedAt ? new Date(m.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : ''

    // `o.frame`: the video is shown by someone else's player inside a frame (Google
    // Drive's). The page around it is ours. That player cannot be steered while it
    // runs, but it can be opened at a moment — so chapters, steps and transcript lines
    // reopen it there, ready to play.
    const jump = (t, inner, cls = '') => `<button class="${cls}" data-t="${Number(t) || 0}">${inner}</button>`
    app.innerHTML = `
      ${o.top || ''}
      <div class="player">${o.frame
        ? `<iframe id="frame" src="${esc(o.frame)}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen title="${esc(m.title || 'Video')}"></iframe>`
        : `<video id="v" controls playsinline preload="metadata" ${m.poster ? `poster="${esc(m.poster)}"` : ''} src="${esc(m.video)}"></video>`}</div>
      <div class="below">
        <h1>${esc(m.title || 'Untitled video')}</h1>
        <div class="meta">${[m.duration ? clock(m.duration) : '', when].filter(Boolean).join(' · ')}</div>
        <div id="status">${o.status || ''}</div>
        ${m.summary ? `<p class="summary">${esc(m.summary)}</p>` : ''}
        <div class="cols ${chapters.length ? '' : 'single'}">
          <div>
            ${steps.length ? `<section><h2>Step by step</h2><ol class="steps">${steps.map(s => `<li><b>${esc(s.title)}</b>${s.detail ? `<p>${esc(s.detail)}</p>` : ''}${jump(s.at, `Watch from ${clock(s.at)}`, 'jump')}</li>`).join('')}</ol></section>` : ''}
            ${cues.length ? `<section><details ${steps.length ? '' : 'open'}><summary><h2>Transcript</h2></summary><p class="transcript">${cues.map((c, i) => `<span data-t="${c.s}" data-i="${i}">${esc(c.t)}</span>`).join(' ')}</p></details></section>` : ''}
          </div>
          ${chapters.length ? `<aside><h2>Chapters</h2><div class="card"><ul class="chapters">${chapters.map((c, i) => `<li><button data-t="${Number(c.start) || 0}" data-c="${i}"><span class="t">${clock(c.start)}</span><span>${esc(c.title)}</span></button></li>`).join('')}</ul></div></aside>` : ''}
        </div>
      </div>`

    if (o.frame) {
      const frame = app.querySelector('#frame')
      const base = String(o.frame).split('?')[0]
      app.addEventListener('click', e => {
        const el = e.target.closest('[data-t]')
        if (!el) return
        const t = Math.floor(Number(el.dataset.t) || 0)
        frame.src = t > 0 ? `${base}?t=${t}` : base
        app.querySelectorAll('[data-c]').forEach(b => b.classList.toggle('on', b === el.closest('[data-c]')))
        const hint = app.querySelector('#status')
        if (hint) hint.innerHTML = `<div class="status"><span class="pill">${clock(t)}</span><span>Press play — the video starts from here.</span></div>`
        if (!o.embed) frame.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
      return { video: null, frame, setStatus: html => { const s = app.querySelector('#status'); if (s) s.innerHTML = html } }
    }
    const video = app.querySelector('#v')

    if (cues.length) {
      const stamp = t => { const h = Math.floor(t / 3600); const mm = Math.floor((t % 3600) / 60); const s = (t % 60).toFixed(3).padStart(6, '0'); return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${s}` }
      const vtt = 'WEBVTT\n\n' + cues.map(c => `${stamp(c.s)} --> ${stamp(c.e)}\n${c.t}`).join('\n\n')
      const track = document.createElement('track')
      track.kind = 'captions'; track.label = 'Captions'; track.srclang = 'en'
      track.src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }))
      video.appendChild(track)
    }

    app.addEventListener('click', e => {
      const el = e.target.closest('[data-t]')
      if (!el) return
      video.currentTime = Number(el.dataset.t) || 0
      video.play().catch(() => {})
      if (!o.embed) video.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })

    const chapterButtons = [...app.querySelectorAll('[data-c]')]
    const cueSpans = [...app.querySelectorAll('.transcript span')]
    let lastChapter = -1; let lastCue = -1

    /* A view starts when the video starts playing. "Watched" is time actually played:
       skipping forward does not count as watching the part skipped. `marks` remembers
       WHICH five-second stretches were played, so progress can be added up across visits. */
    let watched = 0; let lastT = null; let sent = -1; let started = false
    const marks = []
    const bits = () => {
      const n = Math.max(1, Math.ceil((Number(video.duration) || Number(m.duration) || 0) / BUCKET))
      let out = ''
      for (let i = 0; i < n; i++) out += marks[i] ? '1' : '0'
      return out
    }
    const send = final => {
      if (!o.record || !started) return
      const seconds = Math.round(watched * 10) / 10
      if (seconds === sent && !final) return
      sent = seconds
      o.record({ seconds, duration: Number(video.duration) || Number(m.duration) || 0, bits: bits() }, !!final)
    }

    video.addEventListener('playing', () => { lastT = video.currentTime; if (!started) { started = true; send(true) } })
    video.addEventListener('seeking', () => { lastT = null })
    video.addEventListener('timeupdate', () => {
      const t = video.currentTime
      if (!video.paused && !video.seeking && lastT !== null) {
        const d = t - lastT
        if (d > 0 && d < 2) { watched += d; marks[Math.floor(Math.max(0, t - d / 2) / BUCKET)] = true }
      }
      lastT = video.paused ? null : t

      let ci = -1
      for (let i = 0; i < chapters.length; i++) if (t >= (Number(chapters[i].start) || 0) - 0.05) ci = i
      if (ci !== lastChapter) { chapterButtons.forEach((b, i) => b.classList.toggle('on', i === ci)); lastChapter = ci }
      if (cueSpans.length) {
        let qi = -1
        for (let i = 0; i < cues.length; i++) { if (t >= cues[i].s && t <= cues[i].e) { qi = i; break } }
        if (qi !== lastCue) { if (cueSpans[lastCue]) cueSpans[lastCue].classList.remove('on'); if (cueSpans[qi]) cueSpans[qi].classList.add('on'); lastCue = qi }
      }
    })
    video.addEventListener('pause', () => { lastT = null; send(false) })
    video.addEventListener('ended', () => send(true))
    setInterval(() => send(false), 10000)
    addEventListener('pagehide', () => send(true))
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send(false) })

    if (o.startAt > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = o.startAt }, { once: true })
    return { video, setStatus: html => { const s = app.querySelector('#status'); if (s) s.innerHTML = html } }
  }

  const fail = (app, title, text) => { app.innerHTML = `<div class="state"><b>${esc(title)}</b><span>${esc(text)}</span></div>` }
  return { render, fail, esc, clock, LOGO }
})()
