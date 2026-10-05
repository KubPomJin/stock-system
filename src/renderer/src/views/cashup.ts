// ขายหน้าร้าน — ปิดยอดประจำวัน (daily cash-up)
//
// Count the drawer, compare it with what the keyed bills say should be there,
// save the result, and print an A4 sheet the owner signs. The A4 sheet lives in
// #cashup-print-area, a direct child of <body> (never inside the position:fixed
// preview dialog — that is what once caused an endless print job).

import { $, baht, esc, input, select } from '../format'
import { level } from '../state'
import { loadPrinters, runPrint, savePdf } from '../print'
import { showToast, toastError } from '../ui'
import type { CashCloseView, DaySummary } from '../../../shared/types'
import { money, payLabel, thaiDate, thaiDateTime, todayIso, transferBadge, TRANSFER_STATUS } from './salesCommon'

const DENOMS = [1000, 500, 100, 50, 20, 10, 5, 2, 1]
const PAGE_CSS = '@media print{@page{size:A4 portrait;margin:12mm;}}'
const PRINTER_KEY = 'printer.cashup' // A4
const PRINTER_KEY_FORM = 'printer.cashup.form' // order-ticket form
// Set on the order page (orders.ts) — the same printer and continuous paper.
const ORDER_PRINTER_KEY = 'printer.orderTicket'
const ORDER_PAPER_KEY = 'print.orderPaper'
const ORDER_MARGIN_KEY = 'print.orderMargins'
// This sheet's own paper width + margins on that form (falls back to the above).
const FORM_SETTINGS_KEY = 'print.cashupForm'
// A4 portrait with 12mm margins leaves 273mm of height per page.
const PRINTABLE_HEIGHT_MM = 273

// Which parts of the A4 sheet to print. Remembered per machine — the shop
// settles on one layout and keeps it. Off parts are kept in code, not deleted,
// so they can be switched back on later (the owner's request).
interface SheetOpts {
  // 'form' = the 9 x 5.5in order-ticket paper, printed portrait (owner's pick)
  paper: 'form' | 'a4'
  flip: boolean // turn the form 180deg if it comes out upside down
  summary: boolean
  cash: boolean
  cashMode: 'auto' | 'blank' // figures from the system, or empty boxes to write in
  denoms: boolean
  bills: boolean
  others: boolean
  note: boolean
  noteLines: number
  sign: boolean
}
const SHEET_KEY = 'cashup.sheet'
const DENOMS_KEY = 'cashup.useDenoms'
const DEFAULT_OPTS: SheetOpts = {
  paper: 'form',
  flip: false,
  summary: true,
  cash: true,
  cashMode: 'auto',
  denoms: false,
  bills: false,
  others: false,
  note: true,
  noteLines: 5,
  sign: true
}
type FlagKey = 'summary' | 'cash' | 'denoms' | 'bills' | 'others' | 'note' | 'sign'

let day: DaySummary | null = null
let dirty = false
let goToView: (view: string) => void = () => {}
let opts: SheetOpts = loadOpts()

function loadOpts(): SheetOpts {
  try {
    const saved = JSON.parse(localStorage.getItem(SHEET_KEY) ?? 'null')
    return saved ? { ...DEFAULT_OPTS, ...saved } : { ...DEFAULT_OPTS }
  } catch {
    return { ...DEFAULT_OPTS }
  }
}

function storeOpts(): void {
  try {
    localStorage.setItem(SHEET_KEY, JSON.stringify(opts))
  } catch {
    // not remembered — still prints with what is ticked now
  }
}

// Count the drawer note by note, or just type the total (the default — the
// counter staff don't count denominations).
function useDenoms(): boolean {
  return (document.getElementById('cu-use-denoms') as HTMLInputElement).checked
}

function num(id: string): number {
  return parseFloat(input(id).value) || 0
}

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/* ---------- live calculation ---------- */

function denomTotal(): number {
  let total = num('cu-coins-other')
  for (const d of DENOMS) total += (parseInt(input(`cu-d-${d}`).value, 10) || 0) * d
  return r2(total)
}

function countedTotal(): number {
  return useDenoms() ? denomTotal() : r2(num('cu-counted-input'))
}

function applyDenomMode(): void {
  const on = useDenoms()
  $('cu-denom-wrap').style.display = on ? '' : 'none'
  $('cu-total-wrap').style.display = on ? 'none' : ''
  recalc()
}

function expectedCash(): number {
  return r2(num('cu-float') + (day?.cashTotal ?? 0) + num('cu-in') - num('cu-out'))
}

function diffHtml(diff: number): { cls: string; text: string } {
  if (Math.abs(diff) < 0.005) return { cls: 'ok', text: 'เงินตรงพอดี ✓' }
  if (diff < 0) return { cls: 'short', text: `เงินขาด ${baht(-diff)}` }
  return { cls: 'over', text: `เงินเกิน ${baht(diff)}` }
}

function recalc(): void {
  for (const d of DENOMS) {
    const c = parseInt(input(`cu-d-${d}`).value, 10) || 0
    $(`cu-a-${d}`).textContent = c ? money(c * d) : ''
  }
  const counted = countedTotal()
  const expected = expectedCash()
  $('cu-counted').textContent = baht(counted)
  $('cu-counted-2').textContent = baht(counted)
  $('cu-expected').textContent = baht(expected)
  const d = diffHtml(counted - expected)
  const box = $('cu-diff')
  box.className = `cu-diff ${d.cls}`
  box.textContent = d.text
}

