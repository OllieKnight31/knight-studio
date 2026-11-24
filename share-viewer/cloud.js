// Signing in and talking to the sharing service, for the pages people open in a browser.
// config.js (written when the site is published) says where the service is.
window.KSCloud = (() => {
  const cfg = window.KS_CLOUD || {}
  const base = String(cfg.url || '').replace(/\/+$/, '')
  const key = cfg.key || ''
  const KEY = 'ks-session'
  const { esc } = window.KSPlayer

  // Kept in this browser so the person stays signed in. An embedded page may be refused
  // storage by the browser; then the sign-in simply lasts until the page is closed.
  let memory = null
  const read = () => { if (memory) return memory; try { memory = JSON.parse(localStorage.getItem(KEY) || 'null') } catch {} return memory }
  const write = s => { memory = s; try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY) } catch {} }
  const keep = (j, email) => write({ access: j.access_token, refresh: j.refresh_token, expires: Date.now() + (Number(j.expires_in) || 3600) * 1000, email: (j.user && j.user.email) || email || (read() || {}).email })

  async function call (path, body, token) {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${token || key}` }, body: JSON.stringify(body || {}) })
    let json = null
    try { json = await res.json() } catch {}
    return { ok: res.ok, status: res.status, json }
  }

  let renewing = null
  async function token () {
    const s = read()
    if (!s) return null
    if (s.expires - Date.now() > 60000) return s.access
    if (!renewing) {
      renewing = call('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh })
        .then(r => { if (!r.ok) { write(null); return null } keep(r.json); return r.json.access_token })
        .finally(() => { renewing = null })
    }
    return renewing
  }

  /** Calls one of the service's functions, as the signed-in person if there is one. */
  async function rpc (fn, body) {
    let r = await call(`/rest/v1/rpc/${fn}`, body, await token())
    if (r.status === 401 && read()) { write({ ...read(), expires: 0 }); r = await call(`/rest/v1/rpc/${fn}`, body, await token()) }
    if (!r.ok) throw new Error((r.json && (r.json.message || r.json.msg)) || `HTTP ${r.status}`)
    return r.json
  }

  /** Fire-and-forget, safe to call as the page closes. */
  function beacon (fn, body) {
    const s = read()
    fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${(s && s.expires > Date.now() ? s.access : null) || key}` }, body: JSON.stringify(body) })
      .then(r => r.json()).then(j => { if (beacon.onAnswer) beacon.onAnswer(j) }).catch(() => {})
  }

  // An emailed sign-in link lands here with the keys in the address; take them and tidy up.
  function adoptLink () {
    if (!/access_token=/.test(location.hash)) return false
    const h = new URLSearchParams(location.hash.slice(1))
    if (!h.get('access_token') || !h.get('refresh_token')) return false
    let email = ''
    try { email = JSON.parse(atob(h.get('access_token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || '' } catch {}
    keep({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_in: h.get('expires_in') }, email)
    history.replaceState(null, '', location.pathname + location.search)
    return true
  }

  function signOut () {
    const s = read()
    if (s) fetch(`${base}/auth/v1/logout`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${s.access}` } }).catch(() => {})
    write(null)
  }

  /** The sign-in card: email, then the six-digit code that was emailed. */
  function gate (app, { title, text, onDone }) {
    let email = ''
    const step1 = err => {
      app.innerHTML = `<form class="gate" id="g"><h1>${esc(title)}</h1><p>${esc(text)}</p>
        <input type="email" id="e" placeholder="you@company.com" autocomplete="email" value="${esc(email)}" required>
        ${err ? `<div class="err">${esc(err)}</div>` : ''}
        <button class="go" id="go">Email me a sign-in code</button>
        <p style="font-size:13px">No password. We email you a six-digit code.</p></form>`
      app.querySelector('#e').focus()
      app.querySelector('#g').onsubmit = async ev => {
        ev.preventDefault()
        email = app.querySelector('#e').value.trim().toLowerCase()
        app.querySelector('#go').disabled = true
        const r = await call('/auth/v1/otp', { email, create_user: true }).catch(() => ({ ok: false, json: null }))
        if (!r.ok) return step1(r.status === 429 ? 'Too many codes have been asked for. Wait a minute and try again.' : 'That code could not be sent. Check the address and try again.')
        step2()
      }
    }
    const step2 = err => {
      app.innerHTML = `<form class="gate" id="g"><h1>Check your email</h1><p>We sent a six-digit code to <b>${esc(email)}</b>. It can take a minute.</p>
        <input class="code" id="c" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="8" required>
        ${err ? `<div class="err">${esc(err)}</div>` : ''}
        <button class="go" id="go">Sign in</button>
        <button type="button" class="alt" id="back">Use a different email</button></form>`
      app.querySelector('#c').focus()
      app.querySelector('#back').onclick = () => step1()
      app.querySelector('#g').onsubmit = async ev => {
        ev.preventDefault()
        app.querySelector('#go').disabled = true
        const r = await call('/auth/v1/verify', { type: 'email', email, token: app.querySelector('#c').value.replace(/\D/g, '') }).catch(() => ({ ok: false }))
        if (!r.ok || !r.json || !r.json.access_token) return step2('That code is not right, or it has expired. Check the newest email.')
        keep(r.json, email)
        onDone()
      }
    }
    step1()
  }

  const fileUrl = path => path ? `${base}/storage/v1/object/public/videos/${String(path).split('/').map(encodeURIComponent).join('/')}` : null
  return { ready: !!(base && key), rpc, beacon, gate, adoptLink, signOut, fileUrl, email: () => (read() || {}).email || null, signedIn: () => !!read() }
})()
