import type { OrderDocView, OrderLinePayload, OrderLineView } from '../../../shared/types'
import { $, esc, input, select } from '../format'
import { fitSheets, loadPrinters, runPrint } from '../print'
import { productById, state } from '../state'
import { showToast, toastError } from '../ui'

let lines: OrderLinePayload[] = []
let history: OrderDocView[] = []

/* ---------- helpers ---------- */

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function nowTime(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return ''
  return n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Thai business documents use the Buddhist year.
function thaiDateParts(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return iso
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear() + 543}`
}

function num(id: string): number | null {
  const v = parseFloat(input(id).value)
  return isNaN(v) ? null : v
}

/* ---------- selectors ---------- */

export function renderOrderSelectors(): void {
  const sel = select('order-product-select')
  const current = sel.value
  sel.innerHTML =
    '<option value="">— ไม่เลือก (พิมพ์ชื่อเอง) —</option>' +
    state.products.map((p) => `<option value="${p.id}">${esc(p.barcode)} — ${esc(p.description)}</option>`).join('')
  if (current) sel.value = current

  const loc = select('order-location')
  const currentLoc = loc.value
  loc.innerHTML =
    '<option value="">—</option>' + state.locations.map((l) => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join('')
  if (currentLoc) loc.value = currentLoc

  refreshUnitOptions()
}

function refreshUnitOptions(): void {
  const unitSel = select('order-unit')
  const p = productById(Number(select('order-product-select').value))
  if (!p) {
    // Free-text item: let them type any unit name via a small fixed list.
    unitSel.innerHTML = ['', 'ชิ้น', 'กล่อง', 'พาเลท', 'ม้วน', 'แผ่น', 'กก.']
      .map((u) => `<option value="${esc(u)}">${esc(u || '—')}</option>`)
      .join('')
    return
  }
  unitSel.innerHTML = p.units.map((u) => `<option value="${esc(u.name)}">${esc(u.name)}</option>`).join('')
  // Default the price to the retail tier when a catalogue product is picked.
  if (p.prices['RETAIL'] !== undefined) input('order-price').value = String(p.prices['RETAIL'])
}

export async function refreshOrderDocNumber(): Promise<void> {
  try {
    input('order-doc-number').value = await window.api.orders.nextNumber(select('order-book').value)
  } catch {
    input('order-doc-number').value = ''
  }
}

/* ---------- lines ---------- */

function renderLines(): void {
  $('order-lines-body').innerHTML =
    lines
      .map(
        (l, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td>${esc(l.description)}</td>
      <td>${esc(l.locationName)}</td>
      <td class="num">${l.qty ?? ''}</td>
      <td>${esc(l.unitName)}</td>
      <td class="num">${money(l.unitPrice)}</td>
      <td class="num">${money(l.amount)}</td>
      <td><button class="icon-btn ord-remove" data-idx="${i}"><i class="ti ti-trash"></i></button></td>
    </tr>`
      )
      .join('') ||
    `<tr><td colspan="8"><div class="empty-state"><i class="ti ti-file-invoice"></i>ยังไม่มีรายการ — เพิ่มรายการด้านบน</div></td></tr>`

  $('order-lines-body')
    .querySelectorAll<HTMLButtonElement>('.ord-remove')
    .forEach((btn) =>
      btn.addEventListener('click', () => {
        lines.splice(Number(btn.dataset.idx), 1)
        renderLines()
      })
    )

  updateTotals()
}

function updateTotals(): void {
  const subtotal = lines.reduce((s, l) => s + (l.amount ?? 0), 0)
  const fee = parseFloat(input('order-delivery-fee').value) || 0
  const grand = subtotal + fee
  $('order-subtotal').textContent = money(subtotal)
  $('order-grand-total').textContent = money(grand)

  // Change is derived, never typed — keeps the printed slip self-consistent.
  const received = num('order-cash-received')
  input('order-cash-change').value = received === null ? '' : (received - grand).toFixed(2)
}

function addLine(): void {
  const p = productById(Number(select('order-product-select').value))
  const freeDesc = input('order-free-desc').value.trim()
  const description = p ? p.description : freeDesc
  if (!description) {
    showToast('กรุณาเลือกสินค้า หรือพิมพ์ชื่อสินค้าเอง', true)
    return
  }
  const qty = num('order-qty')
  const price = num('order-price')
  const amount = qty !== null && price !== null ? qty * price : null

  lines.push({
    productId: p?.id ?? null,
    description,
    locationName: select('order-location').value,
    qty,
    unitName: select('order-unit').value,
    unitPrice: price,
    amount
  })

  input('order-free-desc').value = ''
  input('order-qty').value = '1'
  renderLines()
}