/* ---------- render ---------- */

function renderDenoms(close: CashCloseView | null): void {
  $('cu-denom-body').innerHTML =
    DENOMS.map(
      (d) => `<tr>
        <td>${d >= 20 ? 'ธนบัตร' : 'เหรียญ'} <b>${d.toLocaleString('th-TH')}</b></td>
        <td class="num"><input type="number" id="cu-d-${d}" min="0" step="1" value="${close?.counts?.[String(d)] ?? ''}"></td>
        <td class="num mono" id="cu-a-${d}"></td>
      </tr>`
    ).join('') +
    `<tr><td>เศษสตางค์ / อื่นๆ (บาท)</td>
       <td class="num"><input type="number" id="cu-coins-other" min="0" step="0.25" value="${close?.coinsOther || ''}"></td>
       <td></td></tr>`
  $('cu-denom-body')
    .querySelectorAll('input')
    .forEach((el) =>
      el.addEventListener('input', () => {
        dirty = true
        recalc()
      })
    )
}

function kpi(label: string, value: string, sub = '', cls = ''): string {
  return `<div class="kpi-card ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value" style="font-size:22px;">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`
}

export async function renderCashup(): Promise<void> {
  if (!input('cu-date').value) input('cu-date').value = todayIso()
  const date = input('cu-date').value
  try {
    day = await window.api.sales.day(date)
  } catch (err) {
    toastError(err)
    return
  }
  const d = day
  const c = d.close
  dirty = false

  // ---- alerts ----
  const alerts: string[] = []
  if (d.locked) {
    alerts.push(`<div class="alert-banner warn" style="background:var(--ok-bg);border-color:#BFE0CC;color:var(--ok);"><i class="ti ti-lock alert-icon"></i>
      <div class="alert-text"><b>เจ้าของตรวจแล้ว</b> โดย ${esc(c?.ownerCheckedBy ?? '')} เมื่อ ${thaiDateTime(c?.ownerCheckedAt)} — ข้อมูลของวันนี้ถูกล็อก</div></div>`)
  } else if (c && d.closeStale) {
    alerts.push(`<div class="alert-banner danger"><i class="ti ti-alert-triangle alert-icon"></i>
      <div class="alert-text"><b>มีการเพิ่ม/แก้/ยกเลิกบิลหลังปิดยอด</b> — ยอดตอนปิด ${baht(c.grandTotal)} (${c.billCount} บิล)
      แต่ตอนนี้เป็น ${baht(d.grandTotal)} (${d.billCount} บิล) · กด "บันทึกปิดยอด" ใหม่เพื่ออัปเดต</div></div>`)
  } else if (c) {
    alerts.push(`<div class="alert-banner warn" style="background:var(--accent-soft);border-color:#F2D3AD;color:var(--accent-dark);"><i class="ti ti-circle-check alert-icon"></i>
      <div class="alert-text">ปิดยอดแล้วโดย ${esc(c.closedBy ?? '')} เมื่อ ${thaiDateTime(c.closedAt)} — รอเจ้าของตรวจ</div></div>`)
  }
  if (d.unspecifiedTotal > 0) {
    alerts.push(`<div class="alert-banner warn"><i class="ti ti-help-circle alert-icon"></i>
      <div class="alert-text">มีบิลที่ไม่ได้ระบุวิธีชำระเงินรวม ${baht(d.unspecifiedTotal)} — ไม่ถูกนับเป็นเงินสดหรือโอน ควรเปิดแก้ที่หน้าคีย์บิล</div></div>`)
  }
  $('cu-alerts').innerHTML = alerts.join('')

  // ---- KPIs ----
  $('cu-kpis').innerHTML =
    kpi('จำนวนบิล', String(d.billCount), d.voidCount ? `ยกเลิก ${d.voidCount} ใบ` : '') +
    kpi('ยอดขายรวม', baht(d.grandTotal), d.deliveryFeeTotal ? `รวมค่าจัดส่ง ${money(d.deliveryFeeTotal)}` : '') +
    kpi('เงินสด (จากบิล)', baht(d.cashTotal)) +
    kpi(
      'เงินโอน',
      baht(d.transferTotal),
      d.transferTotal ? `พบยอดแล้ว ${money(d.transferVerified)} · รอตรวจ ${money(d.transferPending)}` : '',
      d.transferPending > 0 || d.transferNotFound > 0 ? 'alert-warn' : ''
    ) +
    kpi('เครดิต (ยังไม่ได้รับเงิน)', baht(d.creditTotal))

  // ---- cash count ----
  renderDenoms(c)
  input('cu-counted-input').value = c?.countedTotal ? String(c.countedTotal) : ''
  applyDenomMode()
  input('cu-float').value = c ? String(c.openingFloat || '') : ''
  input('cu-in').value = c ? String(c.cashInOther || '') : ''
  input('cu-out').value = c ? String(c.cashOut || '') : ''
  input('cu-adjust-note').value = c?.adjustNote ?? ''
  ;(document.getElementById('cu-note') as HTMLTextAreaElement).value = c?.note ?? ''
  $('cu-cash-sales').textContent = baht(d.cashTotal)
  $('cu-count-sub').textContent = `ยอดรวม = เงินทอนตั้งต้น − เงินใช้ระหว่างวัน + ขายเงินสด (+ เงินเข้าอื่นๆ)`
  recalc()

  // ---- transfers ----
  const transfers = d.sales.filter((s) => !s.voided && s.transferAmount > 0)
  $('cu-transfer-sub').textContent = transfers.length
    ? `${transfers.length} บิล · พบยอดแล้ว ${money(d.transferVerified)} · รอตรวจ ${money(d.transferPending)}${d.transferNotFound ? ` · ไม่พบยอด ${money(d.transferNotFound)}` : ''}`
    : 'ไม่มีบิลโอนในวันนี้'
  $('cu-transfer-body').innerHTML = transfers.length
    ? transfers
        .map(
          (s) => `<tr><td class="mono"><b>${esc(s.docNumber)}</b></td><td>${esc(s.docTime ?? '')}</td>
            <td>${esc(s.customerName ?? '')}</td><td class="num">${money(s.transferAmount)}</td>
            <td class="mono">${esc(s.transferTime ?? '')}</td><td>${esc(s.transferRef ?? '')}</td><td>${transferBadge(s.transferStatus)}</td></tr>`
        )
        .join('')
    : `<tr><td colspan="7"><div class="empty-state" style="padding:20px;">ไม่มีบิลโอน</div></td></tr>`

  // ---- credit / voided / gaps ----
  const credit = d.sales.filter((s) => !s.voided && s.creditAmount > 0)
  const voided = d.sales.filter((s) => s.voided)
  const noTicket = d.sales.filter((s) => !s.voided && s.noTicket)
  const block = (title: string, body: string): string =>
    `<div style="margin-bottom:14px;"><div style="font-weight:700;margin-bottom:6px;">${title}</div>${body}</div>`
  $('cu-others').innerHTML =
    block(
      `เครดิต (ยังไม่ได้รับเงิน) — ${credit.length} บิล`,
      credit.length
        ? credit.map((s) => `<span class="badge muted" style="margin:0 6px 6px 0;">${esc(s.docNumber)} · ${esc(s.customerName ?? 'ไม่ระบุชื่อ')} · ${money(s.creditAmount)}</span>`).join('')
        : '<span class="text-muted">ไม่มี</span>'
    ) +
    block(
      `บิลที่ยกเลิก — ${voided.length} ใบ`,
      voided.length
        ? voided.map((s) => `<span class="badge danger" style="margin:0 6px 6px 0;">${esc(s.docNumber)} · ${esc(s.voidReason ?? '')}</span>`).join('')
        : '<span class="text-muted">ไม่มี</span>'
    ) +
    block(
      `บิลที่ไม่มีใบ (ไม่ได้ใช้ใบสั่งสินค้าที่พิมพ์ไว้) — ${noTicket.length} ใบ`,
      noTicket.length
        ? noTicket
            .map(
              (s) =>
                `<span class="badge muted" style="margin:0 6px 6px 0;">${esc(s.docNumber)} · ${money(s.grandTotal)}${s.note ? ` · ${esc(s.note)}` : ' · <i>ไม่ได้เขียนเหตุผล</i>'}</span>`
            )
            .join('')
        : '<span class="text-muted">ไม่มี</span>'
    ) +
    block(
      'เลขที่ใบที่ขาดหาย (มีเลขก่อน-หลังแต่ยังไม่ได้คีย์)',
      d.gaps.length
        ? d.gaps
            .map(
              (g) =>
                `<div style="margin-bottom:4px;"><b>เล่ม ${esc(g.book)}:</b> <span class="mono">${g.numbers.map(esc).join(', ')}</span>${g.more ? ` และอีก ${g.more} ใบ` : ''}</div>`
            )
            .join('')
        : '<span class="text-muted">ไม่มี — เลขเรียงครบ</span>'
    )

  // ---- save / owner ----
  $('cu-close-sub').textContent = c ? `ปิดยอดล่าสุด ${thaiDateTime(c.closedAt)} โดย ${c.closedBy ?? ''}` : 'ยังไม่ได้ปิดยอดของวันนี้'
  ;($('cu-btn-save') as HTMLButtonElement).disabled = d.locked
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('#view-cashup input:not(#cu-date), #view-cashup textarea').forEach((el) => {
    if (el.id !== 'cu-owner-note' && el.id !== 'cu-use-denoms') el.disabled = d.locked
  })

  $('cu-owner-panel').style.display = level() >= 3 ? '' : 'none'
  input('cu-owner-note').value = c?.ownerNote ?? ''
  $('cu-owner-sub').textContent = c?.ownerCheckedAt
    ? `ตรวจแล้วโดย ${c.ownerCheckedBy ?? ''} เมื่อ ${thaiDateTime(c.ownerCheckedAt)}`
    : c
      ? 'ยังไม่ได้ตรวจ'
      : 'ต้องบันทึกปิดยอดก่อน'
  ;($('cu-btn-owner-check') as HTMLButtonElement).style.display = c && !c.ownerCheckedAt ? '' : 'none'
  ;($('cu-btn-owner-undo') as HTMLButtonElement).style.display = c?.ownerCheckedAt ? '' : 'none'
}

