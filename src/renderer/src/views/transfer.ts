import { $, esc, formatStock, input, select } from '../format'
import { productById, state } from '../state'
import { showToast, toastError } from '../ui'

interface TransferLine {
  productId: number
  unitId: number
  barcode: string
  desc: string
  unitName: string
  qty: number
  qtyBase: number
}

const lines: TransferLine[] = []
let refreshAfterPost: () => Promise<void> = async () => {}

export async function refreshTransferDocNumber(): Promise<void> {
  try {
    input('transfer-doc-number').value = await window.api.transfer.nextDocNumber()
  } catch {
    input('transfer-doc-number').value = ''
  }
}

export function renderTransferSelectors(): void {
  const fromSel = select('transfer-from')
  const toSel = select('transfer-to')
  const currentFrom = fromSel.value
  const currentTo = toSel.value
  const options = state.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')
  fromSel.innerHTML = options
  toSel.innerHTML = options
  if (state.locations.length >= 2) {
    fromSel.value = currentFrom || String(state.locations[0].id)
    toSel.value =
      currentTo && currentTo !== fromSel.value
        ? currentTo
        : String(state.locations.find((l) => String(l.id) !== fromSel.value)?.id ?? state.locations[1].id)
  }

  const sel = select('transfer-product-select')
  sel.innerHTML = state.products
    .map((p) => `<option value="${p.id}">${esc(p.barcode)} — ${esc(p.description)}</option>`)
    .join('')
  refreshUnitOptions()
  renderLines()
}

function refreshUnitOptions(): void {
  const p = productById(Number(select('transfer-product-select').value))
  const unitSel = select('transfer-unit-select')
  if (!p) {
    unitSel.innerHTML = ''
    updateHint()
    return
  }
  const base = p.units[p.units.length - 1]
  unitSel.innerHTML = p.units
    .map(
      (u) =>
        `<option value="${u.unitId}">${esc(u.name)}${u.qtyPerBase > 1 ? ` (1 ${esc(u.name)} = ${u.qtyPerBase} ${esc(base.name)})` : ''}</option>`
    )
    .join('')
  updateHint()
}

function updateHint(): void {
  const p = productById(Number(select('transfer-product-select').value))
  const fromId = Number(select('transfer-from').value)
  const fromName = state.locations.find((l) => l.id === fromId)?.name ?? ''
  if (!p) {
    $('transfer-available-hint').textContent = ''
    return
  }
  const available = p.stockByLocation[fromId] ?? 0
  $('transfer-available-hint').textContent = `คงเหลือที่ "${fromName}" ตอนนี้: ${formatStock(available, p.units)}`
}