/* ---------- print template (mirrors the paper form) ---------- */

interface PrintData {
  docNumber: string
  docDate: string
  docTime: string
  customerCode: string
  customerName: string
  customerContact: string
  deliveryMethod: string
  vehiclePlate: string
  paymentMethod: string
  cashReceived: number | null
  cashChange: number | null
  transferAmount: number | null
  transferRef: string
  note: string
  // null on a blank form, so the totals boxes print empty instead of "0.00"
  subtotal: number | null
  deliveryFee: number | null
  grandTotal: number | null
  lines: { description: string; locationName: string; qty: number | null; unitName: string; unitPrice: number | null; amount: number | null }[]
}

const MIN_PRINT_ROWS = 8
// A blank form gets the full ruled grid. Kept at 8 so each row can stretch
// tall enough to hand-write in without the sheet spilling onto a second page.
const BLANK_PRINT_ROWS = 8

// Everything empty except the running number — this is the sheet that gets
// filled in by hand, replacing the Google Sheets printout.
function blankPrintData(docNumber: string): PrintData {
  return {
    docNumber,
    docDate: '',
    docTime: '',
    customerCode: '',
    customerName: '',
    customerContact: '',
    deliveryMethod: '',
    vehiclePlate: '',
    paymentMethod: '',
    cashReceived: null,
    cashChange: null,
    transferAmount: null,
    transferRef: '',
    note: '',
    subtotal: null,
    deliveryFee: null,
    grandTotal: null,
    lines: []
  }
}

function box(checked: boolean): string {
  return checked ? '☑' : '☐'
}

function buildPrintHtml(d: PrintData): string {
  const rows = d.lines
    .map(
      (l, i) => `<tr class="ot-row">
      <td class="ot-c">${i + 1}</td>
      <td>${esc(l.description)}</td>
      <td class="ot-c">${esc(l.locationName ?? '')}</td>
      <td class="ot-n">${l.qty ?? ''}</td>
      <td class="ot-c">${esc(l.unitName ?? '')}</td>
      <td class="ot-n">${money(l.unitPrice)}</td>
      <td class="ot-n">${money(l.amount)}</td>
    </tr>`
    )
    .join('')

  // Pad with empty ruled rows so the printed form always looks like the
  // pre-printed paper, even for a short order (or a fully blank one).
  const wanted = d.lines.length === 0 ? BLANK_PRINT_ROWS : MIN_PRINT_ROWS
  const blanks = Math.max(0, wanted - d.lines.length)
  const blankRows = Array.from({ length: blanks })
    .map(() => `<tr class="ot-row"><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`)
    .join('')

  const dateText = d.docDate ? thaiDateParts(d.docDate) : '____ / ____ / ______'
  const timeText = d.docTime ? d.docTime : '____ : ____'

  return `<div class="ot-sheet"><div class="ot-doc">
    <div class="ot-head">
      <div class="ot-cust">
        <div>รหัสลูกค้า : <span class="ot-fill">${esc(d.customerCode)}</span></div>
        <div>ชื่อลูกค้า : <span class="ot-fill">${esc(d.customerName)}</span></div>
        <div>ที่อยู่ / โทร : <span class="ot-fill">${esc(d.customerContact)}</span></div>
      </div>
      <div class="ot-right">
        <div class="ot-title">ใบสั่งสินค้า</div>
        <div class="ot-meta">
          <span>เลขที่ : <b>${esc(d.docNumber)}</b></span>
          <span>หน้า : ___ / ___</span>
          <span>วันที่ : ${esc(dateText)}</span>
          <span>เวลา : ${esc(timeText)}</span>
        </div>
      </div>
    </div>

    <table class="ot-table">
      <colgroup>
        <col style="width:4%"><col style="width:40%"><col style="width:9%"><col style="width:9%">
        <col style="width:9%"><col style="width:13%"><col style="width:16%">
      </colgroup>
      <thead><tr>
        <th>NO</th><th>รายการสินค้า</th><th>คลัง</th><th>จำนวน</th><th>หน่วย</th><th>ราคา/หน่วย</th><th>จำนวนเงิน</th>
      </tr></thead>
      <tbody>${rows}${blankRows}</tbody>
    </table>

    <div class="ot-bottom">
      <div class="ot-pay">
        <div>วิธีรับสินค้า : ${box(d.deliveryMethod === 'DELIVER')} จัดส่ง &nbsp; ${box(d.deliveryMethod === 'PICKUP')} รับที่ร้าน &nbsp; ทะเบียนรถ : <span class="ot-u">${esc(d.vehiclePlate)}</span></div>
        <div>ชำระเงิน : ${box(d.paymentMethod === 'CASH')} เงินสด &nbsp; รับเงินมา: <span class="ot-u">${money(d.cashReceived)}</span> บาท &nbsp; เงินทอน: <span class="ot-u">${money(d.cashChange)}</span> บาท</div>
        <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${box(d.paymentMethod === 'TRANSFER')} โอน &nbsp; ยอดโอน: <span class="ot-u">${money(d.transferAmount)}</span> บาท (เบอร์โทร/เลขบัญชี): <span class="ot-u">${esc(d.transferRef)}</span></div>
        <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${box(d.paymentMethod === 'CREDIT')} เครดิต &nbsp; หมายเหตุ: <span class="ot-u" style="min-width:170px;">${esc(d.note)}</span></div>
      </div>
      <div class="ot-totals">
        <div><span class="l">รวม</span><span class="v">${money(d.subtotal)}</span></div>
        <div><span class="l">ค่าจัดส่ง</span><span class="v">${money(d.deliveryFee)}</span></div>
        <div class="ot-grand"><span class="l">รวมเป็นเงิน (บาท)</span><span class="v">${money(d.grandTotal)}</span></div>
      </div>
    </div>

    <div class="ot-sign">
      <div><div class="ot-line"></div>พนักงานยกของ/ส่งของ</div>
      <div><div class="ot-line"></div>ผู้รับของ (ลูกค้า)</div>
      <div><div class="ot-line"></div>ผู้ออกเอกสาร</div>
      <div><div class="ot-line"></div>ผู้รับเงิน(เจ้าของ)</div>
    </div>
  </div></div>`
}

