'use strict'
/**
 * Templates: a saved look — canvas shape, background, how the recording sits on it,
 * the camera bubble, the cursor, zoom style and caption style — that can be put on any
 * video in one click, or on every new recording automatically.
 *
 * A template holds the look only. It never carries clips, cuts, text or music, so
 * applying one cannot change what a video says.
 */
const crypto = require('node:crypto')
const prefs = require('./prefs')

const LOOK = ['canvas', 'background', 'style', 'camera', 'cursor', 'autoZoom', 'subtitles']

const all = () => Array.isArray(prefs.read().templates) ? prefs.read().templates : []
const copy = v => JSON.parse(JSON.stringify(v))

function lookOf (project) {
  const look = {}
  for (const k of LOOK) if (project && project[k] !== undefined) look[k] = copy(project[k])
  return look
}

function list () {
  const def = prefs.read().defaultTemplate || null
  return {
    templates: all().map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, isDefault: t.id === def })),
    defaultId: all().some(t => t.id === def) ? def : null
  }
}

function save (name, project) {
  const clean = String(name || '').trim().slice(0, 60)
  if (!clean) throw new Error('Give the template a name.')
  const items = all()
  const existing = items.find(t => t.name.toLowerCase() === clean.toLowerCase())
  const t = { id: existing?.id || `tpl_${crypto.randomBytes(5).toString('hex')}`, name: clean, createdAt: new Date().toISOString(), look: lookOf(project) }
  prefs.write({ templates: existing ? items.map(x => x.id === t.id ? t : x) : [...items, t] })
  return { ...list(), saved: t.id, replaced: !!existing }
}

function remove (id) {
  const patch = { templates: all().filter(t => t.id !== id) }
  if (prefs.read().defaultTemplate === id) patch.defaultTemplate = null
  prefs.write(patch)
  return list()
}

function setDefault (id) {
  prefs.write({ defaultTemplate: id && all().some(t => t.id === id) ? id : null })
  return list()
}

/** The look stored in a template, or null. */
function get (id) {
  const t = all().find(x => x.id === id)
  return t ? copy(t.look) : null
}

/** Lays a look over a project. Groups merge, so a template from an older version still fits. */
function applyTo (project, look) {
  if (!look) return project
  const next = { ...project }
  for (const k of LOOK) if (look[k] && typeof look[k] === 'object') next[k] = { ...(project[k] || {}), ...copy(look[k]) }
  return next
}

/** A brand-new video starts with the default template, if one is set. */
const applyDefault = project => applyTo(project, get(prefs.read().defaultTemplate))

module.exports = { list, save, remove, setDefault, get, applyTo, applyDefault, lookOf, LOOK }
