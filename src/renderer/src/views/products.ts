import type { ProductView } from '../../../shared/types'
import { $, baseUnitName, esc, input, select, statusBadge, stockCellHtml, stockStatus } from '../format'
import { level, productById, state } from '../state'
import { promptModal, showToast, toastError } from '../ui'

// -------- filters --------

type StatusFilter = 'ทั้งหมด' | 'ปกติ' | 'ต่ำกว่าขั้นต่ำ' | 'ติดลบ'

interface ProductFilters {
  search: string
  category: string
  status: StatusFilter
  zone: string // 'ทั้งหมด' | zone code | 'ยังไม่ระบุ'
  sort: string
}

let filters: ProductFilters = { search: '', category: 'ทั้งหมด', status: 'ทั้งหมด', zone: 'ทั้งหมด', sort: 'default' }
let refreshAfterSave: () => Promise<void> = async () => {}

// Ticked rows, kept by product id so a filter change does not lose the
// selection the user has already built up.
let selectedIds = new Set<number>()

export function resetProductFilters(): void {
  filters = { search: '', category: 'ทั้งหมด', status: 'ทั้งหมด', zone: 'ทั้งหมด', sort: 'default' }
  input('product-search').value = ''
  select('product-sort').value = 'default'
}

function getFilteredSorted(): ProductView[] {
  const statusMap: Record<string, string> = { 'ปกติ': 'ok', 'ต่ำกว่าขั้นต่ำ': 'warn', 'ติดลบ': 'danger' }
  let list = state.products.filter((p) => {
    if (filters.category !== 'ทั้งหมด' && p.categoryName !== filters.category) return false
    if (filters.status !== 'ทั้งหมด' && stockStatus(p) !== statusMap[filters.status]) return false
    if (filters.zone === 'ยังไม่ระบุ' && p.zoneCodes.length > 0) return false
    if (filters.zone !== 'ทั้งหมด' && filters.zone !== 'ยังไม่ระบุ' && !p.zoneCodes.includes(filters.zone)) return false
    const q = filters.search.trim().toLowerCase()
    if (q && !p.barcode.toLowerCase().includes(q) && !p.description.toLowerCase().includes(q)) return false
    return true
  })
  if (filters.sort === 'name') list = [...list].sort((a, b) => a.description.localeCompare(b.description, 'th'))
  else if (filters.sort === 'stock-asc') list = [...list].sort((a, b) => a.totalOnHand - b.totalOnHand)
  else if (filters.sort === 'stock-desc') list = [...list].sort((a, b) => b.totalOnHand - a.totalOnHand)
  // Bay order is what a picker walks in, so sort numerically and push the
  // unassigned items to the end rather than letting them sort as bay 0.
  else if (filters.sort === 'zone') {
    const key = (p: ProductView): number =>
      p.zoneCodes.length ? Math.min(...p.zoneCodes.map((c) => Number(c) || 999)) : 999
    list = [...list].sort((a, b) => key(a) - key(b) || a.description.localeCompare(b.description, 'th'))
  }
  return list
}

function renderFilterChips(): void {
  const categories = ['ทั้งหมด', ...new Set(state.products.map((p) => p.categoryName))]
  $('filter-category-chips').innerHTML = categories
    .map(
      (c) =>
        `<button type="button" class="chip${filters.category === c ? ' active' : ''}" data-filter="category" data-value="${esc(c)}">${esc(c)}</button>`
    )
    .join('')
  const statuses: StatusFilter[] = ['ทั้งหมด', 'ปกติ', 'ต่ำกว่าขั้นต่ำ', 'ติดลบ']
  $('filter-status-chips').innerHTML = statuses
    .map(
      (s) =>
        `<button type="button" class="chip${filters.status === s ? ' active' : ''}" data-filter="status" data-value="${s}">${s}</button>`
    )
    .join('')
  // Bay chips are built from the products themselves, sorted numerically.
  const usedZones = [...new Set(state.products.flatMap((p) => p.zoneCodes))].sort(
    (a, b) => (Number(a) || 999) - (Number(b) || 999)
  )
  const zoneOptions = ['ทั้งหมด', ...usedZones, 'ยังไม่ระบุ']
  $('filter-zone-chips').innerHTML = zoneOptions
    .map((z) => {
      const label = z === 'ทั้งหมด' || z === 'ยังไม่ระบุ' ? z : `โซน ${z}`
      return `<button type="button" class="chip${filters.zone === z ? ' active' : ''}" data-filter="zone" data-value="${esc(z)}">${esc(label)}</button>`
    })
    .join('')

  document.querySelectorAll<HTMLButtonElement>('#filter-category-chips .chip, #filter-status-chips .chip, #filter-zone-chips .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.filter as 'category' | 'status' | 'zone'
      ;(filters as any)[key] = btn.dataset.value
      renderProducts()
    })
  })
}

