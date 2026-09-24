// ขายหน้าร้าน — คีย์บิลขาย (POS entry)
//
// Built for typing up hand-written order tickets quickly, Excel-style:
// type a product name/barcode → ↑↓ + Enter to pick → qty → Enter → price →
// Enter opens the next line. Anything not in the catalogue can still be typed
// as free text. Saving never touches stock (money only, owner's decision).

import { $, baht, esc, input } from '../format'
import { level, state } from '../state'
import { promptModal, showToast, toastError } from '../ui'
import type { BookNextNumber, ProductView, SalePayMethod, SaleView } from '../../../shared/types'
import { money, payLabel, splitText, thaiDate, thaiDateTime, todayIso, transferBadge } from './salesCommon'

interface Line {
  productId: number | null
  description: string
  qty: number
  unitName: string
  unitPrice: number
}

const BOOKS = ['A', 'B', 'C', 'D']
// Pseudo-book for a sale that wasn't written on a printed, numbered ticket.
// The server numbers those itself in their own series (N69-0001).
const NO_TICKET = 'NONE'

let lines: Line[] = []
let editingId: number | null = null
let book = 'A'
let lastPaperBook = 'A' // where to go back to after a no-ticket bill
let editingNoTicketNumber = '' // N-number of the no-ticket bill being edited
let pay: SalePayMethod = 'CASH'
let nextNumbers: BookNextNumber[] = []
let dayLocked = false
let goToView: (view: string) => void = () => {}

/* =========================================================================
   Product search (one floating dropdown shared by every line)
   ========================================================================= */

let indexFor: ProductView[] | null = null
let searchIndex: { p: ProductView; hay: string; bar: string }[] = []

function ensureIndex(): void {
  if (indexFor === state.products) return
  indexFor = state.products
  searchIndex = state.products.map((p) => ({
    p,
    bar: (p.barcode ?? '').toLowerCase(),
    hay: `${p.barcode ?? ''} ${p.subBarcode ?? ''} ${p.description}`.toLowerCase()
  }))
}

// Every typed word must appear; exact barcode first, then names starting with
// the text, then the rest — so typing a barcode + Enter picks the right item.
function searchProducts(text: string, limit = 10): ProductView[] {
  const q = text.trim().toLowerCase()
  if (!q) return []
  ensureIndex()
  const words = q.split(/\s+/)
  const scored: { p: ProductView; score: number }[] = []
  for (const e of searchIndex) {
    if (!words.every((w) => e.hay.includes(w))) continue
    let score = 3
    if (e.bar === q) score = 0
    else if (e.p.description.toLowerCase().startsWith(q)) score = 1
    else if (e.bar.startsWith(q)) score = 2
    scored.push({ p: e.p, score })
    if (scored.length > 400) break
  }
  scored.sort((a, b) => a.score - b.score || a.p.description.localeCompare(b.p.description, 'th'))
  return scored.slice(0, limit).map((s) => s.p)
}

function retailPerBase(p: ProductView): number {
  return p.prices?.RETAIL ?? 0
}

function baseUnit(p: ProductView): { name: string; qtyPerBase: number } | null {
  const u = p.units[p.units.length - 1]
  return u ? { name: u.name, qtyPerBase: u.qtyPerBase } : null
}

let suggestFor = -1 // line index the dropdown belongs to
let suggestItems: ProductView[] = []
let suggestActive = 0

function suggestBox(): HTMLElement {
  return $('pos-suggest')
}

function closeSuggest(): void {
  suggestBox().classList.remove('open')
  suggestFor = -1
}

