import type { PrinterInfo } from '../../shared/types'
import { esc } from './format'

let printers: PrinterInfo[] = []
let loaded = false

// Fetched once per session — the list rarely changes while the app is open.
//
// rememberKey keeps a SEPARATE printer choice per document type. The shop runs
// two printers with no overlap in paper: the count sheet is A4 and the order
// ticket is a 9 x 5.5in continuous form on the dot matrix. Defaulting both to
// the Windows default printer meant the A4 job kept going to the LQ-310, which
// has no A4 media at all — the driver refuses it and Chromium reports only
// "Print job failed". Remembering per document stops that happening silently.
export async function loadPrinters(selectEl: HTMLSelectElement, rememberKey?: string): Promise<void> {
  if (!loaded) {
    try {
      printers = await window.api.print.listPrinters()
    } catch {
      printers = []
    }
    loaded = true
  }
  const previous = selectEl.value
  selectEl.innerHTML = printers.length
    ? printers
        .map((p) => `<option value="${esc(p.name)}"${p.isDefault ? ' selected' : ''}>${esc(p.displayName)}</option>`)
        .join('')
    : '<option value="">— ไม่พบเครื่องพิมพ์ —</option>'

  const saved = rememberKey ? localStorage.getItem(rememberKey) : null
  if (saved && printers.some((p) => p.name === saved)) selectEl.value = saved
  else if (previous && printers.some((p) => p.name === previous)) selectEl.value = previous

  if (rememberKey && !selectEl.dataset.remember) {
    selectEl.dataset.remember = rememberKey
    selectEl.addEventListener('change', () => {
      if (selectEl.value) localStorage.setItem(rememberKey, selectEl.value)
    })
  }
}

export interface PrintRequest {
  bodyClass: string // which template the print stylesheet should reveal
  deviceName: string
  copies: number
  landscape: boolean
  // Number of sheets rendered — becomes a hard page cap on the job.
  pageCount?: number
  pageSize?: 'A4' | { widthIn: number; heightIn: number }
  // Leave unset unless the paper really has no unprintable edge. Asking a
  // laser/inkjet for 'none' makes the driver refuse the whole job.
  margins?: { marginType: 'default' | 'none' | 'printableArea' | 'custom' }
  // Suggested filename when the job is routed to the PDF writer path.
  defaultFileName?: string
  // CSS @page for this job only, so each document keeps its own paper size
  pageCss: string
}

// Prints straight to the chosen printer — the app's own preview has already
// shown the user the exact pages, so the Windows dialog would add nothing.
export async function runPrint(req: PrintRequest): Promise<{ ok: boolean; canceled?: boolean }> {
  const style = document.createElement('style')
  style.textContent = req.pageCss
  document.head.appendChild(style)
  document.body.classList.add(req.bodyClass)
  try {
    // "Microsoft Print to PDF" (and the other PDF writers) cannot be driven by
    // a silent print job — Windows shows its Save dialog but the spooler
    // receives nothing, so the saved file is always 0 bytes. Render the PDF
    // ourselves instead; same layout, and it works with no printer at all.
    if (/print to pdf|adobe pdf|xps document writer/i.test(req.deviceName || '')) {
      return await window.api.print.toPdf({
        landscape: req.landscape,
        defaultFileName: req.defaultFileName || 'stockkeep.pdf'
      })
    }
    return await window.api.print.run({
      deviceName: req.deviceName || undefined,
      copies: req.copies,
      landscape: req.landscape,
      pageCount: req.pageCount,
      pageSize: req.pageSize,
      margins: req.margins
    })
  } finally {
    document.body.classList.remove(req.bodyClass)
    style.remove()
  }
}

// Render the current template straight to a PDF file, with no printer involved.
// Used by screens that only ever need a file (the count-round record), and by
// the print dialog when the chosen "printer" is a PDF writer.
export async function savePdf(req: {
  bodyClass: string
  pageCss: string
  landscape?: boolean
  defaultFileName?: string
}): Promise<{ ok: boolean; canceled?: boolean; filePath?: string }> {
  const style = document.createElement('style')
  style.textContent = req.pageCss
  document.head.appendChild(style)
  document.body.classList.add(req.bodyClass)
  try {
    return await window.api.print.toPdf({
      landscape: req.landscape,
      defaultFileName: req.defaultFileName || 'stockkeep.pdf'
    })
  } finally {
    document.body.classList.remove(req.bodyClass)
    style.remove()
  }
}

// ---------------------------------------------------------------------------
// True-size preview
// ---------------------------------------------------------------------------
// Sheets are laid out at their real paper size so the preview matches the
// printout exactly, and are shown at 100% (the pane scrolls if the sheet is
// wider than the dialog). max-width is deliberately avoided — it squashed the
// width and quietly changed the layout, which is what made printed output
// differ from the preview.
export interface FitResult {
  scalePct: number
  overflowing: number // sheets whose content is taller than the page
}

export function fitSheets(areaId: string, sheetSelector: string, _sheetWidthIn: number): FitResult {
  const area = document.getElementById(areaId)
  if (!area) return { scalePct: 100, overflowing: 0 }

  // Shown at 100% — the preview pane scrolls rather than shrinking the sheet,
  // so what is on screen is literally the printed size.
  area.style.setProperty('--pv-zoom', '1')

  // Flag any sheet whose content spills past the fixed page height — that is
  // exactly the content that would be cut off on paper.
  let overflowing = 0
  area.querySelectorAll<HTMLElement>(sheetSelector).forEach((sheet) => {
    const inner = (sheet.firstElementChild as HTMLElement) ?? sheet
    // clientHeight includes the sheet's own paper-edge padding, which content
    // may not use — measure against the content box or the check goes blind.
    const cs = getComputedStyle(sheet)
    const avail = sheet.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    const spills = inner.scrollHeight > avail + 2
    sheet.classList.toggle('pv-overflow', spills)
    if (spills) overflowing++
  })

  return { scalePct: 100, overflowing }
}
