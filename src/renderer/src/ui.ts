import { $, esc } from './format'

let toastTimer: ReturnType<typeof setTimeout> | undefined

export function showToast(msg: string, isError = false): void {
  const t = $('toast')
  ;($('toast-msg') as HTMLElement).textContent = msg
  t.classList.toggle('error', isError)
  const icon = t.querySelector('i')
  if (icon) icon.className = isError ? 'ti ti-alert-circle-filled' : 'ti ti-circle-check'
  t.classList.add('show')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 3600)
}

export function toastError(err: unknown): void {
  showToast(err instanceof Error ? err.message : String(err), true)
}

export interface ModalField {
  key: string
  label: string
  type?: 'text' | 'password' | 'select'
  placeholder?: string
  value?: string
  options?: { value: string; label: string }[]
}

// window.prompt() is not supported in Electron, so simple inputs go through
// this small modal instead. Resolves null when cancelled.
export function promptModal(
  title: string,
  fields: ModalField[],
  validate?: (values: Record<string, string>) => string | null
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const backdrop = $('modal-backdrop')
    const errorEl = $('modal-error')
    ;($('modal-title') as HTMLElement).textContent = title
    errorEl.style.display = 'none'

    $('modal-fields').innerHTML = fields
      .map((f) => {
        if (f.type === 'select') {
          const opts = (f.options ?? [])
            .map((o) => `<option value="${esc(o.value)}"${o.value === f.value ? ' selected' : ''}>${esc(o.label)}</option>`)
            .join('')
          return `<div class="modal-field"><label>${esc(f.label)}</label><select data-key="${esc(f.key)}">${opts}</select></div>`
        }
        return `<div class="modal-field"><label>${esc(f.label)}</label><input type="${f.type ?? 'text'}" data-key="${esc(f.key)}" placeholder="${esc(f.placeholder ?? '')}" value="${esc(f.value ?? '')}" autocomplete="off"></div>`
      })
      .join('')

    backdrop.classList.add('active')
    const firstInput = $('modal-fields').querySelector('input, select') as HTMLElement | null
    firstInput?.focus()

    const okBtn = $('modal-ok')
    const cancelBtn = $('modal-cancel')

    function readValues(): Record<string, string> {
      const values: Record<string, string> = {}
      $('modal-fields')
        .querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]')
        .forEach((el) => {
          values[el.dataset.key as string] = el.value
        })
      return values
    }

    function cleanup(): void {
      backdrop.classList.remove('active')
      okBtn.replaceWith(okBtn.cloneNode(true))
      cancelBtn.replaceWith(cancelBtn.cloneNode(true))
      document.removeEventListener('keydown', onKey)
    }

    function submit(): void {
      const values = readValues()
      const error = validate?.(values) ?? null
      if (error) {
        errorEl.textContent = error
        errorEl.style.display = 'block'
        return
      }
      cleanup()
      resolve(values)
    }

    function cancel(): void {
      cleanup()
      resolve(null)
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') cancel()
      else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'SELECT') submit()
    }

    okBtn.addEventListener('click', submit)
    cancelBtn.addEventListener('click', cancel)
    document.addEventListener('keydown', onKey)
  })
}
