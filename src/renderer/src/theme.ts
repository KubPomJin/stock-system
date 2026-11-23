// Light / dark theme. The choice is kept per machine in localStorage (like the
// print settings), not per user: it has to apply to the login screen too, and
// a shop PC is shared. Default is light — the look the shop already knows.
//
// The colours themselves live in the DARK MODE block of index.html, keyed on
// <html data-theme="dark">. That block is screen-only, so printing never
// depends on what is set here.

type Theme = 'light' | 'dark'

const KEY = 'ui.theme'

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function apply(theme: Theme): void {
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme

  const btn = document.getElementById('btn-theme')
  if (!btn) return
  // The button names what a click will do, not the current state.
  const label = theme === 'dark' ? 'เปลี่ยนเป็นโหมดสว่าง' : 'เปลี่ยนเป็นโหมดมืด'
  btn.title = label
  btn.setAttribute('aria-label', label)
  const icon = btn.querySelector('i')
  if (icon) icon.className = theme === 'dark' ? 'ti ti-sun' : 'ti ti-moon'
}

export function initTheme(): void {
  apply(stored())
  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const next: Theme = stored() === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem(KEY, next)
    } catch {
      /* storage unavailable: the theme still switches for this session */
    }
    apply(next)
  })
}