function currentFormData(): PrintData {
  const subtotal = lines.reduce((s, l) => s + (l.amount ?? 0), 0)
  const deliveryFee = parseFloat(input('order-delivery-fee').value) || 0
  const received = num('order-cash-received')
  const grandTotal = subtotal + deliveryFee
  return {
    docNumber: input('order-doc-number').value.trim(),
    docDate: input('order-date').value,
    docTime: input('order-time').value,
    customerCode: input('order-cust-code').value.trim(),
    customerName: input('order-cust-name').value.trim(),
    customerContact: input('order-cust-contact').value.trim(),
    deliveryMethod: select('order-delivery-method').value,
    vehiclePlate: input('order-plate').value.trim(),
    paymentMethod: select('order-payment-method').value,
    cashReceived: received,
    cashChange: received === null ? null : received - grandTotal,
    transferAmount: num('order-transfer-amount'),
    transferRef: input('order-transfer-ref').value.trim(),
    note: input('order-note').value.trim(),
    subtotal,
    deliveryFee,
    grandTotal,
    lines
  }
}

// Accepts one or many sheets — blank-form batches print several at once.
// Horizontal print offset, in millimetres, stored per machine. Continuous
// paper rarely sits perfectly centred in the tractor feed, and that is a
// property of the printer rather than of the document — so it is a setting,
// never a hard-coded nudge in the layout.
// Paper margins, in millimetres, stored per machine. A continuous form never
// sits identically in two tractor feeds, so the usable area is a property of
// the printer, not of the document — the operator dials it in once here.
type Margins = { top: number; right: number; bottom: number; left: number }

const MARGIN_KEY = 'print.orderMargins'
const PAPER_KEY = 'print.orderPaper'

// 5.1mm = 0.2in top/bottom. Sides default to the 0.5in tractor strip on a full
// 9in sheet, and to nothing when only the 8in printable area is sent.
function defaultMargins(paperIn: number): Margins {
  const side = paperIn === 9 ? 12.7 : 0
  return { top: 5.1, right: side, bottom: 5.1, left: side }
}

