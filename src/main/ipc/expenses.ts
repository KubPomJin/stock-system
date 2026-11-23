// รายจ่ายประจำวัน (v1.6.15) — money that leaves the shop during the day.
//
// Three things the owner sees every day: fuel for the truck, paying a supplier
// when goods arrive (cash if the drawer has enough, otherwise a cheque), and an
// employee drawing a cash advance. Each one is a line in cash_expenses.
//
//  * CASH lines come out of the drawer, so their total is what the cash-up
//    subtracts for the day (sales.ts reads it through expenseTotals()).
//  * CHEQUE lines are recorded for the record only — they never touch the drawer.
//  * Nothing here touches stock. Paying for goods is money only; receiving the
//    goods stays on the รับสินค้า page.
//  * A line is never deleted, only voided (with who/why), like a bill.
//  * The owner's tick on the cash-up page locks the day's expenses as well.

import { getDb } from '../database'
import { getSession } from '../session'
import { handle } from './helpers'
import { isDayLocked, isIsoDate, round2, thaiDate } from './dayLock'
import type {
  AdvanceReport,
  ExpenseCategory,
  ExpenseDay,
  ExpensePayMethod,
  ExpensePayload,
  ExpenseView
} from '../../shared/types'

const CATEGORIES: ExpenseCategory[] = ['FUEL', 'STOCK', 'ADVANCE', 'OTHER']

export const EXPENSE_LABEL: Record<ExpenseCategory, string> = {
  FUEL: 'น้ำมันรถ',
  STOCK: 'จ่ายค่าสินค้า',
  ADVANCE: 'พนักงานเบิกล่วงหน้า',
  OTHER: 'อื่นๆ'
}

function assertDayOpen(date: string): void {
  if (isDayLocked(date)) {
    throw new Error(
      `วันที่ ${thaiDate(date)} เจ้าของตรวจยอดแล้ว จึงแก้ไขรายจ่ายของวันนั้นไม่ได้ — ` +
        'ถ้าจำเป็นต้องแก้ ให้เจ้าของกด "ยกเลิกการตรวจ" ที่หน้าปิดยอดประจำวันก่อน'
    )
  }
}

/* ---------- totals (used by the cash-up in sales.ts) ---------- */

export interface ExpenseTotals {
  count: number // live (not voided) lines
  cashCount: number // live CASH lines — the day is "itemised" for the cash-up when this is > 0
  cashTotal: number // came out of the drawer
  chequeTotal: number // paid by cheque — not drawer money
  byCategory: { category: ExpenseCategory; cash: number; cheque: number }[]
}

export function expenseTotals(date: string): ExpenseTotals {
  const rows = getDb()
    .prepare(
      `SELECT category, pay_method AS payMethod, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
       FROM cash_expenses WHERE voided = 0 AND expense_date = ?
       GROUP BY category, pay_method`
    )
    .all(date) as { category: ExpenseCategory; payMethod: ExpensePayMethod; n: number; total: number }[]

  const out: ExpenseTotals = { count: 0, cashCount: 0, cashTotal: 0, chequeTotal: 0, byCategory: [] }
  for (const c of CATEGORIES) {
    const cash = rows.find((r) => r.category === c && r.payMethod === 'CASH')
    const cheque = rows.find((r) => r.category === c && r.payMethod === 'CHEQUE')
    out.count += (cash?.n ?? 0) + (cheque?.n ?? 0)
    out.cashCount += cash?.n ?? 0
    out.cashTotal += cash?.total ?? 0
    out.chequeTotal += cheque?.total ?? 0
    if (cash || cheque) out.byCategory.push({ category: c, cash: round2(cash?.total ?? 0), cheque: round2(cheque?.total ?? 0) })
  }
  out.cashTotal = round2(out.cashTotal)
  out.chequeTotal = round2(out.chequeTotal)
  return out
}

