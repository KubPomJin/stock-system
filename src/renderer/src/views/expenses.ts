// ขายหน้าร้าน — รายจ่ายประจำวัน (v1.6.15)
//
// Money that leaves the shop during the day: fuel, paying a supplier when
// goods arrive (cash if the drawer has enough, a cheque if not) and employees
// drawing a cash advance. Lines are keyed as they happen; the cash ones are
// what the cash-up subtracts for the day, so nobody has to add them up at
// closing time. The second panel (manager and up) shows advances per employee.

import { $, baht, esc, input } from '../format'
import { level } from '../state'
import { promptModal, showToast, toastError } from '../ui'
import type {
  AdvanceReport,
  DaySummary,
  ExpenseCategory,
  ExpenseDay,
  ExpensePayMethod,
  ExpenseView
} from '../../../shared/types'
import { money, thaiDate, thaiDateTime, THAI_MONTHS, todayIso } from './salesCommon'

const SHORT_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

interface CatInfo {
  value: ExpenseCategory
  label: string
  icon: string
  payeeLabel: string
  payeePlaceholder: string
  cheque: boolean // can be paid by cheque
}

const CATS: CatInfo[] = [
  { value: 'FUEL', label: 'น้ำมันรถ', icon: 'ti-gas-station', payeeLabel: 'รถ / คนเติม (ถ้ามี)', payeePlaceholder: 'เช่น กระบะ บท-1234', cheque: false },
  { value: 'STOCK', label: 'จ่ายค่าสินค้า', icon: 'ti-truck-delivery', payeeLabel: 'ผู้จำหน่ายที่จ่ายเงินให้', payeePlaceholder: 'ชื่อร้าน / บริษัท', cheque: true },
  { value: 'ADVANCE', label: 'พนักงานเบิกล่วงหน้า', icon: 'ti-user-dollar', payeeLabel: 'ชื่อพนักงานที่เบิก', payeePlaceholder: 'เลือกชื่อเดิม หรือพิมพ์ชื่อใหม่', cheque: false },
  { value: 'OTHER', label: 'อื่นๆ', icon: 'ti-dots', payeeLabel: 'จ่ายให้ใคร (ถ้ามี)', payeePlaceholder: '', cheque: true }
]

const catInfo = (c: ExpenseCategory): CatInfo => CATS.find((x) => x.value === c) ?? CATS[3]

let day: ExpenseDay | null = null
let salesDay: DaySummary | null = null
let category: ExpenseCategory = 'FUEL'
let method: ExpensePayMethod = 'CASH'
let editingId: number | null = null

let advReport: AdvanceReport | null = null
let advSelected: string | null = null

/* ---------- entry form ---------- */

async function loadPayees(): Promise<void> {
  try {
    const names = await window.api.expenses.payees(category)
    $('ex-payee-list').innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('')
  } catch {
    $('ex-payee-list').innerHTML = '' // suggestions are a convenience — never block keying
  }
}

function applyCategory(): void {
  const info = catInfo(category)
  $('ex-cat-chips').innerHTML = CATS.map(
    (c) =>
      `<button type="button" class="chip${c.value === category ? ' active' : ''}" data-v="${c.value}"><i class="ti ${c.icon}" style="margin-right:6px;"></i>${c.label}</button>`
  ).join('')
  $('ex-cat-chips')
    .querySelectorAll<HTMLButtonElement>('.chip')
    .forEach((b) =>
      b.addEventListener('click', () => {
        category = b.dataset.v as ExpenseCategory
        applyCategory()
        input('ex-payee').focus()
      })
    )
  $('ex-payee-label').textContent = info.payeeLabel
  input('ex-payee').placeholder = info.payeePlaceholder
  if (!info.cheque) method = 'CASH'
  $('ex-method-wrap').style.display = info.cheque ? '' : 'none'
  applyMethod()
  void loadPayees()
}

