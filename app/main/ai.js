'use strict'
/**
 * Reads a video's transcript and writes the things a person would otherwise type up
 * afterwards: a summary, chapters, and the numbered steps of a written SOP.
 *
 * One request produces all three, because they come from the same reading of the
 * same transcript. The result is kept on the project, so the chapters on a share
 * page, the summary in a database row and the written SOP always agree.
 *
 * Only the transcript text leaves this Mac — never the video or the audio.
 */
const Anthropic = require('@anthropic-ai/sdk')
const titler = require('./titler')

const MODEL = 'claude-opus-5-5'
const MAX_TOKENS = 16000
// A stand-in address, so the checks can run without spending anything.
const BASE_URL = process.env.KS_ANTHROPIC_API || undefined

class AiError extends Error {}

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: { start: { type: 'number' }, title: { type: 'string' } },
        required: ['start', 'title'],
        additionalProperties: false
      }
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { at: { type: 'number' }, title: { type: 'string' }, detail: { type: 'string' } },
        required: ['at', 'title', 'detail'],
        additionalProperties: false
      }
    }
  },
  required: ['summary', 'chapters', 'steps'],
  additionalProperties: false
}

const SYSTEM = `You turn the transcript of a screen recording into written material for the people who will watch it or follow it.

The transcript arrives as lines of the form "[seconds] words spoken", where the number is how far into the finished video that line starts. The speaker is usually showing how to do something on their screen.

Write three things.

summary: Two to four plain sentences saying what the video covers and what someone will be able to do after watching it. Write it for a colleague deciding whether to watch.

chapters: The natural sections of the video, in order. Each has "start" (the seconds value of the line where that section begins, taken from the transcript) and a short "title" of two to six words that names what happens in it. The first chapter starts at 0. Aim for a chapter every one to three minutes; a video under a minute gets one or two. Do not invent sections the speaker did not cover.

steps: The procedure as a written standard operating procedure, so someone can follow it without watching. Each step has "at" (the seconds value of the line where the speaker does or explains that step), a "title" that starts with a verb and names one action, and "detail" of one to three sentences with the specifics the speaker gave: which button, which setting, which value, and why when they said why. Keep the speaker's own names for things on screen. Leave out greetings, filler, and asides. If the video is not a procedure at all, return the main points in order instead, phrased the same way.

Use only what is in the transcript. Write in the transcript's own language. Do not use markdown.`

const client = apiKey => new Anthropic({ apiKey, baseURL: BASE_URL, maxRetries: 2, timeout: 5 * 60 * 1000 })

const stamp = t => `[${Math.max(0, Math.round(Number(t) || 0))}]`

/** What went wrong, in words the person can act on. */
function explain (e) {
  if (e instanceof AiError) return e
  if (e instanceof Anthropic.AuthenticationError) return new AiError('Claude does not accept that API key. Paste it again in Settings → Captions & titles.')
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError('That Claude API key is not allowed to use this model.')
  if (e instanceof Anthropic.RateLimitError) return new AiError('Claude is busy or this key has reached its limit. Try again in a minute.')
  if (e instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(e.message)) return new AiError('The Claude account behind this key has no credit left. Add credit at console.anthropic.com → Billing.')
    return new AiError(`Claude could not read the request: ${e.message}`)
  }
  if (e instanceof Anthropic.APIConnectionError) return new AiError('Could not reach Claude — check the internet connection.')
  if (e instanceof Anthropic.APIError) return new AiError(`Claude had a problem (${e.status || 'no status'}). Try again in a minute.`)
  return new AiError(String(e.message || e))
}

/** Makes the answer safe to rely on: times inside the video, in order, nothing empty. */
function tidy (raw, duration) {
  const max = Math.max(0, Number(duration) || 0)
  const inside = t => Math.min(Math.max(0, Number(t) || 0), max ? Math.max(0, max - 0.5) : Infinity)
  const text = s => String(s || '').replace(/\s+/g, ' ').trim()

  const chapters = []
  for (const c of [...(raw.chapters || [])].sort((a, b) => a.start - b.start)) {
    const title = text(c.title)
    const start = Math.round(inside(c.start))
    if (!title) continue
    const prev = chapters[chapters.length - 1]
    if (prev && start - prev.start < 5) continue        // two chapters on top of each other
    chapters.push({ start, title })
  }
  if (chapters.length) chapters[0].start = 0

  const steps = [...(raw.steps || [])]
    .map(s => ({ at: Math.round(inside(s.at) * 10) / 10, title: text(s.title), detail: text(s.detail) }))
    .filter(s => s.title)
    .sort((a, b) => a.at - b.at)

  return { summary: text(raw.summary), chapters, steps }
}