function updateFilterMeta(filteredCount: number): void {
  $('filter-result-count').textContent = `แสดง ${filteredCount} จาก ${state.products.length} รายการ`
  const anyActive =
    filters.search !== '' || filters.category !== 'ทั้งหมด' || filters.status !== 'ทั้งหมด' || filters.zone !== 'ทั้งหมด'
  $('btn-clear-filters').style.display = anyActive ? 'inline' : 'none'
}

// -------- table --------

// Optional columns. Barcode and description are never in here — they are the
// identifying pair and stay pinned to the left so a horizontal scroll never
// leaves you looking at numbers with no idea whose they are.
const OPTIONAL_COLS: { key: string; label: string; minLevel?: number }[] = [
  { key: 'zone', label: 'โซน' },
  { key: 'category', label: 'หมวดหมู่' },
  { key: 'unit', label: 'หน่วยฐาน' },
  { key: 'stock', label: 'สต๊อก' },
  { key: 'unitBreakdown', label: 'แยกตามหน่วย (จำนวน + ราคา)' },
  { key: 'cost', label: 'ต้นทุน', minLevel: 2 },
  { key: 'retail', label: 'ราคาขายหน้าร้าน' },
  { key: 'tradesman', label: 'ราคาเพิ่มเติม 1', minLevel: 2 },
  { key: 'wholesale', label: 'ราคาเพิ่มเติม 2', minLevel: 2 },
  { key: 'status', label: 'สถานะ' }
]

const COLS_KEY = 'products.visibleCols'
const DEFAULT_COLS = ['zone', 'category', 'unit', 'stock', 'retail', 'status']

let visibleCols = new Set<string>(DEFAULT_COLS)

export function loadVisibleCols(): void {
  try {
    const raw = localStorage.getItem(COLS_KEY)
    if (raw) visibleCols = new Set(JSON.parse(raw) as string[])
  } catch {
    visibleCols = new Set(DEFAULT_COLS)
  }
}

function saveVisibleCols(): void {
  localStorage.setItem(COLS_KEY, JSON.stringify([...visibleCols]))
}

// A column shows only if the role allows it AND the user asked for it.
function colOn(key: string, lvl: number): boolean {
  const def = OPTIONAL_COLS.find((c) => c.key === key)
  if (def?.minLevel !== undefined && lvl < def.minLevel) return false
  return visibleCols.has(key)
}

// Prices are stored per base unit, so a box price is just the base price times
// the number of base units in a box.
function unitPriceList(p: ProductView): string {
  const base = p.prices['RETAIL']
  if (base === undefined || p.units.length < 2) return ''
  return p.units.map((u) => `${esc(u.name)} ${(base * u.qtyPerBase).toFixed(2)}`).join(' · ')
}

function unitQtyList(p: ProductView): string {
  if (p.units.length < 2) return ''
  return p.units.map((u) => `${esc(u.name)} ${Math.floor(Math.abs(p.totalOnHand) / u.qtyPerBase)}`).join(' · ')
}

