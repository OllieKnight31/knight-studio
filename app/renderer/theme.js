// The app's colours: Ainable's "bone on night". Every other colour in the app is
// derived from these (see styles.css).

export const BRAND = { accent: '#F5F5F7', surface: '#0A0A0B' }

const hex = c => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Perceived lightness, 0 (black) to 1 (white). */
export function luminance (colour) {
  const rgb = hex(colour)
  if (!rgb) return 0
  const [r, g, b] = rgb.map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function applyBrand () {
  const root = document.documentElement
  root.style.setProperty('--accent', BRAND.accent)
  root.style.setProperty('--surface', BRAND.surface)
  root.style.setProperty('--ink', '#FFFFFF')
  root.style.setProperty('--on-accent', '#0E0E10')
  root.dataset.theme = 'dark'
  document.title = 'Knight Studio'
}

export const fileURL = p => 'knight://file' + String(p).split('/').map(encodeURIComponent).join('/')
