import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { TOURS } from './tours.js'

// Walkthroughs: a card that steps through a screen, dimming everything except the
// part it is talking about.
//
// Anything can ask for one:   requestTour('library')            — only if not seen yet
//                             requestTour('editor:cut', true)   — always (a replay)
// and <TourLayer>, mounted once at the top of the app, decides whether to show it.

const EVENT = 'knight-tour'
const TOOL_EVENT = 'knight-tour-tool'

export function requestTour (id, force = false) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { id, force } }))
}

/** The editor listens for this to switch tools on the tour's behalf. */
export function onTourTool (fn) {
  const handler = e => fn(e.detail)
  window.addEventListener(TOOL_EVENT, handler)
  return () => window.removeEventListener(TOOL_EVENT, handler)
}

const find = target => {
  try {
    const el = typeof target === 'function' ? target() : document.querySelector(target)
    if (!el || !el.isConnected) return null
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 ? el : null
  } catch { return null }
}

const CARD_W = 330
const GAP = 14

/** Where the card goes: beside the highlight on the preferred side, kept on screen. */
function placeCard (rect, side, cardH) {
  const W = window.innerWidth
  const H = window.innerHeight
  if (!rect) return { left: (W - CARD_W) / 2, top: (H - cardH) / 2 }
  const room = {
    right: W - rect.right, left: rect.left, bottom: H - rect.bottom, top: rect.top
  }
  const fits = s => (s === 'left' || s === 'right' ? room[s] >= CARD_W + GAP * 2 : room[s] >= cardH + GAP * 2)
  const order = [side, 'right', 'bottom', 'left', 'top'].filter(Boolean)
  const use = order.find(fits)
  const clampX = x => Math.max(GAP, Math.min(W - CARD_W - GAP, x))
  const clampY = y => Math.max(GAP, Math.min(H - cardH - GAP, y))
  if (use === 'right') return { left: rect.right + GAP, top: clampY(rect.top + rect.height / 2 - cardH / 2) }
  if (use === 'left') return { left: rect.left - CARD_W - GAP, top: clampY(rect.top + rect.height / 2 - cardH / 2) }
  if (use === 'bottom') return { left: clampX(rect.left + rect.width / 2 - CARD_W / 2), top: rect.bottom + GAP }
  if (use === 'top') return { left: clampX(rect.left + rect.width / 2 - CARD_W / 2), top: rect.top - cardH - GAP }
  // The highlight fills the screen: sit inside it, bottom right.
  return { left: W - CARD_W - GAP * 2, top: H - cardH - GAP * 2 }
}

/**
 * @param prefs      saved settings; `prefs.tours` holds which walkthroughs have been seen
 * @param savePrefs  writes a settings patch
 */
