// Minimal MP4 / QuickTime demuxer for the exporter.
//
// The recorder writes plain (non-fragmented) .mov files: ftyp, mdat, then a moov
// atom holding the sample tables. Walking those tables gives every video sample's
// byte range, decode/presentation time and keyframe flag, which is all WebCodecs
// needs to decode the file sequentially — far faster than seeking a <video>
// element frame by frame (which re-decodes from the last keyframe every time).
//
// `read(offset, length)` must resolve to a Uint8Array of exactly that byte range.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts'])

function fourcc (dv, o) {
  return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))
}

/** Yields { type, start, end, body } for every box between start and end. */
function * boxes (dv, start, end) {
  let o = start
  while (o + 8 <= end) {
    let size = dv.getUint32(o)
    const type = fourcc(dv, o + 4)
    let hdr = 8
    if (size === 1) {
      size = Number(dv.getBigUint64(o + 8))
      hdr = 16
    } else if (size === 0) {
      size = end - o
    }
    if (size < hdr || o + size > end) break
    yield { type, start: o, end: o + size, body: o + hdr }
    o += size
  }
}

function find (dv, start, end, type) {
  for (const b of boxes(dv, start, end)) if (b.type === type) return b
  return null
}

/** Reads the top-level box list and pulls the whole moov atom into memory. */
async function loadMoov (read, fileSize) {
  let off = 0
  while (off + 8 <= fileSize) {
    const head = await read(off, Math.min(16, fileSize - off))
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
    let size = dv.getUint32(0)
    const type = fourcc(dv, 4)
    if (size === 1) size = Number(dv.getBigUint64(8))
    else if (size === 0) size = fileSize - off
    if (size < 8) throw new Error('corrupt box header at ' + off)
    if (type === 'moov') {
      const buf = await read(off, size)
      return new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    }
    off += size
  }
  throw new Error('no moov atom — is the recording still being written?')
}

function fullBox (dv, b) {
  return { version: dv.getUint8(b.body), flags: dv.getUint32(b.body) & 0xffffff, at: b.body + 4 }
}

function hex2 (n) { return n.toString(16).padStart(2, '0') }

function hevcCodecString (prefix, d) {
  const profileSpace = d[1] >> 6
  const tier = (d[1] >> 5) & 1
  const profileIdc = d[1] & 0x1f
  const compat = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0
  let rev = 0
  for (let i = 0; i < 32; i++) rev = ((rev << 1) | ((compat >>> i) & 1)) >>> 0
  const constraint = [d[6], d[7], d[8], d[9], d[10], d[11]]
  let s = `${prefix}.${['', 'A', 'B', 'C'][profileSpace]}${profileIdc}.${rev.toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${d[12]}`
  let last = 5
  while (last >= 0 && constraint[last] === 0) last--
  for (let i = 0; i <= last; i++) s += '.' + constraint[i].toString(16).toUpperCase()
  return s
}

/** Parses the first video sample description into a WebCodecs codec + description. */
function parseStsd (dv, b) {
  const { at } = fullBox(dv, b)
  const count = dv.getUint32(at)
  let o = at + 4
  for (let i = 0; i < count; i++) {
    const size = dv.getUint32(o)
    const type = fourcc(dv, o + 4)
    const width = dv.getUint16(o + 8 + 24)
    const height = dv.getUint16(o + 8 + 26)
    // Child boxes follow the 78-byte visual sample entry.
    for (const c of boxes(dv, o + 8 + 78, o + size)) {
      const payload = new Uint8Array(dv.buffer, dv.byteOffset + c.body, c.end - c.body)
      if (c.type === 'avcC') {
        return {
          codec: `avc1.${hex2(payload[1])}${hex2(payload[2])}${hex2(payload[3])}`,
          description: payload,
          width,
          height,
          entry: type
        }
      }
      if (c.type === 'hvcC') {
        return {
          codec: hevcCodecString(type === 'hev1' ? 'hev1' : 'hvc1', payload),
          description: payload,
          width,
          height,
          entry: type
        }
      }
    }
    o += size
  }
  return null
}

function readTable (dv, b, fields) {
  const { at } = fullBox(dv, b)
  const n = dv.getUint32(at)
  const out = new Array(n)
  let o = at + 4
  for (let i = 0; i < n; i++) {
    const row = {}
    for (const [name, kind] of fields) {
      if (kind === 'u32') { row[name] = dv.getUint32(o); o += 4 } else if (kind === 'i32') { row[name] = dv.getInt32(o); o += 4 }
    }
    out[i] = row
  }
  return out
}

