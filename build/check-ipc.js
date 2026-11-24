#!/usr/bin/env node
'use strict'
// Every channel the preload exposes must have a handler in the main process.
//
// This exists because an editing slip once deleted all seven export:* handlers while
// the preload kept calling them, and the only symptom was "Error invoking remote
// method" at the moment a user tried to export. A missing handler is invisible until
// someone clicks the thing, so it gets checked at build time instead.
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'app/main/index.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'app/preload/index.js'), 'utf8')

const invoked = [...new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map(m => m[1]))]
const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]))
const missing = invoked.filter(c => !handled.has(c))

// Channels the renderer listens on must be allow-listed in the preload's `on` guard.
const sent = [...new Set([...main.matchAll(/send\('([^']+)'/g)].map(m => m[1]))]
const forwarded = new Set([...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map(m => m[1]))
const allowed = new Set([...preload.matchAll(/'([a-z]+:[a-zA-Z]+)'/g)].map(m => m[1]))
const unreachable = sent.filter(c => !forwarded.has(c) && !allowed.has(c))

if (missing.length) {
  console.error(`IPC check FAILED — preload calls channels with no handler:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}
console.log(`IPC check ok — ${invoked.length} channels, all handled.` +
  (unreachable.length ? `\n  note: main sends but nothing forwards: ${unreachable.join(', ')}` : ''))
