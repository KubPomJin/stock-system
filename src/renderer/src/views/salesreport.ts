// ขายหน้าร้าน — สรุปยอดขาย
//
// Answers the owner's questions: which months sell best, what customers want
// in each month, and (v1.6.8) what happened on each day. Month table → click a
// month for its calendar (darker = sold more), comparisons and best sellers →
// click a day for its bills → click a bill for every line on it. Click a
// product for its month-by-month trend across the year.

import { $, baht, esc, select } from '../format'
import { toastError } from '../ui'
import type { DailyRow, MonthlyRow, ProductSalesRow, SaleView } from '../../../shared/types'
import { openSaleForEdit } from './sales'
import {
  THAI_MONTHS,
  money,
  payLabel,
  qtyText,
  sheetsLabel,
  splitText,
  thaiDate,
  thaiDateTime,
  todayIso,
  transferBadge
} from './salesCommon'

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']
const WEEKDAY_NAMES = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']

let year = new Date().getFullYear()
let months: MonthlyRow[] = []
let selectedMonth: number | null = null // null = whole year
let topRows: ProductSalesRow[] = []
let selectedKey: string | null = null
let daily: DailyRow[] = []
let selectedDay: string | null = null
let openedBillId: number | null = null
let firstOpen = true
let goToView: (view: string) => void = () => {}

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

function kpi(label: string, value: string, sub = ''): string {
  return `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value" style="font-size:22px;">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`
}

// "▲ 12.5%" / "▼ 3.0%" against an earlier figure ('' when there is nothing to compare).
function change(now: number, before: number): string {
  if (!(before > 0)) return ''
  const pct = ((now - before) / before) * 100
  if (Math.abs(pct) < 0.05) return '<span class="sr-chg">เท่าเดิม</span>'
  return `<span class="sr-chg ${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</span>`
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
  // First visit: open straight onto this month's calendar.
  if (firstOpen) {
    firstOpen = false
    const now = new Date()
    if (year === now.getFullYear()) selectedMonth = now.getMonth() + 1
  }
  renderMonths()
  await Promise.all([renderTop(), renderMonthDetail()])
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
  $('sr-kpis').innerHTML =
    kpi(`ยอดขายทั้งปี ${year + 543}`, baht(total.sales), `${total.bills.toLocaleString('th-TH')} บิล`) +
    kpi('เฉลี่ยต่อเดือน', baht(active.length ? total.sales / active.length : 0), `จาก ${active.length} เดือนที่มีข้อมูล`) +
    kpi('เดือนที่ขายดีที่สุด', best ? THAI_MONTHS[best.month - 1] : '—', best ? baht(best.grandTotal) : '') +
    kpi('เฉลี่ยต่อบิล', baht(total.bills ? total.sales / total.bills : 0))

  const max = Math.max(...months.map((m) => m.grandTotal), 0)
  $('sr-month-body').innerHTML =
    months
      .map((m, i) => {
        const prev = i > 0 ? months[i - 1] : null
        return `<tr class="sr-click${m.month === selectedMonth ? ' selected' : ''}" data-m="${m.month}">
          <td><b>${THAI_MONTHS[m.month - 1]}</b></td>
          <td class="num">${m.billCount || '—'}</td>
          <td class="num"><b>${m.billCount ? money(m.grandTotal) : '—'}</b></td>
          <td class="num">${m.billCount && prev ? change(m.grandTotal, prev.grandTotal) : ''}</td>
          <td class="num">${m.cashTotal ? money(m.cashTotal) : '—'}</td>
          <td class="num">${m.transferTotal ? money(m.transferTotal) : '—'}</td>
          <td class="num">${m.creditTotal ? money(m.creditTotal) : '—'}</td>
          <td class="num">${m.billCount ? money(m.grandTotal / m.billCount) : '—'}</td>
          <td class="sr-bar-cell">${bar(m.grandTotal, max)}</td>
        </tr>`
      })
      .join('') +
    `<tr class="sr-total"><td><b>รวมทั้งปี</b></td><td class="num"><b>${total.bills}</b></td><td class="num"><b>${money(total.sales)}</b></td><td></td>
       <td class="num">${money(total.cash)}</td><td class="num">${money(total.transfer)}</td><td class="num">${money(total.credit)}</td>
       <td class="num">${total.bills ? money(total.sales / total.bills) : '—'}</td><td></td></tr>`

  $('sr-month-body')
    .querySelectorAll<HTMLTableRowElement>('tr.sr-click')
    .forEach((tr) =>
      tr.addEventListener('click', () => {
        const m = Number(tr.dataset.m)
        selectedMonth = selectedMonth === m ? null : m
        selectedDay = null
        renderMonths()
        void renderTop()
        void renderMonthDetail()
      })
    )
}

