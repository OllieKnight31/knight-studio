'use strict'
/**
 * Locates the helper programs the app runs: ffmpeg and the speech-to-text engine.
 *
 * A downloaded copy of the app has to work on a Mac with nothing else installed, so
 * the copies shipped inside the app bundle are always preferred. The system
 * locations after them only matter when running from source.
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')

const cache = new Map()

function candidates (name) {
  const res = process.resourcesPath || ''
  const root = path.join(__dirname, '..', '..')
  const env = { ffmpeg: process.env.KNIGHT_STUDIO_FFMPEG, 'whisper-cli': process.env.KNIGHT_STUDIO_WHISPER }[name]
  const dev = {
    ffmpeg: path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg'),
    'whisper-cli': path.join(root, 'vendor', 'bin', 'whisper-cli')
  }[name]
  return [
    env,
    res && path.join(res, 'bin', name),      // inside the packaged app
    dev,                                     // running from source
    path.join(os.homedir(), '.local', 'bin', name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`
  ].filter(Boolean)
}

/** Absolute path of a helper, or null when this Mac has no copy of it at all. */
function find (name) {
  if (cache.has(name)) return cache.get(name)
  let found = null
  for (const c of candidates(name)) {
    try { if (fs.existsSync(c)) { found = c; break } } catch { /* keep looking */ }
  }
  cache.set(name, found)
  return found
}

/** Path to run. Falls back to the bare name so the shell's PATH gets a last try. */
function tool (name) { return find(name) || name }

/**
 * What ffmpeg can tell about a file, in the shape ffprobe would give it.
 *
 * ffprobe is deliberately not used: the only redistributable build of it for
 * Apple silicon is an Intel binary, which will not run on a Mac without Rosetta.
 * ffmpeg prints everything needed here when asked to open a file and do nothing.
 */
function probe (file) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool('ffmpeg'), ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 20000)
    child.stderr.on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', () => {
      clearTimeout(timer)
      const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err)
      if (!d) return reject(new Error(`could not read ${path.basename(file)}`))
      const duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])
      const streams = []
      for (const m of err.matchAll(/Stream #\d+:(\d+)[^:]*:\s*(Video|Audio):\s*([^\n]*)/g)) {
        const s = { index: Number(m[1]), codec_type: m[2].toLowerCase(), codec_name: m[3].split(/[ ,(]/)[0] }
        if (s.codec_type === 'video') {
          const size = /,\s*(\d{2,5})x(\d{2,5})[\s,[]/.exec(m[3] + ' ')
          if (size) { s.width = Number(size[1]); s.height = Number(size[2]) }
        }
        streams.push(s)
      }
      resolve({ format: { duration }, streams })
    })
  })
}

module.exports = { tool, find, probe }
