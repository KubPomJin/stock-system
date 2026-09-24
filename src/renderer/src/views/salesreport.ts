// ขายหน้าร้าน — สรุปยอดขาย
//
// Answers the two questions the owner asked for: which months sell best, and
// what customers want in each month. Month table → click a month for its best
// sellers → click a product for its month-by-month trend across the year.

import { $, baht, esc, select } from '../format'
import { toastError } from '../ui'
import type { MonthlyRow, ProductSalesRow } from '../../../shared/types'
import { THAI_MONTHS, money, qtyText } from './salesCommon'

let year = new Date().getFullYear()
let months: MonthlyRow[] = []
let selectedMonth: number | null = null // null = whole year
let topRows: ProductSalesRow[] = []
let selectedKey: string | null = null

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function monthRange(y: number, m: number | null): { from: string; to: string } {
  if (m == null) return { from: `${y}-01-01`, to: `${y}-12-31` }
  const last = new Date(y, m, 0).getDate()
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` }
}

function qtyCell(q: { unit: string; qty: number }[]): string {
  return q.length ? q.map((x) => `${qtyText(x.qty)} ${esc(x.unit === '-' ? '' : x.unit)}`).join(' · ') : '—'
}

function bar(value: number, max: number): string {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 1 : 0) : 0
  return `<div class="sr-bar" style="width:${pct.toFixed(1)}%"></div>`
}

export async function renderSalesReport(): Promise<void> {
  try {
    const years = await window.api.sales.years()
    if (!years.includes(year)) year = years[0] ?? year
    select('sr-year').innerHTML = years
      .map((y) => `<option value="${y}"${y === year ? ' selected' : ''}>ปี ${y + 543}</option>`)
      .join('')
    months = await window.api.sales.monthly(year)
  } catch (err) {
    toastError(err)
    return
  }
  renderMonths()
  await renderTop()
}

function renderMonths(): void {
  const total = months.reduce(
    (a, m) => ({
      bills: a.bills + m.billCount,
      sales: a.sales + m.grandTotal,
      cash: a.cash + m.cashTotal,
      transfer: a.transfer + m.transferTotal,
      credit: a.credit + m.creditTotal
    }),
    { bills: 0, sales: 0, cash: 0, transfer: 0, credit: 0 }
  )
  const active = months.filter((m) => m.billCount > 0)
  const best = [...active].sort((a, b) => b.grandTotal - a.grandTotal)[0]
  const kpi = (label: string, value: string, sub = ''): string =>
    `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value" style="font-size:22px;">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`
  $('sr-kpis').innerHTML =
    kpi(`ยอดขายทั้งปี ${year + 543}`, baht(total.sales), `${total.bills.toLocaleString('th-TH')} บิล`) +
    kpi('เฉลี่ยต่อเดือน', baht(active.length ? total.sales / active.length : 0), `จาก ${active.length} เดือนที่มีข้อมูล`) +
    kpi('เดือนที่ขายดีที่สุด', best ? THAI_MONTHS[best.month - 1] : '—', best ? baht(best.grandTotal) : '') +
    kpi('เฉลี่ยต่อบิล', baht(total.bills ? total.sales / total.bills : 0))

  const max = Math.max(...months.map((m) => m.grandTotal), 0)
  $('sr-month-body').innerHTML =
    months
      .map(
        (m) => `<tr class="sr-click${m.month === selectedMonth ? ' selected' : ''}" data-m="${m.month}">
          <td><b>${THAI_MONTHS[m.month - 1]}</b></td>
          <td class="num">${m.billCount || '—'}</td>
          <td class="num"><b>${m.billCount ? money(m.grandTotal) : '—'}</b></td>
          <td class="num">${m.cashTotal ? money(m.cashTotal) : '—'}</td>
          <td class="num">${m.transferTotal ? money(m.transferTotal) : '—'}</td>
          <td class="num">${m.creditTotal ? money(m.creditTotal) : '—'}</td>
          <td class="num">${m.billCount ? money(m.grandTotal / m.billCount) : '—'}</td>
          <td class="sr-bar-cell">${bar(m.grandTotal, max)}</td>
        </tr>`
      )
      .join('') +
    `<tr class="sr-total"><td><b>รวมทั้งปี</b></td><td class="num"><b>${total.bills}</b></td><td class="num"><b>${money(total.sales)}</b></td>
       <td class="num">${money(total.cash)}</td><td class="num">${money(total.transfer)}</td><td class="num">${money(total.credit)}</td>
       <td class="num">${total.bills ? money(total.sales / total.bills) : '—'}</td><td></td></tr>`

  $('sr-month-body')
    .querySelectorAll<HTMLTableRowElement>('tr.sr-click')
    .forEach((tr) =>
      tr.addEventListener('click', () => {
        const m = Number(tr.dataset.m)
        selectedMonth = selectedMonth === m ? null : m
        renderMonths()
        void renderTop()
      })
    )
}