function renderSuggest(): void {
  const box = suggestBox()
  const inputEl = document.querySelector<HTMLInputElement>(`.pl-item[data-i="${suggestFor}"]`)
  if (!inputEl) return closeSuggest()
  const typed = inputEl.value.trim()
  if (!typed) return closeSuggest()

  const opts = suggestItems
    .map((p, i) => {
      const price = retailPerBase(p)
      const bu = baseUnit(p)
      return `<div class="ps-opt${i === suggestActive ? ' active' : ''}" data-k="${i}">
        <span class="ps-bar">${esc(p.barcode)}</span>
        <span class="ps-desc">${esc(p.description)}</span>
        <span class="ps-price">${price ? money(price) : '—'}${bu ? ` / ${esc(bu.name)}` : ''}</span>
      </div>`
    })
    .join('')
  const freeIdx = suggestItems.length
  box.innerHTML =
    opts +
    `<div class="ps-opt ps-free${suggestActive === freeIdx ? ' active' : ''}" data-k="${freeIdx}">
       <i class="ti ti-pencil"></i> ใช้ข้อความที่พิมพ์: "${esc(typed)}" (ไม่อยู่ในรายการสินค้า)
     </div>`

  const r = inputEl.getBoundingClientRect()
  box.style.left = `${Math.round(r.left)}px`
  box.style.top = `${Math.round(r.bottom + 3)}px`
  box.style.width = `${Math.max(Math.round(r.width), 460)}px`
  box.classList.add('open')

  box.querySelectorAll<HTMLElement>('.ps-opt').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      pickSuggestion(Number(el.dataset.k))
    })
  })
  box.querySelector('.ps-opt.active')?.scrollIntoView({ block: 'nearest' })
}

function openSuggest(i: number): void {
  const el = document.querySelector<HTMLInputElement>(`.pl-item[data-i="${i}"]`)
  if (!el) return
  suggestFor = i
  suggestItems = searchProducts(el.value)
  suggestActive = 0
  renderSuggest()
}

function pickSuggestion(k: number): void {
  const i = suggestFor
  if (i < 0) return
  const p = suggestItems[k]
  closeSuggest()
  if (p) applyProduct(i, p)
  else lines[i].productId = null // chose "use the typed text"
  renderRow(i)
  updateTotals()
  focusCell(i, 'pl-qty')
}

function applyProduct(i: number, p: ProductView): void {
  const bu = baseUnit(p)
  lines[i] = {
    productId: p.id,
    description: p.description,
    qty: lines[i].qty || 1,
    unitName: bu?.name ?? '',
    unitPrice: Math.round(retailPerBase(p) * (bu?.qtyPerBase ?? 1) * 100) / 100
  }
}

/* =========================================================================
   Line grid
   ========================================================================= */

function emptyLine(): Line {
  return { productId: null, description: '', qty: 1, unitName: '', unitPrice: 0 }
}

function lineAmount(l: Line): number {
  return Math.round(l.qty * l.unitPrice * 100) / 100
}

function rowHtml(l: Line, i: number): string {
  const p = l.productId ? state.products.find((x) => x.id === l.productId) : undefined
  const tag = p
    ? `<div class="pl-tag"><span class="mono">${esc(p.barcode)}</span></div>`
    : l.description.trim()
      ? '<div class="pl-tag free">ไม่อยู่ในรายการสินค้า — บันทึกเป็นข้อความ</div>'
      : ''
  const unitOpts = (p?.units ?? []).map((u) => `<option value="${esc(u.name)}"></option>`).join('')
  return `<tr data-i="${i}">
    <td class="pl-no">${i + 1}</td>
    <td class="pl-item-cell">
      <input type="text" class="pl-item" data-i="${i}" value="${esc(l.description)}" placeholder="พิมพ์ชื่อสินค้า หรือ บาร์โค้ด" autocomplete="off">
      ${tag}
    </td>
    <td><input type="number" class="pl-qty" data-i="${i}" value="${l.qty || ''}" step="any" min="0"></td>
    <td><input type="text" class="pl-unit" data-i="${i}" value="${esc(l.unitName)}" list="dl-unit-${i}" autocomplete="off"><datalist id="dl-unit-${i}">${unitOpts}</datalist></td>
    <td><input type="number" class="pl-price" data-i="${i}" value="${l.unitPrice ? l.unitPrice : ''}" step="0.01" min="0"></td>
    <td class="pl-amount" data-i="${i}">${money(lineAmount(l))}</td>
    <td><button class="icon-btn pl-del" data-i="${i}" title="ลบบรรทัด" tabindex="-1"><i class="ti ti-trash"></i></button></td>
  </tr>`
}

function renderLines(): void {
  if (!lines.length) lines.push(emptyLine())
  $('pos-lines-body').innerHTML = lines.map(rowHtml).join('')
  bindRows($('pos-lines-body'))
  updateTotals()
}

