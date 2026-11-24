import React, { useEffect, useRef, useState } from 'react'

/**
 * Live input meter for the selected microphone.
 *
 * This exists because a recording can look perfect and still be silent — the level is
 * the only thing that tells you the mic is actually hearing you before you commit to a
 * take. It also catches the common case of a working mic turned down so far that the
 * result is inaudible.
 *
 * Levels are drawn straight from an AnalyserNode via requestAnimationFrame and written
 * to refs, so the meter never re-renders React at 60fps.
 */
export default function MicMeter ({ micId, devices, systemAudio }) {
  const [status, setStatus] = useState('idle')   // idle | listening | denied | nodevice
  const [peakDb, setPeakDb] = useState(-Infinity)
  const [inputVolume, setInputVolume] = useState(null)
  const barRef = useRef(null)
  const peakRef = useRef(null)
  const rafRef = useRef(0)
  const streamRef = useRef(null)
  const ctxRef = useRef(null)
  const holdRef = useRef({ value: 0, until: 0 })

  useEffect(() => {
    window.knight.system.inputVolume().then(setInputVolume).catch(() => {})
  }, [micId])

  useEffect(() => {
    let cancelled = false
    const teardown = () => {
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
      ctxRef.current?.close().catch(() => {})
      ctxRef.current = null
    }
    teardown()
    if (!micId) { setStatus('idle'); return }

    const wanted = devices?.microphones?.find(m => m.id === micId)?.name || ''
    ;(async () => {
      try {
        // Same two-namespace problem as the camera: the capture engine names devices
        // by AVFoundation uniqueID, getUserMedia by its own ids. Match on the label.
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
        probe.getTracks().forEach(t => t.stop())
        const all = await navigator.mediaDevices.enumerateDevices()
        const mics = all.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default')
        const match = mics.find(d => d.label && wanted && d.label.startsWith(wanted.slice(0, 16))) || mics[0]
        if (!match) { if (!cancelled) setStatus('nodevice'); return }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: match.deviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream

        const ctx = new AudioContext()
        ctxRef.current = ctx
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.15
        src.connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        setStatus('listening')

        let lastReport = 0
        const tick = () => {
          rafRef.current = requestAnimationFrame(tick)
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          let peak = 0
          for (let i = 0; i < buf.length; i++) {
            const v = buf[i]
            sum += v * v
            const a = Math.abs(v)
            if (a > peak) peak = a
          }
          const rms = Math.sqrt(sum / buf.length)
          // -60dB floor mapped across the bar; speech normally sits past 55%.
          const toPct = v => Math.max(0, Math.min(1, (20 * Math.log10(v || 1e-7) + 60) / 60))
          const level = toPct(rms)

          const now = performance.now()
          const peakPct = toPct(peak)
          if (peakPct >= holdRef.current.value || now > holdRef.current.until) {
            holdRef.current = { value: peakPct, until: now + 900 }
          }

          if (barRef.current) barRef.current.style.transform = `scaleX(${level.toFixed(3)})`
          if (peakRef.current) peakRef.current.style.left = `${(holdRef.current.value * 100).toFixed(1)}%`
          if (now - lastReport > 200) {
            lastReport = now
            setPeakDb(peak > 0 ? 20 * Math.log10(peak) : -Infinity)
          }
        }
        tick()
      } catch (e) {
        if (!cancelled) setStatus(e?.name === 'NotAllowedError' ? 'denied' : 'nodevice')
      }
    })()

    return () => { cancelled = true; teardown() }
  }, [micId, devices])

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    ctxRef.current?.close().catch(() => {})
  }, [])

  const raiseVolume = async () => {
    const v = await window.knight.system.setInputVolume(85)
    setInputVolume(v)
  }

  if (!micId) {
    return <p className="panel-sub muted" style={{ marginTop: -4 }}>No microphone selected — this recording will be silent.</p>
  }

  const tooQuiet = status === 'listening' && peakDb < -40
  const healthy = status === 'listening' && peakDb >= -30

  return (
    <div className="meter-wrap">
      <div className="row between">
        <span className="label" style={{ margin: 0 }}>Input level</span>
        <span className="val">
          {status === 'listening'
            ? (peakDb === -Infinity ? 'silent' : `${Math.round(peakDb)} dB`)
            : status === 'denied' ? 'mic blocked'
            : status === 'nodevice' ? 'no input' : '…'}
        </span>
      </div>

      <div className="meter">
        <div className="meter-fill" ref={barRef} />
        <i className="meter-peak" ref={peakRef} />
        {/* the band healthy speech should reach */}
        <span className="meter-target" />
      </div>

      <p className={`meter-hint ${tooQuiet ? 'warn-text' : healthy ? 'ok-text' : 'muted'}`}>
        {status === 'denied'
          ? 'macOS is blocking microphone access for the preview.'
          : status === 'nodevice'
            ? 'That input is not reporting any audio.'
            : tooQuiet
              ? 'Too quiet to hear. Speak now — the bar should reach the marked band.'
              : healthy
                ? 'Sounds good — that will be clearly audible.'
                : 'Say something; the bar should reach the marked band.'}
      </p>

      {tooQuiet && inputVolume != null && inputVolume < 70 && (
        <button className="btn sm" onClick={raiseVolume}>
          Raise macOS input volume ({inputVolume}% → 85%)
        </button>
      )}

      {systemAudio && (
        <p className="panel-sub muted" style={{ marginTop: 2 }}>
          System audio is recorded on its own track, so it is mixed separately at export.
        </p>
      )}
    </div>
  )
}