function renderLines(): void {
  const fromId = Number(select('transfer-from').value)
  const body = $('transfer-lines-body')
  // running deduction per product so "remaining after transfer" reflects stacked lines
  const deducted: Record<number, number> = {}
  if (lines.length === 0) {
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><i class="ti ti-package"></i>ยังไม่มีรายการ — เพิ่มรายการด้านบน</div></td></tr>`
  } else {
    body.innerHTML = lines
      .map((l, i) => {
        const p = productById(l.productId)
        if (!p) return ''
        deducted[l.productId] = (deducted[l.productId] ?? 0) + l.qtyBase
        const remaining = (p.stockByLocation[fromId] ?? 0) - deducted[l.productId]
        const remainStyle = remaining < 0 ? 'style="color:var(--danger);font-weight:600;"' : ''
        return `<tr>
        <td class="mono">${esc(l.barcode)}</td>
        <td>${esc(l.desc)}</td>
        <td>${esc(l.unitName)}</td>
        <td class="num">${l.qty}</td>
        <td ${remainStyle}>${formatStock(remaining, p.units)}${remaining < 0 ? ' (ไม่พอ!)' : ''}</td>
        <td><button class="icon-btn trf-remove" data-idx="${i}"><i class="ti ti-trash"></i></button></td>
      </tr>`
      })
      .join('')
    body.querySelectorAll<HTMLButtonElement>('.trf-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        lines.splice(Number(btn.dataset.idx), 1)
        renderLines()
      })
    })
  }
}

function keepDifferent(changed: 'from' | 'to'): void {
  const fromSel = select('transfer-from')
  const toSel = select('transfer-to')
  if (fromSel.value === toSel.value) {
    const other = state.locations.find((l) => String(l.id) !== fromSel.value)
    if (other) {
      if (changed === 'from') toSel.value = String(other.id)
      else fromSel.value = String(state.locations.find((l) => String(l.id) !== toSel.value)?.id ?? other.id)
    }
  }
}

export function initTransfer(refresh: () => Promise<void>): void {
  refreshAfterPost = refresh

  select('transfer-product-select').addEventListener('change', refreshUnitOptions)
  select('transfer-unit-select').addEventListener('change', updateHint)
  select('transfer-from').addEventListener('change', () => {
    keepDifferent('from')
    updateHint()
    renderLines()
  })
  select('transfer-to').addEventListener('change', () => {
    keepDifferent('to')
    updateHint()
    renderLines()
  })
  $('btn-swap-transfer').addEventListener('click', () => {
    const fromSel = select('transfer-from')
    const toSel = select('transfer-to')
    const tmp = fromSel.value
    fromSel.value = toSel.value
    toSel.value = tmp
    updateHint()
    renderLines()
  })

  $('btn-add-transfer-line').addEventListener('click', () => {
    const p = productById(Number(select('transfer-product-select').value))
    if (!p) { showToast('กรุณาเลือกสินค้า', true); return }
    const unit = p.units.find((u) => u.unitId === Number(select('transfer-unit-select').value))
    if (!unit) { showToast('กรุณาเลือกหน่วยที่เบิก', true); return }
    const qty = parseFloat(input('transfer-qty').value) || 0
    if (qty <= 0) { showToast('กรุณาระบุจำนวนมากกว่าศูนย์', true); return }
    lines.push({
      productId: p.id,
      unitId: unit.unitId,
      barcode: p.barcode,
      desc: p.description,
      unitName: unit.name,
      qty,
      qtyBase: qty * unit.qtyPerBase
    })
    renderLines()
  })

  $('btn-post-transfer').addEventListener('click', async () => {
    if (lines.length === 0) { showToast('กรุณาเพิ่มรายการที่จะเบิกอย่างน้อย 1 รายการ', true); return }
    const fromId = Number(select('transfer-from').value)
    const toId = Number(select('transfer-to').value)
    const fromName = state.locations.find((l) => l.id === fromId)?.name ?? ''
    const toName = state.locations.find((l) => l.id === toId)?.name ?? ''

    // Client-side pre-check for fast feedback; the main process re-validates
    // inside a transaction anyway (the authoritative check).
    const totals: Record<number, number> = {}
    for (const l of lines) totals[l.productId] = (totals[l.productId] ?? 0) + l.qtyBase
    for (const [id, needed] of Object.entries(totals)) {
      const p = productById(Number(id))
      if (p && (p.stockByLocation[fromId] ?? 0) < needed) {
        showToast(`สต๊อกที่ "${fromName}" ไม่พอสำหรับ ${p.description}`, true)
        return
      }
    }

    try {
      const result = await window.api.transfer.post({
        fromLocationId: fromId,
        toLocationId: toId,
        lines: lines.map((l) => ({ productId: l.productId, unitId: l.unitId, qty: l.qty }))
      })
      lines.length = 0
      await refreshAfterPost()
      await refreshTransferDocNumber()
      updateHint()
      showToast(`บันทึกการเบิกของ ${result.docNumber} แล้ว — โยกจาก "${fromName}" ไป "${toName}" เรียบร้อย`)
    } catch (err) {
      toastError(err)
    }
  })
}