// Replace one row in place (keeps the other rows' focus/caret untouched).
function renderRow(i: number): void {
  const old = document.querySelector(`#pos-lines-body tr[data-i="${i}"]`)
  if (!old) return renderLines()
  const tmp = document.createElement('tbody')
  tmp.innerHTML = rowHtml(lines[i], i)
  const row = tmp.firstElementChild as HTMLElement
  old.replaceWith(row)
  bindRows(row)
}

function focusCell(i: number, cls: string): void {
  const el = document.querySelector<HTMLInputElement>(`.${cls}[data-i="${i}"]`)
  if (el) {
    el.focus()
    el.select()
  }
}

function addLineAndFocus(): void {
  lines.push(emptyLine())
  renderLines()
  focusCell(lines.length - 1, 'pl-item')
}

function bindRows(root: HTMLElement): void {
  root.querySelectorAll<HTMLInputElement>('.pl-item').forEach((el) => {
    const i = Number(el.dataset.i)
    el.addEventListener('input', () => {
      lines[i].description = el.value
      // Editing the text of a picked product turns it back into free text.
      const p = lines[i].productId ? state.products.find((x) => x.id === lines[i].productId) : undefined
      if (p && el.value.trim() !== p.description) lines[i].productId = null
      openSuggest(i)
    })
    el.addEventListener('focus', () => {
      if (el.value.trim() && !lines[i].productId) openSuggest(i)
    })
    el.addEventListener('blur', () => setTimeout(() => suggestFor === i && closeSuggest(), 120))
    el.addEventListener('keydown', (e) => {
      const open = suggestBox().classList.contains('open') && suggestFor === i
      if (open && e.key === 'ArrowDown') {
        e.preventDefault()
        suggestActive = Math.min(suggestActive + 1, suggestItems.length)
        renderSuggest()
      } else if (open && e.key === 'ArrowUp') {
        e.preventDefault()
        suggestActive = Math.max(suggestActive - 1, 0)
        renderSuggest()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (open) pickSuggestion(suggestActive)
        else if (el.value.trim()) {
          renderRow(i)
          focusCell(i, 'pl-qty')
        }
      } else if (e.key === 'Escape') {
        closeSuggest()
      } else if (e.key === 'Tab') {
        closeSuggest()
      }
    })
  })

  root.querySelectorAll<HTMLInputElement>('.pl-qty').forEach((el) => {
    const i = Number(el.dataset.i)
    el.addEventListener('input', () => {
      lines[i].qty = parseFloat(el.value) || 0
      refreshAmount(i)
    })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        focusCell(i, 'pl-price')
      }
    })
  })

  root.querySelectorAll<HTMLInputElement>('.pl-unit').forEach((el) => {
    const i = Number(el.dataset.i)
    el.addEventListener('change', () => {
      lines[i].unitName = el.value.trim()
      // Catalogue prices are per BASE unit — selling by the box multiplies up.
      const p = lines[i].productId ? state.products.find((x) => x.id === lines[i].productId) : undefined
      const u = p?.units.find((x) => x.name === lines[i].unitName)
      if (p && u && retailPerBase(p) > 0) {
        lines[i].unitPrice = Math.round(retailPerBase(p) * u.qtyPerBase * 100) / 100
        const priceEl = document.querySelector<HTMLInputElement>(`.pl-price[data-i="${i}"]`)
        if (priceEl) priceEl.value = String(lines[i].unitPrice)
        refreshAmount(i)
      }
    })
    el.addEventListener('input', () => {
      lines[i].unitName = el.value.trim()
    })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        focusCell(i, 'pl-price')
      }
    })
  })

  root.querySelectorAll<HTMLInputElement>('.pl-price').forEach((el) => {
    const i = Number(el.dataset.i)
    el.addEventListener('input', () => {
      lines[i].unitPrice = parseFloat(el.value) || 0
      refreshAmount(i)
    })
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      if (i === lines.length - 1) addLineAndFocus()
      else focusCell(i + 1, 'pl-item')
    })
  })

  root.querySelectorAll<HTMLButtonElement>('.pl-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      lines.splice(Number(btn.dataset.i), 1)
      renderLines()
    })
  })
}

function refreshAmount(i: number): void {
  const cell = document.querySelector(`.pl-amount[data-i="${i}"]`)
  if (cell) cell.textContent = money(lineAmount(lines[i]))
  updateTotals()
}