async function renderTop(): Promise<void> {
  const r = monthRange(year, selectedMonth)
  $('sr-top-title').textContent =
    selectedMonth == null
      ? `สินค้าขายดี ทั้งปี ${year + 543}`
      : `สินค้าขายดี เดือน${THAI_MONTHS[selectedMonth - 1]} ${year + 543}`
  try {
    topRows = await window.api.sales.topProducts({ dateFrom: r.from, dateTo: r.to, limit: 50 })
  } catch (err) {
    toastError(err)
    return
  }
  const periodTotal =
    selectedMonth == null
      ? months.reduce((s, m) => s + m.grandTotal, 0)
      : (months.find((m) => m.month === selectedMonth)?.grandTotal ?? 0)
  $('sr-top-body').innerHTML = topRows.length
    ? topRows
        .map(
          (p, i) => `<tr class="sr-click${p.key === selectedKey ? ' selected' : ''}" data-k="${esc(p.key)}">
            <td class="num">${i + 1}</td>
            <td>${esc(p.description)}${p.barcode ? `<div class="pl-tag mono">${esc(p.barcode)}</div>` : p.productId ? '' : '<div class="pl-tag free">พิมพ์เอง (ไม่อยู่ในรายการสินค้า)</div>'}</td>
            <td>${qtyCell(p.qtyByUnit)}</td>
            <td class="num">${p.billCount}</td>
            <td class="num"><b>${money(p.amount)}</b></td>
            <td class="num">${periodTotal > 0 ? ((p.amount / periodTotal) * 100).toFixed(1) + '%' : '—'}</td>
          </tr>`
        )
        .join('')
    : `<tr><td colspan="6"><div class="empty-state"><i class="ti ti-chart-bar-off"></i>ยังไม่มียอดขายในช่วงนี้</div></td></tr>`

  $('sr-top-body')
    .querySelectorAll<HTMLTableRowElement>('tr.sr-click')
    .forEach((tr) => tr.addEventListener('click', () => void showTrend(tr.dataset.k as string)))
}

async function showTrend(key: string): Promise<void> {
  selectedKey = key
  $('sr-top-body')
    .querySelectorAll<HTMLTableRowElement>('tr.sr-click')
    .forEach((tr) => tr.classList.toggle('selected', tr.dataset.k === key))
  const p = topRows.find((x) => x.key === key)
  try {
    const trend = await window.api.sales.productTrend({ year, key })
    const max = Math.max(...trend.map((t) => t.amount), 0)
    $('sr-trend-title').textContent = `${p?.description ?? ''} — ปี ${year + 543}`
    $('sr-trend-body').innerHTML = trend
      .map(
        (t) => `<tr>
          <td><b>${THAI_MONTHS[t.month - 1]}</b></td>
          <td>${qtyCell(t.qtyByUnit)}</td>
          <td class="num">${t.billCount || '—'}</td>
          <td class="num">${t.amount ? money(t.amount) : '—'}</td>
          <td class="sr-bar-cell">${bar(t.amount, max)}</td>
        </tr>`
      )
      .join('')
    $('sr-trend-panel').style.display = ''
    $('sr-trend-panel').scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (err) {
    toastError(err)
  }
}

export function initSalesReport(): void {
  select('sr-year').addEventListener('change', () => {
    year = Number(select('sr-year').value)
    selectedMonth = null
    selectedKey = null
    $('sr-trend-panel').style.display = 'none'
    void renderSalesReport()
  })
  $('sr-btn-year').addEventListener('click', () => {
    selectedMonth = null
    renderMonths()
    void renderTop()
  })
}