/**
 * @param {object} opts
 * @param {string} opts.title       the video's name
 * @param {{t:number,text:string}[]} opts.lines  what was said, timed on the finished video
 * @param {number} opts.duration    length of the finished video in seconds
 * @returns {Promise<{summary:string, chapters:{start:number,title:string}[], steps:{at:number,title:string,detail:string}[], model:string, createdAt:string}>}
 */
async function analyse ({ title, lines, duration }) {
  const spoken = (lines || []).filter(l => l && String(l.text || '').trim())
  if (spoken.length < 2 || spoken.reduce((n, l) => n + l.text.split(/\s+/).length, 0) < 25) {
    throw new AiError('There is not enough speech in this video to work from. Transcribe it under Captions first, or record with the microphone on.')
  }
  const transcript = spoken.map(l => `${stamp(l.t)} ${l.text.trim()}`).join('\n')
  const mins = Math.max(1, Math.round((Number(duration) || 0) / 60))

  const claudeKey = titler.resolveApiKey()
  const geminiKey = titler.resolveGeminiKey()
  if (!claudeKey && !geminiKey) throw new AiError('Add a Claude API key in Settings → Captions & titles first.')
  const user = `Video title: ${title || 'Untitled video'}\nLength: about ${mins} minute${mins === 1 ? '' : 's'} (${Math.round(Number(duration) || 0)} seconds)\n\nTranscript:\n${transcript}`
  const finish = (parsed, model) => {
    const out = tidy(parsed, duration)
    if (!out.summary && !out.chapters.length && !out.steps.length) throw new AiError('Nothing to write up was found in this video.')
    return { ...out, model, createdAt: new Date().toISOString() }
  }

  // Claude first. Gemini is the stand-by, the same way it is for titles: a Claude key
  // with no credit should not leave the feature dead when another key is saved.
  let claudeProblem = null
  if (claudeKey) {
    try {
      return finish(...await askClaude(claudeKey, user))
    } catch (e) {
      claudeProblem = explain(e)
      if (!geminiKey) throw claudeProblem
    }
  }
  try {
    return finish(await askGemini(geminiKey, user), GEMINI_MODEL)
  } catch (e) {
    throw claudeProblem || (e instanceof AiError ? e : new AiError(`Gemini could not write this up: ${e.message}`))
  }
}

async function askClaude (apiKey, user) {
  let message
  try {
    message = await client(apiKey).beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      // If a safety check declines the request, the API retries it on its recommended
      // model inside the same call rather than handing back nothing.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: user }]
    })
  } catch (e) {
    throw explain(e)
  }

  if (message.stop_reason === 'refusal') throw new AiError('Claude declined to work on this transcript.')
  if (message.stop_reason === 'max_tokens') throw new AiError('This video is too long to write up in one go. Split it into shorter videos and try each one.')
  const body = message.content.filter(b => b.type === 'text').map(b => b.text).join('')
  let parsed
  try { parsed = JSON.parse(body) } catch { throw new AiError('Claude answered in a form the app could not read. Try again.') }
  return [parsed, message.model || MODEL]
}

const GEMINI_MODEL = 'gemini-2.5-flash'

async function askGemini (apiKey, user) {
  // Gemini's schema dialect has no `additionalProperties`.
  const strip = node => Array.isArray(node)
    ? node.map(strip)
    : node && typeof node === 'object'
      ? Object.fromEntries(Object.entries(node).filter(([k]) => k !== 'additionalProperties').map(([k, v]) => [k, strip(v)]))
      : node
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    signal: AbortSignal.timeout(3 * 60 * 1000),
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: user }] }],
      systemInstruction: { parts: [{ text: SYSTEM }] },
      generationConfig: { responseMimeType: 'application/json', responseSchema: strip(SCHEMA), temperature: 0.3 }
    })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) {
    if (res.status === 400 && /API key/i.test(data.error?.message || '')) throw new AiError('Gemini does not accept that API key. Paste it again in Settings → Captions & titles.')
    if (res.status === 402) throw new AiError('The Gemini account behind this key has no credit left.')
    if (res.status === 429) throw new AiError('Gemini is busy or this key has reached its limit. Try again in a minute.')
    throw new AiError(`Gemini had a problem (${res.status}).`)
  }
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || ''
  try { return JSON.parse(text) } catch { throw new AiError('Gemini answered in a form the app could not read. Try again.') }
}

const isConfigured = () => !!(titler.resolveApiKey() || titler.resolveGeminiKey())

/** "0:00 Intro" lines — the form YouTube, Notion and a webhook all understand. */
const chapterText = chapters => (chapters || []).map(c => {
  const m = Math.floor(c.start / 60)
  const s = String(Math.floor(c.start % 60)).padStart(2, '0')
  return `${m}:${s} ${c.title}`
}).join('\n')

module.exports = { analyse, isConfigured, chapterText, tidy, AiError, MODEL }