function renderColPicker(lvl: number): void {
  const box = $('col-picker')
  box.innerHTML =
    OPTIONAL_COLS.filter((c) => c.minLevel === undefined || lvl >= c.minLevel)
      .map(
        (c) =>
          `<label><input type="checkbox" class="col-toggle" value="${c.key}"${visibleCols.has(c.key) ? ' checked' : ''}> ${esc(c.label)}</label>`
      )
      .join('') +
    `<hr><button type="button" class="btn small ghost" id="btn-cols-reset" style="width:100%;">คืนค่าเริ่มต้น</button>`

  box.querySelectorAll<HTMLInputElement>('.col-toggle').forEach((cb) =>
    cb.addEventListener('change', () => {
      if (cb.checked) visibleCols.add(cb.value)
      else visibleCols.delete(cb.value)
      saveVisibleCols()
      renderProducts()
    })
  )
  document.getElementById('btn-cols-reset')?.addEventListener('click', () => {
    visibleCols = new Set(DEFAULT_COLS)
    saveVisibleCols()
    renderProducts()
  })
}

// The menu is position:fixed so the panel's overflow:hidden cannot clip it.
// The trade-off is placing it by hand in viewport coordinates, and keeping it
// inside the window: with the button low on screen "below the button" can run
// off the bottom edge, so the height is capped at whatever room is left and the
// menu scrolls inside itself rather than disappearing.
function placeColPicker(): void {
  const r = $('btn-col-picker').getBoundingClientRect()
  const picker = $('col-picker')
  picker.style.top = `${r.bottom + 6}px`
  picker.style.right = `${Math.max(8, window.innerWidth - r.right)}px`
  picker.style.maxHeight = `${Math.max(140, window.innerHeight - r.bottom - 18)}px`
}

function closeColPicker(): void {
  $('col-picker').classList.remove('show')
}