/* ---------- save ---------- */

async function saveClose(silent = false): Promise<boolean> {
  if (!day) return false
  // Total-only counting is stored as "other" money with no denominations, so
  // the saved counted_total is the same either way.
  const counts: Record<string, number> = {}
  if (useDenoms()) {
    for (const d of DENOMS) {
      const c = parseInt(input(`cu-d-${d}`).value, 10) || 0
      if (c > 0) counts[String(d)] = c
    }
  }
  try {
    await window.api.sales.saveClose({
      date: day.date,
      openingFloat: num('cu-float'),
      cashInOther: num('cu-in'),
      cashOut: num('cu-out'),
      adjustNote: input('cu-adjust-note').value,
      counts,
      coinsOther: useDenoms() ? num('cu-coins-other') : num('cu-counted-input'),
      note: (document.getElementById('cu-note') as HTMLTextAreaElement).value
    })
    await renderCashup()
    if (!silent) showToast(`บันทึกปิดยอดวันที่ ${thaiDate(day.date)} แล้ว`)
    return true
  } catch (err) {
    toastError(err)
    return false
  }
}

/* ---------- A4 sheet ---------- */

function buildSheet(d: DaySummary, c: CashCloseView, o: SheetOpts): string {
  const live = d.sales.filter((s) => !s.voided)
  const voided = d.sales.filter((s) => s.voided)
  const noTicket = live.filter((s) => s.noTicket)
  const blank = o.cashMode === 'blank'
  // Section numbers follow whatever is switched on.
  let n = 0
  const h2 = (title: string): string => `<h2>${++n}. ${title}</h2>`
  const parts: string[] = []

  if (o.summary) {
    parts.push(`<table class="cu-sum">
      <tr><th>จำนวนบิล</th><th>ยอดขายรวม</th><th>เงินสด</th><th>เงินโอน</th><th>เครดิต</th><th>บิลยกเลิก</th></tr>
      <tr class="cu-big"><td class="n">${d.billCount}</td><td class="n">${money(d.grandTotal)}</td><td class="n">${money(d.cashTotal)}</td>
        <td class="n">${money(d.transferTotal)}</td><td class="n">${money(d.creditTotal)}</td><td class="n">${d.voidCount}</td></tr>
    </table>`)
  }

  // Cash check: "auto" prints what was keyed in; "blank" leaves the boxes empty
  // to be written by hand (cash sales still come from the bills).
  const cashTable = (): string => {
    const v = (x: number): string => (blank ? '' : money(x))
    const detail = (x: string): string => (blank ? '' : esc(x))
    const diff = diffHtml(c.difference)
    return `<table class="cu-cash${blank ? ' blank' : ''}">
      <tr><th class="lbl">รายการ</th><th class="amt">จำนวนเงิน (บาท)</th><th>รายละเอียด</th></tr>
      <tr><td>เงินทอนตั้งต้น</td><td class="n">${v(c.openingFloat)}</td><td></td></tr>
      <tr><td>− เงินใช้ระหว่างวัน</td><td class="n">${v(c.cashOut)}</td><td>${detail(c.adjustNote ?? '')}</td></tr>
      <tr><td>+ ขายเป็นเงินสด (จากบิล)</td><td class="n">${money(c.cashTotal)}</td><td></td></tr>
      ${
        // Rarely used — only printed when there actually was some.
        !blank && c.cashInOther ? `<tr><td>+ เงินเข้าอื่นๆ</td><td class="n">${money(c.cashInOther)}</td><td></td></tr>` : ''
      }
      <tr><th style="text-align:left;">ยอดรวม (เงินสดที่ควรมี)</th><th class="n">${v(c.expectedCash)}</th><td></td></tr>
      <tr><th style="text-align:left;">นับได้จริง</th><th class="n">${v(c.countedTotal)}</th><td></td></tr>
      <tr class="cu-big"><td><b>ผลต่าง</b></td>
        <td class="n">${blank ? '' : `<b>${esc(diff.text)}</b>`}</td>
        <td>${blank ? '<span class="cu-hand">☐ ตรงพอดี &nbsp; ☐ ขาด &nbsp; ☐ เกิน</span>' : ''}</td></tr>
    </table>`
  }

  // Denominations: the counted numbers when there are any, otherwise an empty
  // grid to fill in by hand.
  const denomTable = (): string => {
    const rows = DENOMS.map((v) => {
      const cnt = c.counts?.[String(v)] ?? 0
      return `<tr><td>${v.toLocaleString('th-TH')}</td><td class="n">${cnt || ''}</td><td class="n">${cnt ? money(cnt * v) : ''}</td></tr>`
    }).join('')
    const hasCounts = Object.values(c.counts ?? {}).some((x) => x > 0)
    return `<table>
      <tr><th>ธนบัตร/เหรียญ</th><th>จำนวน</th><th>เป็นเงิน</th></tr>
      ${rows}
      <tr><td>เศษสตางค์/อื่นๆ</td><td></td><td class="n">${hasCounts && c.coinsOther ? money(c.coinsOther) : ''}</td></tr>
      <tr><th colspan="2" style="text-align:left;">นับได้รวม</th><th class="n">${hasCounts && !blank ? money(c.countedTotal) : ''}</th></tr>
    </table>`
  }

  if (o.cash && o.denoms) parts.push(h2('ตรวจนับเงินสด') + `<div class="cu-two">${denomTable()}${cashTable()}</div>`)
  else if (o.cash) parts.push(h2('ตรวจเงินสด') + cashTable())
  else if (o.denoms) parts.push(h2('นับธนบัตร / เหรียญ') + `<div class="cu-two">${denomTable()}<div></div></div>`)

  if (o.bills) {
    const billRows = live
      .map(
        (s, i) => `<tr>
        <td class="n">${i + 1}</td><td>${esc(s.docNumber)}${s.noTicket ? ' (ไม่มีใบ)' : ''}</td><td>${esc(s.docTime ?? '')}</td>
        <td>${esc(s.customerName ?? '')}</td><td class="n">${money(s.grandTotal)}</td>
        <td>${esc(payLabel(s.paymentMethod))}</td>
        <td class="n">${s.cashAmount ? money(s.cashAmount) : ''}</td>
        <td class="n">${s.transferAmount ? money(s.transferAmount) : ''}</td>
        <td class="n">${s.creditAmount ? money(s.creditAmount) : ''}</td>
        <td>${s.transferStatus ? esc(TRANSFER_STATUS[s.transferStatus]?.label ?? '') : ''}</td>
      </tr>`
      )
      .join('')
    parts.push(`${h2(`รายการบิลทั้งหมด (${live.length} ใบ)`)}
    <table class="cu-bills">
      <tr><th>#</th><th>เลขที่</th><th>เวลา</th><th>ลูกค้า</th><th>ยอดรวม</th><th>ชำระ</th><th>เงินสด</th><th>โอน</th><th>เครดิต</th><th>ตรวจโอน</th></tr>
      ${billRows || '<tr><td colspan="10" style="text-align:center;">ไม่มีบิล</td></tr>'}
      <tr><th colspan="4" style="text-align:right;">รวม</th><th class="n">${money(d.grandTotal)}</th><th></th>
        <th class="n">${money(d.cashTotal)}</th><th class="n">${money(d.transferTotal)}</th><th class="n">${money(d.creditTotal)}</th><th></th></tr>
    </table>`)
  }

  if (o.others) {
    const gaps = d.gaps
      .map((g) => `เล่ม ${esc(g.book)}: ${g.numbers.map(esc).join(', ')}${g.more ? ` และอีก ${g.more} ใบ` : ''}`)
      .join('<br>')
    parts.push(`${h2('บิลยกเลิก / บิลที่ไม่มีใบ / เลขที่ใบที่ขาดหาย')}
    <div class="cu-notebox" style="min-height:0;">
      <b>บิลยกเลิก:</b> ${voided.length ? voided.map((s) => `${esc(s.docNumber)} (${esc(s.voidReason ?? '')})`).join(', ') : 'ไม่มี'}<br>
      <b>บิลที่ไม่มีใบ:</b> ${
        noTicket.length
          ? noTicket.map((s) => `${esc(s.docNumber)} ${money(s.grandTotal)}${s.note ? ` (${esc(s.note)})` : ''}`).join(', ')
          : 'ไม่มี'
      }<br>
      <b>เลขที่ขาดหาย:</b> ${gaps || 'ไม่มี'}
    </div>`)
  }

  if (o.note) {
    // What was typed into the system goes on the top lines; the rest are
    // empty dotted lines for writing by hand.
    const typed = [c.note?.trim(), c.ownerNote?.trim() ? `เจ้าของ: ${c.ownerNote.trim()}` : '']
      .filter((x): x is string => !!x)
      .map((t) => `<div class="cu-noteline text">${esc(t)}</div>`)
      .join('')
    const blanks = '<div class="cu-noteline"></div>'.repeat(o.noteLines)
    parts.push(
      h2('หมายเหตุ') +
        (typed || blanks
          ? `<div class="cu-notebox lined">${typed}${blanks}</div>`
          : '<div class="cu-notebox"></div>')
    )
  }

  if (o.sign) {
    parts.push(`<div class="cu-sign">
      <div><div class="cu-line"></div>ผู้ปิดยอด (${esc(c.closedBy ?? '')})<br>วันที่ ........./........./.........</div>
      <div><div class="cu-line"></div>ผู้ตรวจ (เจ้าของร้าน)<br>วันที่ ........./........./.........</div>
    </div>`)
  }

  return `<div class="cu-sheet${o.paper === 'form' ? ' small' : ''}">
    <h1>ใบสรุปยอดขายประจำวัน</h1>
    <div class="cu-sub">วันที่ <b>${thaiDate(d.date)}</b></div>
    <div class="cu-meta">
      ปิดยอดโดย: <b>${esc(c.closedBy ?? '')}</b> เมื่อ ${thaiDateTime(c.closedAt)}
      · สถานะ: <b>${c.ownerCheckedAt ? `เจ้าของตรวจแล้ว (${esc(c.ownerCheckedBy ?? '')} ${thaiDateTime(c.ownerCheckedAt)})` : 'รอเจ้าของตรวจ'}</b>
      · พิมพ์เมื่อ ${new Date().toLocaleString('th-TH')}
      ${d.closeStale ? '<br><b>หมายเหตุ: มีการแก้บิลหลังปิดยอด — ตัวเลขด้านล่างเป็นยอดล่าสุด</b>' : ''}
    </div>
    ${parts.join('\n')}
  </div>`
}