function applyMethod(): void {
  $('ex-method')
    .querySelectorAll<HTMLButtonElement>('.seg-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.v === method))
  $('ex-cheque-wrap').style.display = method === 'CHEQUE' ? '' : 'none'
  $('ex-form-hint').textContent =
    method === 'CHEQUE'
      ? 'จ่ายด้วยเช็ค — บันทึกไว้เป็นหลักฐาน ไม่หักเงินสดในลิ้นชัก'
      : 'จ่ายด้วยเงินสด — หักจากเงินในลิ้นชักของวันนี้ (ไปลบในหน้าปิดยอดประจำวันให้เอง)'
}

function resetForm(): void {
  editingId = null
  input('ex-payee').value = ''
  input('ex-amount').value = ''
  input('ex-cheque').value = ''
  input('ex-note').value = ''
  method = 'CASH'
  $('ex-form').classList.remove('editing')
  $('ex-form-title').textContent = 'เพิ่มรายจ่าย'
  $('ex-btn-save-text').textContent = 'บันทึกรายจ่าย'
  $('ex-btn-cancel').style.display = 'none'
  applyCategory()
}

function startEdit(e: ExpenseView): void {
  editingId = e.id
  category = e.category
  method = e.payMethod
  applyCategory()
  input('ex-payee').value = e.payee ?? ''
  input('ex-amount').value = String(e.amount)
  input('ex-cheque').value = e.chequeNo ?? ''
  input('ex-note').value = e.note ?? ''
  $('ex-form').classList.add('editing')
  $('ex-form-title').textContent = `แก้ไขรายจ่าย — ${catInfo(e.category).label} ${money(e.amount)}`
  $('ex-btn-save-text').textContent = 'บันทึกการแก้ไข'
  $('ex-btn-cancel').style.display = ''
  $('ex-form').scrollIntoView({ block: 'nearest' })
  input('ex-amount').focus()
}

async function save(): Promise<void> {
  if (!day) return
  const amount = parseFloat(input('ex-amount').value)
  if (!(amount > 0)) {
    showToast('กรุณาใส่จำนวนเงิน', true)
    input('ex-amount').focus()
    return
  }
  const btn = $('ex-btn-save') as HTMLButtonElement
  btn.disabled = true
  try {
    const saved = await window.api.expenses.save({
      id: editingId ?? undefined,
      date: day.date,
      category,
      payMethod: method,
      amount,
      payee: input('ex-payee').value,
      chequeNo: input('ex-cheque').value,
      note: input('ex-note').value
    })
    showToast(`${editingId ? 'แก้ไข' : 'บันทึก'}รายจ่าย ${catInfo(saved.category).label} ${baht(saved.amount)} แล้ว`)
    resetForm()
    await renderExpenses()
    input('ex-payee').focus()
  } catch (err) {
    toastError(err)
  } finally {
    btn.disabled = !!day?.locked
  }
}

/* ---------- the day ---------- */

function kpi(label: string, value: string, sub = '', cls = ''): string {
  return `<div class="kpi-card ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${
    sub ? `<div class="kpi-sub">${sub}</div>` : ''
  }</div>`
}

function methodCell(e: ExpenseView): string {
  if (e.payMethod === 'CHEQUE') {
    return `<span class="badge warn">เช็ค</span>${e.chequeNo ? `<div class="pl-tag mono">${esc(e.chequeNo)}</div>` : ''}`
  }
  return '<span class="badge ok">เงินสด</span>'
}

export async function renderExpenses(): Promise<void> {
  const date = input('ex-date').value || todayIso()
  try {
    // The day's bills are only needed for "how much cash is there to pay with",
    // so a failure there must not hide the expenses themselves.
    ;[day, salesDay] = await Promise.all([
      window.api.expenses.day(date),
      window.api.sales.day(date).catch(() => null)
    ])
  } catch (err) {
    toastError(err)
    return
  }
  const d = day
  const isToday = d.date === todayIso()

  // ---- alerts ----
  const alerts: string[] = []
  if (d.locked) {
    alerts.push(`<div class="alert-banner warn" style="background:var(--ok-bg);border-color:var(--ok-border,#BFE0CC);color:var(--ok);"><i class="ti ti-lock alert-icon"></i>
      <div class="alert-text"><b>เจ้าของตรวจยอดวันที่ ${thaiDate(d.date)} แล้ว</b> — รายจ่ายของวันนี้ถูกล็อก เพิ่ม / แก้ / ยกเลิกไม่ได้</div></div>`)
  } else if (salesDay?.expenseStale) {
    alerts.push(`<div class="alert-banner danger"><i class="ti ti-alert-triangle alert-icon"></i>
      <div class="alert-text"><b>รายจ่ายเปลี่ยนหลังปิดยอดของวันนี้</b> — ตอนปิดยอดหักไว้ ${baht(salesDay.close?.cashOut ?? 0)}
      แต่ตอนนี้จ่ายเงินสดรวม ${baht(d.cashTotal)} · ไปหน้าปิดยอดประจำวันแล้วกด "บันทึกปิดยอด" ใหม่</div></div>`)
  }
  $('ex-alerts').innerHTML = alerts.join('')

  // ---- KPIs ----
  const cashSales = salesDay?.cashTotal ?? 0
  const left = Math.round((cashSales - d.cashTotal) * 100) / 100
  $('ex-kpis').innerHTML =
    kpi('จ่ายเงินสด (ออกจากลิ้นชัก)', baht(d.cashTotal), `${d.lines.filter((l) => !l.voided && l.payMethod === 'CASH').length} รายการ`) +
    kpi('จ่ายด้วยเช็ค', baht(d.chequeTotal), d.chequeTotal ? 'ไม่หักเงินสดในลิ้นชัก' : '') +
    kpi(
      'ขายเงินสด − จ่ายเงินสด',
      baht(left),
      `ขายเงินสด ${money(cashSales)} · ยังไม่รวมเงินทอนตั้งต้น`,
      left < 0 ? 'alert-warn' : ''
    )

  // ---- lines ----
  $('ex-body').innerHTML = d.lines.length
    ? d.lines
        .map((e) => {
          const info = catInfo(e.category)
          const actions = d.locked
            ? ''
            : e.voided
              ? `<button class="btn small" data-act="restore" data-id="${e.id}"><i class="ti ti-arrow-back-up"></i>คืนรายการ</button>`
              : `<button class="btn small" data-act="edit" data-id="${e.id}"><i class="ti ti-pencil"></i>แก้</button>
                 <button class="btn small" data-act="void" data-id="${e.id}" style="color:var(--danger);"><i class="ti ti-x"></i>ยกเลิก</button>`
          return `<tr class="${e.voided ? 'is-void' : ''}">
            <td style="white-space:nowrap;">${thaiDateTime(e.createdAt).slice(11)}</td>
            <td><i class="ti ${info.icon}" style="margin-right:6px;"></i>${info.label}</td>
            <td>${esc(e.payee ?? '')}</td>
            <td>${methodCell(e)}</td>
            <td class="num"><b>${money(e.amount)}</b></td>
            <td>${esc(e.note ?? '')}${e.voided ? `<div class="pl-tag">ยกเลิก: ${esc(e.voidReason ?? '')}</div>` : ''}</td>
            <td style="font-size:13px;">${esc(e.createdBy ?? '')}${
              e.updatedBy ? `<div class="pl-tag">แก้ล่าสุด ${esc(e.updatedBy)}</div>` : ''
            }</td>
            <td style="white-space:nowrap;text-align:right;">${actions}</td>
          </tr>`
        })
        .join('')
    : `<tr><td colspan="8"><div class="empty-state"><i class="ti ti-wallet"></i>ยังไม่มีรายจ่ายของวันที่ ${thaiDate(d.date)}</div></td></tr>`

  $('ex-body')
    .querySelectorAll<HTMLButtonElement>('button[data-act]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        const e = d.lines.find((l) => l.id === Number(b.dataset.id))
        if (!e) return
        if (b.dataset.act === 'edit') startEdit(e)
        if (b.dataset.act === 'void') void voidLine(e)
        if (b.dataset.act === 'restore') void restoreLine(e)
      })
    )

  const cats = d.byCategory
    .map((c) => `${catInfo(c.category).label} <b class="mono">${money(c.cash + c.cheque)}</b>`)
    .join(' · ')
  $('ex-foot').innerHTML = d.count
    ? `<span>${cats}</span><span style="margin-left:auto;font-weight:700;">รวมเงินสด ${baht(d.cashTotal)}${
        d.chequeTotal ? ` · เช็ค ${baht(d.chequeTotal)}` : ''
      }</span>`
    : `<span class="text-muted">${isToday ? 'เพิ่มรายจ่ายรายการแรกของวันนี้ได้จากช่องด้านบน' : ''}</span>`

  // ---- lock ----
  $('ex-form').style.display = d.locked ? 'none' : ''
  ;($('ex-btn-save') as HTMLButtonElement).disabled = d.locked

  $('ex-adv-panel').style.display = level() >= 2 ? '' : 'none'
  if (level() >= 2) await renderAdvances()
}