/* ---------- one month: comparisons, calendar, weekdays ---------- */

async function renderMonthDetail(): Promise<void> {
  const panel = $('sr-day-panel')
  if (selectedMonth == null) {
    panel.style.display = 'none'
    $('sr-bills-panel').style.display = 'none'
    return
  }
  const m = selectedMonth
  const y = year
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 }
  let prevDaily: DailyRow[]
  try {
    ;[daily, prevDaily] = await Promise.all([
      window.api.sales.daily({ year: y, month: m }),
      window.api.sales.daily({ year: prev.y, month: prev.m })
    ])
  } catch (err) {
    toastError(err)
    return
  }
  panel.style.display = ''
  $('sr-cal-title').textContent = `ยอดขายรายวัน — ${THAI_MONTHS[m - 1]} ${y + 543}`

  // ---- comparisons ----
  const today = todayIso()
  const monthKey = `${y}-${pad(m)}`
  const isCurrent = today.startsWith(monthKey)
  // A month still in progress is compared with the SAME days of last month,
  // otherwise half a month always looks like a slump.
  const cutoff = isCurrent ? Number(today.slice(8, 10)) : daily.length
  const sumTo = (rows: DailyRow[], n: number): number =>
    rows.filter((d) => Number(d.date.slice(8, 10)) <= n).reduce((s, d) => s + d.grandTotal, 0)
  const total = daily.reduce((s, d) => s + d.grandTotal, 0)
  const bills = daily.reduce((s, d) => s + d.billCount, 0)
  const nowPart = sumTo(daily, cutoff)
  const prevPart = sumTo(prevDaily, cutoff)
  const activeDays = daily.filter((d) => d.billCount > 0)
  const bestDay = [...activeDays].sort((a, b) => b.grandTotal - a.grandTotal)[0]
  const prevLabel = isCurrent
    ? `เทียบ 1–${cutoff} ${THAI_MONTHS[prev.m - 1]}`
    : `เทียบทั้งเดือน${THAI_MONTHS[prev.m - 1]}`
  $('sr-month-kpis').innerHTML =
    kpi(`ยอดขาย${THAI_MONTHS[m - 1]}${isCurrent ? ' (ถึงวันนี้)' : ''}`, baht(total), `${bills.toLocaleString('th-TH')} บิล`) +
    kpi(prevLabel, prevPart > 0 ? change(nowPart, prevPart) || '—' : '—', prevPart > 0 ? `เดือนก่อน ${money(prevPart)} → ตอนนี้ ${money(nowPart)}` : 'เดือนก่อนยังไม่มีข้อมูล') +
    kpi('เฉลี่ยต่อวันที่มีขาย', baht(activeDays.length ? total / activeDays.length : 0), `ขาย ${activeDays.length} วัน`) +
    kpi('วันที่ขายดีที่สุด', bestDay ? thaiDate(bestDay.date) : '—', bestDay ? `${WEEKDAY_NAMES[new Date(bestDay.date + 'T00:00').getDay()]} · ${baht(bestDay.grandTotal)}` : '') +
    kpi('เฉลี่ยต่อบิล', baht(bills ? total / bills : 0))

  renderCalendar(y, m, today)
  renderWeekdays()

  if (selectedDay && selectedDay.startsWith(monthKey)) await renderDayBills(selectedDay)
  else $('sr-bills-panel').style.display = 'none'
}

