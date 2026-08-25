import { $, esc, statusBadge, stockCellHtml, stockStatus } from '../format'
import { level, state } from '../state'

function renderKpis(): void {
  const products = state.products
  ;$('kpi-total-skus').textContent = String(products.length)
  const catCount = new Set(products.map((p) => p.categoryName)).size
  $('kpi-total-skus-sub').textContent = `ใน ${catCount} หมวดหมู่`

  const lowCount = products.filter((p) => p.totalOnHand < p.minStock).length
  $('kpi-low-stock').textContent = String(lowCount)
  const zeroCount = products.filter((p) => p.totalOnHand === 0).length
  $('kpi-zero-stock').textContent = String(zeroCount)

  $('kpi-low-stock-card').className = 'kpi-card' + (lowCount > 0 ? ' alert-danger' : '')
  $('kpi-zero-stock-card').className = 'kpi-card' + (zeroCount > 0 ? ' alert-warn' : '')

  // Stock-value card: staff (level 1) never sees this card at all. The cost
  // field itself is already stripped at the IPC layer for level 1.
  const card = $('kpi-stock-value-card')
  if (level() >= 2) {
    card.style.display = ''
    const stockValue = products.reduce((sum, p) => sum + p.totalOnHand * (p.cost ?? 0), 0)
    card.innerHTML = `<div class="kpi-label">มูลค่าสต๊อก</div><div class="kpi-value">฿${Math.round(stockValue).toLocaleString('th-TH')}</div><div class="kpi-sub">ตามต้นทุนล่าสุด รวมทุกคลัง</div>`
  } else {
    card.style.display = 'none'
  }
}

function renderAlert(): void {
  const negative = state.products.filter((p) => p.totalOnHand < 0)
  const low = state.products.filter((p) => p.totalOnHand >= 0 && p.totalOnHand < p.minStock)
  const el = $('dashboard-alert')
  if (negative.length > 0) {
    el.innerHTML = `<div class="alert-banner danger">
      <i class="ti ti-alert-triangle-filled alert-icon"></i>
      <div class="alert-text"><b>เตือน:</b> มีสินค้า <b>${negative.length} รายการ</b> ที่สต๊อกติดลบ (ระบบบันทึกน้อยกว่าที่ควรจะเป็น) และอีก <b>${low.length} รายการ</b> ต่ำกว่าขั้นต่ำ — ควรตรวจสอบและสั่งซื้อโดยด่วน</div>
      <button class="alert-jump" id="btn-alert-jump">ดูรายการ</button>
    </div>`
  } else if (low.length > 0) {
    el.innerHTML = `<div class="alert-banner warn">
      <i class="ti ti-alert-circle-filled alert-icon"></i>
      <div class="alert-text">มีสินค้า <b>${low.length} รายการ</b> ต่ำกว่าสต๊อกขั้นต่ำ — ควรพิจารณาสั่งซื้อเพิ่ม</div>
      <button class="alert-jump" id="btn-alert-jump">ดูรายการ</button>
    </div>`
  } else {
    el.innerHTML = ''
  }
  document.getElementById('btn-alert-jump')?.addEventListener('click', () => {
    $('low-stock-body').scrollIntoView({ behavior: 'smooth' })
  })
}

export function renderDashboard(): void {
  const statusRank = { danger: 0, warn: 1, ok: 2 }
  const low = state.products
    .filter((p) => p.totalOnHand < p.minStock)
    .sort((a, b) => statusRank[stockStatus(a)] - statusRank[stockStatus(b)])

  $('low-stock-body').innerHTML =
    low
      .map((p) => {
        const s = stockStatus(p)
        return `<tr>
      <td>${statusBadge(s, true)}</td>
      <td class="mono">${esc(p.barcode)}</td>
      <td>${esc(p.description)}</td>
      <td>${stockCellHtml(p)}</td>
    </tr>`
      })
      .join('') ||
    `<tr><td colspan="4"><div class="empty-state"><i class="ti ti-circle-check-filled" style="color:var(--ok);opacity:1;"></i>ไม่มีสินค้าต่ำกว่าขั้นต่ำ ทุกอย่างปกติดี</div></td></tr>`

  renderAlert()
  renderKpis()
}