function paperWidthIn(): number {
  return select('ov-paper').value === '8' ? 8 : 9
}

function readMargins(): Margins {
  const n = (id: string, fallback: number): number => {
    const v = parseFloat(input(id).value)
    return isNaN(v) ? fallback : Math.max(0, Math.min(60, v))
  }
  const d = defaultMargins(paperWidthIn())
  return { top: n('ov-m-top', d.top), right: n('ov-m-right', d.right), bottom: n('ov-m-bottom', d.bottom), left: n('ov-m-left', d.left) }
}

function writeMarginInputs(m: Margins): void {
  input('ov-m-top').value = String(m.top)
  input('ov-m-right').value = String(m.right)
  input('ov-m-bottom').value = String(m.bottom)
  input('ov-m-left').value = String(m.left)
}

function applyMargins(): void {
  const m = readMargins()
  const area = $('order-print-area')
  area.style.setProperty('--ot-mt', `${m.top}mm`)
  area.style.setProperty('--ot-mr', `${m.right}mm`)
  area.style.setProperty('--ot-mb', `${m.bottom}mm`)
  area.style.setProperty('--ot-ml', `${m.left}mm`)

  // Show what is actually left to print on — the number that matters when the
  // table starts getting clipped.
  const wMm = paperWidthIn() * 25.4 - m.left - m.right
  const hMm = 5.5 * 25.4 - m.top - m.bottom
  $('ov-print-area').textContent = `พื้นที่พิมพ์ ${wMm.toFixed(1)} × ${hMm.toFixed(1)} มม.`
  localStorage.setItem(MARGIN_KEY, JSON.stringify(m))
}

function applyPaperChoice(): void {
  $('order-print-area').style.setProperty('--ot-paper-w', `${paperWidthIn()}in`)
  $('ov-scale').textContent = `แสดงขนาดจริง 100% · ${paperWidthIn()} × 5.5 นิ้ว`
}

function restorePrintSettings(): void {
  select('ov-paper').value = localStorage.getItem(PAPER_KEY) ?? '9'
  applyPaperChoice()
  let m = defaultMargins(paperWidthIn())
  try {
    const saved = localStorage.getItem(MARGIN_KEY)
    if (saved) m = { ...m, ...(JSON.parse(saved) as Margins) }
  } catch {
    // Corrupt stored value — fall back to the defaults rather than breaking print.
  }
  writeMarginInputs(m)
  applyMargins()
}

function openPreview(docs: PrintData | PrintData[]): void {
  const list = Array.isArray(docs) ? docs : [docs]
  $('order-print-area').innerHTML = list.map(buildPrintHtml).join('')
  $('ov-sheet-count').textContent = String(list.length)
  restorePrintSettings()
  void loadPrinters(select('ov-printer'), 'printer.orderTicket')
  $('order-preview-modal').classList.add('active')
  // Must run after the modal is visible, otherwise widths measure as zero.
  requestAnimationFrame(() => {
    const fit = fitSheets('order-print-area', '.ot-sheet', 9)
    $('ov-scale').textContent = `แสดงขนาดจริง 100% · ${paperWidthIn()} × 5.5 นิ้ว`
    const warn = $('ov-warn')
    warn.classList.toggle('show', fit.overflowing > 0)
    const msg = warn.querySelector('span')
    if (msg) msg.textContent = `เนื้อหาเกินขอบกระดาษ ${fit.overflowing} ใบ — ส่วนที่เกินจะหายตอนพิมพ์`
  })
}

function closePreview(): void {
  $('order-preview-modal').classList.remove('active')
}