/* =========================================================================
   Totals + payment
   ========================================================================= */

function numVal(id: string): number {
  return parseFloat(input(id).value) || 0
}

function totals(): { subtotal: number; grand: number; transfer: number; cashPart: number } {
  const subtotal = Math.round(lines.reduce((s, l) => s + lineAmount(l), 0) * 100) / 100
  const grand = Math.round((subtotal + Math.max(numVal('pos-delivery'), 0)) * 100) / 100
  let transfer = 0
  let cashPart = 0
  if (pay === 'CASH') cashPart = grand
  if (pay === 'TRANSFER') transfer = grand
  if (pay === 'MIXED') {
    transfer = numVal('pos-transfer-amount')
    cashPart = Math.round((grand - transfer) * 100) / 100
  }
  return { subtotal, grand, transfer, cashPart }
}

function updateTotals(): void {
  const t = totals()
  $('pos-subtotal').textContent = baht(t.subtotal)
  $('pos-grand').textContent = baht(t.grand)

  // Split line under the total — what the drawer / bank should receive.
  const splitRow = $('pos-split-row')
  if (pay === 'MIXED') {
    splitRow.style.display = 'flex'
    $('pos-split-label').textContent = `เงินสด ${money(t.cashPart)} + โอน`
    $('pos-split').textContent = money(t.transfer)
  } else if (pay === 'CREDIT') {
    splitRow.style.display = 'flex'
    $('pos-split-label').textContent = 'ค้างชำระ (เครดิต)'
    $('pos-split').textContent = money(t.grand)
  } else {
    splitRow.style.display = 'none'
  }

  const received = numVal('pos-cash-received')
  const changeRow = $('pos-change-row')
  if ((pay === 'CASH' || pay === 'MIXED') && received > 0) {
    const change = Math.round((received - t.cashPart) * 100) / 100
    changeRow.style.display = 'flex'
    changeRow.classList.toggle('short', change < 0)
    $('pos-change').textContent = change < 0 ? `ขาดอีก ${money(-change)}` : baht(change)
  } else {
    changeRow.style.display = 'none'
  }
}

function setPay(m: SalePayMethod): void {
  pay = m
  document.querySelectorAll<HTMLButtonElement>('#pos-pay .pos-pay-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.pay === m)
  })
  const show = (id: string, on: boolean): void => {
    $(id).style.display = on ? '' : 'none'
  }
  show('pos-f-transfer', m === 'MIXED')
  show('pos-f-received', m === 'CASH' || m === 'MIXED')
  show('pos-f-ref', m === 'TRANSFER' || m === 'MIXED')
  $('pos-pay-hint').textContent =
    m === 'TRANSFER'
      ? 'ยอดทั้งบิลเป็นเงินโอน — จะไปอยู่ในหน้า "ตรวจยอดโอน" ให้เช็กกับบัญชีธนาคาร'
      : m === 'MIXED'
        ? 'ใส่ยอดที่โอน ส่วนที่เหลือระบบคิดเป็นเงินสดให้'
        : m === 'CREDIT'
          ? 'ยังไม่ได้รับเงิน — ไม่นับเข้าลิ้นชักวันนี้'
          : 'รับเงินมาเท่าไร ใส่ไว้เพื่อคิดเงินทอน (ไม่ใส่ก็ได้)'
  updateTotals()
}

/* =========================================================================
   Ticket number
   ========================================================================= */

function yy(): string {
  return String((new Date().getFullYear() + 543) % 100).padStart(2, '0')
}

// Accepts what people actually type: "12", "A12", "a-12", "A69-12", "A69-0012"
// → "A69-0012". Old formats (A6907-000) pass through untouched.
function normalizeDoc(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, '')
  if (!s) return ''
  let m = s.match(/^([A-Z])(\d{2})-(\d{1,5})$/)
  if (m) return `${m[1]}${m[2]}-${m[3].padStart(4, '0')}`
  if (/^[A-Z]{1,2}\d{2,4}-\d{1,5}$/.test(s)) return s
  m = s.match(/^([A-Z])-?(\d{1,5})$/)
  if (m) return `${m[1]}${yy()}-${m[2].padStart(4, '0')}`
  m = s.match(/^(\d{1,5})$/)
  if (m) return `${book === NO_TICKET ? lastPaperBook : book}${yy()}-${m[1].padStart(4, '0')}`
  return s
}