// The order-ticket continuous form. This sheet keeps its OWN paper width and
// margins (dialled in on the cash-up print dialog), starting from whatever the
// order page uses — same printer, same paper — until someone changes them
// here. The order page's settings are only ever read, never written.
interface FormMargins {
  top: number
  right: number
  bottom: number
  left: number
}
interface FormGeometry {
  paperIn: number // 9 = full sheet incl. tractor strips, 8 = printable part only
  m: FormMargins
  // The PORTRAIT content box: across the 5.5in side, along the 9in side.
  widthMm: number
  heightMm: number
}

function defaultFormMargins(paperIn: number): FormMargins {
  const side = paperIn === 9 ? 12.7 : 0
  return { top: 5.1, right: side, bottom: 5.1, left: side }
}

function orderPageForm(): { paperIn: number; m: FormMargins } {
  let paperIn = 9
  let m = defaultFormMargins(9)
  try {
    paperIn = localStorage.getItem(ORDER_PAPER_KEY) === '8' ? 8 : 9
    m = defaultFormMargins(paperIn)
    const saved = localStorage.getItem(ORDER_MARGIN_KEY)
    if (saved) m = { ...m, ...(JSON.parse(saved) as FormMargins) }
  } catch {
    // defaults above
  }
  return { paperIn, m }
}

