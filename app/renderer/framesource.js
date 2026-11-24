// Sequential frame access to a recording for the exporter.
//
// A <video> element answers "give me the frame at t" by seeking, and every seek
// re-decodes from the previous keyframe — up to two seconds of 4K frames for a
// single output frame. Over a six-minute export that was an hour of decoding.
//
// FrameSource instead walks the file once: it demuxes the sample table, streams
// the bytes in large ranged reads, and pushes samples through a hardware
// VideoDecoder in decode order. frameAt(t) then just consumes decoded frames
// until it holds the one that is on screen at t. Only a jump backwards (or a
// long jump forwards) costs a re-seek to the nearest keyframe.

import { demuxVideo } from './demux.js'

const MAX_DECODE_QUEUE = 10   // encoded chunks in flight inside the decoder
const MAX_OUTPUT = 6          // decoded frames waiting to be drawn
const WINDOW = 8 << 20        // bytes per ranged read

export class FrameSource {
  constructor (url) {
    this.url = url
    this.decoder = null
    this.samples = []
    this.syncs = []           // indices of keyframes, in decode order
    this.next = 0             // next sample index to feed
    this.out = []             // decoded frames, presentation order
    this.current = null       // the frame on screen at the last requested time
    this.started = false
    this.ended = false
    this.flushing = null
    this.error = null
    this.closed = false
    this.wake = null
    this.win = null           // { start, end, buf }
    this.prefetch = null      // { start, end, promise }
    this.busy = false
    this.shift = 0
  }