function parseTrack (dv, trak, movieTimescale) {
  const mdia = find(dv, trak.body, trak.end, 'mdia')
  if (!mdia) return null
  const hdlr = find(dv, mdia.body, mdia.end, 'hdlr')
  if (!hdlr || fourcc(dv, hdlr.body + 8) !== 'vide') return null

  const mdhd = find(dv, mdia.body, mdia.end, 'mdhd')
  const mh = fullBox(dv, mdhd)
  const timescale = mh.version === 1 ? dv.getUint32(mh.at + 16) : dv.getUint32(mh.at + 8)

  const minf = find(dv, mdia.body, mdia.end, 'minf')
  const stbl = minf && find(dv, minf.body, minf.end, 'stbl')
  if (!stbl) return null

  const desc = parseStsd(dv, find(dv, stbl.body, stbl.end, 'stsd'))
  if (!desc) return null

  const stts = readTable(dv, find(dv, stbl.body, stbl.end, 'stts'), [['count', 'u32'], ['delta', 'u32']])
  const cttsBox = find(dv, stbl.body, stbl.end, 'ctts')
  const ctts = cttsBox ? readTable(dv, cttsBox, [['count', 'u32'], ['offset', 'i32']]) : null
  const stssBox = find(dv, stbl.body, stbl.end, 'stss')
  const stss = stssBox ? readTable(dv, stssBox, [['n', 'u32']]).map(r => r.n - 1) : null
  const stsc = readTable(dv, find(dv, stbl.body, stbl.end, 'stsc'),
    [['first', 'u32'], ['perChunk', 'u32'], ['desc', 'u32']])

  const stszBox = find(dv, stbl.body, stbl.end, 'stsz')
  if (!stszBox) throw new Error('stz2 sample sizes are not supported')
  const sz = fullBox(dv, stszBox)
  const uniform = dv.getUint32(sz.at)
  const sampleCount = dv.getUint32(sz.at + 4)
  const sizes = new Uint32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) sizes[i] = uniform || dv.getUint32(sz.at + 8 + i * 4)

  let offsets
  const stco = find(dv, stbl.body, stbl.end, 'stco')
  if (stco) {
    const t = fullBox(dv, stco)
    const n = dv.getUint32(t.at)
    offsets = new Array(n)
    for (let i = 0; i < n; i++) offsets[i] = dv.getUint32(t.at + 4 + i * 4)
  } else {
    const co64 = find(dv, stbl.body, stbl.end, 'co64')
    if (!co64) throw new Error('no chunk offset table')
    const t = fullBox(dv, co64)
    const n = dv.getUint32(t.at)
    offsets = new Array(n)
    for (let i = 0; i < n; i++) offsets[i] = Number(dv.getBigUint64(t.at + 4 + i * 8))
  }

  // Edit list: an empty leading edit delays presentation; a media_time offset
  // shifts it earlier (how B-frame files start at 0 despite the reorder delay).
  let delay = 0
  let mediaStart = 0
  const edts = find(dv, trak.body, trak.end, 'edts')
  const elst = edts && find(dv, edts.body, edts.end, 'elst')
  if (elst) {
    const e = fullBox(dv, elst)
    const n = dv.getUint32(e.at)
    let o = e.at + 4
    let seenMedia = false
    for (let i = 0; i < n; i++) {
      let segDur, mediaTime
      if (e.version === 1) {
        segDur = Number(dv.getBigUint64(o)); mediaTime = Number(dv.getBigInt64(o + 8)); o += 20
      } else {
        segDur = dv.getUint32(o); mediaTime = dv.getInt32(o + 4); o += 12
      }
      if (mediaTime === -1) { if (!seenMedia) delay += segDur / movieTimescale } else if (!seenMedia) { mediaStart = mediaTime; seenMedia = true }
    }
  }

  // Decode timestamps and durations from stts.
  const dts = new Float64Array(sampleCount)
  const dur = new Float64Array(sampleCount)
  let t = 0
  let i = 0
  for (const { count, delta } of stts) {
    for (let k = 0; k < count && i < sampleCount; k++, i++) { dts[i] = t; dur[i] = delta; t += delta }
  }
  for (; i < sampleCount; i++) { dts[i] = t; dur[i] = stts.length ? stts[stts.length - 1].delta : 0 }

  // Composition offsets from ctts.
  const cto = new Float64Array(sampleCount)
  if (ctts) {
    i = 0
    for (const { count, offset } of ctts) {
      for (let k = 0; k < count && i < sampleCount; k++, i++) cto[i] = offset
    }
  }

  // Byte offsets from the chunk tables.
  const fileOffset = new Float64Array(sampleCount)
  let sample = 0
  let run = 0
  for (let c = 0; c < offsets.length && sample < sampleCount; c++) {
    while (run + 1 < stsc.length && stsc[run + 1].first - 1 <= c) run++
    let o = offsets[c]
    const per = stsc[run] ? stsc[run].perChunk : 0
    for (let k = 0; k < per && sample < sampleCount; k++, sample++) {
      fileOffset[sample] = o
      o += sizes[sample]
    }
  }
  if (sample < sampleCount) throw new Error(`chunk tables cover ${sample} of ${sampleCount} samples`)

  const keys = stss ? new Set(stss) : null
  const toUs = ticks => Math.round(ticks * 1e6 / timescale)
  const samples = new Array(sampleCount)
  for (let s = 0; s < sampleCount; s++) {
    samples[s] = {
      offset: fileOffset[s],
      size: sizes[s],
      dts: toUs(dts[s]),
      pts: toUs(dts[s] + cto[s] - mediaStart) + Math.round(delay * 1e6),
      duration: toUs(dur[s]),
      key: keys ? keys.has(s) : true
    }
  }

  let duration = 0
  for (const s of samples) duration = Math.max(duration, s.pts + s.duration)

  return {
    codec: desc.codec,
    description: desc.description,
    width: desc.width,
    height: desc.height,
    timescale,
    samples,
    duration: duration / 1e6
  }
}

/**
 * Returns the first video track: { codec, description, width, height, samples, duration }.
 * `samples` are in decode (file) order with pts/dts/duration in microseconds.
 */
export async function demuxVideo (read, fileSize) {
  const dv = await loadMoov(read, fileSize)
  const moov = find(dv, 0, dv.byteLength, 'moov')
  if (!moov) throw new Error('moov atom unreadable')

  const mvhd = find(dv, moov.body, moov.end, 'mvhd')
  let movieTimescale = 600
  if (mvhd) {
    const h = fullBox(dv, mvhd)
    movieTimescale = h.version === 1 ? dv.getUint32(h.at + 16) : dv.getUint32(h.at + 8)
  }

  for (const b of boxes(dv, moov.body, moov.end)) {
    if (b.type !== 'trak') continue
    const track = parseTrack(dv, b, movieTimescale)
    if (track) return track
  }
  throw new Error('no video track found')
}