export function TourLayer ({ prefs, savePrefs }) {
  const [run, setRun] = useState(null)        // { id, index }
  const [rect, setRect] = useState(null)
  const [cardH, setCardH] = useState(190)
  const cardRef = useRef(null)
  const runRef = useRef(null)
  const prefsRef = useRef(prefs)
  useEffect(() => { runRef.current = run }, [run])
  useEffect(() => { prefsRef.current = prefs }, [prefs])

  const markSeen = useCallback(id => {
    if (prefsRef.current?.tours?.[id]) return
    savePrefs({ tours: { [id]: true } })
  }, [savePrefs])

  /* ------------------------------------------------------------ starting */

  useEffect(() => {
    let timer = null
    const onRequest = e => {
      const { id, force } = e.detail || {}
      const tour = TOURS[id]
      if (!tour) return
      const seen = prefsRef.current?.tours || {}
      if (!force && (seen.disabled || seen[id])) return
      if (runRef.current && !force) return     // never interrupt one that is showing

      // Wait until the screen is actually there — a project still loading, or the
      // settings window open on top — rather than pointing at nothing.
      clearTimeout(timer)
      let tries = 0
      const attempt = () => {
        const blocked = document.querySelector('.modal-back') || document.querySelector('.countdown')
        if (tour.tool) window.dispatchEvent(new CustomEvent(TOOL_EVENT, { detail: tour.tool }))
        const ready = !blocked && tour.steps.some(s => find(s.target))
        if (ready) {
          if (runRef.current && !force) return
          setRun({ id, index: firstVisible(tour, 0, 1) })
          return
        }
        if (++tries < (force ? 20 : 90)) timer = setTimeout(attempt, 350)
      }
      timer = setTimeout(attempt, force ? 30 : 700)
    }
    window.addEventListener(EVENT, onRequest)
    return () => { clearTimeout(timer); window.removeEventListener(EVENT, onRequest) }
  }, [])

  const tour = run ? TOURS[run.id] : null
  const step = tour ? tour.steps[run.index] : null

  /* ------------------------------------------------------------- moving */

  const close = useCallback(() => {
    const cur = runRef.current
    if (cur) markSeen(cur.id)
    setRun(null)
    setRect(null)
  }, [markSeen])

  const go = useCallback(dir => {
    const cur = runRef.current
    if (!cur) return
    const t = TOURS[cur.id]
    const next = firstVisible(t, cur.index + dir, dir)
    if (next === -1) { if (dir > 0) close(); return }
    setRun({ id: cur.id, index: next })
  }, [close])

  const neverAgain = useCallback(() => {
    savePrefs({ tours: { disabled: true } })
    setRun(null)
    setRect(null)
  }, [savePrefs])

  // Arrow keys and Escape belong to the tour while it is open. Captured before the
  // editor's own shortcuts, so → does not also scrub the video.
  useEffect(() => {
    if (!run) return
    const onKey = e => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'Escape') close()
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [!!run, go, close])

  /* ------------------------------------------------------- highlighting */

  // Open the right tool, bring the target into view, then keep tracking where it is:
  // panels scroll, windows resize, and the highlight has to stay on its subject.
  useEffect(() => {
    if (!step) return
    const wanted = step.tool || tour.tool
    if (wanted) window.dispatchEvent(new CustomEvent(TOOL_EVENT, { detail: wanted }))
    let alive = true
    let scrolled = false
    const measure = () => {
      if (!alive) return
      const el = find(step.target)
      if (el && !scrolled) {
        scrolled = true
        const r = el.getBoundingClientRect()
        if (r.top < 60 || r.bottom > window.innerHeight - 20) el.scrollIntoView({ block: 'center' })
      }
      const r = el ? el.getBoundingClientRect() : null
      const pad = step.pad ?? 6
      const next = r ? {
        left: Math.max(4, r.left - pad),
        top: Math.max(4, r.top - pad),
        right: Math.min(window.innerWidth - 4, r.right + pad),
        bottom: Math.min(window.innerHeight - 4, r.bottom + pad)
      } : null
      if (next) { next.width = next.right - next.left; next.height = next.bottom - next.top }
      setRect(prev => (same(prev, next) ? prev : next))
    }
    measure()
    const interval = setInterval(measure, 120)
    window.addEventListener('resize', measure)
    return () => { alive = false; clearInterval(interval); window.removeEventListener('resize', measure) }
  }, [run?.id, run?.index])

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight)
  }, [run?.id, run?.index, rect])

  if (!run || !step) return null

  const visible = tour.steps.map((s, i) => i).filter(i => i === run.index || find(tour.steps[i].target))
  const position = visible.indexOf(run.index) + 1
  const total = visible.length
  const last = firstVisible(tour, run.index + 1, 1) === -1
  const first = firstVisible(tour, run.index - 1, -1) === -1
  const card = placeCard(rect, step.side, cardH)

  return (
    <div className="tour" onMouseDown={e => e.stopPropagation()}>
      {/* Swallows clicks on the app, so nothing changes under the walkthrough. */}
      <div className="tour-block" />
      {rect
        ? <div className="tour-spot" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
        : <div className="tour-dim" />}
      <div className="tour-card" ref={cardRef} style={{ left: card.left, top: card.top, width: CARD_W }}>
        <div className="tour-meta">
          <span>{tour.name}</span>
          <span>{position} of {total}</span>
        </div>
        <h4>{step.title}</h4>
        <p>{step.body}</p>
        <div className="tour-dots">
          {visible.map(i => <i key={i} className={i === run.index ? 'on' : ''} />)}
        </div>
        <div className="tour-actions">
          <button className="btn ghost sm" onClick={close}>{last ? 'Close' : 'Skip'}</button>
          <div className="spacer" />
          <button className="btn sm" disabled={first} onClick={() => go(-1)}>← Previous</button>
          <button className="btn sm primary" onClick={() => go(1)}>{last ? 'Done' : 'Next →'}</button>
        </div>
        <button className="tour-never" onClick={neverAgain}>Don’t show walkthroughs automatically</button>
      </div>
    </div>
  )
}

/** The nearest step from `from`, moving in `dir`, whose target is on screen. -1 if none. */
function firstVisible (tour, from, dir) {
  for (let i = from; i >= 0 && i < tour.steps.length; i += dir) {
    const s = tour.steps[i]
    // A step that opens a tool cannot be judged until that tool is open, so it counts.
    if (s.tool || find(s.target)) return i
  }
  return -1
}

function same (a, b) {
  if (!a || !b) return a === b
  return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
}