function formGeometry(): FormGeometry {
  let f = orderPageForm()
  try {
    const own = localStorage.getItem(FORM_SETTINGS_KEY)
    if (own) {
      const o = JSON.parse(own) as { paperIn: number; m: FormMargins }
      const paperIn = o.paperIn === 8 ? 8 : 9
      f = { paperIn, m: { ...defaultFormMargins(paperIn), ...o.m } }
    }
  } catch {
    // fall back to the order page's settings
  }
  return {
    paperIn: f.paperIn,
    m: f.m,
    widthMm: r2(5.5 * 25.4 - f.m.top - f.m.bottom),
    heightMm: r2(f.paperIn * 25.4 - f.m.left - f.m.right)
  }
}

// Read the paper/margin boxes and remember them for this sheet.
function storeFormSettings(paperChanged: boolean): void {
  const paperIn = select('cu-form-paper').value === '8' ? 8 : 9
  // Side margins mean something different per paper width (tractor strips or
  // not), so a width change starts from that width's defaults.
  const d = defaultFormMargins(paperIn)
  const n = (id: string, fallback: number): number => {
    const v = parseFloat(input(id).value)
    return isNaN(v) ? fallback : Math.max(0, Math.min(60, v))
  }
  const m = paperChanged
    ? d
    : { top: n('cu-m-top', d.top), right: n('cu-m-right', d.right), bottom: n('cu-m-bottom', d.bottom), left: n('cu-m-left', d.left) }
  try {
    localStorage.setItem(FORM_SETTINGS_KEY, JSON.stringify({ paperIn, m }))
  } catch {
    // not remembered — still used for this print
  }
}