async function voidLine(e: ExpenseView): Promise<void> {
  const v = await promptModal(
    `ยกเลิกรายจ่าย ${catInfo(e.category).label} ${money(e.amount)} บาท`,
    [{ key: 'reason', label: 'เหตุผลที่ยกเลิก', placeholder: 'เช่น คีย์ซ้ำ / คีย์ผิดวัน' }],
    (vals) => (vals.reason.trim() ? null : 'กรุณาระบุเหตุผล')
  )
  if (!v) return
  try {
    await window.api.expenses.void({ id: e.id, reason: v.reason })
    if (editingId === e.id) resetForm()
    showToast('ยกเลิกรายจ่ายแล้ว')
    await renderExpenses()
  } catch (err) {
    toastError(err)
  }
}

async function restoreLine(e: ExpenseView): Promise<void> {
  try {
    await window.api.expenses.restore(e.id)
    showToast('คืนรายการแล้ว')
    await renderExpenses()
  } catch (err) {
    toastError(err)
  }
}

/* ---------- advances per employee (manager and up) ---------- */

async function loadAdvanceYears(): Promise<void> {
  const sel = $('ex-adv-year') as HTMLSelectElement
  const keep = sel.value
  let years: number[]
  try {
    years = await window.api.expenses.advanceYears()
  } catch {
    years = [new Date().getFullYear()]
  }
  sel.innerHTML = years.map((y) => `<option value="${y}">ปี ${y + 543}</option>`).join('')
  if (keep && years.includes(Number(keep))) sel.value = keep
}

