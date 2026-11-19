export const THEME_KEY = 'influ-theme'
const THEME_COLORS = { light: '#f4eee3', dark: '#15110d' }

export function readTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function resolveTheme(preference) {
  if (preference === 'light' || preference === 'dark') return preference
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'
}

export function applyTheme(preference) {
  const theme = resolveTheme(preference)
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme])
  return theme
}

export function saveTheme(preference) {
  try {
    if (preference === 'system') window.localStorage.removeItem(THEME_KEY)
    else window.localStorage.setItem(THEME_KEY, preference)
  } catch {
    return applyTheme(preference)
  }
  return applyTheme(preference)
}