// The physical page stays exactly the driver's 9 x 5.5in form (asking for any
// other size made the paper creep on the order ticket), and the portrait sheet
// is turned 90deg onto it. Unflipped, the top of the sheet sits at the LEFT
// edge of the form: tear it off and turn it clockwise to read.
function formPageHtml(sheet: string, g: FormGeometry): string {
  const transform = opts.flip
    ? `translate(${g.m.left + g.heightMm}mm, ${g.m.top}mm) rotate(90deg)`
    : `translate(${g.m.left}mm, ${g.m.top + g.widthMm}mm) rotate(-90deg)`
  return `<div class="cu-form-page" style="width:${g.paperIn}in;height:5.5in;">
    <div class="cu-form-rot" style="width:${g.widthMm}mm;height:${g.heightMm}mm;transform:${transform};">${sheet}</div>
  </div>`
}

// Same sheet into the on-screen preview and the real print area, and the
// option boxes set to match. The preview shows the form UPRIGHT (as it is
// read); only the print copy is rotated.
function drawSheet(): void {
  if (!day?.close) return
  const html = buildSheet(day, day.close, opts)
  const paper = $('cashup-preview-paper')
  const form = opts.paper === 'form'
  paper.classList.toggle('form', form)
  if (form) {
    const g = formGeometry()
    paper.innerHTML = `<div class="cu-form-preview" style="width:${g.widthMm}mm;height:${g.heightMm}mm;">${html}</div>`
    $('cashup-print-area').innerHTML = formPageHtml(html, g)
    $('cu-paper-hint').textContent =
      `กระดาษต่อเนื่องเดียวกับใบสั่งสินค้า พิมพ์หมุนเป็นแนวตั้ง — ฉีกแล้วหมุนอ่าน · ` +
      `พื้นที่พิมพ์ ${g.widthMm.toFixed(0)} × ${g.heightMm.toFixed(0)} มม.`
  } else {
    paper.innerHTML = html
    $('cashup-print-area').innerHTML = html
    $('cu-paper-hint').textContent = ''
  }

  const box = $('cu-pv-options')
  box.querySelectorAll<HTMLInputElement>('input[name="cu-paper"]').forEach((el) => {
    el.checked = el.value === opts.paper
  })
  input('cu-flip').checked = opts.flip
  $('cu-form-settings').style.display = form ? '' : 'none'
  if (form) {
    const g = formGeometry()
    select('cu-form-paper').value = String(g.paperIn)
    input('cu-m-top').value = String(g.m.top)
    input('cu-m-bottom').value = String(g.m.bottom)
    input('cu-m-left').value = String(g.m.left)
    input('cu-m-right').value = String(g.m.right)
  }
  box.querySelectorAll<HTMLInputElement>('input[data-opt]').forEach((el) => {
    el.checked = opts[el.dataset.opt as FlagKey]
  })
  box.querySelectorAll<HTMLInputElement>('input[name="cu-cash-mode"]').forEach((el) => {
    el.checked = el.value === opts.cashMode
    el.disabled = !opts.cash
  })
  select('cu-note-lines').value = String(opts.noteLines)
  select('cu-note-lines').disabled = !opts.note

  // One form = one page. Anything taller is cut off, so say so up front.
  const over = form && formOverflowing()
  const warn = $('cu-pv-warn')
  warn.classList.toggle('show', over)
  const msg = warn.querySelector('span')
  if (msg) msg.textContent = 'เนื้อหายาวเกินกระดาษ — ส่วนล่างจะหายตอนพิมพ์ · ปิดบางส่วน ลดบรรทัดหมายเหตุ หรือเลือกกระดาษ A4'
  updatePrinterHint()
}