// Prints straight to the selected printer. pageSize MUST be the physical paper
// (9 x 5.5in — the driver form "Carbonless papaer 9x5.5"), not the printable
// area: asking for 8 x 5.5 matched no form, so Windows substituted a different
// one and the paper crept down a little on every sheet. The tractor-feed strips
// are excluded with a 0.5in side margin instead, leaving the same 8 x 5.1in of
// content as before. The A4 stocktake sheet keeps its own size because the page
// rule is injected per job.
async function doPrint(): Promise<void> {
  try {
    const res = await runPrint({
      bodyClass: 'printing-order',
      deviceName: select('ov-printer').value,
      copies: parseInt(input('ov-copies').value, 10) || 1,
      landscape: false,
      pageCount: $('order-print-area').querySelectorAll('.ot-sheet').length,
      pageSize: { widthIn: paperWidthIn(), heightIn: 5.5 },
      defaultFileName: 'ใบสั่งสินค้า.pdf',
      // Only this document asks for a zero edge: the LQ-310 continuous form is
      // defined in the driver with margin 0.00 on all sides, and each .ot-sheet
      // pads itself. Never set this for A4 — the driver rejects borderless.
      margins: { marginType: 'none' },
      // margin:0 here — the 0.2/0.5in edges live as padding on each .ot-sheet so
      // they repeat on every page (container padding only pads first/last page).
      pageCss: `@media print{@page{size:${paperWidthIn()}in 5.5in;margin:0;}}`
    })
    if (res.ok) {
      closePreview()
      showToast('ส่งไปที่เครื่องพิมพ์แล้ว')
    }
  } catch (err) {
    toastError(err)
  }
}

/* ---------- blank forms (the main workflow) ---------- */

export async function refreshBlankStartNumber(): Promise<void> {
  try {
    input('blank-start').value = await window.api.orders.nextNumber(select('blank-book').value)
  } catch {
    input('blank-start').value = ''
  }
}

async function previewBlankForms(): Promise<void> {
  const count = parseInt(input('blank-count').value, 10)
  if (!(count >= 1 && count <= 100)) {
    showToast('จำนวนใบต้องอยู่ระหว่าง 1 ถึง 100', true)
    return
  }
  try {
    // Reserving here consumes the numbers, so the next batch continues on and
    // the same number is never printed twice.
    const { numbers } = await window.api.orders.reserveNumbers({
      bookType: select('blank-book').value,
      startNumber: input('blank-start').value.trim(),
      count
    })
    openPreview(numbers.map(blankPrintData))
    await refreshBlankStartNumber()
    showToast(
      numbers.length === 1
        ? `เตรียมฟอร์มเปล่าเลขที่ ${numbers[0]} แล้ว — กด "พิมพ์" ในหน้าต่างตัวอย่าง`
        : `เตรียมฟอร์มเปล่า ${numbers.length} ใบ (${numbers[0]} ถึง ${numbers[numbers.length - 1]})`
    )
  } catch (err) {
    toastError(err)
  }
}

/* ---------- save + history ---------- */

function resetForm(): void {
  lines = []
  ;['order-cust-code', 'order-cust-name', 'order-cust-contact', 'order-plate', 'order-note',
    'order-transfer-ref', 'order-cash-received', 'order-transfer-amount'].forEach((id) => (input(id).value = ''))
  input('order-delivery-fee').value = '0'
  input('order-date').value = todayIso()
  input('order-time').value = nowTime()
  select('order-delivery-method').value = ''
  select('order-payment-method').value = ''
  renderLines()
}

async function saveAndPrint(): Promise<void> {
  const d = currentFormData()
  if (!d.docNumber) {
    showToast('กรุณาระบุเลขที่เอกสาร', true)
    return
  }
  if (lines.length === 0) {
    showToast('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ', true)
    return
  }
  try {
    await window.api.orders.save({
      docNumber: d.docNumber,
      bookType: select('order-book').value,
      docDate: d.docDate,
      docTime: d.docTime,
      customerCode: d.customerCode,
      customerName: d.customerName,
      customerContact: d.customerContact,
      deliveryMethod: d.deliveryMethod as never,
      vehiclePlate: d.vehiclePlate,
      paymentMethod: d.paymentMethod as never,
      cashReceived: d.cashReceived,
      cashChange: d.cashChange,
      transferAmount: d.transferAmount,
      transferRef: d.transferRef,
      note: d.note,
      // currentFormData() always computes these; the nullable type exists only
      // so blank forms can print empty totals.
      subtotal: d.subtotal ?? 0,
      deliveryFee: d.deliveryFee ?? 0,
      grandTotal: d.grandTotal ?? 0,
      lines
    })
    showToast(`บันทึกใบสั่งสินค้า ${d.docNumber} แล้ว`)
    openPreview(d)
    await renderOrderHistory()
    resetForm()
    await refreshOrderDocNumber()
  } catch (err) {
    toastError(err)
  }
}

