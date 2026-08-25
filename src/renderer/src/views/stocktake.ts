import type { PendingSheetView, ProductView, StocktakeEntry } from '../../../shared/types'
import { $, baseUnitName, esc, formatStock, input, select } from '../format'
import { fitSheets, loadPrinters, runPrint } from '../print'
import { state } from '../state'
import { showToast, toastError } from '../ui'

// Counts are per product PER LOCATION now, so everything is keyed "productId:locationId".
interface CellState {
  // Base-unit total — always the value that gets saved and compared.
  counted?: number
  // What was actually typed, one entry per unit level (largest first). Kept so
  // re-rendering shows "4 กล่อง / 2 ชิ้น" again rather than collapsing to 98.
  parts?: (number | undefined)[]
  note?: string
  hasReceived?: boolean
  receivedQty?: number | null
  receivedDate?: string
}

let cells: Record<string, CellState> = {}
let openRows: Record<number, boolean> = {}
let filterUncounted = false
let filterDiff = false
let pendingSheets: PendingSheetView[] = []
let refreshAfterSave: () => Promise<void> = async () => {}

const cellKey = (productId: number, locationId: number): string => `${productId}:${locationId}`

// Counting happens in whatever unit the goods are stacked in — 4 boxes plus 2
// loose pieces — so each unit level gets its own box and the base total is
// derived. Undefined everywhere means "not counted yet", which is NOT the same
// as a counted zero.
function partsToBase(parts: (number | undefined)[] | undefined, units: ProductView['units']): number | undefined {
  if (!parts || parts.every((v) => v === undefined)) return undefined
  return units.reduce((sum, u, i) => sum + (parts[i] ?? 0) * u.qtyPerBase, 0)
}
const cellOf = (productId: number, locationId: number): CellState => cells[cellKey(productId, locationId)] ?? {}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function nowTime(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export async function refreshStocktakeDocNumber(): Promise<void> {
  try {
    input('count-doc-number').value = await window.api.stocktake.nextDocNumber()
  } catch {
    input('count-doc-number').value = ''
  }
}

/* ---------- printed sheets waiting to be keyed in ---------- */

export async function refreshPendingSheets(): Promise<void> {
  try {
    pendingSheets = await window.api.stocktake.pending()
  } catch {
    pendingSheets = []
  }
  const sel = select('count-pending-sheet')
  const current = sel.value
  sel.innerHTML =
    '<option value="">— ไม่ใช้ (ออกเลขใหม่) —</option>' +
    pendingSheets
      .map(
        (s) =>
          `<option value="${s.id}">${esc(s.docNumber ?? '')} · ${esc(s.countDate ?? '')} ${esc(s.countTime ?? '')}${s.counterName ? ' · ' + esc(s.counterName) : ''}</option>`
      )
      .join('')
  if (current && pendingSheets.some((s) => String(s.id) === current)) sel.value = current
}

// Picking a printed sheet pulls its details in, so the entry matches the paper.
function applyPendingSheet(): void {
  const id = Number(select('count-pending-sheet').value)
  const sheet = pendingSheets.find((s) => s.id === id)
  const isPending = !!sheet
  input('count-doc-number').readOnly = isPending
  ;($('count-no-serial') as HTMLInputElement).disabled = isPending
  if (!sheet) {
    void refreshStocktakeDocNumber()
    return
  }
  input('count-doc-number').value = sheet.docNumber ?? ''
  if (sheet.countDate) input('count-date').value = sheet.countDate
  if (sheet.countTime) input('count-time').value = sheet.countTime
  if (sheet.counterName) input('count-counter-name').value = sheet.counterName
  if (sheet.category) select('count-category').value = sheet.category
  ;($('count-no-serial') as HTMLInputElement).checked = false
  renderStocktakeTable()
}

/* ---------- selectors ---------- */

export function renderStocktakeSelectors(): void {
  const catSel = select('count-category')
  const cats = ['ทั้งหมด', ...new Set(state.products.map((p) => p.categoryName))]
  const current = catSel.value
  catSel.innerHTML = cats.map((c) => `<option${c === current ? ' selected' : ''}>${esc(c)}</option>`).join('')

  if (!input('count-date').value) input('count-date').value = todayIso()
  if (!input('count-time').value) input('count-time').value = nowTime()

  renderStocktakeTable()
}

function getRows(): ProductView[] {
  const category = select('count-category').value
  return state.products.filter((p) => category === 'ทั้งหมด' || p.categoryName === category)
}

function systemQty(p: ProductView, locationId: number): number {
  return p.stockByLocation[locationId] ?? 0
}

/* ---------- table ---------- */

function varianceBadge(diff: number, units: ProductView['units']): string {
  if (diff === 0) return `<span class="badge ok">ตรง</span>`
  const cls = diff < 0 ? 'danger' : 'warn'
  const label = diff < 0 ? 'ขาด' : 'เกิน'
  return `<span class="badge ${cls}">${label} ${formatStock(Math.abs(diff), units)}</span>`
}

// Rows the filters currently allow through.
function visibleRows(): ProductView[] {
  const q = (document.getElementById('count-search') as HTMLInputElement | null)?.value.trim().toLowerCase() ?? ''
  return getRows().filter((p) => {
    if (q && !p.barcode.toLowerCase().includes(q) && !p.description.toLowerCase().includes(q)) return false
    const st = rowStatus(p)
    if (filterUncounted && !(st === 'none' || st === 'partial')) return false
    if (filterDiff && st !== 'diff') return false
    return true
  })
}

type RowStatus = 'none' | 'partial' | 'ok' | 'diff'

// One product's overall state across every location.
function rowStatus(p: ProductView): RowStatus {
  const counts = state.locations.map((l) => cellOf(p.id, l.id).counted)
  const filled = counts.filter((c) => c !== undefined).length
  if (filled === 0) return 'none'
  if (filled < counts.length) return 'partial'
  const anyDiff = state.locations.some((l) => {
    const c = cellOf(p.id, l.id).counted
    return c !== undefined && c !== systemQty(p, l.id)
  })
  return anyDiff ? 'diff' : 'ok'
}

const MARK: Record<RowStatus, string> = { ok: '✅', diff: '⚠️', partial: '◑', none: '⬜' }
const STRIPE: Record<RowStatus, string> = {
  ok: 'var(--ok)',
  diff: 'var(--danger)',
  partial: 'var(--warn)',
  none: 'var(--border)'
}
const ROW_BG: Record<RowStatus, string> = { ok: '#F6FBF8', diff: '#FEF8F7', partial: '#FFFDF7', none: '#FFFFFF' }

// Variance shown as plain coloured text (matches the approved design).
function diffText(counted: number | undefined, sys: number, units: ProductView['units']): { text: string; color: string; border: string } {
  if (counted === undefined) return { text: 'ยังไม่นับ', color: '#6D767B', border: '#C9D1D4' }
  const d = counted - sys
  if (d === 0) return { text: '✓ ตรงกัน', color: 'var(--ok)', border: 'var(--ok)' }
  if (d > 0) return { text: `เกิน ${formatStock(d, units)}`, color: 'var(--warn)', border: 'var(--warn)' }
  return { text: `ขาด ${formatStock(-d, units)}`, color: 'var(--danger)', border: 'var(--danger)' }
}

export function renderStocktakeTable(): void {
  const locations = state.locations
  const rows = visibleRows()

  // The grid template is shared by the header and every row.
  document.documentElement.style.setProperty('--loc-count', String(locations.length))

  let head = '<div class="st-cols"><div>สถานะ</div><div>สินค้า</div>'
  locations.forEach((l) => {
    head += `<div style="text-align:center;">${esc(l.name)}</div>`
  })
  head += '<div style="text-align:center;">รวมทุกคลัง</div><div style="text-align:right;">ของเข้า / หมายเหตุ</div></div>'
  $('stocktake-head').innerHTML = head

  $('stocktake-body').innerHTML =
    rows
      .map((p) => {
        const st = rowStatus(p)
        const g = cellOf(p.id, locations[0]?.id ?? 0)
        const open = !!openRows[p.id]

        let cells = `<div class="st-mark">${MARK[st]}</div>
        <div style="padding-right:16px;">
          <div class="st-name">${esc(p.description)}</div>
          <div class="st-meta"><span class="st-code">${esc(p.barcode)}</span><span class="st-unit">หน่วย: ${esc(baseUnitName(p))}</span></div>
        </div>`

        let totalSystem = 0
        let totalCounted = 0
        let allCounted = true

        locations.forEach((l) => {
          const sys = systemQty(p, l.id)
          const counted = cellOf(p.id, l.id).counted
          totalSystem += sys
          if (counted === undefined) allCounted = false
          else totalCounted += counted
          const d = diffText(counted, sys, p.units)
          const parts = cellOf(p.id, l.id).parts ?? []
          // One box per unit level so nobody has to multiply in their head.
          // Single-unit products keep exactly one box, unlabelled, as before.
          const boxes =
            p.units.length > 1
              ? `<div class="st-unit-row">${p.units
                  .map(
                    (u, i) => `<label class="st-unit"><span>${esc(u.name)}</span>
                      <input type="number" class="st-cin count-input" data-count data-p="${p.id}" data-l="${l.id}" data-u="${i}"
                             value="${parts[i] !== undefined ? parts[i] : ''}" placeholder="0" style="border-color:${d.border};"></label>`
                  )
                  .join('')}</div>`
              : `<input type="number" class="st-cin count-input" data-count data-p="${p.id}" data-l="${l.id}" data-u="0"
                        value="${parts[0] !== undefined ? parts[0] : ''}" placeholder="นับได้" style="border-color:${d.border};">`
          cells += `<div class="st-loc">
            <div class="st-sysline">ระบบ <b>${formatStock(sys, p.units)}</b></div>
            ${boxes}
            <div class="st-diff" id="var-${p.id}-${l.id}" style="color:${d.color};">${d.text}</div>
          </div>`
        })

        const totD = diffText(allCounted ? totalCounted : undefined, totalSystem, p.units)
        const totBg = !allCounted ? '#EEF1F2' : totD.color === 'var(--ok)' ? 'var(--ok-bg)' : totD.color === 'var(--warn)' ? 'var(--warn-bg)' : 'var(--danger-bg)'
        cells += `<div class="st-tot">
          <div class="st-tot-sys">ระบบรวม ${formatStock(totalSystem, p.units)}</div>
          <div class="st-tot-v" id="tot-${p.id}">${allCounted ? formatStock(totalCounted, p.units) : '—'}</div>
          <div class="st-tot-b" id="totvar-${p.id}" style="background:${totBg};color:${allCounted ? totD.color : '#6D767B'};">${allCounted ? totD.text : 'ยังไม่ครบ'}</div>
        </div>`

        const hasExtra = g.hasReceived || (g.note ?? '') !== ''
        cells += `<div class="st-extra-cell">
          <button type="button" class="st-extra-btn row-toggle" data-p="${p.id}"
                  style="background:${open ? 'var(--accent-soft)' : '#fff'};border-color:${open || hasExtra ? 'var(--accent)' : '#C9D1D4'};">
            ${open ? 'ปิด ▲' : hasExtra ? '● ของเข้า/หมายเหตุ' : '+ ของเข้า/หมายเหตุ'}
          </button>
        </div>`

        const extra = open
          ? `<div class="st-extra">
          <label class="st-recv-chk"><input type="checkbox" class="recv-has" data-p="${p.id}" ${g.hasReceived ? 'checked' : ''}> มีของเข้าระหว่างนับ</label>
          <div><label>จำนวนของเข้า</label><input type="number" class="st-in st-qty recv-qty" data-p="${p.id}" value="${g.receivedQty ?? ''}" placeholder="0"></div>
          <div><label>วันที่ของเข้า</label><input type="date" class="st-in mono recv-date" data-p="${p.id}" value="${esc(g.receivedDate ?? '')}"></div>
          <div><label>หมายเหตุผู้นับ (เหตุผลของผลต่าง)</label><input type="text" class="st-in count-note-input" data-p="${p.id}" value="${esc(g.note ?? '')}" placeholder="เช่น ของเสียหาย / ขายแล้วยังไม่บันทึก"></div>
        </div>`
          : ''

        return `<div class="st-row" style="border-left-color:${STRIPE[st]};background:${ROW_BG[st]};">
          <div class="st-cols">${cells}</div>${extra}
        </div>`
      })
      .join('') ||
    '<div class="empty-state"><i class="ti ti-search-off"></i>ไม่พบสินค้าตามตัวกรองที่เลือก</div>'

  bindInputs()
  updateSummary()
}

function ensureCell(productId: number, locationId: number): CellState {
  const k = cellKey(productId, locationId)
  if (!cells[k]) cells[k] = {}
  return cells[k]
}

// Goods-in / note belong to the product row, so mirror them onto every
// location cell of that product — that way they survive whichever cell is saved.
function setForAllLocations(productId: number, patch: Partial<CellState>): void {
  state.locations.forEach((l) => Object.assign(ensureCell(productId, l.id), patch))
}

// Keeps the "รวมทุกคลัง" cell in step as each location is typed in.
function updateRowTotal(p: ProductView): void {
  let totalSystem = 0
  let totalCounted = 0
  let anyCounted = false
  let allCounted = true
  state.locations.forEach((l) => {
    totalSystem += systemQty(p, l.id)
    const c = cellOf(p.id, l.id).counted
    if (c === undefined) allCounted = false
    else {
      totalCounted += c
      anyCounted = true
    }
  })
  const totEl = document.getElementById(`tot-${p.id}`)
  if (totEl) totEl.textContent = anyCounted ? formatStock(totalCounted, p.units) : '—'
  const totVarEl = document.getElementById(`totvar-${p.id}`)
  if (totVarEl) totVarEl.innerHTML = allCounted ? varianceBadge(totalCounted - totalSystem, p.units) : ''
}

function bindInputs(): void {
  document.querySelectorAll<HTMLInputElement>('.count-input').forEach((el) => {
    el.addEventListener('input', () => {
      const pid = Number(el.dataset.p)
      const lid = Number(el.dataset.l)
      const cell = ensureCell(pid, lid)
      const p = state.products.find((x) => x.id === pid)
      const idx = Number(el.dataset.u ?? 0)
      if (p) {
        if (!cell.parts) cell.parts = p.units.map(() => undefined)
        cell.parts[idx] = el.value === '' ? undefined : parseFloat(el.value) || 0
        cell.counted = partsToBase(cell.parts, p.units)
      }
      if (p) {
        const sys = systemQty(p, lid)
        const varEl = document.getElementById(`var-${pid}-${lid}`)
        if (varEl) {
          varEl.innerHTML =
            cell.counted === undefined
              ? '<span style="color:var(--text-secondary);font-size:11px;">ยังไม่นับ</span>'
              : varianceBadge(cell.counted - sys, p.units)
        }
        updateRowTotal(p)
      }
      updateSummary()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('.row-toggle').forEach((btn) =>
    btn.addEventListener('click', () => {
      const pid = Number(btn.dataset.p)
      openRows[pid] = !openRows[pid]
      renderStocktakeTable()
    })
  )
  document.querySelectorAll<HTMLInputElement>('.recv-has').forEach((el) =>
    el.addEventListener('change', () => setForAllLocations(Number(el.dataset.p), { hasReceived: el.checked }))
  )
  document.querySelectorAll<HTMLInputElement>('.recv-qty').forEach((el) =>
    el.addEventListener('input', () =>
      setForAllLocations(Number(el.dataset.p), { receivedQty: el.value === '' ? null : parseFloat(el.value) || 0 })
    )
  )
  document.querySelectorAll<HTMLInputElement>('.recv-date').forEach((el) =>
    el.addEventListener('input', () => setForAllLocations(Number(el.dataset.p), { receivedDate: el.value }))
  )
  document.querySelectorAll<HTMLInputElement>('.count-note-input').forEach((el) =>
    el.addEventListener('input', () => setForAllLocations(Number(el.dataset.p), { note: el.value }))
  )
}

function collectEntries(): StocktakeEntry[] {
  const entries: StocktakeEntry[] = []
  getRows().forEach((p) => {
    state.locations.forEach((l) => {
      const c = cellOf(p.id, l.id)
      if (c.counted === undefined) return
      entries.push({
        productId: p.id,
        locationId: l.id,
        counted: c.counted,
        // Only meaningful when more than one unit level was on screen; a
        // single-unit product has nothing to break down.
        countedParts:
          p.units.length > 1 && c.parts
            ? p.units.map((u, i) => ({ unit: u.name, qty: c.parts?.[i] ?? 0 }))
            : undefined,
        note: c.note ?? '',
        hasReceived: !!c.hasReceived,
        receivedQty: c.receivedQty ?? null,
        receivedDate: c.receivedDate ?? ''
      })
    })
  })
  return entries
}

function updateSummary(): void {
  const rows = getRows()
  const entries = collectEntries()
  const varianceRows = entries.filter((e) => {
    const p = state.products.find((x) => x.id === e.productId)
    return p ? e.counted !== systemQty(p, e.locationId) : false
  })
  const valueImpact = varianceRows.reduce((sum, e) => {
    const p = state.products.find((x) => x.id === e.productId)
    if (!p) return sum
    return sum + (e.counted - systemQty(p, e.locationId)) * (p.cost ?? 0)
  }, 0)

  const totalCells = rows.length * Math.max(state.locations.length, 1)
  $('stocktake-summary-counted').textContent = String(entries.length)
  $('st-total-cells').textContent = `/ ${totalCells} ช่อง`
  $('stocktake-summary-variance').textContent = String(varianceRows.length)
  const rounded = Math.round(valueImpact)
  $('stocktake-summary-value').textContent = (rounded > 0 ? '+' : '') + '฿' + rounded.toLocaleString('th-TH')

  const pct = totalCells ? Math.round((entries.length / totalCells) * 100) : 0
  $('st-progress').style.width = pct + '%'
  $('st-remain').textContent =
    entries.length >= totalCells ? 'คีย์ครบทุกช่องแล้ว' : `ยังเหลืออีก ${totalCells - entries.length} ช่อง`
}

/* ---------- print (A4 landscape, all locations + goods-in) ---------- */

function thaiDate(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'long', year: 'numeric' })
}

function closePreview(): void {
  $('stocktake-preview-modal').classList.remove('active')
}

function applyNoSerialState(): void {
  const noSerial = ($('count-no-serial') as HTMLInputElement).checked
  $('btn-print-stocktake').style.display = noSerial ? 'none' : ''
  if (noSerial) {
    input('count-doc-number').value = '(ไม่ออกเลขที่เอกสาร)'
    input('count-doc-number').readOnly = true
  } else {
    input('count-doc-number').readOnly = false
    if (!select('count-pending-sheet').value) void refreshStocktakeDocNumber()
  }
}

// Locked at 20 items per printed page — anything more starts a new sheet.
const ROWS_PER_SHEET = 20

function openPreview(): void {
  const rows = getRows()
  if (rows.length === 0) {
    showToast('ไม่มีสินค้าให้พิมพ์ตามตัวกรองที่เลือก', true)
    return
  }
  const locations = state.locations
  const docNumber = input('count-doc-number').value || '(ยังไม่ได้บันทึก)'
  const printStamp = `${thaiDate(todayIso())} ${nowTime()} น.`
  const category = select('count-category').value
  const note = input('count-note').value.trim()
  const counterName = input('count-counter-name').value.trim()

  let head = `<tr>
      <th rowspan="2" style="width:26px;">ลำดับ</th>
      <th rowspan="2" style="width:92px;">บาร์โค้ด</th>
      <th rowspan="2">คำอธิบาย</th>
      <th rowspan="2" style="width:52px;">หน่วย</th>`
  locations.forEach((l) => {
    head += `<th colspan="2" style="text-align:center;">${esc(l.name)}</th>`
  })
  head += `<th colspan="2" style="text-align:center;">รวมทุกคลัง</th><th colspan="3" style="text-align:center;">ของเข้า</th></tr><tr>`
  locations.forEach(() => {
    head += `<th style="width:62px;">ในระบบ</th><th style="width:78px;">นับได้จริง</th>`
  })
  head += `<th style="width:62px;">ในระบบ</th><th style="width:78px;">นับได้จริง</th>`
  head += `<th style="width:32px;">มี</th><th style="width:70px;">จำนวน</th><th style="width:86px;">วันที่</th></tr>`

  // Split into fixed-size pages so a long list never overflows a sheet.
  const pages: ProductView[][] = []
  for (let i = 0; i < rows.length; i += ROWS_PER_SHEET) pages.push(rows.slice(i, i + ROWS_PER_SHEET))

  $('stocktake-print-area').innerHTML = pages
    .map((pageRows, pageIdx) => {
      const body = pageRows
        .map((p, i) => {
          let tds = `<td class="pt-num">${pageIdx * ROWS_PER_SHEET + i + 1}</td><td>${esc(p.barcode)}</td><td>${esc(p.description)}</td><td>${esc(baseUnitName(p))}</td>`
          locations.forEach((l) => {
            tds += `<td class="pt-num">${formatStock(systemQty(p, l.id), p.units)}</td><td class="pt-blank"></td>`
          })
          // Total across every location, plus a blank box so the counter can
          // add up what they found and cross-check on the spot.
          const totalSystem = locations.reduce((sum, l) => sum + systemQty(p, l.id), 0)
          tds += `<td class="pt-num"><b>${formatStock(totalSystem, p.units)}</b></td><td class="pt-blank"></td>`
          tds += `<td class="pt-blank"></td><td class="pt-blank"></td><td class="pt-blank"></td>`
          return `<tr>${tds}</tr>`
        })
        .join('')

      return `<div class="pt-sheet"><div class="pt-doc">
    <h1>ใบตรวจนับสต๊อกสินค้า</h1>
    <div class="pt-subtitle">นับจริงหน้างานทุกคลัง แล้วนำกลับไปบันทึกในระบบ</div>
    <div class="pt-meta">
      <div>เลขที่เอกสาร: <b>${esc(docNumber)}</b> &nbsp; หน้า <b>${pageIdx + 1}</b> / <b>${pages.length}</b></div>
      <div>พิมพ์เมื่อ: <b>${esc(printStamp)}</b></div>
      <div>หมวดหมู่: <b>${esc(category)}</b> &nbsp; จำนวนรายการรวม: <b>${rows.length}</b></div>
      <div>ผู้นับ: ${counterName ? `<b>${esc(counterName)}</b>` : '<span class="pt-write pt-w-name"></span>'}</div>
      <div style="grid-column:1 / -1;">วันที่นับจริง: <span class="pt-write pt-w-date"></span> &nbsp; เวลาที่นับ: <span class="pt-write pt-w-time"></span> น.</div>
    </div>
    <table class="pt-table"><thead>${head}</thead><tbody>${body}</tbody></table>
    <div class="pt-notes">
      <div>หมายเหตุ / เหตุผลของผลต่าง${note ? ` (${esc(note)})` : ''} :</div>
      <div class="pt-notes-lines"></div>
    </div>
    <div class="pt-footer">
      <div>ผู้ตรวจนับ ............................................ วันที่ ................</div>
      <div>ผู้ตรวจสอบ ............................................ วันที่ ................</div>
    </div>
  </div></div>`
    })
    .join('')

  // Seed the dialog: sheet count, printers, and the orientation used last time
  // (orientation lives only in the print dialog now).
  $('pv-sheet-count').textContent = String(pages.length)
  document.querySelectorAll<HTMLInputElement>('input[name="pv-layout"]').forEach((r) => {
    r.checked = r.value === (lastLandscape ? 'landscape' : 'portrait')
  })
  applyPreviewOrientation()
  void loadPrinters(select('pv-printer'), 'printer.stocktake')
  $('stocktake-preview-modal').classList.add('active')
  requestAnimationFrame(() => refreshStocktakeFit())
}

// Remembered across prints in this session, so the choice sticks.
let lastLandscape = true

function previewLandscape(): boolean {
  const checked = document.querySelector<HTMLInputElement>('input[name="pv-layout"]:checked')
  return (checked?.value ?? 'landscape') === 'landscape'
}

function applyPreviewOrientation(): void {
  lastLandscape = previewLandscape()
  $('stocktake-print-area').classList.toggle('portrait', !lastLandscape)
  refreshStocktakeFit()
}

// Scale the true-size A4 sheets to fit the dialog and flag any that overflow.
function refreshStocktakeFit(): void {
  const widthIn = lastLandscape ? 297 / 25.4 : 210 / 25.4
  const fit = fitSheets('stocktake-print-area', '.pt-sheet', widthIn)
  $('pv-scale').textContent = `แสดงขนาดจริง 100% · A4 ${lastLandscape ? 'แนวนอน' : 'แนวตั้ง'}`
  const warn = $('pv-warn')
  warn.classList.toggle('show', fit.overflowing > 0)
  const msg = warn.querySelector('span')
  if (msg) msg.textContent = `เนื้อหาเกินขอบกระดาษ ${fit.overflowing} ใบ — ส่วนที่เกินจะหายตอนพิมพ์`
}

// Printing records the sheet so its number can be keyed in later.
async function doPrint(): Promise<void> {
  const docNumber = input('count-doc-number').value.trim()
  const usingPending = !!select('count-pending-sheet').value
  if (docNumber && !usingPending && !docNumber.startsWith('(')) {
    try {
      await window.api.stocktake.recordPrinted({
        docNumber,
        countDate: input('count-date').value,
        countTime: input('count-time').value,
        category: select('count-category').value,
        counterName: input('count-counter-name').value
      })
      await refreshPendingSheets()
      await refreshStocktakeDocNumber()
    } catch {
      // Already recorded (e.g. printed twice) — printing should still work.
    }
  }
  const landscape = previewLandscape()
  try {
    const res = await runPrint({
      bodyClass: 'printing-stocktake',
      deviceName: select('pv-printer').value,
      copies: parseInt(input('pv-copies').value, 10) || 1,
      landscape,
      pageCount: $('stocktake-print-area').querySelectorAll('.pt-sheet').length,
      pageSize: 'A4',
      defaultFileName: `ใบตรวจนับ-${input('count-doc-number').value.trim() || 'ไม่มีเลขที่'}.pdf`,
      pageCss: `@media print{@page{size:A4 ${landscape ? 'landscape' : 'portrait'};margin:10mm;}}`
    })
    if (res.ok) {
      closePreview()
      showToast('ส่งไปที่เครื่องพิมพ์แล้ว')
    }
  } catch (err) {
    toastError(err)
  }
}

/* ---------- init ---------- */

export function initStocktake(refresh: () => Promise<void>): void {
  refreshAfterSave = refresh

  select('count-category').addEventListener('change', renderStocktakeTable)
  // Filters re-render the grid so long lists stay manageable.
  document.getElementById('count-search')?.addEventListener('input', renderStocktakeTable)
  document.getElementById('count-only-uncounted')?.addEventListener('click', function (this: HTMLElement) {
    filterUncounted = !filterUncounted
    this.classList.toggle('active', filterUncounted)
    renderStocktakeTable()
  })
  document.getElementById('count-only-diff')?.addEventListener('click', function (this: HTMLElement) {
    filterDiff = !filterDiff
    this.classList.toggle('active', filterDiff)
    renderStocktakeTable()
  })
  select('count-pending-sheet').addEventListener('change', applyPendingSheet)
  ;($('count-no-serial') as HTMLInputElement).addEventListener('change', applyNoSerialState)
  $('btn-print-stocktake').addEventListener('click', openPreview)
  $('btn-do-print').addEventListener('click', () => void doPrint())
  // Switching orientation in the dialog re-shapes the preview immediately.
  document.querySelectorAll<HTMLInputElement>('input[name="pv-layout"]').forEach((r) =>
    r.addEventListener('change', applyPreviewOrientation)
  )
  $('btn-close-preview').addEventListener('click', closePreview)
  $('btn-cancel-preview').addEventListener('click', closePreview)
  $('stocktake-preview-modal').addEventListener('click', (e) => {
    if (e.target === $('stocktake-preview-modal')) closePreview()
  })

  function showConfirm(show: boolean): void {
    $('st-confirm').style.display = show ? 'flex' : 'none'
    $('btn-save-stocktake').style.display = show ? 'none' : 'inline-flex'
  }
  $('btn-cancel-save').addEventListener('click', () => showConfirm(false))
  $('btn-save-stocktake').addEventListener('click', () => {
    if (collectEntries().length === 0) {
      showToast('กรุณานับสินค้าอย่างน้อย 1 รายการก่อนบันทึก', true)
      return
    }
    showConfirm(true)
  })

  $('btn-confirm-save').addEventListener('click', async () => {
    showConfirm(false)
    const entries = collectEntries()
    if (entries.length === 0) {
      showToast('กรุณานับสินค้าอย่างน้อย 1 รายการก่อนบันทึก', true)
      return
    }
    const noSerial = ($('count-no-serial') as HTMLInputElement).checked
    const sessionId = Number(select('count-pending-sheet').value) || null
    try {
      const result = await window.api.stocktake.save({
        sessionId,
        docNumber: noSerial ? '' : input('count-doc-number').value.trim(),
        countDate: input('count-date').value || todayIso(),
        countTime: input('count-time').value || nowTime(),
        category: select('count-category').value,
        generalNote: input('count-note').value,
        counterName: input('count-counter-name').value,
        noSerial,
        entries
      })
      cells = {}
      openRows = {}
      input('count-note').value = ''
      select('count-pending-sheet').value = ''
      await refreshAfterSave()
      await refreshPendingSheets()
      applyNoSerialState()
      showToast(
        result.adjusted > 0
          ? `บันทึกผลตรวจนับ ${result.docNumber || '(ปรับด่วน)'} แล้ว — ปรับสต๊อก ${result.adjusted} รายการ`
          : `บันทึกผลตรวจนับ ${result.docNumber || '(ปรับด่วน)'} แล้ว — ไม่มีรายการที่ต้องปรับ`
      )
    } catch (err) {
      toastError(err)
    }
  })
}
