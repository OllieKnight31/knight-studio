import React, { useEffect, useState, useRef } from 'react'

const fmt = s => {
  const t = Math.max(0, Math.floor(s))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/** The floating bar shown over every app while a take is running. */
export default function Overlay () {
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const startRef = useRef(Date.now())
  const pausedTotal = useRef(0)
  const pauseStart = useRef(0)

  // Quick-record from the Dock or a hotkey counts down in this bar, since there is no
  // app window on screen to count down in.
  useEffect(() => window.knight.record.on('record:countdown', ({ n }) => {
    setCountdown(n)
    if (n === 0) { startRef.current = Date.now(); pausedTotal.current = 0; setElapsed(0) }
  }), [])

  // The bar is hidden between takes rather than torn down, so its state has to be
  // cleared on the way out — otherwise the next recording opens on "Finishing…".
  const reset = () => {
    setBusy(false)
    setPaused(false)
    setElapsed(0)
    startRef.current = Date.now()
    pausedTotal.current = 0
  }
  useEffect(() => window.knight.record.on('record:complete', reset), [])
  useEffect(() => window.knight.record.on('record:failed', reset), [])

  useEffect(() => {
    const id = setInterval(() => {
      if (!paused) setElapsed((Date.now() - startRef.current - pausedTotal.current) / 1000)
    }, 200)
    return () => clearInterval(id)
  }, [paused])

  const togglePause = async () => {
    if (paused) {
      pausedTotal.current += Date.now() - pauseStart.current
      await window.knight.record.resume()
      setPaused(false)
    } else {
      pauseStart.current = Date.now()
      await window.knight.record.pause()
      setPaused(true)
    }
  }

  const stop = async () => {
    setBusy(true)
    await window.knight.record.stop()
  }

  if (countdown > 0) {
    return (
      <div className="overlay-bar drag">
        <div className="rec-dot" />
        <div className="overlay-time mono">Recording in {countdown}…</div>
        <div className="spacer" />
        <button className="btn ghost no-drag" onClick={() => window.knight.record.stop()}>Cancel</button>
      </div>
    )
  }

  return (
    <div className="overlay-bar drag">
      <div className={`rec-dot ${paused ? 'paused' : ''}`} />
      <div className="mono overlay-time">{fmt(elapsed)}</div>
      <div className="overlay-sep" />
      <button className="btn ghost no-drag" onClick={togglePause} disabled={busy}>
        {paused ? 'Resume' : 'Pause'}
      </button>
      <button className="btn danger no-drag" onClick={stop} disabled={busy}>
        {busy ? 'Finishing…' : 'Stop'}
      </button>
    </div>
  )
}
