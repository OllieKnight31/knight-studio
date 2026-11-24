import React, { useEffect, useState } from 'react'

/* ------------------------------------------------------------------ icons */

const PATHS = {
  setup: 'M4 6h16M4 12h10M4 18h13',
  cut: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
  layout: 'M3 5h18v14H3zM14 12h5v5h-5z',
  zoom: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M11 8v6M8 11h6',
  style: 'M12 3a9 9 0 1 0 0 18c1.2 0 2-1 2-2 0-1.5-1.5-1.5-1.5-3 0-1 1-2 2.5-2H18a3 3 0 0 0 3-3c0-4.4-4-8-9-8zM7.5 12h.01M9.5 8h.01M14.5 7.5h.01',
  cursor: 'M5 3l6.5 17 2.3-7.2L21 10.5z',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  audio: 'M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  subtitles: 'M3 5h18v14H3zM7 14h4M14 14h3M7 10h2M12 10h5',
  export: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.5-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.6 7.6 0 0 0 7 6.5l-2.4-1-2 3.5 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.5z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  folderPlus: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  inbox: 'M3 13l3-8h12l3 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h5l1.5 2.5h5L16 13h5',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h3.5v16H7zM13.5 4H17v16h-3.5z',
  split: 'M12 3v18M7 8l-4 4 4 4M17 8l4 4-4 4',
  undo: 'M4 9h10a6 6 0 0 1 0 12h-3M4 9l4-4M4 9l4 4',
  redo: 'M20 9H10a6 6 0 0 0 0 12h3M20 9l-4-4M20 9l-4 4',
  quiet: 'M3 12h3M9 9v6M13 6v12M17 10v4M21 12h0M3 4l18 16',
  headline: 'M5 5v14M13 5v14M5 12h8M17 9l3-2v12',
  volume: 'M11 5 6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6',
  mute: 'M11 5 6 9H3v6h3l5 4zM16 9.5l5 5M21 9.5l-5 5',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  restore: 'M4 12a8 8 0 1 0 2.5-5.8M4 4v4.5h4.5',
  drive: 'M8.5 3h7l6 10.5-3.5 6h-12L2.5 13.5zM8.5 3l6 10.5M15.5 3 9 13.5M2.5 13.5h19',
  brand: 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.3 6L12 16.5 6.6 19.4l1.3-6L3.4 9.3l6-.7z',
  files: 'M4 4h10l6 6v10H4zM14 4v6h6',
  record: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.700l1-1',
  blur: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.500 6-11 6-11z',
  send: 'M21 3 10 14M21 3l-7 18-4-7-7-4z',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7.500'
}

export function Icon ({ name, ...rest }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={PATHS[name] || ''} />
    </svg>
  )
}

/* ---------------------------------------------------------------- tooltips */

/**
 * One tooltip for the whole window. Any element can carry:
 *   data-tip="what it does"   data-tip-title="Name"   data-tip-key="S"   data-tip-side="right"
 * It appears beside the control after a brief pause and is clamped to the window,
 * so it is never clipped by a scrolling panel the way a CSS-only tooltip would be.
 */