function renderBooks(): void {
  $('pos-books').innerHTML =
    BOOKS.map(
      (b) => `<button type="button" class="seg-btn${b === book ? ' active' : ''}" data-book="${b}">${b}</button>`
    ).join('') +
    `<button type="button" class="seg-btn pos-noticket${book === NO_TICKET ? ' active' : ''}" data-book="${NO_TICKET}"
       title="ขายโดยไม่ได้ใช้ใบสั่งสินค้าที่พิมพ์เลขไว้">ไม่มีใบ</button>`
  $('pos-books')
    .querySelectorAll<HTMLButtonElement>('.seg-btn')
    .forEach((btn) =>
      btn.addEventListener('click', () => {
        const wasNoTicket = book === NO_TICKET
        book = btn.dataset.book as string
        if (book !== NO_TICKET) lastPaperBook = book
        renderBooks()
        applyDocMode()
        if (book === NO_TICKET) {
          focusCell(0, 'pl-item')
          return
        }
        // Coming back from "no ticket" while editing: the paper number has to
        // be typed — the old N-number is not a paper ticket.
        if (!editingId) suggestDoc()
        else if (wasNoTicket) input('pos-doc').value = ''
        input('pos-doc').focus()
        input('pos-doc').select()
      })
    )
}

// "ไม่มีใบ" locks the number box — the server hands out the N-series number.
function applyDocMode(): void {
  const el = input('pos-doc')
  const none = book === NO_TICKET
  el.readOnly = none
  el.placeholder = none ? 'ออกเลขให้เอง' : 'A69-0001'
  if (!none) return
  el.value = editingNoTicketNumber
  const hint = $('pos-doc-hint')
  hint.className = 'pos-hint'
  hint.innerHTML =
    '<b>บิลที่ไม่ได้ใช้ใบสั่งสินค้าที่พิมพ์ไว้</b> — ระบบออกเลขชุด <b>N</b> ให้เอง (เช่น N69-0001) ' +
    'ไม่กินเลขของเล่ม A–D และไม่นับเป็นเลขที่ขาดหาย · ควรเขียนเหตุผลไว้ในช่องหมายเหตุ'
}

function suggestDoc(): void {
  if (book === NO_TICKET) return applyDocMode()
  const n = nextNumbers.find((x) => x.book === book)
  input('pos-doc').value = n?.next ?? ''
  void checkDoc()
}

async function refreshNextNumbers(): Promise<void> {
  try {
    nextNumbers = await window.api.sales.nextNumbers()
  } catch {
    nextNumbers = []
  }
}

async function checkDoc(): Promise<void> {
  if (book === NO_TICKET) return
  const hint = $('pos-doc-hint')
  const doc = normalizeDoc(input('pos-doc').value)
  input('pos-doc').value = doc
  const m = doc.match(/^([A-D])/)
  if (m && m[1] !== book) {
    book = m[1]
    renderBooks()
  }
  const n = nextNumbers.find((x) => x.book === book)
  const info = n
    ? `เล่ม ${book}: คีย์ล่าสุด ${n.lastKeyed ?? '— ยังไม่เคยคีย์'} · พิมพ์ฟอร์มไปถึง ${n.lastPrinted ?? '—'}`
    : ''
  hint.className = 'pos-hint'
  hint.textContent = info
  if (!doc) return
  try {
    const found = (await window.api.sales.list({ search: doc, includeVoided: true, limit: 20 })).find(
      (s) => s.docNumber === doc && s.id !== editingId
    )
    if (found) {
      hint.className = 'pos-hint bad'
      hint.textContent = `เลขที่ ${doc} คีย์ไปแล้วเมื่อวันที่ ${thaiDate(found.docDate)} (${baht(found.grandTotal)}) — ถ้าจะแก้ ให้กด "แก้ไข" ที่บิลนั้น`
    }
  } catch {
    // the server checks duplicates again on save
  }
}

/* =========================================================================
   Form reset / load / save
   ========================================================================= */

