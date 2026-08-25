import { BrowserWindow, dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { handle } from './helpers'

function targetWindow(): BrowserWindow {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) throw new Error('ไม่พบหน้าต่างโปรแกรม')
  return win
}

export interface PrintRunOptions {
  deviceName?: string
  copies?: number
  landscape?: boolean
  // Hard cap on pages. The renderer knows exactly how many sheets it drew, so
  // a CSS mistake can never run a dot-matrix printer away with a box of paper.
  pageCount?: number
  // 'A4' or a custom size in inches (used by the 9 x 5.5 order ticket)
  pageSize?: 'A4' | { widthIn: number; heightIn: number }
  // Per-job margins. MUST stay optional: forcing 'none' on every job asks the
  // driver for a borderless page, which ordinary laser/inkjet printers reject
  // outright — that broke A4 stocktake printing in v1.4.2. Only the dot-matrix
  // order ticket wants a true zero edge (its form is defined with margin 0.00
  // and the sheet pads itself). Omit to keep Electron's default behaviour.
  margins?: { marginType: 'default' | 'none' | 'printableArea' | 'custom' }
}

const MICRONS_PER_INCH = 25400

export function registerPrintHandlers(): void {
  // Printers available to Windows, so the in-app dialog can offer the same
  // list the system dialog would.
  handle('print:listPrinters', 2, async () => {
    const printers = await targetWindow().webContents.getPrintersAsync()
    return printers.map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!p.isDefault,
      status: p.status
    }))
  })

  // Real PDF export. "Microsoft Print to PDF" cannot be driven by a silent
  // webContents.print(): Windows pops its Save dialog but the spooler job
  // carries no data, so the file lands on disk at 0 bytes every time. Rendering
  // the PDF ourselves and writing it is the only reliable route — and it needs
  // no printer driver at all, which matters because the shop's only physical
  // printer is a dot matrix with no A4 media.
  handle('print:toPdf', 2, async (opts: PrintRunOptions & { defaultFileName?: string }) => {
    const win = targetWindow()
    // preferCSSPageSize honours the @page rule the renderer just injected, so
    // each document keeps the exact paper size it was laid out for.
    const data = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      landscape: !!opts.landscape
    })
    const res = await dialog.showSaveDialog(win, {
      title: 'บันทึกเป็นไฟล์ PDF',
      defaultPath: opts.defaultFileName || 'stockkeep.pdf',
      filters: [{ name: 'ไฟล์ PDF', extensions: ['pdf'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    writeFileSync(res.filePath, data)
    return { ok: true, filePath: res.filePath }
  })

  // Prints without opening the Windows dialog — the app's own preview window
  // has already shown the user exactly what will come out.
  handle(
    'print:run',
    2,
    (opts: PrintRunOptions) =>
      new Promise((resolve, reject) => {
        const pageSize =
          opts.pageSize && typeof opts.pageSize === 'object'
            ? {
                width: Math.round(opts.pageSize.widthIn * MICRONS_PER_INCH),
                height: Math.round(opts.pageSize.heightIn * MICRONS_PER_INCH)
              }
            : 'A4'

        targetWindow().webContents.print(
          {
            silent: true,
            printBackground: true,
            deviceName: opts.deviceName || undefined,
            copies: Math.max(1, Math.min(99, Math.floor(opts.copies ?? 1))),
            landscape: !!opts.landscape,
            pageSize,
            ...(opts.margins ? { margins: opts.margins } : {}),
            ...(opts.pageCount && opts.pageCount > 0
              ? { pageRanges: [{ from: 0, to: Math.min(opts.pageCount, 200) - 1 }] }
              : {})
          },
          (success, failureReason) => {
            // Cancelling at the driver level reports failure too — treat the
            // known cancel string as a non-error so no scary toast appears.
            if (success) return resolve({ ok: true })
            if ((failureReason || '').toLowerCase().includes('cancel')) {
              return resolve({ ok: false, canceled: true })
            }
            // Chromium only ever says "Print job failed", which is a dead end
            // for the shop. The overwhelmingly common cause is asking a printer
            // for paper it does not have (an A4 count sheet sent to the
            // dot-matrix, which only holds the 9 x 5.5in form), so name the
            // printer and the paper in the message.
            const paper =
              opts.pageSize && typeof opts.pageSize === 'object'
                ? `${opts.pageSize.widthIn} × ${opts.pageSize.heightIn} นิ้ว`
                : `A4 ${opts.landscape ? 'แนวนอน' : 'แนวตั้ง'}`
            const who = opts.deviceName || 'เครื่องพิมพ์เริ่มต้นของ Windows'
            reject(
              new Error(
                `พิมพ์ไม่สำเร็จ — "${who}" ไม่รับงานกระดาษ ${paper}\n` +
                  `มักเกิดจากเครื่องพิมพ์นั้นไม่มีกระดาษขนาดนี้ ` +
                  `(เช่นส่งใบตรวจนับ A4 ไปที่เครื่องดอตแมทริกซ์ที่ใส่กระดาษต่อเนื่อง 9 × 5.5 นิ้ว)\n` +
                  `ลองเลือกเครื่องพิมพ์ให้ตรงกับชนิดเอกสาร แล้วพิมพ์ใหม่` +
                  (failureReason ? `\n[ระบบแจ้ง: ${failureReason}]` : '')
              )
            )
          }
        )
      })
  )
}
