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
const PRINTER_KEY = 'printer.cashup'
// A4 portrait with 12mm margins leaves 273mm of height per page.
const PRINTABLE_HEIGHT_MM = 273

let day: DaySummary | null = null
let dirty = false
let goToView: (view: string) => void = () => {}

function num(id: string): number {
  return parseFloat(input(id).value) || 0
}

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/* ---------- live calculation ---------- */

function countedTotal(): number {
  let total = num('cu-coins-other')
  for (const d of DENOMS) total += (parseInt(input(`cu-d-${d}`).value, 10) || 0) * d
  return r2(total)
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
  input('cu-float').value = c ? String(c.openingFloat || '') : ''
  input('cu-in').value = c ? String(c.cashInOther || '') : ''
  input('cu-out').value = c ? String(c.cashOut || '') : ''
  input('cu-adjust-note').value = c?.adjustNote ?? ''
  ;(document.getElementById('cu-note') as HTMLTextAreaElement).value = c?.note ?? ''
  $('cu-cash-sales').textContent = baht(d.cashTotal)
  $('cu-count-sub').textContent = `ลิ้นชักควรมี = เงินทอนตั้งต้น + ขายเงินสด + เงินเข้าอื่นๆ − จ่ายออก`
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
            <td>${esc(s.transferRef ?? '')}</td><td>${transferBadge(s.transferStatus)}</td></tr>`
        )
        .join('')
    : `<tr><td colspan="6"><div class="empty-state" style="padding:20px;">ไม่มีบิลโอน</div></td></tr>`

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
    if (el.id !== 'cu-owner-note') el.disabled = d.locked
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
  const counts: Record<string, number> = {}
  for (const d of DENOMS) {
    const c = parseInt(input(`cu-d-${d}`).value, 10) || 0
    if (c > 0) counts[String(d)] = c
  }
  try {
    await window.api.sales.saveClose({
      date: day.date,
      openingFloat: num('cu-float'),
      cashInOther: num('cu-in'),
      cashOut: num('cu-out'),
      adjustNote: input('cu-adjust-note').value,
      counts,
      coinsOther: num('cu-coins-other'),
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

function buildSheet(d: DaySummary, c: CashCloseView): string {
  const live = d.sales.filter((s) => !s.voided)
  const diff = diffHtml(c.difference)
  const denomRows = DENOMS.map((v) => {
    const n = c.counts?.[String(v)] ?? 0
    return `<tr><td>${v.toLocaleString('th-TH')}</td><td class="n">${n || ''}</td><td class="n">${n ? money(n * v) : ''}</td></tr>`
  }).join('')

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

  const voided = d.sales.filter((s) => s.voided)
  const noTicket = live.filter((s) => s.noTicket)
  const gaps = d.gaps
    .map((g) => `เล่ม ${esc(g.book)}: ${g.numbers.map(esc).join(', ')}${g.more ? ` และอีก ${g.more} ใบ` : ''}`)
    .join('<br>')

  return `<div class="cu-sheet">
    <h1>ใบสรุปยอดขายประจำวัน</h1>
    <div class="cu-sub">วันที่ <b>${thaiDate(d.date)}</b></div>
    <div class="cu-meta">
      ปิดยอดโดย: <b>${esc(c.closedBy ?? '')}</b> เมื่อ ${thaiDateTime(c.closedAt)}
      · สถานะ: <b>${c.ownerCheckedAt ? `เจ้าของตรวจแล้ว (${esc(c.ownerCheckedBy ?? '')} ${thaiDateTime(c.ownerCheckedAt)})` : 'รอเจ้าของตรวจ'}</b>
      · พิมพ์เมื่อ ${new Date().toLocaleString('th-TH')}
      ${d.closeStale ? '<br><b>หมายเหตุ: มีการแก้บิลหลังปิดยอด — ตัวเลขด้านล่างเป็นยอดล่าสุด</b>' : ''}
    </div>

    <table class="cu-sum">
      <tr><th>จำนวนบิล</th><th>ยอดขายรวม</th><th>เงินสด</th><th>เงินโอน</th><th>เครดิต</th><th>บิลยกเลิก</th></tr>
      <tr class="cu-big"><td class="n">${d.billCount}</td><td class="n">${money(d.grandTotal)}</td><td class="n">${money(d.cashTotal)}</td>
        <td class="n">${money(d.transferTotal)}</td><td class="n">${money(d.creditTotal)}</td><td class="n">${d.voidCount}</td></tr>
    </table>

    <h2>1. ตรวจนับเงินสด</h2>
    <div class="cu-two">
      <table>
        <tr><th>ธนบัตร/เหรียญ</th><th>จำนวน</th><th>เป็นเงิน</th></tr>
        ${denomRows}
        <tr><td>เศษสตางค์/อื่นๆ</td><td></td><td class="n">${c.coinsOther ? money(c.coinsOther) : ''}</td></tr>
        <tr><th colspan="2" style="text-align:left;">นับได้รวม</th><th class="n">${money(c.countedTotal)}</th></tr>
      </table>
      <table>
        <tr><td>เงินทอนตั้งต้น</td><td class="n">${money(c.openingFloat)}</td></tr>
        <tr><td>+ ขายเป็นเงินสด</td><td class="n">${money(c.cashTotal)}</td></tr>
        <tr><td>+ เงินเข้าอื่นๆ</td><td class="n">${money(c.cashInOther)}</td></tr>
        <tr><td>− จ่ายออก</td><td class="n">${money(c.cashOut)}</td></tr>
        ${c.adjustNote ? `<tr><td colspan="2" style="font-size:10.5px;">รายละเอียด: ${esc(c.adjustNote)}</td></tr>` : ''}
        <tr><th style="text-align:left;">ควรมีเงินสด</th><th class="n">${money(c.expectedCash)}</th></tr>
        <tr><th style="text-align:left;">นับได้จริง</th><th class="n">${money(c.countedTotal)}</th></tr>
        <tr class="cu-big"><td><b>ผลต่าง</b></td><td class="n"><b>${esc(diff.text)}</b></td></tr>
      </table>
    </div>

    <h2>2. รายการบิลทั้งหมด (${live.length} ใบ)</h2>
    <table class="cu-bills">
      <tr><th>#</th><th>เลขที่</th><th>เวลา</th><th>ลูกค้า</th><th>ยอดรวม</th><th>ชำระ</th><th>เงินสด</th><th>โอน</th><th>เครดิต</th><th>ตรวจโอน</th></tr>
      ${billRows || '<tr><td colspan="10" style="text-align:center;">ไม่มีบิล</td></tr>'}
      <tr><th colspan="4" style="text-align:right;">รวม</th><th class="n">${money(d.grandTotal)}</th><th></th>
        <th class="n">${money(d.cashTotal)}</th><th class="n">${money(d.transferTotal)}</th><th class="n">${money(d.creditTotal)}</th><th></th></tr>
    </table>

    <h2>3. บิลยกเลิก / บิลที่ไม่มีใบ / เลขที่ใบที่ขาดหาย</h2>
    <div class="cu-notebox" style="min-height:0;">
      <b>บิลยกเลิก:</b> ${voided.length ? voided.map((s) => `${esc(s.docNumber)} (${esc(s.voidReason ?? '')})`).join(', ') : 'ไม่มี'}<br>
      <b>บิลที่ไม่มีใบ:</b> ${
        noTicket.length
          ? noTicket.map((s) => `${esc(s.docNumber)} ${money(s.grandTotal)}${s.note ? ` (${esc(s.note)})` : ''}`).join(', ')
          : 'ไม่มี'
      }<br>
      <b>เลขที่ขาดหาย:</b> ${gaps || 'ไม่มี'}
    </div>

    <h2>4. หมายเหตุ</h2>
    <div class="cu-notebox">${esc(c.note ?? '')}${c.ownerNote ? `<br><b>เจ้าของ:</b> ${esc(c.ownerNote)}` : ''}</div>

    <div class="cu-sign">
      <div><div class="cu-line"></div>ผู้ปิดยอด (${esc(c.closedBy ?? '')})<br>วันที่ ........./........./.........</div>
      <div><div class="cu-line"></div>ผู้ตรวจ (เจ้าของร้าน)<br>วันที่ ........./........./.........</div>
    </div>
  </div>`
}

function estimatePages(): number {
  const sheet = document.querySelector<HTMLElement>('#cashup-preview-paper .cu-sheet')
  if (!sheet) return 1
  const mm = (sheet.scrollHeight * 25.4) / 96
  return Math.max(1, Math.ceil(mm / PRINTABLE_HEIGHT_MM))
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
  const html = buildSheet(day, day.close)
  $('cashup-preview-paper').innerHTML = html
  $('cashup-print-area').innerHTML = html
  $('cashup-preview-modal').classList.add('active')
  await loadPrinters(select('cu-printer'), PRINTER_KEY)
  // The shop's only physical printer is the LQ-310 dot matrix, which holds the
  // 9 x 5.5in form and NO A4 — sending this sheet there fails with "Print job
  // failed". Until someone picks a printer for this sheet, default to the PDF
  // writer so the first attempt produces a file instead of an error.
  let remembered: string | null = null
  try {
    remembered = localStorage.getItem(PRINTER_KEY)
  } catch {
    remembered = null
  }
  if (!remembered) {
    const pdf = [...select('cu-printer').options].find((o) => /print to pdf/i.test(o.value))
    if (pdf) select('cu-printer').value = pdf.value
  }
  updatePrinterHint()
}

function updatePrinterHint(): void {
  const pages = `ประมาณ ${estimatePages()} หน้า A4 แนวตั้ง`
  const dotMatrix = /LQ-?\d|dot ?matrix/i.test(select('cu-printer').value)
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
  try {
    const res = pdfOnly
      ? await savePdf({ bodyClass: 'printing-cashup', pageCss: PAGE_CSS, landscape: false, defaultFileName: fileName })
      : await runPrint({
          bodyClass: 'printing-cashup',
          deviceName: select('cu-printer').value,
          copies: Math.max(1, Math.min(20, parseInt(input('cu-copies').value, 10) || 1)),
          landscape: false,
          // Hard cap: pages actually laid out, plus one for rounding.
          pageCount: estimatePages() + 1,
          pageSize: 'A4',
          pageCss: PAGE_CSS,
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
  for (const id of ['cu-float', 'cu-in', 'cu-out']) {
    input(id).addEventListener('input', () => {
      dirty = true
      recalc()
    })
  }
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
  select('cu-printer').addEventListener('change', updatePrinterHint)
  $('cu-pv-print').addEventListener('click', () => void doPrint(false))
  $('cu-pv-pdf').addEventListener('click', () => void doPrint(true))
}
