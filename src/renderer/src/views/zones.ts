import type { ZoneProductView, ZoneSearchHit, ZoneView } from '../../../shared/types'
import { $, esc, input } from '../format'
import { state } from '../state'
import { showToast, toastError } from '../ui'

// Warehouse map + "where is this item?" lookup. Zones are a picking aid only —
// nothing here writes to stock_movements, so the ledger is untouched.

let zones: ZoneView[] = []
let selectedZoneId: number | null = null
let highlightedCodes: string[] = []

function canEdit(): boolean {
  return (state.user?.roleLevel ?? 0) >= 2
}

/* ---------- map ---------- */

function renderMap(): void {
  $('zone-map').innerHTML = zones
    .map((z) => {
      const style = `grid-column:${z.gridCol} / span ${z.gridW};grid-row:${z.gridRow} / span ${z.gridH};`
      const classes = ['zone-cell']
      if (z.kind === 'zone') {
        classes.push('is-zone')
        if (z.id === selectedZoneId) classes.push('selected')
        else if (highlightedCodes.includes(z.code)) classes.push('hit')
      } else {
        classes.push(z.kind === 'label' ? 'is-label' : 'is-space')
      }
      const body =
        z.kind === 'zone'
          ? `${esc(z.label)}<span class="zone-count">${z.productCount} รายการ</span>`
          : esc(z.label)
      return `<div class="${classes.join(' ')}" style="${style}"${
        z.kind === 'zone' ? ` data-zone="${z.id}" title="โซน ${esc(z.code)}"` : ''
      }>${body}</div>`
    })
    .join('')

  $('zone-map')
    .querySelectorAll<HTMLElement>('.zone-cell.is-zone')
    .forEach((cell) =>
      cell.addEventListener('click', () => void selectZone(Number(cell.dataset.zone)))
    )
}

/* ---------- zone detail ---------- */

function productRow(p: ZoneProductView, zoneId: number): string {
  const pending = p.barcodePending ? ' <span class="zone-badge none">รอใส่บาร์โค้ด</span>' : ''
  const remove = canEdit()
    ? `<button class="icon-btn zone-remove" data-p="${p.id}" data-z="${zoneId}" title="เอาออกจากโซนนี้"><i class="ti ti-x"></i></button>`
    : ''
  return `<div class="zone-prod">
    <div class="zp-desc">${esc(p.description)}${pending}
      <div class="zp-bar">${esc(p.barcode)}${p.baseUnit ? ` · หน่วย: ${esc(p.baseUnit)}` : ''}</div>
    </div>${remove}
  </div>`
}

async function selectZone(zoneId: number): Promise<void> {
  selectedZoneId = zoneId
  highlightedCodes = []
  renderMap()

  const zone = zones.find((z) => z.id === zoneId)
  if (!zone) return
  try {
    const products = await window.api.zones.products(zoneId)
    const list = products.length
      ? products.map((p) => productRow(p, zoneId)).join('')
      : '<div class="empty-state"><i class="ti ti-package-off"></i>ยังไม่มีสินค้าในโซนนี้</div>'

    const noteBox = canEdit()
      ? `<div class="form-row" style="margin-bottom:12px;">
           <label>หมายเหตุของโซน (ไม่บังคับ)</label>
           <input type="text" id="zone-note" value="${esc(zone.note ?? '')}" placeholder="เช่น เหล็กเส้นยาว 6 เมตร">
         </div>
         <div class="form-row" style="margin-bottom:12px;">
           <label>เพิ่มสินค้าเข้าโซนนี้</label>
           <select id="zone-add-product"></select>
         </div>
         <button class="btn small" id="zone-add-btn"><i class="ti ti-plus"></i> เพิ่มเข้าโซน</button>
         <hr style="border:none;border-top:1px solid var(--border);margin:14px 0;">`
      : zone.note
        ? `<div class="field-hint" style="margin-bottom:12px;">${esc(zone.note)}</div>`
        : ''

    $('zone-detail').innerHTML = `
      <h3>โซน ${esc(zone.label)}</h3>
      <div class="zone-detail-sub">${products.length} รายการ</div>
      ${noteBox}
      ${list}`

    if (canEdit()) {
      // Only products not already in this zone are offered.
      const already = new Set(products.map((p) => p.id))
      const sel = $('zone-add-product') as HTMLSelectElement
      sel.innerHTML =
        '<option value="">— เลือกสินค้า —</option>' +
        state.products
          .filter((p) => !already.has(p.id))
          .map((p) => `<option value="${p.id}">${esc(p.barcode)} — ${esc(p.description)}</option>`)
          .join('')

      $('zone-add-btn').addEventListener('click', () => void addToZone(zoneId, sel))
      input('zone-note').addEventListener('change', () => void saveNote(zoneId))
    }

    $('zone-detail')
      .querySelectorAll<HTMLButtonElement>('.zone-remove')
      .forEach((btn) =>
        btn.addEventListener('click', () =>
          void removeFromZone(Number(btn.dataset.p), Number(btn.dataset.z))
        )
      )
  } catch (err) {
    toastError(err)
  }
}