// "น้ำมันรถ 500.00 · จ่ายค่าสินค้า 2,000.00" — the cash lines only, for the
// note beside "เงินใช้ระหว่างวัน" on the cash-up and its printed sheet.
export function expenseCashSummary(t: ExpenseTotals): string {
  return t.byCategory
    .filter((c) => c.cash > 0)
    .map(
      (c) =>
        `${EXPENSE_LABEL[c.category]} ${c.cash.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    )
    .join(' · ')
}

/* ---------- read ---------- */

const SELECT = `
  SELECT e.id, e.expense_date AS date, e.category, e.pay_method AS payMethod, e.amount,
         e.payee, e.cheque_no AS chequeNo, e.note, e.voided, e.void_reason AS voidReason,
         e.created_at AS createdAt, cu.display_name AS createdBy,
         e.updated_at AS updatedAt, uu.display_name AS updatedBy
  FROM cash_expenses e
  LEFT JOIN users cu ON cu.id = e.created_by
  LEFT JOIN users uu ON uu.id = e.updated_by`

type Row = Omit<ExpenseView, 'voided'> & { voided: number }

function toView(r: Row): ExpenseView {
  return { ...r, voided: !!r.voided }
}

function getExpense(id: number): ExpenseView {
  const r = getDb().prepare(`${SELECT} WHERE e.id = ?`).get(id) as Row | undefined
  if (!r) throw new Error('ไม่พบรายจ่ายนี้')
  return toView(r)
}

function expenseDay(date: string): ExpenseDay {
  if (!isIsoDate(date)) throw new Error('วันที่ไม่ถูกต้อง')
  const lines = (getDb().prepare(`${SELECT} WHERE e.expense_date = ? ORDER BY e.id`).all(date) as Row[]).map(toView)
  const t = expenseTotals(date)
  return {
    date,
    locked: isDayLocked(date),
    lines,
    count: t.count,
    cashTotal: t.cashTotal,
    chequeTotal: t.chequeTotal,
    byCategory: t.byCategory
  }
}

/* ---------- write ---------- */

function saveExpense(p: ExpensePayload): ExpenseView {
  const user = getSession()!
  if (!p || !isIsoDate(p.date)) throw new Error('วันที่ไม่ถูกต้อง')
  if (!CATEGORIES.includes(p.category)) throw new Error('ประเภทรายจ่ายไม่ถูกต้อง')

  const amount = round2(Number(p.amount) || 0)
  if (!(amount > 0)) throw new Error('จำนวนเงินต้องมากกว่า 0')

  // Fuel and advances are always drawer cash — only goods and "other" can go by cheque.
  let payMethod: ExpensePayMethod = p.payMethod === 'CHEQUE' ? 'CHEQUE' : 'CASH'
  if (p.category === 'FUEL' || p.category === 'ADVANCE') payMethod = 'CASH'

  const payee = (p.payee ?? '').trim().replace(/\s+/g, ' ')
  if (p.category === 'ADVANCE' && !payee) throw new Error('กรุณาใส่ชื่อพนักงานที่เบิก')
  if (p.category === 'STOCK' && !payee) throw new Error('กรุณาใส่ชื่อผู้จำหน่ายที่จ่ายเงินให้')
  const chequeNo = payMethod === 'CHEQUE' ? (p.chequeNo ?? '').trim() || null : null
  const note = (p.note ?? '').trim() || null

  const db = getDb()
  assertDayOpen(p.date)

  if (p.id) {
    const old = getExpense(p.id)
    if (old.voided) throw new Error('รายจ่ายนี้ถูกยกเลิกแล้ว — กด "คืนรายการ" ก่อนจึงจะแก้ไขได้')
    if (old.date !== p.date) assertDayOpen(old.date) // moving a line: both days must be open
    db.prepare(
      `UPDATE cash_expenses
       SET expense_date = ?, category = ?, pay_method = ?, amount = ?, payee = ?, cheque_no = ?, note = ?,
           updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(p.date, p.category, payMethod, amount, payee || null, chequeNo, note, user.id, p.id)
    return getExpense(p.id)
  }

  const res = db
    .prepare(
      `INSERT INTO cash_expenses (expense_date, category, pay_method, amount, payee, cheque_no, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(p.date, p.category, payMethod, amount, payee || null, chequeNo, note, user.id)
  return getExpense(Number(res.lastInsertRowid))
}

function setVoided(id: number, voided: boolean, reason: string): void {
  const user = getSession()!
  const e = getExpense(id)
  if (voided && !reason.trim()) throw new Error('กรุณาระบุเหตุผลที่ยกเลิกรายจ่าย')
  if (voided === e.voided) throw new Error(voided ? 'รายจ่ายนี้ถูกยกเลิกไปแล้ว' : 'รายจ่ายนี้ยังไม่ได้ถูกยกเลิก')
  assertDayOpen(e.date)
  getDb()
    .prepare(
      `UPDATE cash_expenses SET voided = ?, void_reason = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    .run(voided ? 1 : 0, voided ? reason.trim() || null : null, user.id, id)
}

/* ---------- suggestions + advances report ---------- */

// Names already used for this kind of expense, most recent first, so the same
// employee / supplier is typed the same way every time (the advances report
// groups by the exact name).
function payees(category: ExpenseCategory): string[] {
  if (!CATEGORIES.includes(category)) return []
  const db = getDb()
  const used = (
    db
      .prepare(
        `SELECT payee FROM cash_expenses
         WHERE category = ? AND payee IS NOT NULL AND payee <> ''
         GROUP BY payee ORDER BY MAX(id) DESC LIMIT 200`
      )
      .all(category) as { payee: string }[]
  ).map((r) => r.payee)
  if (category !== 'STOCK') return used
  // Supplier names only — no prices or costs, so this is safe at staff level.
  const suppliers = (db.prepare('SELECT name FROM suppliers ORDER BY name').all() as { name: string }[]).map((r) => r.name)
  return [...new Set([...used, ...suppliers])]
}

function advances(p: { year: number; month?: number | null }): AdvanceReport {
  const year = Math.floor(Number(p?.year))
  if (!(year >= 2000 && year <= 2200)) throw new Error('ปีไม่ถูกต้อง')
  const month = p?.month ? Math.floor(Number(p.month)) : null
  if (month !== null && !(month >= 1 && month <= 12)) throw new Error('เดือนไม่ถูกต้อง')

  const from = month ? `${year}-${String(month).padStart(2, '0')}-01` : `${year}-01-01`
  const to = month ? `${year}-${String(month).padStart(2, '0')}-31` : `${year}-12-31`

  const lines = (
    getDb()
      .prepare(
        `${SELECT} WHERE e.category = 'ADVANCE' AND e.voided = 0 AND e.expense_date BETWEEN ? AND ?
         ORDER BY e.expense_date DESC, e.id DESC`
      )
      .all(from, to) as Row[]
  ).map(toView)

  const byName = new Map<string, { payee: string; count: number; total: number; lastDate: string; months: number[] }>()
  for (const l of lines) {
    const name = l.payee ?? ''
    let r = byName.get(name)
    if (!r) byName.set(name, (r = { payee: name, count: 0, total: 0, lastDate: l.date, months: Array(12).fill(0) }))
    r.count++
    r.total += l.amount
    if (l.date > r.lastDate) r.lastDate = l.date
    r.months[Number(l.date.slice(5, 7)) - 1] += l.amount
  }
  const rows = [...byName.values()]
    .map((r) => ({ ...r, total: round2(r.total), months: r.months.map(round2) }))
    .sort((a, b) => b.total - a.total)

  return { year, month, rows, lines, total: round2(rows.reduce((s, r) => s + r.total, 0)) }
}

function advanceYears(): number[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT CAST(substr(expense_date, 1, 4) AS INTEGER) AS y
       FROM cash_expenses WHERE category = 'ADVANCE' AND voided = 0 ORDER BY y DESC`
    )
    .all() as { y: number }[]
  const years = rows.map((r) => r.y)
  const thisYear = new Date().getFullYear()
  if (!years.includes(thisYear)) years.unshift(thisYear)
  return years
}

export function registerExpenseHandlers(): void {
  handle('expenses:day', 1, (date: string) => expenseDay(date))
  handle('expenses:save', 1, (p: ExpensePayload) => saveExpense(p))
  handle('expenses:void', 1, (p: { id: number; reason: string }) => setVoided(Number(p?.id), true, String(p?.reason ?? '')))
  handle('expenses:restore', 1, (id: number) => setVoided(Number(id), false, ''))
  handle('expenses:payees', 1, (category: ExpenseCategory) => payees(category))
  // Who draws advances, and how often, is for the owner / manager — not the counter.
  handle('expenses:advances', 2, (p: { year: number; month?: number | null }) => advances(p))
  handle('expenses:advanceYears', 2, () => advanceYears())
}