async function renderAdvances(): Promise<void> {
  await loadAdvanceYears()
  const year = Number(($('ex-adv-year') as HTMLSelectElement).value)
  const month = Number(($('ex-adv-month') as HTMLSelectElement).value) || null
  try {
    advReport = await window.api.expenses.advances({ year, month })
  } catch (err) {
    toastError(err)
    return
  }
  const r = advReport
  if (advSelected !== null && !r.rows.some((x) => x.payee === advSelected)) advSelected = null
  const max = Math.max(1, ...r.rows.map((x) => x.total))

  $('ex-adv-body').innerHTML = r.rows.length
    ? r.rows
        .map(
          (x) => `<tr class="ex-adv-row${x.payee === advSelected ? ' selected' : ''}" data-name="${esc(x.payee)}">
            <td><b>${esc(x.payee)}</b></td>
            <td class="num">${x.count}</td>
            <td class="num"><b>${money(x.total)}</b></td>
            <td class="num">${money(x.total / x.count)}</td>
            <td>${thaiDate(x.lastDate)}</td>
            <td class="sr-bar-cell"><div class="sr-bar" style="width:${Math.max(2, (x.total / max) * 100)}%;"></div></td>
          </tr>`
        )
        .join('') +
      `<tr class="sr-total"><td><b>รวม ${r.rows.length} คน</b></td><td class="num">${r.lines.length}</td><td class="num"><b>${money(r.total)}</b></td><td colspan="3"></td></tr>`
    : `<tr><td colspan="6"><div class="empty-state"><i class="ti ti-user-dollar"></i>ไม่มีการเบิกล่วงหน้าในช่วงนี้</div></td></tr>`

  $('ex-adv-body')
    .querySelectorAll<HTMLTableRowElement>('tr.ex-adv-row')
    .forEach((tr) =>
      tr.addEventListener('click', () => {
        advSelected = advSelected === tr.dataset.name ? null : (tr.dataset.name ?? null)
        void renderAdvances()
      })
    )

  renderAdvanceDetail()
}