export function renderProducts(): void {
  const lvl = level()
  const showAction = lvl >= 2

  $('product-count-sub').textContent = `ทั้งหมด ${state.products.length} รายการ`
  $('products-panel-actions').innerHTML = showAction
    ? `<button class="btn primary" id="btn-add-product"><i class="ti ti-plus"></i>เพิ่มสินค้า</button>`
    : ''
  if (showAction) {
    $('btn-add-product').addEventListener('click', () => openSlideover(null))
  }

  // Pinned columns, with their left offsets accumulated in render order.
  const pinned: { w: number; head: string; html: (p: ProductView) => string }[] = []
  if (showAction) {
    pinned.push({
      w: 40,
      head: `<input type="checkbox" class="row-check" id="check-all">`,
      html: (p) =>
        `<input type="checkbox" class="row-check row-select" data-id="${p.id}"${selectedIds.has(p.id) ? ' checked' : ''}>`
    })
  }
  pinned.push({
    w: 120,
    head: 'บาร์โค้ด',
    html: (p) =>
      `<span class="mono">${esc(p.barcode)}</span>${p.barcodePending ? ' <span class="badge warn">รอใส่บาร์โค้ด</span>' : ''}`
  })
  pinned.push({ w: 240, head: 'คำอธิบาย', html: (p) => esc(p.description) })

  let left = 0
  const offsets = pinned.map((c) => {
    const at = left
    left += c.w
    return at
  })
  const pinCell = (i: number, tag: 'th' | 'td', inner: string): string =>
    `<${tag} class="sticky-col${i === pinned.length - 1 ? ' sticky-edge' : ''}" style="left:${offsets[i]}px;min-width:${pinned[i].w}px;">${inner}</${tag}>`

  let head = pinned.map((c, i) => pinCell(i, 'th', c.head)).join('')
  let colCount = pinned.length
  const add = (on: boolean, th: string): void => {
    if (on) {
      head += th
      colCount++
    }
  }
  add(colOn('zone', lvl), `<th>โซน</th>`)
  add(colOn('category', lvl), `<th>หมวดหมู่</th>`)
  add(colOn('unit', lvl), `<th>หน่วยฐาน</th>`)
  // Location names come from the table, not a fixed string — the shop gained a
  // third location when the 4POS balances were carried over, and a hard-coded
  // "(คลัง / หน้าร้าน)" would then be describing columns that are not there.
  add(colOn("stock", lvl), `<th>สต๊อก (${esc(state.locations.map((l) => l.short).join(" / "))})</th>`)
  add(colOn('unitBreakdown', lvl), `<th>แยกตามหน่วย</th>`)
  add(colOn('cost', lvl), `<th class="num">ต้นทุน/หน่วยฐาน</th>`)
  add(colOn('retail', lvl), `<th class="num">ราคาขายหน้าร้าน</th>`)
  add(colOn("tradesman", lvl), `<th class="num">ราคาเพิ่มเติม 1</th>`)
  add(colOn("wholesale", lvl), `<th class="num">ราคาเพิ่มเติม 2</th>`)
  add(colOn('status', lvl), `<th>สถานะ</th>`)
  if (showAction) {
    head += `<th></th>`
    colCount++
  }
  $('products-head-row').innerHTML = head

  const filtered = getFilteredSorted()
  $('products-body').innerHTML =
    filtered
      .map((p) => {
        const price = (code: string): string => (p.prices[code] !== undefined ? p.prices[code].toFixed(2) : '—')
        let row = pinned.map((c, i) => pinCell(i, 'td', c.html(p))).join('')
        if (colOn('zone', lvl))
          row += `<td>${p.zoneCodes.length ? p.zoneCodes.map((c) => `<span class="zone-badge">${esc(c)}</span>`).join('') : '<span class="text-muted">—</span>'}</td>`
        if (colOn('category', lvl)) row += `<td>${esc(p.categoryName)}</td>`
        if (colOn('unit', lvl)) row += `<td>${esc(baseUnitName(p))}</td>`
        if (colOn('stock', lvl)) row += `<td>${stockCellHtml(p)}</td>`
        if (colOn('unitBreakdown', lvl)) {
          const q = unitQtyList(p)
          const pr = unitPriceList(p)
          row += `<td>${q ? `<div>${q}</div>` : '<span class="text-muted">—</span>'}${pr ? `<div class="unit-price-list">${pr}</div>` : ''}</td>`
        }
        if (colOn('cost', lvl)) row += `<td class="num">${(p.cost ?? 0).toFixed(2)}</td>`
        if (colOn('retail', lvl)) row += `<td class="num">${price('RETAIL')}</td>`
        if (colOn('tradesman', lvl)) row += `<td class="num">${price('TRADESMAN')}</td>`
        if (colOn('wholesale', lvl)) row += `<td class="num">${price('WHOLESALE')}</td>`
        if (colOn('status', lvl)) row += `<td>${statusBadge(stockStatus(p), false)}</td>`
        if (showAction)
          row += `<td><button class="icon-btn btn-edit-product" data-id="${p.id}" title="แก้ไขสินค้า"><i class="ti ti-pencil"></i></button></td>`
        return `<tr>${row}</tr>`
      })
      .join('') ||
    `<tr><td colspan="${colCount}"><div class="empty-state"><i class="ti ti-search-off"></i>ไม่พบสินค้าตามตัวกรองที่เลือก</div></td></tr>`

  document.querySelectorAll<HTMLButtonElement>('.btn-edit-product').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = productById(Number(btn.dataset.id))
      if (p) openSlideover(p)
    })
  })

  renderColPicker(lvl)
  if (showAction) bindSelection(filtered)
  renderFilterChips()
  updateFilterMeta(filtered.length)
}

// -------- bulk zone assignment --------

function visibleIds(list: ProductView[]): number[] {
  return list.map((p) => p.id)
}

function refreshBulkBar(): void {
  const bar = $('bulk-bar')
  bar.classList.toggle('show', selectedIds.size > 0)
  $('bulk-count').textContent = String(selectedIds.size)
}

function bindSelection(filtered: ProductView[]): void {
  document.querySelectorAll<HTMLInputElement>('.row-select').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id)
      if (cb.checked) selectedIds.add(id)
      else selectedIds.delete(id)
      syncCheckAll(filtered)
      refreshBulkBar()
    })
  })
  const all = document.getElementById('check-all') as HTMLInputElement | null
  if (all) {
    syncCheckAll(filtered)
    all.addEventListener('change', () => {
      // Applies to what is on screen only — never to rows hidden by a filter.
      for (const id of visibleIds(filtered)) {
        if (all.checked) selectedIds.add(id)
        else selectedIds.delete(id)
      }
      document.querySelectorAll<HTMLInputElement>('.row-select').forEach((cb) => (cb.checked = all.checked))
      refreshBulkBar()
    })
  }
  refreshBulkBar()
}