function resetForm(keepDate = true): void {
  editingId = null
  editingNoTicketNumber = ''
  // A no-ticket bill is the exception — the next one is normally on paper again.
  if (book === NO_TICKET) {
    book = lastPaperBook
    renderBooks()
  }
  applyDocMode()
  lines = [emptyLine()]
  const date = keepDate && input('pos-date').value ? input('pos-date').value : todayIso()
  input('pos-date').value = date
  input('pos-time').value = ''
  for (const id of ['pos-customer', 'pos-contact', 'pos-transfer-amount', 'pos-cash-received', 'pos-transfer-ref', 'pos-note']) {
    input(id).value = ''
  }
  input('pos-delivery').value = '0'
  $('pos-title').textContent = 'คีย์บิลขาย'
  $('pos-subtitle').textContent = 'พิมพ์ตามใบสั่งสินค้าที่เขียนด้วยมือ — บันทึกยอดเงินอย่างเดียว ไม่ตัดสต๊อก'
  $('pos-btn-cancel-edit').style.display = 'none'
  setPay('CASH')
  renderLines()
  suggestDoc()
}

async function loadForEdit(id: number): Promise<void> {
  try {
    const { sale, lines: saleLines } = await window.api.sales.get(id)
    if (sale.voided) {
      showToast('บิลนี้ถูกยกเลิกแล้ว แก้ไขไม่ได้', true)
      return
    }
    editingId = sale.id
    lines = saleLines.map((l) => ({
      productId: l.productId,
      description: l.description,
      qty: l.qty ?? 0,
      unitName: l.unitName ?? '',
      unitPrice: l.unitPrice ?? 0
    }))
    editingNoTicketNumber = sale.noTicket ? sale.docNumber : ''
    const m = sale.docNumber.match(/^([A-D])/)
    if (sale.noTicket) book = NO_TICKET
    else if (m) book = lastPaperBook = m[1]
    renderBooks()
    input('pos-doc').value = sale.docNumber
    applyDocMode()
    input('pos-date').value = sale.docDate
    input('pos-time').value = sale.docTime ?? ''
    input('pos-customer').value = sale.customerName ?? ''
    input('pos-contact').value = sale.customerContact ?? ''
    input('pos-delivery').value = String(sale.deliveryFee || 0)
    input('pos-transfer-ref').value = sale.transferRef ?? ''
    input('pos-note').value = sale.note ?? ''
    const method = (['CASH', 'TRANSFER', 'MIXED', 'CREDIT'] as SalePayMethod[]).includes(sale.paymentMethod as SalePayMethod)
      ? (sale.paymentMethod as SalePayMethod)
      : 'CASH'
    input('pos-transfer-amount').value = method === 'MIXED' ? String(sale.transferAmount) : ''
    input('pos-cash-received').value = sale.cashReceived ? String(sale.cashReceived) : ''
    $('pos-title').textContent = `แก้ไขบิล ${sale.docNumber}`
    $('pos-subtitle').textContent =
      sale.transferStatus === 'VERIFIED'
        ? 'บิลนี้ตรวจยอดโอนแล้ว — ถ้าเปลี่ยนยอดโอน จะกลับไปเป็น "รอตรวจ" อีกครั้ง'
        : 'แก้แล้วกด "บันทึกบิล" เพื่อบันทึกทับ'
    $('pos-btn-cancel-edit').style.display = ''
    setPay(method)
    renderLines()
    $('pos-doc-hint').textContent = ''
    window.scrollTo({ top: 0 })
    document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (err) {
    toastError(err)
  }
}

async function save(): Promise<void> {
  if (dayLocked) {
    showToast('วันนี้เจ้าของตรวจยอดแล้ว — แก้ไขหรือเพิ่มบิลไม่ได้', true)
    return
  }
  closeSuggest()
  const noTicket = book === NO_TICKET
  const doc = noTicket ? '' : normalizeDoc(input('pos-doc').value)
  if (!noTicket) input('pos-doc').value = doc
  const filled = lines.filter((l) => l.description.trim())
  if (!noTicket && !doc) {
    showToast('กรุณาใส่เลขที่ใบสั่งสินค้า — ถ้าขายโดยไม่ได้เขียนใบ ให้กดปุ่ม "ไม่มีใบ"', true)
    input('pos-doc').focus()
    return
  }
  if (!filled.length) {
    showToast('กรุณาใส่รายการสินค้าอย่างน้อย 1 รายการ', true)
    focusCell(0, 'pl-item')
    return
  }
  const t = totals()
  const received = numVal('pos-cash-received')
  if ((pay === 'CASH' || pay === 'MIXED') && received > 0 && received < t.cashPart) {
    showToast(`รับเงินมา ${money(received)} ยังไม่พอ (ต้องจ่ายเงินสด ${money(t.cashPart)})`, true)
    return
  }
  try {
    const wasEditing = editingId != null
    const res = await window.api.sales.save({
      id: editingId ?? undefined,
      docNumber: doc,
      noTicket,
      docDate: input('pos-date').value,
      docTime: input('pos-time').value,
      customerName: input('pos-customer').value,
      customerContact: input('pos-contact').value,
      paymentMethod: pay,
      cashReceived: received > 0 ? received : null,
      transferAmount: pay === 'MIXED' ? numVal('pos-transfer-amount') : null,
      transferRef: input('pos-transfer-ref').value,
      deliveryFee: numVal('pos-delivery'),
      note: input('pos-note').value,
      lines: filled.map((l) => ({
        productId: l.productId,
        description: l.description.trim(),
        qty: l.qty,
        unitName: l.unitName,
        unitPrice: l.unitPrice
      }))
    })
    await refreshNextNumbers()
    resetForm(true)
    await renderDayList()
    showToast(`${wasEditing ? 'แก้ไข' : 'บันทึก'}บิล ${res.docNumber} แล้ว · ${baht(t.grand)}`)
    input('pos-doc').focus()
    input('pos-doc').select()
  } catch (err) {
    toastError(err)
  }
}

/* =========================================================================
   Bills of the selected day
   ========================================================================= */

async function renderDayList(): Promise<void> {
  const date = input('pos-date').value || todayIso()
  $('pos-day-title').textContent = `บิลของวันที่ ${thaiDate(date)}`
  let day
  try {
    day = await window.api.sales.day(date)
  } catch (err) {
    toastError(err)
    return
  }

  dayLocked = day.locked
  $('pos-lock-banner').innerHTML = day.locked
    ? `<div class="alert-banner warn"><i class="ti ti-lock alert-icon"></i>
         <div class="alert-text"><b>เจ้าของตรวจยอดของวันที่ ${thaiDate(date)} แล้ว</b> — เพิ่ม/แก้ไข/ยกเลิกบิลของวันนี้ไม่ได้
         (ถ้าต้องแก้ ให้เจ้าของกด "ยกเลิกการตรวจ" ที่หน้าปิดยอดประจำวัน)</div></div>`
    : ''
  ;($('pos-btn-save') as HTMLButtonElement).disabled = day.locked

  $('pos-day-sum').innerHTML = `
    <span>บิล <b>${day.billCount}</b> ใบ${day.voidCount ? ` (ยกเลิก ${day.voidCount})` : ''}</span>
    <span>รวม <b>${baht(day.grandTotal)}</b></span>
    <span>เงินสด <b>${baht(day.cashTotal)}</b></span>
    <span>โอน <b>${baht(day.transferTotal)}</b></span>
    <span>เครดิต <b>${baht(day.creditTotal)}</b></span>`

  const rows = [...day.sales].reverse()
  $('pos-day-body').innerHTML = rows.length
    ? rows.map(dayRowHtml).join('')
    : `<tr><td colspan="9"><div class="empty-state"><i class="ti ti-receipt-off"></i>ยังไม่มีบิลของวันนี้</div></td></tr>`

  const body = $('pos-day-body')
  body.querySelectorAll<HTMLButtonElement>('.pd-edit').forEach((b) =>
    b.addEventListener('click', () => void loadForEdit(Number(b.dataset.id)))
  )
  body.querySelectorAll<HTMLButtonElement>('.pd-void').forEach((b) =>
    b.addEventListener('click', () => void voidSale(Number(b.dataset.id), b.dataset.doc as string))
  )
  body.querySelectorAll<HTMLButtonElement>('.pd-restore').forEach((b) =>
    b.addEventListener('click', () => void restoreSale(Number(b.dataset.id)))
  )
}

function dayRowHtml(s: SaleView): string {
  const actions = s.voided
    ? level() >= 2 && !dayLocked
      ? `<button class="btn small pd-restore" data-id="${s.id}">คืนสถานะ</button>`
      : ''
    : dayLocked
      ? ''
      : `<button class="btn small pd-edit" data-id="${s.id}">แก้ไข</button>
         <button class="btn small pd-void" data-id="${s.id}" data-doc="${esc(s.docNumber)}">ยกเลิก</button>`
  return `<tr class="${s.voided ? 'is-void' : ''}">
    <td class="mono"><b>${esc(s.docNumber)}</b>${s.noTicket ? '<div class="pl-tag no-strike"><span class="badge muted">ไม่มีใบ</span></div>' : ''}</td>
    <td>${esc(s.docTime ?? '')}</td>
    <td>${esc(s.customerName ?? '')}${s.voided ? `<div class="pl-tag no-strike" style="color:var(--danger);">ยกเลิก: ${esc(s.voidReason ?? '')}</div>` : ''}</td>
    <td class="num">${s.lineCount}</td>
    <td class="num"><b>${money(s.grandTotal)}</b></td>
    <td>${esc(payLabel(s.paymentMethod))}<div class="pl-tag">${esc(splitText(s))}</div></td>
    <td>${transferBadge(s.transferStatus)}</td>
    <td style="font-size:13px;">${esc(s.createdBy ?? '')}<div class="pl-tag">${thaiDateTime(s.createdAt)}</div></td>
    <td class="nowrap" style="white-space:nowrap;">${actions}</td>
  </tr>`
}

async function voidSale(id: number, doc: string): Promise<void> {
  const v = await promptModal(
    `ยกเลิกบิล ${doc}`,
    [{ key: 'reason', label: 'เหตุผลที่ยกเลิก (จะแสดงในใบสรุปให้เจ้าของเห็น)', placeholder: 'เช่น เขียนผิด ลูกค้าไม่เอา' }],
    (vals) => (vals.reason?.trim() ? null : 'กรุณาระบุเหตุผล')
  )
  if (!v) return
  try {
    await window.api.sales.void({ id, reason: v.reason })
    if (editingId === id) resetForm(true)
    await renderDayList()
    showToast(`ยกเลิกบิล ${doc} แล้ว`)
  } catch (err) {
    toastError(err)
  }
}

async function restoreSale(id: number): Promise<void> {
  try {
    await window.api.sales.restore(id)
    await renderDayList()
    showToast('คืนสถานะบิลแล้ว')
  } catch (err) {
    toastError(err)
  }
}

/* =========================================================================
   Entry points
   ========================================================================= */

export async function renderSalesView(): Promise<void> {
  await refreshNextNumbers()
  if (!editingId && !lines.some((l) => l.description.trim())) suggestDoc()
  await renderDayList()
}

export function initSales(navigate: (view: string) => void): void {
  goToView = navigate
  renderBooks()
  input('pos-date').value = todayIso()

  input('pos-doc').addEventListener('blur', () => void checkDoc())
  input('pos-doc').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void checkDoc()
      focusCell(0, 'pl-item')
    }
  })
  input('pos-date').addEventListener('change', () => void renderDayList())

  document.querySelectorAll<HTMLButtonElement>('#pos-pay .pos-pay-btn').forEach((b) =>
    b.addEventListener('click', () => setPay(b.dataset.pay as SalePayMethod))
  )
  for (const id of ['pos-delivery', 'pos-transfer-amount', 'pos-cash-received']) {
    input(id).addEventListener('input', updateTotals)
  }
  $('pos-btn-exact').addEventListener('click', () => {
    input('pos-cash-received').value = String(totals().cashPart)
    updateTotals()
  })
  $('pos-btn-add-line').addEventListener('click', addLineAndFocus)
  $('pos-btn-save').addEventListener('click', () => void save())
  $('pos-btn-clear').addEventListener('click', () => resetForm(true))
  $('pos-btn-cancel-edit').addEventListener('click', () => resetForm(true))
  $('pos-btn-goto-cashup').addEventListener('click', () => goToView('cashup'))

  // Ctrl+S saves — only while this page is the one on screen.
  document.addEventListener('keydown', (e) => {
    if (!$('view-sales').classList.contains('active')) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
    }
  })
  // The dropdown is position:fixed — hide it rather than let it float away.
  document.querySelector('.content')?.addEventListener('scroll', closeSuggest, { passive: true })
  window.addEventListener('resize', closeSuggest)

  resetForm(false)
  input('pos-time').value = ''
}