function renderAdvanceDetail(): void {
  const r = advReport
  const row = r?.rows.find((x) => x.payee === advSelected)
  if (!r || !row) {
    $('ex-adv-detail').innerHTML = ''
    return
  }
  const lines = r.lines.filter((l) => (l.payee ?? '') === row.payee)
  // The month strip only makes sense on a whole-year view.
  const months = r.month
    ? ''
    : `<div class="ex-months">${row.months
        .map((m, i) => `<div class="ex-month${m ? '' : ' zero'}">${SHORT_MONTHS[i]}<b>${m ? money(m) : '—'}</b></div>`)
        .join('')}</div>`
  $('ex-adv-detail').innerHTML = `
    <div class="ex-adv-detail-head">${esc(row.payee)} — เบิก ${row.count} ครั้ง รวม ${baht(row.total)}</div>
    ${months}
    <div class="table-scroll"><table>
      <thead><tr><th>วันที่</th><th class="num">จำนวนเงิน</th><th>หมายเหตุ</th><th>ผู้บันทึก</th></tr></thead>
      <tbody>${lines
        .map(
          (l) => `<tr><td>${thaiDate(l.date)}</td><td class="num"><b>${money(l.amount)}</b></td><td>${esc(l.note ?? '')}</td>
            <td style="font-size:13px;">${esc(l.createdBy ?? '')}</td></tr>`
        )
        .join('')}</tbody>
    </table></div>`
}

/* ---------- init ---------- */

export function initExpenses(): void {
  input('ex-date').value = todayIso()
  input('ex-date').addEventListener('change', () => {
    resetForm()
    void renderExpenses()
  })
  $('ex-method')
    .querySelectorAll<HTMLButtonElement>('.seg-btn')
    .forEach((b) =>
      b.addEventListener('click', () => {
        method = b.dataset.v as ExpensePayMethod
        applyMethod()
        if (method === 'CHEQUE') input('ex-cheque').focus()
      })
    )
  $('ex-btn-save').addEventListener('click', () => void save())
  $('ex-btn-cancel').addEventListener('click', resetForm)
  // Enter in any box saves — an expense is one short line, keyed mid-sale.
  for (const id of ['ex-payee', 'ex-amount', 'ex-cheque', 'ex-note']) {
    input(id).addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return
      ev.preventDefault()
      // Enter on the name moves on to the amount; anywhere else it saves.
      if (id !== 'ex-amount' && !input('ex-amount').value) input('ex-amount').focus()
      else void save()
    })
  }

  const monthSel = $('ex-adv-month') as HTMLSelectElement
  monthSel.innerHTML =
    '<option value="0">ทั้งปี</option>' + THAI_MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')
  monthSel.value = String(new Date().getMonth() + 1)
  monthSel.addEventListener('change', () => void renderAdvances())
  $('ex-adv-year').addEventListener('change', () => void renderAdvances())

  resetForm()
}
