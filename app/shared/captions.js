// Turns Whisper's word timings into on-screen captions, and back again — the same
// word list drives both the burned-in captions and transcript-based cutting.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

// Sounds people make while thinking. Deliberately short: these are never real words in
// a sentence, so removing them cannot change what was said. ("like" and "you know" are
// left alone for exactly that reason.)
const FILLERS = new Set(['um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'uhmm', 'er', 'err', 'erm', 'ah', 'ahh', 'hm', 'hmm', 'hmmm', 'mm', 'mmm', 'mhm', 'eh'])
const bare = w => String(w?.word || '').toLowerCase().replace(/[^a-z]/g, '')

/** Whether a transcript word is a filler sound. */
export const isFiller = w => FILLERS.has(bare(w))

/** The filler words in a transcript that have not been cut yet. */
export function findFillers (words, cuts = []) {
  return (words || []).filter(w => isFiller(w) && !cuts.some(c => w.start >= c.start - 0.03 && w.end <= c.end + 0.03))
}

/**
 * What was said in the finished video, as timed lines: [{ t, text }] with `t` on the
 * output timeline. Cut words are left out, so this always matches what a viewer hears.
 */
export function spokenLines (timeline, media, { maxWords = 28 } = {}) {
  const lines = []
  let cur = null
  const flush = () => { if (cur && cur.words.length) lines.push({ t: +cur.t.toFixed(1), text: cur.words.join(' ') }); cur = null }
  for (const seg of timeline?.segs || []) {
    for (const w of media?.[seg.clip.id]?.transcript?.words || []) {
      if (w.start < seg.localIn - 0.01 || w.start >= seg.localOut) continue
      if (isFiller(w)) continue
      if (!cur) cur = { t: seg.start + (w.start - seg.localIn), words: [] }
      cur.words.push(w.word.trim())
      if (/[.!?]$/.test(w.word.trim()) || cur.words.length >= maxWords) flush()
    }
  }
  flush()
  return lines
}

/** Captions for the finished video: [{ start, end, text }] on the output timeline. */
export function outputCues (timeline, media) {
  const cues = []
  for (const seg of timeline?.segs || []) {
    for (const cap of media?.[seg.clip.id]?.captions || []) {
      const start = Math.max(cap.start, seg.localIn)
      const end = Math.min(cap.end, seg.localOut)
      if (end - start < 0.05) continue
      cues.push({ start: +(seg.start + (start - seg.localIn)).toFixed(2), end: +(seg.start + (end - seg.localIn)).toFixed(2), text: cap.text })
    }
  }
  return cues
}

/**
 * Groups words into short phrases. Short phrases read far better on video than full
 * sentences, and they break on punctuation and on natural pauses rather than purely
 * on a word count.
 */
export function buildCaptions (allWords, { maxWords = 4, maxGap = 0.6, oneWordAtATime = false } = {}) {
  // Nobody wants "um" spelled out on screen, whether or not it has been cut from the video.
  const words = (allWords || []).filter(w => !isFiller(w))
  if (!words.length) return []
  if (oneWordAtATime) {
    return words.map(w => ({ start: w.start, end: w.end, text: w.word.trim(), words: [w] }))
  }
  const groups = []
  let cur = []
  const flush = () => {
    if (!cur.length) return
    groups.push({
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      text: cur.map(w => w.word).join(' ').replace(/\s+/g, ' ').trim(),
      words: cur
    })
    cur = []
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    cur.push(w)
    const next = words[i + 1]
    const endsSentence = /[.!?,;:]$/.test(w.word.trim())
    const bigGap = next && next.start - w.end > maxGap
    if (cur.length >= maxWords || endsSentence || bigGap || !next) flush()
  }
  flush()
  return groups
}

/** The caption visible at time `t`, or null. */
export function captionAt (captions, t) {
  if (!captions || !captions.length) return null
  for (const c of captions) {
    if (t >= c.start && t <= c.end) return c
  }
  return null
}

/**
 * Stretches of silence long enough to be worth removing, expressed as cut ranges.
 * A little padding is left on each side so speech is never clipped.
 */
export function findSilences (words, { duration, minGap = 0.7, pad = 0.12 } = {}) {
  if (!words || !words.length) return []
  const cuts = []
  const push = (start, end) => {
    const s = start + pad
    const e = end - pad
    if (e - s >= 0.2) cuts.push({ start: +s.toFixed(3), end: +e.toFixed(3) })
  }
  if (words[0].start > minGap) push(0, words[0].start)
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].end
    if (gap >= minGap) push(words[i].end, words[i + 1].start)
  }
  const last = words[words.length - 1]
  if (duration && duration - last.end > minGap) push(last.end, duration)
  return cuts
}

/** Cut ranges covering the given words, merged where they touch. */
export function cutsForWords (wordsToRemove, { pad = 0.02 } = {}) {
  const ranges = (wordsToRemove || [])
    .map(w => ({ start: Math.max(0, w.start - pad), end: w.end + pad }))
    .sort((a, b) => a.start - b.start)
  const merged = []
  for (const r of ranges) {
    const prev = merged[merged.length - 1]
    if (prev && r.start <= prev.end + 0.01) prev.end = Math.max(prev.end, r.end)
    else merged.push({ ...r })
  }
  return merged.map(r => ({ start: +r.start.toFixed(3), end: +r.end.toFixed(3) }))
}

export { clamp }
