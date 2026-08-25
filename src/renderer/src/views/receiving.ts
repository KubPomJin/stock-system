import { $, baht, esc, formatStock, input, select } from '../format'
import { productById, state } from '../state'
import { showToast, toastError } from '../ui'

interface ReceivingLine {
  productId: number
  unitId: number
  barcode: string
  desc: string
  unitName: string
  qty: number
  cost: number
}

const lines: ReceivingLine[] = []
let refreshAfterPost: () => Promise<void> = async () => {}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function refreshReceivingDocNumber(): Promise<void> {
  try {
    input('rec-doc-number').value = await window.api.receiving.nextDocNumber()
  } catch {
    input('rec-doc-number').value = ''
  }
}

export function renderReceivingSelectors(): void {
  const sel = select('rec-product-select')
  sel.innerHTML = state.products
    .map((p) => `<option value="${p.id}">${esc(p.barcode)} — ${esc(p.description)}</option>`)
    .join('')
  select('rec-location').innerHTML = state.locations
    .map((l) => `<option value="${l.id}">${esc(l.name)}</option>`)
    .join('')
  input('rec-date').value = todayIso()
  refreshUnitOptions()
}

function refreshUnitOptions(): void {
  const p = productById(Number(select('rec-product-select').value))
  const unitSel = select('rec-unit-select')
  if (!p) {
    unitSel.innerHTML = ''
    return
  }
  const base = p.units[p.units.length - 1]
  unitSel.innerHTML = p.units
    .map(
      (u) =>
        `<option value="${u.unitId}">${esc(u.name)}${u.qtyPerBase > 1 ? ` (1 ${esc(u.name)} = ${u.qtyPerBase} ${esc(base.name)})` : ''}</option>`
    )
    .join('')
  updateDefaultCost()
}

function updateDefaultCost(): void {
  const p = productById(Number(select('rec-product-select').value))
  if (!p) return
  const unit = p.units.find((u) => u.unitId === Number(select('rec-unit-select').value))
  if (!unit) return
  input('rec-cost').value = ((p.cost ?? 0) * unit.qtyPerBase).toFixed(2)
}