export async function renderOrderHistory(): Promise<void> {
  try {
    history = await window.api.orders.list()
  } catch {
    history = []
  }
  $('order-history-body').innerHTML =
    history
      .map(
        (o) => `<tr>
      <td class="mono">${esc(o.docNumber)}</td>
      <td>${esc(thaiDateParts(o.docDate ?? ''))} ${esc(o.docTime ?? '')}</td>
      <td>${esc(o.customerName ?? '—')}</td>
      <td class="num">${o.lineCount}</td>
      <td class="num">${money(o.grandTotal)}</td>
      <td>${esc(o.userName ?? '—')}</td>
      <td><button class="btn small ord-reprint" data-id="${o.id}"><i class="ti ti-printer"></i>พิมพ์ซ้ำ</button></td>
    </tr>`
      )
      .join('') ||
    `<tr><td colspan="7"><div class="empty-state"><i class="ti ti-file-invoice"></i>ยังไม่มีใบสั่งสินค้าที่บันทึกไว้</div></td></tr>`

  $('order-history-body')
    .querySelectorAll<HTMLButtonElement>('.ord-reprint')
    .forEach((btn) => btn.addEventListener('click', () => void reprint(Number(btn.dataset.id))))
}

async function reprint(id: number): Promise<void> {
  try {
    const { doc, lines: docLines } = await window.api.orders.get(id)
    openPreview({
      docNumber: doc.docNumber,
      docDate: doc.docDate ?? '',
      docTime: doc.docTime ?? '',
      customerCode: doc.customerCode ?? '',
      customerName: doc.customerName ?? '',
      customerContact: doc.customerContact ?? '',
      deliveryMethod: doc.deliveryMethod ?? '',
      vehiclePlate: doc.vehiclePlate ?? '',
      paymentMethod: doc.paymentMethod ?? '',
      cashReceived: doc.cashReceived,
      cashChange: doc.cashChange,
      transferAmount: doc.transferAmount,
      transferRef: doc.transferRef ?? '',
      note: doc.note ?? '',
      subtotal: doc.subtotal,
      deliveryFee: doc.deliveryFee,
      grandTotal: doc.grandTotal,
      lines: (docLines as OrderLineView[]).map((l) => ({
        description: l.description,
        locationName: l.locationName ?? '',
        qty: l.qty,
        unitName: l.unitName ?? '',
        unitPrice: l.unitPrice,
        amount: l.amount
      }))
    })
  } catch (err) {
    toastError(err)
  }
}

/* ---------- init ---------- */

export function initOrders(): void {
  input('order-date').value = todayIso()
  input('order-time').value = nowTime()

  select('blank-book').addEventListener('change', () => void refreshBlankStartNumber())
  $('btn-blank-preview').addEventListener('click', () => void previewBlankForms())

  select('order-book').addEventListener('change', () => void refreshOrderDocNumber())
  select('order-product-select').addEventListener('change', refreshUnitOptions)
  $('btn-order-add-line').addEventListener('click', addLine)
  input('order-delivery-fee').addEventListener('input', updateTotals)
  input('order-cash-received').addEventListener('input', updateTotals)

  $('btn-order-preview').addEventListener('click', () => {
    if (lines.length === 0) {
      showToast('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ', true)
      return
    }
    openPreview(currentFormData())
  })
  $('btn-order-save').addEventListener('click', () => void saveAndPrint())

  // Live-preview the offset and remember it for this machine only.
  select('ov-paper').addEventListener('change', () => {
    localStorage.setItem(PAPER_KEY, select('ov-paper').value)
    applyPaperChoice()
    // Side margins mean something different per paper mode, so reset to that
    // mode's sensible starting point instead of carrying the old numbers over.
    writeMarginInputs(defaultMargins(paperWidthIn()))
    applyMargins()
  })
  ;['ov-m-top', 'ov-m-right', 'ov-m-bottom', 'ov-m-left'].forEach((id) =>
    input(id).addEventListener('input', applyMargins)
  )
  $('ov-m-reset').addEventListener('click', () => {
    writeMarginInputs(defaultMargins(paperWidthIn()))
    applyMargins()
  })
  $('btn-do-order-print').addEventListener('click', () => void doPrint())
  $('btn-close-order-preview').addEventListener('click', closePreview)
  $('btn-cancel-order-preview').addEventListener('click', closePreview)
  $('order-preview-modal').addEventListener('click', (e) => {
    if (e.target === $('order-preview-modal')) closePreview()
  })

  renderLines()
}
