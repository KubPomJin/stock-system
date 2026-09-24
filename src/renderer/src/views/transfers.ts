// ขายหน้าร้าน — ตรวจยอดโอน
//
// Transfers can't be checked at the counter: someone has to open the bank
// statement later and tick off each one. This page is that checklist — it keeps
// every unchecked transfer across all days until it is ticked, so nothing gets
// forgotten just because the day was closed.

import { $, baht, esc, input } from '../format'
import { showToast, toastError } from '../ui'
import type { SaleView, TransferStatus } from '../../../shared/types'
import { money, thaiDate, thaiDateTime, transferBadge } from './salesCommon'

type StatusFilter = TransferStatus | 'ALL'

const STATUS_CHIPS: { value: StatusFilter; label: string }[] = [
  { value: 'PENDING', label: 'รอตรวจ' },
  { value: 'NOT_FOUND', label: 'ไม่พบยอด' },
  { value: 'VERIFIED', label: 'พบยอดแล้ว' },
  { value: 'ALL', label: 'ทั้งหมด' }
]

let status: StatusFilter = 'PENDING'
let rows: SaleView[] = []
const selected = new Set<number>()

function renderChips(): void {
  $('tr-status-chips').innerHTML = STATUS_CHIPS.map(
    (c) => `<button class="chip${c.value === status ? ' active' : ''}" data-v="${c.value}">${c.label}</button>`
  ).join('')
  $('tr-status-chips')
    .querySelectorAll<HTMLButtonElement>('.chip')
    .forEach((b) =>
      b.addEventListener('click', () => {
        status = b.dataset.v as StatusFilter
        renderChips()
        void renderTransfers()
      })
    )
}

export async function renderTransfers(): Promise<void> {
  try {
    rows = await window.api.sales.transfers({
      transferStatus: status,
      dateFrom: input('tr-from').value || undefined,
      dateTo: input('tr-to').value || undefined,
      search: input('tr-search').value || undefined,
      limit: 2000
    })
  } catch (err) {
    toastError(err)
    return
  }
  for (const id of [...selected]) if (!rows.some((r) => r.id === id)) selected.delete(id)

  const total = rows.reduce((s, r) => s + r.transferAmount, 0)
  $('tr-count').textContent = `${rows.length} บิล · รวม ${baht(total)}`

  // Rows grouped by day with a subtotal — bank statements are read day by day.
  let html = ''
  let lastDay = ''
  for (const r of rows) {
    if (r.docDate !== lastDay) {
      lastDay = r.docDate
      const dayRows = rows.filter((x) => x.docDate === r.docDate)
      const dayTotal = dayRows.reduce((s, x) => s + x.transferAmount, 0)
      html += `<tr class="tr-day"><td colspan="9"><b>${thaiDate(r.docDate)}</b> · ${dayRows.length} บิล · รวม ${money(dayTotal)}</td></tr>`
    }
    html += `<tr>
      <td><input type="checkbox" class="tr-check" data-id="${r.id}"${selected.has(r.id) ? ' checked' : ''}></td>
      <td>${thaiDate(r.docDate)} ${esc(r.docTime ?? '')}</td>
      <td class="mono"><b>${esc(r.docNumber)}</b></td>
      <td>${esc(r.customerName ?? '')}</td>
      <td class="num"><b>${money(r.transferAmount)}</b>${r.paymentMethod === 'MIXED' ? '<div class="pl-tag">(จ่ายสด+โอน)</div>' : ''}</td>
      <td>${esc(r.transferRef ?? '')}</td>
      <td>${transferBadge(r.transferStatus)}</td>
      <td style="font-size:13px;">${r.transferVerifiedBy ? `${esc(r.transferVerifiedBy)}<div class="pl-tag">${thaiDateTime(r.transferVerifiedAt)}</div>` : ''}</td>
      <td style="font-size:13px;">${esc(r.transferNote ?? '')}</td>
    </tr>`
  }
  $('tr-body').innerHTML =
    html ||
    `<tr><td colspan="9"><div class="empty-state"><i class="ti ti-checks"></i>${
      status === 'PENDING' ? 'ไม่มีบิลโอนที่รอตรวจ' : 'ไม่พบบิลโอนตามเงื่อนไข'
    }</div></td></tr>`

  $('tr-body')
    .querySelectorAll<HTMLInputElement>('.tr-check')
    .forEach((cb) =>
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.id)
        if (cb.checked) selected.add(id)
        else selected.delete(id)
        renderSelection()
      })
    )
  renderSelection()
}

function renderSelection(): void {
  const picked = rows.filter((r) => selected.has(r.id))
  const sum = picked.reduce((s, r) => s + r.transferAmount, 0)
  // The running sum is what gets compared with the bank's own total.
  $('tr-selected').innerHTML = picked.length
    ? `เลือก <b>${picked.length}</b> บิล · รวม <b class="mono">${baht(sum)}</b>`
    : 'ยังไม่ได้เลือก — ติ๊กบิลที่ตรงกับยอดในบัญชี'
  ;(document.getElementById('tr-check-all') as HTMLInputElement).checked =
    rows.length > 0 && picked.length === rows.length
  for (const id of ['tr-btn-verify', 'tr-btn-notfound', 'tr-btn-pending']) {
    ;($(id) as HTMLButtonElement).disabled = picked.length === 0
  }
}

async function mark(next: TransferStatus): Promise<void> {
  const ids = [...selected]
  if (!ids.length) return
  try {
    const res = await window.api.sales.setTransferStatus({ ids, status: next, note: input('tr-note').value })
    selected.clear()
    input('tr-note').value = ''
    await renderTransfers()
    const label = next === 'VERIFIED' ? 'พบยอดแล้ว' : next === 'NOT_FOUND' ? 'ไม่พบยอด' : 'รอตรวจ'
    showToast(`เปลี่ยนสถานะเป็น "${label}" แล้ว ${res.changed} บิล`)
  } catch (err) {
    toastError(err)
  }
}

export function initTransfers(): void {
  renderChips()
  for (const id of ['tr-from', 'tr-to']) input(id).addEventListener('change', () => void renderTransfers())
  let t: ReturnType<typeof setTimeout> | undefined
  input('tr-search').addEventListener('input', () => {
    if (t) clearTimeout(t)
    t = setTimeout(() => void renderTransfers(), 250)
  })
  ;(document.getElementById('tr-check-all') as HTMLInputElement).addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked
    selected.clear()
    if (on) for (const r of rows) selected.add(r.id)
    $('tr-body')
      .querySelectorAll<HTMLInputElement>('.tr-check')
      .forEach((cb) => (cb.checked = on))
    renderSelection()
  })
  $('tr-btn-verify').addEventListener('click', () => void mark('VERIFIED'))
  $('tr-btn-notfound').addEventListener('click', () => void mark('NOT_FOUND'))
  $('tr-btn-pending').addEventListener('click', () => void mark('PENDING'))
}