function renderCalendar(y: number, m: number, today: string): void {
  const max = Math.max(...daily.map((d) => d.grandTotal), 0)
  const firstDow = new Date(y, m - 1, 1).getDay()
  let html = WEEKDAYS.map((w) => `<div class="sr-cal-h">${w}</div>`).join('')
  html += '<div class="sr-day blank"></div>'.repeat(firstDow)
  for (const d of daily) {
    const lvl = max > 0 && d.grandTotal > 0 ? 0.12 + 0.68 * (d.grandTotal / max) : 0
    const cls = [
      'sr-day',
      d.date === today ? 'today' : '',
      d.date > today ? 'future' : '',
      d.date === selectedDay ? 'selected' : '',
      lvl > 0.55 ? 'hot' : ''
    ]
      .filter(Boolean)
      .join(' ')
    html += `<button type="button" class="${cls}" data-d="${d.date}" style="--lvl:${lvl.toFixed(3)}"
        title="${thaiDate(d.date)} · ${d.billCount} บิล · ${money(d.grandTotal)}">
      <span class="sr-dnum">${Number(d.date.slice(8, 10))}</span>
      ${d.billCount ? `<span class="sr-damt">${Math.round(d.grandTotal).toLocaleString('th-TH')}</span><span class="sr-dbills">${d.billCount} บิล</span>` : ''}
    </button>`
  }
  $('sr-cal').innerHTML = html
  $('sr-cal')
    .querySelectorAll<HTMLButtonElement>('.sr-day[data-d]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        if (b.classList.contains('future')) return
        void renderDayBills(b.dataset.d as string)
      })
    )
}

// Which day of the week sells best — averaged over the days that had sales,
// so closed days don't drag a weekday down.
function renderWeekdays(): void {
  const sum = Array(7).fill(0) as number[]
  const cnt = Array(7).fill(0) as number[]
  for (const d of daily) {
    if (!d.billCount) continue
    const w = new Date(d.date + 'T00:00').getDay()
    sum[w] += d.grandTotal
    cnt[w]++
  }
  const avg = sum.map((s, i) => (cnt[i] ? s / cnt[i] : 0))
  const max = Math.max(...avg, 0)
  const best = max > 0 ? avg.indexOf(max) : -1
  $('sr-week').innerHTML =
    `<h3>ขายดีวันไหนของสัปดาห์</h3><div class="field-hint">เฉลี่ยต่อวันที่มีขาย ในเดือนนี้</div>` +
    [1, 2, 3, 4, 5, 6, 0]
      .map(
        (w) => `<div class="sr-wk-row${w === best ? ' best' : ''}">
          <b>${WEEKDAYS[w]}</b>${bar(avg[w], max)}
          <span>${cnt[w] ? `<b>${Math.round(avg[w]).toLocaleString('th-TH')}</b> <span class="text-muted">(${cnt[w]} วัน)</span>` : '<span class="text-muted">—</span>'}</span>
        </div>`
      )
      .join('') +
    (best >= 0 ? `<div class="field-hint" style="margin-top:10px;">วัน${WEEKDAY_NAMES[best]}ขายได้เฉลี่ยมากที่สุด</div>` : '')
}

/* ---------- one day: its bills ---------- */