function renderLines(): void {
  const body = $('receiving-lines-body')
  if (lines.length === 0) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="ti ti-package"></i>ยังไม่มีรายการสินค้า — เพิ่มรายการด้านบน</div></td></tr>`
  } else {
    body.innerHTML = lines
      .map(
        (l, i) => `<tr>
      <td class="mono">${esc(l.barcode)}</td>
      <td>${esc(l.desc)}</td>
      <td>${esc(l.unitName)}</td>
      <td class="num">${l.qty}</td>
      <td class="num">${l.cost.toFixed(2)}</td>
      <td class="num">${(l.qty * l.cost).toFixed(2)}</td>
      <td><button class="icon-btn rec-remove" data-idx="${i}"><i class="ti ti-trash"></i></button></td>
    </tr>`
      )
      .join('')
    body.querySelectorAll<HTMLButtonElement>('.rec-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        lines.splice(Number(btn.dataset.idx), 1)
        renderLines()
      })
    })
  }
  const subtotal = lines.reduce((s, l) => s + l.qty * l.cost, 0)
  const vat = subtotal * 0.07
  $('rec-subtotal').textContent = baht(subtotal)
  $('rec-vat').textContent = baht(vat)
  $('rec-total').textContent = baht(subtotal + vat)
}

// ---------- supplier combobox (search + add-new) ----------

let supplierActiveIdx = -1
let selectedSupplierId: number | null = null

function renderSupplierList(): void {
  const inputEl = input('rec-supplier-input')
  const list = $('supplier-list')
  const q = inputEl.value.trim().toLowerCase()
  const matches = state.suppliers.filter((s) => s.name.toLowerCase().includes(q))
  let html = matches
    .map(
      (s, i) =>
        `<div class="combobox-option${i === supplierActiveIdx ? ' active' : ''}" data-id="${s.id}" data-value="${esc(s.name)}"><i class="ti ti-building-store"></i>${esc(s.name)}</div>`
    )
    .join('')
  const exactMatch = state.suppliers.some((s) => s.name.toLowerCase() === q)
  if (q && !exactMatch) {
    html += `<div class="combobox-option add-new" data-add="${esc(inputEl.value.trim())}"><i class="ti ti-plus"></i>เพิ่มผู้จำหน่ายใหม่: "${esc(inputEl.value.trim())}"</div>`
  }
  if (!html) html = `<div class="combobox-empty">ไม่พบผู้จำหน่าย — พิมพ์ชื่อเพื่อเพิ่มใหม่</div>`
  list.innerHTML = html
  list.querySelectorAll<HTMLElement>('.combobox-option').forEach((opt) => {
    opt.addEventListener('mousedown', (e) => {
      e.preventDefault()
      if (opt.dataset.add !== undefined) {
        // New supplier: keep the typed name; the actual row is created in the
        // main process when the document is posted (find-or-create by name).
        selectedSupplierId = null
        inputEl.value = opt.dataset.add
        showToast(`จะเพิ่มผู้จำหน่าย "${opt.dataset.add}" เมื่อบันทึกเอกสาร`)
      } else {
        selectedSupplierId = Number(opt.dataset.id)
        inputEl.value = opt.dataset.value ?? ''
      }
      closeSupplierList()
    })
  })
}

function openSupplierList(): void {
  supplierActiveIdx = -1
  renderSupplierList()
  $('supplier-list').classList.add('open')
}

function closeSupplierList(): void {
  $('supplier-list').classList.remove('open')
}

// ---------- init / actions ----------

export function initReceiving(refresh: () => Promise<void>): void {
  refreshAfterPost = refresh

  select('rec-product-select').addEventListener('change', refreshUnitOptions)
  select('rec-unit-select').addEventListener('change', updateDefaultCost)

  const supplierInput = input('rec-supplier-input')
  supplierInput.addEventListener('focus', openSupplierList)
  supplierInput.addEventListener('input', () => {
    supplierActiveIdx = -1
    selectedSupplierId = null
    renderSupplierList()
    $('supplier-list').classList.add('open')
  })
  supplierInput.addEventListener('blur', () => setTimeout(closeSupplierList, 150))
  supplierInput.addEventListener('keydown', (e) => {
    const options = $('supplier-list').querySelectorAll<HTMLElement>('.combobox-option')
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      supplierActiveIdx = Math.min(supplierActiveIdx + 1, options.length - 1)
      renderSupplierList()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      supplierActiveIdx = Math.max(supplierActiveIdx - 1, 0)
      renderSupplierList()
    } else if (e.key === 'Enter' && supplierActiveIdx >= 0) {
      e.preventDefault()
      options[supplierActiveIdx]?.dispatchEvent(new MouseEvent('mousedown'))
    } else if (e.key === 'Escape') {
      closeSupplierList()
    }
  })

  $('btn-add-line').addEventListener('click', () => {
    const p = productById(Number(select('rec-product-select').value))
    if (!p) { showToast('กรุณาเลือกสินค้า', true); return }
    const unit = p.units.find((u) => u.unitId === Number(select('rec-unit-select').value))
    if (!unit) { showToast('กรุณาเลือกหน่วยที่รับ', true); return }
    const qty = parseFloat(input('rec-qty').value) || 0
    const cost = parseFloat(input('rec-cost').value) || 0
    if (qty <= 0) { showToast('กรุณาระบุจำนวนมากกว่าศูนย์', true); return }
    lines.push({
      productId: p.id,
      unitId: unit.unitId,
      barcode: p.barcode,
      desc: p.description,
      unitName: unit.name,
      qty,
      cost
    })
    renderLines()
  })

  $('btn-post-receiving').addEventListener('click', async () => {
    if (lines.length === 0) { showToast('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ', true); return }
    try {
      const result = await window.api.receiving.post({
        docDate: input('rec-date').value || todayIso(),
        supplierId: selectedSupplierId,
        supplierName: input('rec-supplier-input').value.trim(),
        locationId: Number(select('rec-location').value),
        notes: input('rec-notes').value,
        lines: lines.map((l) => ({ productId: l.productId, unitId: l.unitId, qty: l.qty, unitCost: l.cost }))
      })
      lines.length = 0
      input('rec-supplier-input').value = ''
      input('rec-notes').value = ''
      selectedSupplierId = null
      renderLines()
      await refreshAfterPost()
      await refreshReceivingDocNumber()
      state.suppliers = await window.api.lookups.suppliers()
      showToast(`บันทึกเอกสารรับสินค้า ${result.docNumber} แล้ว — ปรับปรุงสต๊อกเรียบร้อย`)
    } catch (err) {
      toastError(err)
    }
  })

  renderLines()
}
