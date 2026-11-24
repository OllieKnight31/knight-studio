'use strict'
/**
 * Small private store for things that must not sit in settings.json where it could
 * be shared or synced by accident: API keys and the Google sign-in. One JSON file,
 * readable only by the user (mode 600), beside the settings.
 */
const fs = require('node:fs')
const path = require('node:path')
const prefs = require('./prefs')

const FILE = path.join(prefs.SETTINGS_DIR, 'secrets.json')

function readAll () {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {} } catch { return {} }
}

function get (key) {
  const v = readAll()[key]
  return v === undefined || v === '' ? null : v
}

function set (key, value) {
  const all = readAll()
  if (value === null || value === undefined || value === '') delete all[key]
  else all[key] = value
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, FILE)
  try { fs.chmodSync(FILE, 0o600) } catch {}
  return true
}

const has = key => get(key) !== null

module.exports = { get, set, has, FILE }