function formOverflowing(): boolean {
  const frame = document.querySelector<HTMLElement>('#cashup-preview-paper .cu-form-preview')
  const sheet = frame?.querySelector<HTMLElement>('.cu-sheet')
  return !!frame && !!sheet && sheet.scrollHeight > frame.clientHeight + 1
}

function estimatePages(): number {
  if (opts.paper === 'form') return 1
  const sheet = document.querySelector<HTMLElement>('#cashup-preview-paper .cu-sheet')
  if (!sheet) return 1
  const mm = (sheet.scrollHeight * 25.4) / 96
  return Math.max(1, Math.ceil(mm / PRINTABLE_HEIGHT_MM))
}

// A separate remembered printer per paper: the form goes to the dot matrix,
// A4 never can (the LQ-310 holds no A4 — that job fails outright).
function printerKey(): string {
  return opts.paper === 'form' ? PRINTER_KEY_FORM : PRINTER_KEY
}

function pickPrinter(): void {
  const sel = select('cu-printer')
  const names = [...sel.options].map((o) => o.value)
  const stored = (key: string): string | null => {
    try {
      const v = localStorage.getItem(key)
      return v && names.includes(v) ? v : null
    } catch {
      return null
    }
  }
  const find = (re: RegExp): string | undefined => names.find((n) => re.test(n))
  const choice =
    opts.paper === 'form'
      ? stored(PRINTER_KEY_FORM) ?? stored(ORDER_PRINTER_KEY) ?? find(/LQ-?\d|dot ?matrix/i)
      : stored(PRINTER_KEY) ?? find(/print to pdf/i)
  if (choice) sel.value = choice
}

async function openPreview(): Promise<void> {
  if (!day) return
  // The paper must match the saved record, so save first whenever the form or
  // the bills have moved since the last save (not possible once locked).
  if (!day.locked && (!day.close || dirty || day.closeStale)) {
    const ok = await saveClose(true)
    if (!ok) return
  }
  if (!day.close) {
    showToast('ยังไม่ได้บันทึกปิดยอดของวันนี้', true)
    return
  }
  $('cashup-preview-modal').classList.add('active')
  drawSheet()
  await loadPrinters(select('cu-printer'))
  pickPrinter()
  updatePrinterHint()
}

function updatePrinterHint(): void {
  const printer = select('cu-printer').value
  const dotMatrix = /LQ-?\d|dot ?matrix/i.test(printer)
  if (opts.paper === 'form') {
    const g = formGeometry()
    $('cu-pv-pages').textContent = `1 แผ่น · ใบสั่งสินค้า ${g.paperIn} × 5.5 นิ้ว (พิมพ์แนวตั้ง)`
    return
  }
  const pages = `ประมาณ ${estimatePages()} หน้า A4 แนวตั้ง`
  $('cu-pv-pages').innerHTML = dotMatrix
    ? `${pages} · <b style="color:var(--danger);">เครื่องนี้ไม่มีกระดาษ A4 — เลือก PDF แล้วนำไฟล์ไปพิมพ์ที่เครื่องอื่น</b>`
    : pages
}

function closePreview(): void {
  $('cashup-preview-modal').classList.remove('active')
}