async function renderDayBills(date: string): Promise<void> {
  selectedDay = date
  $('sr-cal')
    .querySelectorAll<HTMLElement>('.sr-day[data-d]')
    .forEach((el) => el.classList.toggle('selected', el.dataset.d === date))
  let bills: SaleView[]
  try {
    bills = await window.api.sales.list({ dateFrom: date, dateTo: date, includeVoided: true, limit: 500 })
  } catch (err) {
    toastError(err)
    return
  }
  bills.sort((a, b) => (a.docTime ?? '').localeCompare(b.docTime ?? '') || a.createdAt.localeCompare(b.createdAt))
  const live = bills.filter((b) => !b.voided)
  const total = live.reduce((s, b) => s + b.grandTotal, 0)
  $('sr-bills-title').textContent = `บิลของวัน${WEEKDAY_NAMES[new Date(date + 'T00:00').getDay()]}ที่ ${thaiDate(date)} — ${live.length} บิล · รวม ${money(total)}`
  $('sr-bills-body').innerHTML = bills.length
    ? bills
        .map(
          (s) => `<tr class="sr-click${s.voided ? ' is-void' : ''}" data-id="${s.id}">
            <td>${esc(s.docTime || thaiDateTime(s.createdAt).split(' ').pop() || '')}</td>
            <td class="mono"><b>${esc(s.docNumber)}</b>${s.noTicket ? ' <span class="badge muted">ไม่มีใบ</span>' : ''}${
              s.sheetCount > 1 ? `<div class="pl-tag no-strike">${esc(sheetsLabel(s))}</div>` : ''
            }${s.voided ? `<div class="pl-tag no-strike" style="color:var(--danger);">ยกเลิก: ${esc(s.voidReason ?? '')}</div>` : ''}</td>
            <td>${esc(s.customerName ?? '')}</td>
            <td class="num">${s.lineCount}</td>
            <td class="num"><b>${money(s.grandTotal)}</b></td>
            <td>${esc(payLabel(s.paymentMethod))}<div class="pl-tag">${esc(splitText(s))}</div></td>
          </tr>`
        )
        .join('')
    : `<tr><td colspan="6"><div class="empty-state"><i class="ti ti-receipt-off"></i>ไม่มีบิลในวันนี้</div></td></tr>`
  $('sr-bills-body')
    .querySelectorAll<HTMLTableRowElement>('tr[data-id]')
    .forEach((tr) => tr.addEventListener('click', () => void openBill(Number(tr.dataset.id))))
  $('sr-bills-panel').style.display = ''
  $('sr-bills-panel').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/* ---------- one bill: every line ---------- */

async function openBill(id: number): Promise<void> {
  let data
  try {
    data = await window.api.sales.get(id)
  } catch (err) {
    toastError(err)
    return
  }
  const { sale: s, lines, sheets } = data
  openedBillId = s.id
  $('sr-bill-title').textContent = `บิล ${s.docNumber}${s.voided ? ' (ยกเลิกแล้ว)' : ''}`
  const meta: [string, string][] = [
    ['วันที่', `${thaiDate(s.docDate)}${s.docTime ? ` เวลา ${esc(s.docTime)}` : ''}`],
    ['ลูกค้า', esc(s.customerName || '—') + (s.customerContact ? ` · ${esc(s.customerContact)}` : '')],
    ['ชำระ', `${esc(payLabel(s.paymentMethod))} · ${esc(splitText(s))}`],
    ['ผู้คีย์', `${esc(s.createdBy ?? '')} · ${thaiDateTime(s.createdAt)}`]
  ]
  if (s.sheetCount > 1) meta.push(['ใบที่ใช้', esc(sheetsLabel(s))])
  if (s.transferAmount) {
    meta.push(['เงินโอน', `${money(s.transferAmount)}${s.transferTime ? ` · เวลา ${esc(s.transferTime)}` : ''}${s.transferRef ? ` · ${esc(s.transferRef)}` : ''} ${transferBadge(s.transferStatus)}`])
  }
  if (s.note) meta.push(['หมายเหตุ', esc(s.note)])
  if (s.voided) meta.push(['ยกเลิก', esc(s.voidReason ?? '')])
  $('sr-bill-meta').innerHTML = meta.map(([k, v]) => `<div><span>${k}:</span> ${v}</div>`).join('')

  // Lines, ticket by ticket when the sale ran over several paper tickets.
  const sheetName = (n: number): string =>
    n === 1 ? (s.noTicket ? 'ไม่มีเลข' : s.docNumber) : (sheets.find((x) => x.sheetNo === n)?.docNumber ?? 'ไม่มีเลข')
  let html = ''
  let sold = 0
  let returned = 0
  for (let n = 1; n <= s.sheetCount; n++) {
    const own = lines.filter((l) => (l.sheet || 1) === n)
    if (s.sheetCount > 1) html += `<tr class="sr-sheet"><td colspan="6">ใบที่ ${n} · ${esc(sheetName(n))}</td></tr>`
    own.forEach((l, k) => {
      const amt = l.amount ?? (l.qty ?? 0) * (l.unitPrice ?? 0)
      if (l.isReturn) returned += -amt
      else sold += amt
      html += `<tr${l.isReturn ? ' class="sr-ret"' : ''}>
        <td class="num">${k + 1}</td>
        <td>${l.isReturn ? '<b>↩ คืน</b> ' : ''}${esc(l.description)}${l.note ? `<div class="pl-tag">${esc(l.note)}</div>` : ''}</td>
        <td class="num">${qtyText(Math.abs(l.qty ?? 0))}</td>
        <td>${esc(l.unitName ?? '')}</td>
        <td class="num">${l.unitPrice != null ? money(l.unitPrice) : ''}</td>
        <td class="num"><b>${l.isReturn ? '−' + money(-amt) : money(amt)}</b></td>
      </tr>`
    })
  }
  $('sr-bill-lines').innerHTML = html || '<tr><td colspan="6">ไม่มีรายการ</td></tr>'
  const row = (label: string, v: string, cls = ''): string => `<div class="${cls}">${label} <b class="mono">${v}</b></div>`
  $('sr-bill-totals').innerHTML =
    row('รวมค่าสินค้า', money(sold)) +
    (returned ? row('หักของที่คืน', '−' + money(returned)) : '') +
    (s.deliveryFee ? row('ค่าจัดส่ง', money(s.deliveryFee)) : '') +
    (s.discount ? row('ส่วนลด / ปัดเศษ', '−' + money(s.discount)) : '') +
    row(s.grandTotal < 0 ? 'คืนเงินลูกค้า' : 'รวมเป็นเงิน', baht(Math.abs(s.grandTotal)), 'grand')
  ;($('sr-bill-edit') as HTMLButtonElement).style.display = s.voided ? 'none' : ''
  $('sr-bill-hint').textContent = s.voided ? 'บิลที่ยกเลิกแล้วแก้ไขไม่ได้' : ''
  $('sr-bill-modal').classList.add('active')
}

function closeBill(): void {
  $('sr-bill-modal').classList.remove('active')
}

/* ---------- best sellers + product trend ---------- */

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

// Step the calendar a month back / forward, crossing into the next year.
async function stepMonth(delta: number): Promise<void> {
  if (selectedMonth == null) return
  let m = selectedMonth + delta
  let y = year
  if (m < 1) {
    m = 12
    y--
  } else if (m > 12) {
    m = 1
    y++
  }
  selectedDay = null
  selectedMonth = m
  if (y !== year) {
    year = y
    await renderSalesReport()
    return
  }
  renderMonths()
  await Promise.all([renderTop(), renderMonthDetail()])
}

export function initSalesReport(navigate: (view: string) => void): void {
  goToView = navigate
  select('sr-year').addEventListener('change', () => {
    year = Number(select('sr-year').value)
    selectedMonth = null
    selectedKey = null
    selectedDay = null
    $('sr-trend-panel').style.display = 'none'
    void renderSalesReport()
  })
  $('sr-btn-year').addEventListener('click', () => {
    selectedMonth = null
    selectedDay = null
    renderMonths()
    void renderTop()
    void renderMonthDetail()
  })
  $('sr-prev-month').addEventListener('click', () => void stepMonth(-1))
  $('sr-next-month').addEventListener('click', () => void stepMonth(1))
  $('sr-bill-close').addEventListener('click', closeBill)
  $('sr-bill-ok').addEventListener('click', closeBill)
  $('sr-bill-edit').addEventListener('click', () => {
    const id = openedBillId
    if (id == null) return
    closeBill()
    goToView('sales')
    void openSaleForEdit(id)
  })
}
