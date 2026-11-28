'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')

/** Locates the knightcap binary in dev (native/bin) and when packaged (resources). */
function binaryPath () {
  const candidates = [
    path.join(__dirname, '..', '..', 'native', 'bin', 'knightcap'),
    path.join(process.resourcesPath || '', 'knightcap')
  ]
  for (const c of candidates) if (c && fs.existsSync(c)) return c
  throw new Error('knightcap binary not found — run `npm run native`')
}

/** Runs a one-shot knightcap subcommand and resolves the last JSON line it prints. */
function runOnce (args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`knightcap ${args[0]} timed out`)) }, timeoutMs)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      const lines = out.trim().split('\n').filter(Boolean)
      if (!lines.length) return reject(new Error(err || `knightcap ${args[0]} exited ${code} with no output`))
      try {
        resolve(JSON.parse(lines[lines.length - 1]))
      } catch (e) {
        reject(new Error(`unparseable knightcap output: ${lines[lines.length - 1]}`))
      }
    })
  })
}

async function listDevices () {
  const res = await runOnce(['list'])
  return res.data
}

async function requestScreen () {
  const res = await runOnce(['request-screen'], 60000)
  return !!res.data?.screenRecording
}

async function requestPermissions () {
  const res = await runOnce(['permissions'], 120000)
  return res.data
}

/**
 * One recording. Wraps the knightcap process: JSON lines on stdout become events,
 * and pause/resume/stop are written to its stdin.
 */
class CaptureSession extends EventEmitter {
  constructor (opts) {
    super()
    this.opts = opts
    this.child = null
    this.manifest = null
    this.stopped = false
  }

  start () {
    const o = this.opts
    const args = ['record', '--out', o.outDir, '--fps', String(o.fps ?? 60), '--min-fps', String(o.minFps ?? 5)]
    if (o.displayId != null) args.push('--display', String(o.displayId))
    if (o.windowId != null) args.push('--window', String(o.windowId))
    if (o.micId) args.push('--mic', o.micId)
    if (o.cameraId) args.push('--camera', o.cameraId)
    if (o.systemAudio === false) args.push('--no-system-audio')
    if (o.codec) args.push('--codec', o.codec)
    if (o.bakeCursor) args.push('--cursor')
    if (o.excludePids?.length) args.push('--exclude-pid', o.excludePids.join(','))

    this.child = spawn(binaryPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] })

    let buf = ''
    this.child.stdout.on('data', chunk => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (process.env.KS_DEBUG) console.log('[knightcap]', JSON.stringify(msg))
        this.emit('event', msg)
        if (msg.event === 'started') this.emit('started', msg)
        if (msg.event === 'error') this.emit('capture-error', new Error(msg.message))
      }
    })
    this.child.stderr.on('data', d => {
      if (process.env.KS_DEBUG) console.error('[knightcap:stderr]', String(d).trim())
      this.emit('stderr', String(d))
    })
    this.child.on('close', code => {
      if (process.env.KS_DEBUG) console.log('[knightcap] exited with code', code)
      this.stopped = true
      try {
        this.manifest = JSON.parse(fs.readFileSync(path.join(this.opts.outDir, 'manifest.json'), 'utf8'))
      } catch { /* no manifest if the capture never started */ }
      this.emit('closed', { code, manifest: this.manifest })
    })
    return this
  }

  #send (cmd) {
    if (this.child && !this.stopped && this.child.stdin.writable) this.child.stdin.write(cmd + '\n')
  }

  pause () { this.#send('pause') }
  resume () { this.#send('resume') }

  /** Asks knightcap to finalise, then waits for the file to be flushed and closed. */
  stop (timeoutMs = 30000) {
    return new Promise(resolve => {
      if (this.stopped) return resolve(this.manifest)
      const done = ({ manifest }) => resolve(manifest)
      this.once('closed', done)
      this.#send('stop')
      setTimeout(() => {
        if (!this.stopped) { this.child?.kill('SIGINT') }
      }, timeoutMs)
    })
  }
}

module.exports = { requestScreen, listDevices, requestPermissions, CaptureSession, binaryPath }