  async open () {
    const head = await fetch(this.url, { headers: { Range: 'bytes=0-15' } })
    if (!head.ok) throw new Error(`cannot open ${this.url} (${head.status})`)
    const range = head.headers.get('content-range')
    this.size = range ? Number(range.split('/')[1]) : Number(head.headers.get('content-length'))
    await head.arrayBuffer()
    if (!this.size) throw new Error(`cannot size ${this.url}`)

    const info = await demuxVideo((off, len) => this._read(off, len), this.size)
    this.samples = info.samples
    this.duration = info.duration
    this.width = info.width
    this.height = info.height
    this.syncs = []
    let minPts = 0
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].key) this.syncs.push(i)
      minPts = Math.min(minPts, this.samples[i].pts)
    }
    if (!this.syncs.length) throw new Error('recording has no keyframes')
    // Frames ahead of the edit-list start carry negative times; decoders are only
    // guaranteed to be happy with non-negative ones, so everything is shifted up.
    this.shift = -minPts

    const base = {
      codec: info.codec,
      description: info.description,
      codedWidth: info.width,
      codedHeight: info.height,
      optimizeForLatency: false
    }
    let config = { ...base, hardwareAcceleration: 'prefer-hardware' }
    let ok = false
    try { ok = (await VideoDecoder.isConfigSupported(config)).supported } catch { ok = false }
    if (!ok) {
      config = { ...base }
      try { ok = (await VideoDecoder.isConfigSupported(config)).supported } catch { ok = false }
    }
    if (!ok) throw new Error(`this machine cannot decode ${info.codec} recordings`)
    this.config = config
    this.decoder = new VideoDecoder({
      output: frame => this._onFrame(frame),
      error: e => this._onError(e)
    })
    return this
  }

  /**
   * The frame showing at time t (seconds), or null if the file has none.
   * The returned VideoFrame belongs to the source — draw it, don't close it.
   */
  async frameAt (t) {
    if (this.closed) throw new Error('frame source closed')
    if (this.busy) throw new Error('frameAt called re-entrantly')
    this.busy = true
    try {
      const us = Math.round(t * 1e6) + this.shift
      const startAt = this._syncFor(us)
      if (!this.started || (this.current && us < this.current.timestamp) || startAt > this.next) {
        this._seek(startAt)
      }
      for (;;) {
        if (this.error) throw this.error
        while (this.out.length && this.out[0].timestamp <= us) {
          if (this.current) this.current.close()
          this.current = this.out.shift()
        }
        if (this.out.length) return this.current || this.out[0]
        if (this.ended) return this.current
        await this._more()
      }
    } finally {
      this.busy = false
    }
  }

  close () {
    if (this.closed) return
    this.closed = true
    this._drop()
    if (this.wake) { const w = this.wake; this.wake = null; w() }
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close() } catch {}
    this.win = null
    this.prefetch = null
  }

  /* ------------------------------------------------------------- decoding */

  /** Index of the keyframe to decode from for presentation time us. */
  _syncFor (us) {
    let lo = 0
    let hi = this.syncs.length - 1
    let best = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.samples[this.syncs[mid]].pts + this.shift <= us) { best = mid; lo = mid + 1 } else hi = mid - 1
    }
    return this.syncs[best]
  }

  _seek (index) {
    this.flushing = null
    if (this.decoder.state !== 'unconfigured') this.decoder.reset()
    this.decoder.configure(this.config)
    this._drop()
    this.next = index
    this.started = true
    this.ended = false
  }

  _drop () {
    for (const f of this.out) f.close()
    this.out = []
    if (this.current) { this.current.close(); this.current = null }
  }

  async _more () {
    while (this.next < this.samples.length &&
           this.decoder.decodeQueueSize < MAX_DECODE_QUEUE &&
           this.out.length < MAX_OUTPUT) {
      const i = this.next
      const s = this.samples[i]
      const buf = await this._bytes(i)
      if (this.closed) return
      // Sample bytes are copied by the chunk, so a view into the window is fine.
      this.decoder.decode(new EncodedVideoChunk({
        type: s.key ? 'key' : 'delta',
        timestamp: s.pts + this.shift,
        duration: s.duration,
        data: buf
      }))
      this.next = i + 1
    }
    if (this.out.length || this.error) return
    if (this.next >= this.samples.length) {
      if (!this.flushing) {
        // A seek or close can abort this flush; only the flush still in force may
        // mark the stream ended or failed.
        const p = this.decoder.flush().then(
          () => { if (this.flushing === p) this.ended = true },
          e => { if (this.flushing === p && !this.closed) { this.error = e; this.ended = true } })
        this.flushing = p
      }
      await this.flushing
      return
    }
    await new Promise(resolve => { this.wake = resolve })
  }

  _onFrame (frame) {
    if (this.closed) { frame.close(); return }
    this.out.push(frame)
    if (this.wake) { const w = this.wake; this.wake = null; w() }
  }

  _onError (e) {
    this.error = e
    if (this.wake) { const w = this.wake; this.wake = null; w() }
  }

  /* --------------------------------------------------------------- reading */

  async _read (off, len) {
    const end = Math.min(this.size, off + len) - 1
    const r = await fetch(this.url, { headers: { Range: `bytes=${off}-${end}` } })
    if (!r.ok) throw new Error(`read failed (${r.status}) at ${off}`)
    const buf = new Uint8Array(await r.arrayBuffer())
    // A server that ignores Range hands back the whole file.
    if (r.status === 200 && buf.length > end - off + 1) return buf.subarray(off, end + 1)
    return buf
  }

  /** Plans a window starting at sample i that covers as many following samples as fit. */
  _plan (i) {
    const start = this.samples[i].offset
    let end = start + this.samples[i].size
    let j = i + 1
    while (j < this.samples.length) {
      const s = this.samples[j]
      const e = s.offset + s.size
      if (s.offset < start || e - start > WINDOW) break
      end = Math.max(end, e)
      j++
    }
    return { start, end, nextIndex: j }
  }

  _covers (w, s) { return !!w && s.offset >= w.start && s.offset + s.size <= w.end }

  /** Bytes of sample i, reading ahead in large windows and prefetching the next. */
  async _bytes (i) {
    const s = this.samples[i]
    if (!this._covers(this.win, s)) {
      if (this.prefetch && this._covers(this.prefetch, s)) {
        const p = this.prefetch
        this.prefetch = null
        this.win = { start: p.start, end: p.end, nextIndex: p.nextIndex, buf: await p.promise }
      } else {
        const plan = this._plan(i)
        this.prefetch = null
        this.win = { ...plan, buf: await this._read(plan.start, plan.end - plan.start) }
      }
      if (this.closed) return new Uint8Array(0)
      if (this.win.nextIndex < this.samples.length && !this.prefetch) {
        const plan = this._plan(this.win.nextIndex)
        const promise = this._read(plan.start, plan.end - plan.start)
        promise.catch(() => {})
        this.prefetch = { ...plan, promise }
      }
    }
    return this.win.buf.subarray(s.offset - this.win.start, s.offset - this.win.start + s.size)
  }
}