function syncCheckAll(filtered: ProductView[]): void {
  const all = document.getElementById('check-all') as HTMLInputElement | null
  if (!all) return
  const ids = visibleIds(filtered)
  const picked = ids.filter((id) => selectedIds.has(id)).length
  all.checked = ids.length > 0 && picked === ids.length
  all.indeterminate = picked > 0 && picked < ids.length
}

async function fillBulkZoneOptions(): Promise<void> {
  const sel = select('bulk-zone')
  if (sel.options.length) return
  try {
    const zones = await window.api.zones.list()
    sel.innerHTML = zones
      .filter((z) => z.kind === 'zone')
      .sort((a, b) => (Number(a.code) || 999) - (Number(b.code) || 999))
      .map((z) => `<option value="${z.id}">โซน ${esc(z.code)}</option>`)
      .join('')
  } catch (err) {
    toastError(err)
  }
}

async function applyBulkZone(mode: 'add' | 'remove'): Promise<void> {
  const zoneId = Number(select('bulk-zone').value)
  if (!zoneId) {
    showToast('ยังไม่ได้เลือกโซน', true)
    return
  }
  try {
    const res = await window.api.zones.assignMany({ productIds: [...selectedIds], zoneId, mode })
    const zoneLabel = select('bulk-zone').selectedOptions[0]?.textContent ?? 'โซนที่เลือก'
    const verb = mode === 'add' ? 'เพิ่มเข้า' : 'เอาออกจาก'
    const skipNote = res.skipped ? ` (ข้าม ${res.skipped} รายการที่${mode === 'add' ? 'อยู่แล้ว' : 'ไม่ได้อยู่'})` : ''
    selectedIds.clear()
    await refreshAfterSave()
    showToast(`${verb}${zoneLabel} ${res.changed} รายการ${skipNote}`)
  } catch (err) {
    toastError(err)
  }
}

// -------- add/edit slide-over --------

interface UnitLevel {
  name: string
  qtyPerBase: number | ''
  isBase: boolean
}

let unitLevels: UnitLevel[] = []
let editingId: number | null = null
// Kept alongside editingId so the quantity boxes can be redrawn (with the right
// prefill) whenever the unit ladder is edited.
let editingProduct: ProductView | null = null

// Unit names people already use, so the same "ลูก"/"กล่อง"/"ถุง" is picked
// rather than retyped (and misspelled) on every product. Derived from the
// loaded catalogue, so it needs no extra round trip and is never stale.
function refreshUnitNameOptions(): void {
  const names = [...new Set(state.products.flatMap((p) => p.units.map((u) => u.name)))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'th'))
  const dl = document.getElementById('unit-name-options')
  if (dl) dl.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('')
}

function renderUnitLevels(): void {
  const list = $('unit-levels-list')
  list.innerHTML = unitLevels
    .map((lvl, i) => {
      if (lvl.isBase) {
        return `<div class="unit-level-base">
        <input type="text" class="ul-name" list="unit-name-options" data-idx="${i}" data-field="name" value="${esc(lvl.name)}">
        <span class="unit-level-base-tag">หน่วยฐาน · ×1</span>
      </div>`
      }
      return `<div class="unit-level-row">
      <input type="text" class="ul-name" list="unit-name-options" data-idx="${i}" data-field="name" placeholder="ชื่อหน่วย เช่น กล่อง" value="${esc(lvl.name)}">
      <input type="number" class="ul-qty" data-idx="${i}" data-field="qtyPerBase" placeholder="เท่ากับกี่หน่วยฐาน" value="${lvl.qtyPerBase === '' ? '' : lvl.qtyPerBase}">
      <button type="button" class="icon-btn ul-remove" data-idx="${i}"><i class="ti ti-trash"></i></button>
    </div>`
    })
    .join('')

  list.querySelectorAll<HTMLInputElement>('input[data-field]').forEach((el) => {
    el.addEventListener('input', () => {
      const idx = Number(el.dataset.idx)
      if (el.dataset.field === 'name') unitLevels[idx].name = el.value
      else unitLevels[idx].qtyPerBase = el.value === '' ? '' : parseFloat(el.value)
      // The quantity boxes mirror the ladder, so rebuild them as it is edited.
      renderOpeningStockInputs(editingProduct)
    })
  })
  list.querySelectorAll<HTMLButtonElement>('.ul-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      unitLevels.splice(Number(btn.dataset.idx), 1)
      renderUnitLevels()
    })
  })
}