async function addToZone(zoneId: number, sel: HTMLSelectElement): Promise<void> {
  const productId = Number(sel.value)
  if (!productId) {
    showToast('กรุณาเลือกสินค้าก่อน', true)
    return
  }
  try {
    await window.api.zones.assign({ productId, zoneId })
    await reloadZones()
    await selectZone(zoneId)
    showToast('เพิ่มเข้าโซนแล้ว')
  } catch (err) {
    toastError(err)
  }
}

async function removeFromZone(productId: number, zoneId: number): Promise<void> {
  try {
    await window.api.zones.unassign({ productId, zoneId })
    await reloadZones()
    await selectZone(zoneId)
    showToast('เอาออกจากโซนแล้ว')
  } catch (err) {
    toastError(err)
  }
}

async function saveNote(zoneId: number): Promise<void> {
  try {
    await window.api.zones.setNote({ zoneId, note: input('zone-note').value })
    await reloadZones()
    showToast('บันทึกหมายเหตุแล้ว')
  } catch (err) {
    toastError(err)
  }
}

/* ---------- search ---------- */

function hitRow(h: ZoneSearchHit): string {
  const badges = h.zoneCodes.length
    ? h.zoneCodes.map((c) => `<span class="zone-badge">โซน ${esc(c)}</span>`).join('')
    : '<span class="zone-badge none">ยังไม่ได้ระบุโซน</span>'
  return `<div class="zone-prod">
    <div class="zp-desc">${esc(h.description)}
      <div class="zp-bar">${esc(h.barcode)}${h.baseUnit ? ` · หน่วย: ${esc(h.baseUnit)}` : ''}</div>
    </div>
    <div>${badges}</div>
  </div>`
}

async function runSearch(): Promise<void> {
  const q = input('zone-search').value.trim()
  if (!q) {
    $('zone-search-results').innerHTML = ''
    highlightedCodes = []
    renderMap()
    return
  }
  try {
    const hits = await window.api.zones.search(q)
    $('zone-search-results').innerHTML = hits.length
      ? hits.map(hitRow).join('')
      : '<div class="empty-state"><i class="ti ti-search-off"></i>ไม่พบสินค้าที่ตรงกับคำค้นนี้</div>'

    // Light up every bay the matches live in, so the map answers "where do I walk".
    highlightedCodes = [...new Set(hits.flatMap((h) => h.zoneCodes))]
    selectedZoneId = null
    renderMap()
  } catch (err) {
    toastError(err)
  }
}

/* ---------- lifecycle ---------- */

async function reloadZones(): Promise<void> {
  zones = await window.api.zones.list()
}

export async function renderZonesView(): Promise<void> {
  try {
    await reloadZones()
    renderMap()
    if (selectedZoneId) await selectZone(selectedZoneId)
  } catch (err) {
    toastError(err)
  }
}

export function initZones(): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  input('zone-search').addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => void runSearch(), 200)
  })
}