async function doPrint(pdfOnly: boolean): Promise<void> {
  if (!day?.close) return
  const fileName = `สรุปยอดขาย-${day.date}.pdf`
  const form = opts.paper === 'form'
  const g = formGeometry()
  // margin:0 for the form — its edges are already inside the rotated box.
  const pageCss = form ? `@media print{@page{size:${g.paperIn}in 5.5in;margin:0;}}` : PAGE_CSS
  try {
    const res = pdfOnly
      ? await savePdf({ bodyClass: 'printing-cashup', pageCss, landscape: false, defaultFileName: fileName })
      : await runPrint({
          bodyClass: 'printing-cashup',
          deviceName: select('cu-printer').value,
          copies: Math.max(1, Math.min(20, parseInt(input('cu-copies').value, 10) || 1)),
          landscape: false,
          // Hard cap: pages actually laid out, plus one for rounding (the form
          // is always exactly one page).
          pageCount: form ? 1 : estimatePages() + 1,
          pageSize: form ? { widthIn: g.paperIn, heightIn: 5.5 } : 'A4',
          // Same as the order ticket: the LQ-310 form is defined with a zero
          // edge. Never for A4 — laser/inkjet drivers reject borderless.
          ...(form ? { margins: { marginType: 'none' as const } } : {}),
          pageCss,
          defaultFileName: fileName
        })
    if (res.ok) {
      showToast(pdfOnly ? 'บันทึกไฟล์ PDF แล้ว' : 'ส่งพิมพ์แล้ว')
      closePreview()
    }
  } catch (err) {
    toastError(err)
  }
}

/* ---------- owner ---------- */

async function ownerCheck(checked: boolean): Promise<void> {
  if (!day) return
  if (checked && day.closeStale) {
    showToast('มีการแก้บิลหลังปิดยอด — ให้บันทึกปิดยอดใหม่ก่อนตรวจ', true)
    return
  }
  if (!checked && !confirm('ยกเลิกการตรวจของวันนี้? บิลของวันนี้จะกลับมาแก้ไขได้อีกครั้ง')) return
  try {
    await window.api.sales.ownerCheck({ date: day.date, checked, note: input('cu-owner-note').value })
    await renderCashup()
    showToast(checked ? 'บันทึกว่าเจ้าของตรวจแล้ว — ล็อกข้อมูลของวันนี้' : 'ยกเลิกการตรวจแล้ว')
  } catch (err) {
    toastError(err)
  }
}

export function initCashup(navigate: (view: string) => void): void {
  goToView = navigate
  input('cu-date').value = todayIso()
  input('cu-date').addEventListener('change', () => void renderCashup())
  for (const id of ['cu-float', 'cu-in', 'cu-out', 'cu-counted-input']) {
    input(id).addEventListener('input', () => {
      dirty = true
      recalc()
    })
  }

  const denomBox = input('cu-use-denoms')
  try {
    denomBox.checked = localStorage.getItem(DENOMS_KEY) === '1'
  } catch {
    denomBox.checked = false
  }
  denomBox.addEventListener('change', () => {
    // Carry the figure across so switching modes never loses the count.
    if (denomBox.checked) {
      const counted = DENOMS.some((d) => (parseInt(input(`cu-d-${d}`).value, 10) || 0) > 0) || num('cu-coins-other') > 0
      if (!counted) input('cu-coins-other').value = input('cu-counted-input').value
    } else {
      const t = denomTotal()
      input('cu-counted-input').value = t ? String(t) : ''
    }
    try {
      localStorage.setItem(DENOMS_KEY, denomBox.checked ? '1' : '0')
    } catch {
      // the choice just isn't remembered
    }
    dirty = true
    applyDenomMode()
  })

  // Print-dialog options: every change redraws the preview straight away.
  $('cu-pv-options').addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement
    if (el instanceof HTMLInputElement && el.dataset.opt) opts[el.dataset.opt as FlagKey] = el.checked
    else if (el instanceof HTMLInputElement && el.name === 'cu-paper') {
      opts.paper = el.value as SheetOpts['paper']
      pickPrinter()
    } else if (el.id === 'cu-flip') opts.flip = (el as HTMLInputElement).checked
    else if (el.id === 'cu-form-paper' || el.id.startsWith('cu-m-')) {
      storeFormSettings(el.id === 'cu-form-paper')
      drawSheet()
      return
    } else if (el instanceof HTMLInputElement && el.name === 'cu-cash-mode') opts.cashMode = el.value as SheetOpts['cashMode']
    else if (el.id === 'cu-note-lines') opts.noteLines = parseInt(el.value, 10) || 0
    storeOpts()
    drawSheet()
  })
  $('cu-m-reset').addEventListener('click', () => {
    try {
      localStorage.removeItem(FORM_SETTINGS_KEY)
    } catch {
      // nothing stored
    }
    drawSheet()
  })
  $('cu-pv-reset').addEventListener('click', () => {
    opts = { ...DEFAULT_OPTS }
    storeOpts()
    pickPrinter()
    drawSheet()
  })
  for (const id of ['cu-adjust-note', 'cu-note']) {
    $(id).addEventListener('input', () => {
      dirty = true
    })
  }
  $('cu-btn-save').addEventListener('click', () => void saveClose())
  $('cu-btn-print').addEventListener('click', () => void openPreview())
  $('cu-btn-goto-transfers').addEventListener('click', () => goToView('transfers'))
  $('cu-btn-owner-check').addEventListener('click', () => void ownerCheck(true))
  $('cu-btn-owner-undo').addEventListener('click', () => void ownerCheck(false))
  $('cu-pv-close').addEventListener('click', closePreview)
  select('cu-printer').addEventListener('change', () => {
    try {
      if (select('cu-printer').value) localStorage.setItem(printerKey(), select('cu-printer').value)
    } catch {
      // the choice just isn't remembered
    }
    updatePrinterHint()
  })
  $('cu-pv-print').addEventListener('click', () => void doPrint(false))
  $('cu-pv-pdf').addEventListener('click', () => void doPrint(true))
}