function renderCategoryOptions(selectedId?: number | null): void {
  const sel = select('new-product-category')
  sel.innerHTML = state.categories
    .map((c) => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${esc(c.name)}</option>`)
    .join('')
}

// Bay pickers. Checkboxes rather than a single dropdown because a line of goods
// is genuinely sometimes split across two bays — a single select would silently
// drop the second one on save. Nothing ticked = ยังไม่ระบุโซน, which is allowed.
let zoneChoices: { id: number; code: string }[] = []

async function loadZoneChoices(): Promise<void> {
  if (zoneChoices.length) return
  try {
    const all = await window.api.zones.list()
    zoneChoices = all
      .filter((z) => z.kind === 'zone')
      .sort((a, b) => (Number(a.code) || 999) - (Number(b.code) || 999))
      .map((z) => ({ id: z.id, code: z.code }))
  } catch {
    zoneChoices = [] // ไม่ใช่เรื่องคอขวด — ถ้าโหลดไม่ได้ก็ยังบันทึกสินค้าได้
  }
}

function renderZoneChecks(selected: number[]): void {
  const box = $('new-product-zones')
  if (!zoneChoices.length) {
    box.innerHTML = '<div class="field-hint">ยังไม่มีโซนในระบบ</div>'
    return
  }
  const chosen = new Set(selected)
  box.innerHTML = zoneChoices
    .map(
      (z) => `<label class="zone-check"><input type="checkbox" class="zone-check-input" value="${z.id}"${
        chosen.has(z.id) ? ' checked' : ''
      }> ${esc(z.code)}</label>`
    )
    .join('')
}

// Current unit ladder as typed in the form, largest first. Read live from the
// unit rows so the quantity boxes follow whatever is being edited right now.
function currentUnitLadder(): { name: string; qtyPerBase: number }[] {
  const ladder = unitLevels
    .filter((u) => u.isBase || (u.name.trim() && typeof u.qtyPerBase === 'number' && u.qtyPerBase > 0))
    .map((u) => ({ name: u.name.trim() || 'ชิ้น', qtyPerBase: u.isBase ? 1 : (u.qtyPerBase as number) }))
  return ladder.sort((a, b) => b.qtyPerBase - a.qtyPerBase)
}

// Split a base-unit total into the ladder, biggest unit first — the same
// arithmetic formatStock() uses for display.
function splitToUnits(qtyBase: number, ladder: { qtyPerBase: number }[]): number[] {
  let rest = Math.abs(qtyBase)
  return ladder.map((u) => {
    const n = Math.floor(rest / u.qtyPerBase)
    rest -= n * u.qtyPerBase
    return n
  })
}

// Shown for new AND existing products. On create the numbers become OPENING
// movements; on edit the difference from the ledger becomes an ADJUST. Either
// way the balance is derived, never written directly.
//
// One box per unit level, because stock is counted the way it is stacked —
// "2 ถุง กับอีก 3 ชิ้น" — not as a single base-unit figure worked out by hand.
function renderOpeningStockInputs(product: ProductView | null): void {
  const ladder = currentUnitLadder()
  $('opening-stock-inputs').innerHTML = state.locations
    .map((l) => {
      const now = product ? (product.stockByLocation[l.id] ?? 0) : 0
      const parts = splitToUnits(now, ladder)
      const boxes =
        ladder.length > 1
          ? `<div class="st-unit-row">${ladder
              .map(
                (u, i) => `<label class="st-unit"><span>${esc(u.name)}</span>
                  <input type="number" class="opening-stock-input" data-location="${l.id}" data-mult="${u.qtyPerBase}" value="${parts[i]}"></label>`
              )
              .join('')}</div>`
          : `<input type="number" class="opening-stock-input" data-location="${l.id}" data-mult="1" value="${now}">`
      return `<div><label><i class="ti ti-map-pin" style="font-size:13px;vertical-align:-2px;"></i> ${esc(l.name)}</label>${boxes}</div>`
    })
    .join('')
}

function openSlideover(product: ProductView | null): void {
  editingId = product?.id ?? null
  editingProduct = product
  ;($('slideover-title') as HTMLElement).textContent = product ? 'แก้ไขสินค้า' : 'เพิ่มสินค้า'

  unitLevels = product
    ? product.units.map((u, i) => ({
        name: u.name,
        qtyPerBase: u.qtyPerBase,
        isBase: i === product.units.length - 1
      }))
    : [{ name: 'ชิ้น', qtyPerBase: 1, isBase: true }]
  refreshUnitNameOptions()
  renderUnitLevels()
  renderCategoryOptions(product?.categoryId)

  input('new-product-barcode').value = product?.barcode ?? ''
  input('new-product-sub-barcode').value = product?.subBarcode ?? ''
  input('new-product-desc').value = product?.description ?? ''
  input('new-product-min').value = String(product?.minStock ?? 0)
  input('new-product-max').value = String(product?.maxStock ?? 0)
  input('new-product-cost').value = String(product?.cost ?? 0)
  input('new-product-price-retail').value = String(product?.prices['RETAIL'] ?? 0)
  input('new-product-price-tradesman').value = String(product?.prices['TRADESMAN'] ?? 0)
  input('new-product-price-wholesale').value = String(product?.prices['WHOLESALE'] ?? 0)

  // Opening stock is only for brand-new products — later corrections must go
  // through stocktake so the change is recorded as an ADJUST movement.
  // Quantity is editable at all times — people need to correct a wrong count
  // without hunting for the stocktake screen.
  $('fieldset-opening-stock').style.display = ''
  renderOpeningStockInputs(product)
  $('opening-stock-legend').textContent = product
    ? 'จำนวนคงเหลือตอนนี้ (แก้ได้ — ระบบจะบันทึกเป็นรายการปรับตามส่วนต่าง)'
    : 'สต๊อกเริ่มต้น (พิมพ์จำนวนที่นับได้จริงตอนนี้)'
  $('opening-stock-hint').textContent = product
    ? 'นับเป็นหน่วยฐาน — แก้ตัวเลขแล้วระบบจะลงรายการปรับ (ADJUST) เท่ากับส่วนต่าง ไม่ได้เขียนทับยอดเดิม จึงตรวจย้อนหลังได้'
    : 'นับเป็นหน่วยฐาน — แยกจำนวนตามสถานที่เก็บ'

  // Zones load lazily; render as soon as the list is available.
  renderZoneChecks(product?.zoneIds ?? [])
  void loadZoneChoices().then(() => renderZoneChecks(product?.zoneIds ?? []))

  $('overlay').classList.add('active')
  $('slideover').classList.add('active')
}

function closeSlideover(): void {
  $('overlay').classList.remove('active')
  $('slideover').classList.remove('active')
}

async function saveProduct(): Promise<void> {
  const num = (id: string): number => parseFloat(input(id).value) || 0

  // Sorted largest-first on the way out: formatStock() walks the ladder in
  // order doing floor division, so an out-of-order ladder silently produces a
  // wrong breakdown (e.g. ถุง x200 listed after ชิ้น x50 would never match).
  const units = unitLevels
    .filter((u) => u.isBase || (u.name.trim() && typeof u.qtyPerBase === 'number' && u.qtyPerBase > 0))
    .map((u) => ({ name: u.name.trim() || 'ชิ้น', qtyPerBase: u.isBase ? 1 : (u.qtyPerBase as number) }))
    .sort((a, b) => b.qtyPerBase - a.qtyPerBase)

  // Each box carries its own multiplier, so the base total is just the sum of
  // (typed value x units-per-base) across every box for that location.
  const openingStock: Record<number, number> = {}
  document.querySelectorAll<HTMLInputElement>('.opening-stock-input').forEach((el) => {
    const loc = Number(el.dataset.location)
    const mult = Number(el.dataset.mult) || 1
    openingStock[loc] = (openingStock[loc] ?? 0) + (parseFloat(el.value) || 0) * mult
  })

  try {
    await window.api.products.save({
      id: editingId ?? undefined,
      barcode: input('new-product-barcode').value.trim(),
      subBarcode: input('new-product-sub-barcode').value.trim(),
      description: input('new-product-desc').value.trim(),
      categoryId: Number(select('new-product-category').value),
      units: units.length ? units : [{ name: 'ชิ้น', qtyPerBase: 1 }],
      minStock: num('new-product-min'),
      maxStock: num('new-product-max'),
      cost: num('new-product-cost'),
      prices: {
        RETAIL: num('new-product-price-retail'),
        TRADESMAN: num('new-product-price-tradesman'),
        WHOLESALE: num('new-product-price-wholesale')
      },
      openingStock: editingId ? undefined : openingStock,
      currentStock: editingId ? openingStock : undefined,
      // Always an explicit array so unticking everything really clears the bays.
      zoneIds: [...document.querySelectorAll<HTMLInputElement>('.zone-check-input:checked')].map((el) =>
        Number(el.value)
      )
    })
    closeSlideover()
    await refreshAfterSave()
    showToast(editingId ? 'บันทึกการแก้ไขสินค้าแล้ว' : `เพิ่มสินค้า "${input('new-product-desc').value.trim()}" เข้าระบบเรียบร้อยแล้ว`)
  } catch (err) {
    toastError(err)
  }
}

// -------- init --------

export function initProducts(refresh: () => Promise<void>): void {
  refreshAfterSave = refresh

  input('product-search').addEventListener('input', (e) => {
    filters.search = (e.target as HTMLInputElement).value
    renderProducts()
  })
  select('product-sort').addEventListener('change', (e) => {
    filters.sort = (e.target as HTMLSelectElement).value
    renderProducts()
  })
  loadVisibleCols()
  // Column chooser opens on click and closes when you click anywhere else.
  // It is position:fixed (see the CSS note) so it cannot be clipped by the
  // panel, which means its coordinates have to be measured from the button on
  // every open — and it has to close on scroll, because fixed does not follow.
  $('btn-col-picker').addEventListener('click', (e) => {
    e.stopPropagation()
    const picker = $('col-picker')
    if (picker.classList.contains('show')) {
      picker.classList.remove('show')
      return
    }
    placeColPicker()
    picker.classList.add('show')
  })
  $('col-picker').addEventListener('click', (e) => e.stopPropagation())
  document.addEventListener('click', closeColPicker)
  document.querySelector('.content')?.addEventListener('scroll', closeColPicker)
  window.addEventListener('resize', closeColPicker)

  void fillBulkZoneOptions()
  $('btn-bulk-add').addEventListener('click', () => void applyBulkZone('add'))
  $('btn-bulk-remove').addEventListener('click', () => void applyBulkZone('remove'))
  $('btn-bulk-clear').addEventListener('click', () => {
    selectedIds.clear()
    renderProducts()
  })

  $('btn-clear-filters').addEventListener('click', () => {
    filters = { search: '', category: 'ทั้งหมด', status: 'ทั้งหมด', zone: 'ทั้งหมด', sort: filters.sort }
    input('product-search').value = ''
    renderProducts()
  })

  $('btn-add-unit-level').addEventListener('click', () => {
    unitLevels.splice(unitLevels.length - 1, 0, { name: '', qtyPerBase: '', isBase: false })
    renderUnitLevels()
  })
  $('btn-add-category').addEventListener('click', async () => {
    const result = await promptModal(
      'เพิ่มหมวดหมู่ใหม่',
      [{ key: 'name', label: 'ชื่อหมวดหมู่', placeholder: 'เช่น สีและเคมีภัณฑ์' }],
      (v) => (v.name.trim() ? null : 'กรุณาระบุชื่อหมวดหมู่')
    )
    if (!result) return
    try {
      const cat = await window.api.lookups.addCategory(result.name.trim())
      if (!state.categories.some((c) => c.id === cat.id)) state.categories.push(cat)
      renderCategoryOptions(cat.id)
      showToast(`เพิ่มหมวดหมู่ "${cat.name}" แล้ว`)
    } catch (err) {
      toastError(err)
    }
  })

  $('btn-close-slideover').addEventListener('click', closeSlideover)
  $('btn-cancel-product').addEventListener('click', closeSlideover)
  $('overlay').addEventListener('click', closeSlideover)
  $('btn-save-product').addEventListener('click', () => void saveProduct())
}