export function TooltipLayer () {
  const [tip, setTip] = useState(null)

  useEffect(() => {
    let timer = null
    let current = null
    const hide = () => { clearTimeout(timer); current = null; setTip(null) }
    const over = e => {
      const el = e.target.closest?.('[data-tip]')
      if (el === current) return
      clearTimeout(timer)
      current = el
      if (!el) { setTip(null); return }
      timer = setTimeout(() => {
        if (!el.isConnected) return
        const r = el.getBoundingClientRect()
        setTip({
          text: el.dataset.tip,
          title: el.dataset.tipTitle || '',
          keys: el.dataset.tipKey || '',
          side: el.dataset.tipSide || 'top',
          r: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
        })
      }, 220)
    }
    window.addEventListener('mouseover', over)
    window.addEventListener('mousedown', hide)
    window.addEventListener('keydown', hide)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mouseover', over)
      window.removeEventListener('mousedown', hide)
      window.removeEventListener('keydown', hide)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  if (!tip || !tip.text) return null
  const W = 250
  const style = {}
  if (tip.side === 'right') {
    style.left = Math.min(window.innerWidth - W - 8, tip.r.right + 10)
    style.top = Math.max(8, Math.min(window.innerHeight - 90, tip.r.top + tip.r.height / 2 - 22))
  } else {
    style.left = Math.max(8, Math.min(window.innerWidth - W - 8, tip.r.left + tip.r.width / 2 - 90))
    if (tip.r.top > 110) style.bottom = window.innerHeight - tip.r.top + 8
    else style.top = tip.r.bottom + 8
  }
  return (
    <div className="tip" style={style}>
      {(tip.title || tip.keys) && <b>{tip.title}{tip.keys && <kbd>{tip.keys}</kbd>}</b>}
      {tip.text}
    </div>
  )
}

/* ------------------------------------------------------------------ brand */

/** Ainable's logo, drawn in the text colour. It is the app's one brand, not a setting. */
export function Brand () {
  const line = { stroke: 'currentColor', strokeWidth: 7, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }
  return (
    <div className="brand">
      <svg className="brand-logo" viewBox="-107 24 392 88" role="img" aria-label="Ainable">
        <g transform="translate(-99 32.5)">
          <defs>
            <mask id="ainable-mark">
              <rect width="71" height="71" fill="#fff" />
              <g transform="translate(35.5 36.609375) scale(0.8875) translate(-32 -32)">
                <circle cx="32" cy="39" r="15" fill="none" stroke="#000" strokeWidth="7.5" />
                <path d="M47 24V54" fill="none" stroke="#000" strokeWidth="7.5" strokeLinecap="round" />
                <circle cx="47" cy="11.5" r="5.5" fill="#000" />
              </g>
            </mask>
          </defs>
          <rect width="71" height="71" rx="16.640625" fill="currentColor" mask="url(#ainable-mark)" />
        </g>
        <circle cx="20" cy="80" r="16.5" {...line} />
        <path d="M36.5 63.5V100" {...line} />
        <path d="M53.5 63.5V100" {...line} />
        <path d="M69.5 63.5V100M69.5 100V80a16.5 16.5 0 0 1 33 0v20" {...line} />
        <circle cx="135" cy="80" r="16.5" {...line} />
        <path d="M151.5 63.5V100" {...line} />
        <path d="M167.5 38V100" {...line} />
        <circle cx="184" cy="80" r="16.5" {...line} />
        <path d="M216.5 38V100" {...line} />
        <path d="M232.5 80H265.5A16.5 16.5 0 1 0 261.64 90.61" {...line} />
        <circle cx="53.5" cy="45" r="5.5" fill="currentColor" />
      </svg>
    </div>
  )
}

/* --------------------------------------------------------------- controls */

export const Row = ({ label, tip, children }) => (
  <div className="field"><span className="label" data-tip={tip}>{label}</span>{children}</div>
)

export const Slider = ({ label, value, min, max, step = 0.01, onChange, format, tip }) => (
  <div className="field" data-tip={tip}>
    <div className="row between">
      <span className="label">{label}</span>
      <span className="val">{format ? format(value) : Number(value).toFixed(2)}</span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={e => onChange(Number(e.target.value))} />
  </div>
)

export const Toggle = ({ label, checked, onChange, tip }) => (
  <div className="row between" data-tip={tip}>
    <span style={{ fontSize: 12.5 }}>{label}</span>
    <label className="switch">
      <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} />
      <span />
    </label>
  </div>
)

export const Seg = ({ value, options, onChange }) => (
  <div className="seg">
    {options.map(([v, l, tip]) => (
      <button key={String(v)} className={value === v ? 'on' : ''} data-tip={tip} onClick={() => onChange(v)}>{l}</button>
    ))}
  </div>
)

/** A colour swatch that opens the system colour picker. Alpha, if any, is kept. */
export const Colour = ({ label, value, onChange, tip }) => {
  const solid = /^#[0-9a-f]{6}/i.test(value || '') ? value.slice(0, 7) : '#ffffff'
  return (
    <div className="colour-row" data-tip={tip}>
      <span>{label}</span>
      <input type="color" value={solid} onChange={e => onChange(e.target.value)} />
    </div>
  )
}
