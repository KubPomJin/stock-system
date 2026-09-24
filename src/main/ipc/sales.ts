// ขายหน้าร้าน / POS (v1.6.0, "ไม่มีใบ" bills v1.6.1)
//
// The shop still writes order tickets by hand. This module is where those
// tickets get keyed in afterwards so the money can be checked every day and the
// sales history builds up month by month.
//
//   * A sale IS an order_docs row — the paper ticket number (A69-0001) is the
//     key that ties the paper to the system. The order page and this page share
//     the table and the number counter.
//   * Money only: sales never touch stock_movements. Stock is still corrected by
//     the daily count (owner's decision for the trial period).
//   * Cash / transfer / credit amounts are DERIVED in SQL from payment_method +
//     grand_total (the fragments below) so they can never drift from the bill.
//   * Once the owner has checked a day's cash-up, that day's bills are locked.
//     Transfer checking stays open on purpose — bank statements are matched
//     days later, which is the whole point of that page.

import { getDb } from '../database'
import { getSession } from '../session'
import { handle } from './helpers'
import { BOOK_TYPES, counterKey, formatDocNumber, readCounter, syncCounterWithUsedNumber, yearPart } from './orders'
import type {
  BookNextNumber,
  CashCloseView,
  CashClosePayload,
  DaySummary,
  MonthlyRow,
  ProductSalesRow,
  ProductTrendRow,
  SaleFilter,
  SaleLineView,
  SalePayload,
  SalePayMethod,
  SaleView,
  TransferStatus
} from '../../shared/types'

/* ---------- the money split, defined once ---------- */

// Tickets filled on the old order page may have no doc_date — fall back to the
// local date they were saved.
const DAY = `COALESCE(o.doc_date, date(o.created_at, 'localtime'))`
const CASH = `(CASE o.payment_method WHEN 'CASH' THEN o.grand_total
                WHEN 'MIXED' THEN o.grand_total - COALESCE(o.transfer_amount, 0) ELSE 0 END)`
const TRANSFER = `(CASE o.payment_method WHEN 'TRANSFER' THEN COALESCE(NULLIF(o.transfer_amount, 0), o.grand_total)
                    WHEN 'MIXED' THEN COALESCE(o.transfer_amount, 0) ELSE 0 END)`
const CREDIT = `(CASE WHEN o.payment_method = 'CREDIT' THEN o.grand_total ELSE 0 END)`
const UNSPECIFIED = `(CASE WHEN o.payment_method IS NULL
                        OR o.payment_method NOT IN ('CASH','TRANSFER','MIXED','CREDIT') THEN o.grand_total ELSE 0 END)`
// NULL transfer_status on a bill that carries a transfer = not checked yet.
const T_STATUS = `(CASE WHEN ${TRANSFER} > 0 THEN COALESCE(o.transfer_status, 'PENDING') ELSE NULL END)`

const PAY_METHODS: SalePayMethod[] = ['CASH', 'TRANSFER', 'MIXED', 'CREDIT']
const TRANSFER_STATUSES: TransferStatus[] = ['PENDING', 'VERIFIED', 'NOT_FOUND']
// Thai banknotes + coins counted in the drawer. Satang and odd amounts go in
// the separate "coins_other" field as a baht figure.
const DENOMINATIONS = [1000, 500, 100, 50, 20, 10, 5, 2, 1]

const SALE_SELECT = `
  SELECT o.id,
         o.doc_number       AS docNumber,
         o.no_ticket        AS noTicket,
         o.book_type        AS bookType,
         ${DAY}             AS docDate,
         o.doc_time         AS docTime,
         o.customer_name    AS customerName,
         o.customer_contact AS customerContact,
         o.payment_method   AS paymentMethod,
         o.cash_received    AS cashReceived,
         o.cash_change      AS cashChange,
         ${CASH}            AS cashAmount,
         ${TRANSFER}        AS transferAmount,
         ${CREDIT}          AS creditAmount,
         o.transfer_ref     AS transferRef,
         ${T_STATUS}        AS transferStatus,
         o.transfer_verified_at AS transferVerifiedAt,
         vu.display_name    AS transferVerifiedBy,
         o.transfer_note    AS transferNote,
         o.subtotal,
         o.delivery_fee     AS deliveryFee,
         o.grand_total      AS grandTotal,
         o.note,
         o.voided,
         o.void_reason      AS voidReason,
         (SELECT COUNT(*) FROM order_doc_lines l WHERE l.order_id = o.id) AS lineCount,
         o.created_at       AS createdAt,
         cu.display_name    AS createdBy,
         o.updated_at       AS updatedAt
  FROM order_docs o
  LEFT JOIN users cu ON cu.id = o.created_by
  LEFT JOIN users vu ON vu.id = o.transfer_verified_by`

type SaleRow = Omit<SaleView, 'voided' | 'noTicket'> & { voided: number; noTicket: number }

function toView(r: SaleRow): SaleView {
  return { ...r, voided: r.voided === 1, noTicket: r.noTicket === 1 }
}

// Bills sold without a printed ticket get their own series, numbered by the
// system: 'N' + Buddhist year of the sale + running number (N69-0001). The
// letter is outside the A-D paper books, so it never touches their counters
// or shows up in their missing-number check.
const NO_TICKET_PREFIX = 'N'

function nextNoTicketNumber(docDate: string): string {
  const yy = String((Number(docDate.slice(0, 4)) + 543) % 100).padStart(2, '0')
  const rows = getDb()
    .prepare('SELECT doc_number FROM order_docs WHERE doc_number LIKE ?')
    .all(`${NO_TICKET_PREFIX}${yy}-%`) as { doc_number: string }[]
  let max = 0
  for (const r of rows) {
    const m = r.doc_number.match(/-(\d+)$/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${NO_TICKET_PREFIX}${yy}-${String(max + 1).padStart(4, '0')}`
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/* ---------- day lock ---------- */

function isDayLocked(date: string): boolean {
  const row = getDb()
    .prepare('SELECT owner_checked_at FROM cash_closes WHERE close_date = ?')
    .get(date) as { owner_checked_at: string | null } | undefined
  return !!row?.owner_checked_at
}

function assertDayOpen(date: string): void {
  if (isDayLocked(date)) {
    throw new Error(
      `วันที่ ${thaiDate(date)} เจ้าของตรวจยอดแล้ว จึงแก้ไขบิลของวันนั้นไม่ได้ — ` +
        'ถ้าจำเป็นต้องแก้ ให้เจ้าของกด "ยกเลิกการตรวจ" ที่หน้าปิดยอดประจำวันก่อน'
    )
  }
}

function thaiDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d}/${m}/${Number(y) + 543}` : iso
}

/* ---------- list ---------- */

function listSales(filter: SaleFilter, opts: { transfersOnly?: boolean; order?: 'asc' | 'desc' } = {}): SaleView[] {
  const where: string[] = []
  const args: unknown[] = []
  if (filter.dateFrom) {
    where.push(`${DAY} >= ?`)
    args.push(filter.dateFrom)
  }
  if (filter.dateTo) {
    where.push(`${DAY} <= ?`)
    args.push(filter.dateTo)
  }
  if (!filter.includeVoided) where.push('o.voided = 0')
  if (opts.transfersOnly) where.push(`${TRANSFER} > 0`)
  if (filter.transferStatus && filter.transferStatus !== 'ALL') {
    where.push(`${T_STATUS} = ?`)
    args.push(filter.transferStatus)
  }
  const q = filter.search?.trim()
  if (q) {
    const like = `%${q}%`
    where.push(
      `(o.doc_number LIKE ? OR o.customer_name LIKE ? OR o.transfer_ref LIKE ? OR o.transfer_note LIKE ?
        OR EXISTS (SELECT 1 FROM order_doc_lines l WHERE l.order_id = o.id AND l.description LIKE ?))`
    )
    args.push(like, like, like, like, like)
  }
  const dir = opts.order === 'asc' ? 'ASC' : 'DESC'
  const sql = `${SALE_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${DAY} ${dir}, o.doc_number ${dir}
    LIMIT ?`
  args.push(Math.min(Math.max(filter.limit ?? 500, 1), 5000))
  return (getDb().prepare(sql).all(...args) as SaleRow[]).map(toView)
}

function getSale(id: number): SaleView {
  const row = getDb().prepare(`${SALE_SELECT} WHERE o.id = ?`).get(id) as SaleRow | undefined
  if (!row) throw new Error('ไม่พบบิลนี้')
  return toView(row)
}

/* ---------- save ---------- */

function saveSale(p: SalePayload): { id: number; docNumber: string } {
  const user = getSession()!
  const db = getDb()

  const noTicket = !!p.noTicket
  if (!isIsoDate(p.docDate ?? '')) throw new Error('กรุณาระบุวันที่ของบิล')
  let docNumber = String(p.docNumber ?? '').trim().toUpperCase()
  if (!noTicket) {
    if (!docNumber) throw new Error('กรุณาระบุเลขที่ใบสั่งสินค้า (หรือเลือก "ไม่มีใบ" ถ้าขายโดยไม่ได้ใช้ใบที่พิมพ์ไว้)')
    if (!/^[A-Z]{1,2}\d{2,4}-\d{1,5}$/.test(docNumber)) {
      throw new Error(`รูปแบบเลขที่ใบไม่ถูกต้อง "${docNumber}" — ต้องเป็นแบบ A69-0012`)
    }
    if (docNumber.startsWith(NO_TICKET_PREFIX)) {
      throw new Error(`เลขที่ขึ้นต้นด้วย ${NO_TICKET_PREFIX} ใช้กับบิลที่ไม่มีใบเท่านั้น — ถ้าบิลนี้ไม่มีใบ ให้เลือก "ไม่มีใบ"`)
    }
  }
  if (!PAY_METHODS.includes(p.paymentMethod)) throw new Error('กรุณาเลือกวิธีชำระเงิน')

  const lines = (p.lines ?? [])
    .map((l) => ({
      productId: l.productId ?? null,
      description: String(l.description ?? '').trim(),
      qty: Number(l.qty) || 0,
      unitName: String(l.unitName ?? '').trim(),
      unitPrice: Number(l.unitPrice) || 0
    }))
    .filter((l) => l.description !== '')
  if (!lines.length) throw new Error('กรุณาใส่รายการสินค้าอย่างน้อย 1 รายการ')
  for (const l of lines) {
    if (!(l.qty > 0)) throw new Error(`จำนวนของ "${l.description}" ต้องมากกว่า 0`)
    if (l.unitPrice < 0) throw new Error(`ราคาของ "${l.description}" ติดลบไม่ได้`)
  }

  const subtotal = round2(lines.reduce((s, l) => s + round2(l.qty * l.unitPrice), 0))
  const deliveryFee = round2(Math.max(Number(p.deliveryFee) || 0, 0))
  const grandTotal = round2(subtotal + deliveryFee)

  // Split the bill into what went where. TRANSFER always means the whole bill.
  let transferAmount: number | null = null
  let cashPart = 0
  if (p.paymentMethod === 'TRANSFER') transferAmount = grandTotal
  if (p.paymentMethod === 'CASH') cashPart = grandTotal
  if (p.paymentMethod === 'MIXED') {
    transferAmount = round2(Number(p.transferAmount) || 0)
    if (!(transferAmount > 0 && transferAmount < grandTotal)) {
      throw new Error('จ่ายแบบเงินสด+โอน: ยอดโอนต้องมากกว่า 0 และน้อยกว่ายอดรวมของบิล')
    }
    cashPart = round2(grandTotal - transferAmount)
  }

  let cashReceived: number | null = null
  let cashChange: number | null = null
  if (cashPart > 0 && p.cashReceived != null && Number(p.cashReceived) > 0) {
    cashReceived = round2(Number(p.cashReceived))
    if (cashReceived < cashPart) {
      throw new Error(`รับเงินสดมา ${cashReceived.toLocaleString('th-TH')} บาท น้อยกว่ายอดที่ต้องจ่ายเป็นเงินสด ${cashPart.toLocaleString('th-TH')} บาท`)
    }
    cashChange = round2(cashReceived - cashPart)
  }

  const run = db.transaction((): { id: number; docNumber: string } => {
    // No-ticket bills keep the number they already have when edited; a new one
    // (or a paper bill switched to "no ticket") takes the next N number. Done
    // inside the transaction so two saves can't be handed the same number.
    if (noTicket) {
      const current = p.id
        ? (db.prepare('SELECT doc_number, no_ticket FROM order_docs WHERE id = ?').get(p.id) as
            | { doc_number: string; no_ticket: number }
            | undefined)
        : undefined
      docNumber = current?.no_ticket ? current.doc_number : nextNoTicketNumber(p.docDate)
    }
    const bookType = !noTicket && BOOK_TYPES.includes(docNumber[0]) ? docNumber[0] : null

    const dup = db.prepare('SELECT id FROM order_docs WHERE doc_number = ? AND id IS NOT ?').get(docNumber, p.id ?? null)
    if (dup) throw new Error(`เลขที่ใบ ${docNumber} คีย์ไปแล้ว — ถ้าจะแก้ ให้กด "แก้ไข" ที่บิลนั้นในรายการ`)

    let id: number
    if (p.id) {
      const old = db
        .prepare(`SELECT o.voided, ${DAY} AS day, ${TRANSFER} AS transfer, o.transfer_status FROM order_docs o WHERE o.id = ?`)
        .get(p.id) as { voided: number; day: string; transfer: number; transfer_status: string | null } | undefined
      if (!old) throw new Error('ไม่พบบิลที่จะแก้ไข')
      if (old.voided) throw new Error('บิลนี้ถูกยกเลิกไปแล้ว แก้ไขไม่ได้')
      assertDayOpen(old.day)
      assertDayOpen(p.docDate)

      // A transfer that was already matched to the bank stays matched only if
      // the amount is unchanged — otherwise it has to be checked again.
      const newTransfer = transferAmount ?? 0
      const keepCheck = newTransfer > 0 && old.transfer_status && Math.abs(old.transfer - newTransfer) < 0.005
      db.prepare(
        `UPDATE order_docs SET
           doc_number = ?, no_ticket = ?, book_type = ?, doc_date = ?, doc_time = ?, customer_name = ?, customer_contact = ?,
           payment_method = ?, cash_received = ?, cash_change = ?, transfer_amount = ?, transfer_ref = ?,
           note = ?, subtotal = ?, delivery_fee = ?, grand_total = ?,
           transfer_status = ?,
           transfer_verified_at = CASE WHEN ? THEN transfer_verified_at ELSE NULL END,
           transfer_verified_by = CASE WHEN ? THEN transfer_verified_by ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP, updated_by = ?
         WHERE id = ?`
      ).run(
        docNumber,
        noTicket ? 1 : 0,
        bookType,
        p.docDate,
        p.docTime || null,
        p.customerName?.trim() || null,
        p.customerContact?.trim() || null,
        p.paymentMethod,
        cashReceived,
        cashChange,
        transferAmount,
        p.transferRef?.trim() || null,
        p.note?.trim() || null,
        subtotal,
        deliveryFee,
        grandTotal,
        newTransfer > 0 ? (keepCheck ? old.transfer_status : 'PENDING') : null,
        keepCheck ? 1 : 0,
        keepCheck ? 1 : 0,
        user.id,
        p.id
      )
      db.prepare('DELETE FROM order_doc_lines WHERE order_id = ?').run(p.id)
      id = p.id
    } else {
      assertDayOpen(p.docDate)
      id = Number(
        db
          .prepare(
            `INSERT INTO order_docs
               (doc_number, no_ticket, book_type, doc_date, doc_time, customer_name, customer_contact,
                payment_method, cash_received, cash_change, transfer_amount, transfer_ref,
                note, subtotal, delivery_fee, grand_total, transfer_status, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            docNumber,
            noTicket ? 1 : 0,
            bookType,
            p.docDate,
            p.docTime || null,
            p.customerName?.trim() || null,
            p.customerContact?.trim() || null,
            p.paymentMethod,
            cashReceived,
            cashChange,
            transferAmount,
            p.transferRef?.trim() || null,
            p.note?.trim() || null,
            subtotal,
            deliveryFee,
            grandTotal,
            (transferAmount ?? 0) > 0 ? 'PENDING' : null,
            user.id
          ).lastInsertRowid
      )
    }

    const ins = db.prepare(
      `INSERT INTO order_doc_lines (order_id, line_no, product_id, description, location_name, qty, unit_name, unit_price, amount)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`
    )
    lines.forEach((l, i) => {
      ins.run(id, i + 1, l.productId, l.description, l.qty, l.unitName || null, l.unitPrice, round2(l.qty * l.unitPrice))
    })

    if (bookType) syncCounterWithUsedNumber(bookType, docNumber)
    return { id, docNumber }
  })

  return run()
}

/* ---------- day summary + missing numbers ---------- */

// Ticket numbers that were skipped inside each book's keyed sequence. A missing
// number is a ticket that was written (or spoiled) but never keyed — exactly
// what the owner wants to chase. Voided tickets count as accounted for.
function findGaps(books: Set<string>): DaySummary['gaps'] {
  const db = getDb()
  const out: DaySummary['gaps'] = []
  for (const bookYear of books) {
    const book = bookYear.slice(0, 1)
    const yy = bookYear.slice(1)
    const rows = db
      .prepare('SELECT doc_number FROM order_docs WHERE doc_number LIKE ? AND no_ticket = 0')
      .all(`${book}${yy}-%`) as { doc_number: string }[]
    const nums = new Set<number>()
    let width = 4
    for (const r of rows) {
      const m = r.doc_number.match(/-(\d+)$/)
      if (!m) continue
      nums.add(Number(m[1]))
      width = Math.max(width, m[1].length)
    }
    if (nums.size < 2) continue
    const sorted = [...nums].sort((a, b) => a - b)
    const missing: string[] = []
    let more = 0
    for (let n = sorted[0] + 1; n < sorted[sorted.length - 1]; n++) {
      if (nums.has(n)) continue
      if (missing.length < 40) missing.push(`${book}${yy}-${String(n).padStart(width, '0')}`)
      else more++
    }
    if (missing.length) out.push({ book: `${book}${yy}`, numbers: missing, more })
  }
  return out.sort((a, b) => a.book.localeCompare(b.book))
}

interface CloseRow {
  id: number
  close_date: string
  opening_float: number
  cash_in_other: number
  cash_out: number
  adjust_note: string | null
  counts_json: string | null
  coins_other: number
  counted_total: number
  bill_count: number
  grand_total: number
  cash_total: number
  transfer_total: number
  credit_total: number
  expected_cash: number
  difference: number
  note: string | null
  closed_at: string
  closed_by_name: string | null
  owner_checked_at: string | null
  owner_checked_by_name: string | null
  owner_note: string | null
}

function readClose(date: string): CashCloseView | null {
  const r = getDb()
    .prepare(
      `SELECT c.*, cu.display_name AS closed_by_name, ou.display_name AS owner_checked_by_name
       FROM cash_closes c
       LEFT JOIN users cu ON cu.id = c.closed_by
       LEFT JOIN users ou ON ou.id = c.owner_checked_by
       WHERE c.close_date = ?`
    )
    .get(date) as CloseRow | undefined
  if (!r) return null
  let counts: Record<string, number> = {}
  try {
    counts = r.counts_json ? JSON.parse(r.counts_json) : {}
  } catch {
    counts = {}
  }
  return {
    id: r.id,
    date: r.close_date,
    openingFloat: r.opening_float,
    cashInOther: r.cash_in_other,
    cashOut: r.cash_out,
    adjustNote: r.adjust_note ?? '',
    counts,
    coinsOther: r.coins_other,
    note: r.note ?? '',
    countedTotal: r.counted_total,
    billCount: r.bill_count,
    grandTotal: r.grand_total,
    cashTotal: r.cash_total,
    transferTotal: r.transfer_total,
    creditTotal: r.credit_total,
    expectedCash: r.expected_cash,
    difference: r.difference,
    closedBy: r.closed_by_name,
    closedAt: r.closed_at,
    ownerCheckedBy: r.owner_checked_by_name,
    ownerCheckedAt: r.owner_checked_at,
    ownerNote: r.owner_note
  }
}

interface DayTotals {
  billCount: number
  grandTotal: number
  cashTotal: number
  transferTotal: number
  creditTotal: number
}

function dayTotals(date: string): DayTotals {
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS billCount,
              COALESCE(SUM(o.grand_total), 0) AS grandTotal,
              COALESCE(SUM(${CASH}), 0) AS cashTotal,
              COALESCE(SUM(${TRANSFER}), 0) AS transferTotal,
              COALESCE(SUM(${CREDIT}), 0) AS creditTotal
       FROM order_docs o WHERE o.voided = 0 AND ${DAY} = ?`
    )
    .get(date) as DayTotals
  return {
    billCount: r.billCount,
    grandTotal: round2(r.grandTotal),
    cashTotal: round2(r.cashTotal),
    transferTotal: round2(r.transferTotal),
    creditTotal: round2(r.creditTotal)
  }
}

function daySummary(date: string): DaySummary {
  if (!isIsoDate(date)) throw new Error('วันที่ไม่ถูกต้อง')
  const sales = listSales({ dateFrom: date, dateTo: date, includeVoided: true, limit: 5000 }, { order: 'asc' })
  const live = sales.filter((s) => !s.voided)
  const sum = (f: (s: SaleView) => number): number => round2(live.reduce((a, s) => a + f(s), 0))

  const totals = dayTotals(date)
  const close = readClose(date)
  const closeStale =
    !!close &&
    (close.billCount !== totals.billCount ||
      Math.abs(close.grandTotal - totals.grandTotal) > 0.005 ||
      Math.abs(close.cashTotal - totals.cashTotal) > 0.005 ||
      Math.abs(close.transferTotal - totals.transferTotal) > 0.005 ||
      Math.abs(close.creditTotal - totals.creditTotal) > 0.005)

  const bookYears = new Set<string>()
  for (const s of sales) {
    if (s.noTicket) continue // N-series is numbered by the system — nothing can go missing
    const m = s.docNumber.match(/^([A-Z])(\d{2})-\d+$/)
    if (m) bookYears.add(m[1] + m[2])
  }

  return {
    date,
    billCount: totals.billCount,
    voidCount: sales.length - live.length,
    noTicketCount: live.filter((s) => s.noTicket).length,
    grandTotal: totals.grandTotal,
    cashTotal: totals.cashTotal,
    transferTotal: totals.transferTotal,
    transferVerified: sum((s) => (s.transferStatus === 'VERIFIED' ? s.transferAmount : 0)),
    transferPending: sum((s) => (s.transferStatus === 'PENDING' ? s.transferAmount : 0)),
    transferNotFound: sum((s) => (s.transferStatus === 'NOT_FOUND' ? s.transferAmount : 0)),
    creditTotal: totals.creditTotal,
    unspecifiedTotal: round2(
      (getDb()
        .prepare(`SELECT COALESCE(SUM(${UNSPECIFIED}), 0) AS v FROM order_docs o WHERE o.voided = 0 AND ${DAY} = ?`)
        .get(date) as { v: number }).v
    ),
    deliveryFeeTotal: sum((s) => s.deliveryFee),
    sales,
    gaps: findGaps(bookYears),
    close,
    closeStale,
    locked: !!close?.ownerCheckedAt
  }
}

/* ---------- cash-up ---------- */

function saveClose(p: CashClosePayload): CashCloseView {
  const user = getSession()!
  if (!isIsoDate(p.date)) throw new Error('วันที่ไม่ถูกต้อง')
  assertDayOpen(p.date)

  const money = (v: unknown, label: string): number => {
    const n = round2(Number(v) || 0)
    if (n < 0) throw new Error(`${label} ติดลบไม่ได้`)
    return n
  }
  const openingFloat = money(p.openingFloat, 'เงินทอนตั้งต้น')
  const cashInOther = money(p.cashInOther, 'เงินเข้าอื่นๆ')
  const cashOut = money(p.cashOut, 'เงินจ่ายออก')
  const coinsOther = money(p.coinsOther, 'เศษสตางค์ / อื่นๆ')

  const counts: Record<string, number> = {}
  let countedTotal = coinsOther
  for (const d of DENOMINATIONS) {
    const c = Math.floor(Number(p.counts?.[String(d)]) || 0)
    if (c < 0) throw new Error(`จำนวนของ ${d} บาท ติดลบไม่ได้`)
    if (c > 0) counts[String(d)] = c
    countedTotal += c * d
  }
  countedTotal = round2(countedTotal)

  const t = dayTotals(p.date)
  const expectedCash = round2(openingFloat + t.cashTotal + cashInOther - cashOut)
  const difference = round2(countedTotal - expectedCash)

  getDb()
    .prepare(
      `INSERT INTO cash_closes
         (close_date, opening_float, cash_in_other, cash_out, adjust_note, counts_json, coins_other, counted_total,
          bill_count, grand_total, cash_total, transfer_total, credit_total, expected_cash, difference, note, closed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(close_date) DO UPDATE SET
         opening_float = excluded.opening_float, cash_in_other = excluded.cash_in_other,
         cash_out = excluded.cash_out, adjust_note = excluded.adjust_note, counts_json = excluded.counts_json,
         coins_other = excluded.coins_other, counted_total = excluded.counted_total,
         bill_count = excluded.bill_count, grand_total = excluded.grand_total, cash_total = excluded.cash_total,
         transfer_total = excluded.transfer_total, credit_total = excluded.credit_total,
         expected_cash = excluded.expected_cash, difference = excluded.difference, note = excluded.note,
         closed_by = excluded.closed_by, closed_at = CURRENT_TIMESTAMP`
    )
    .run(
      p.date,
      openingFloat,
      cashInOther,
      cashOut,
      p.adjustNote?.trim() || null,
      JSON.stringify(counts),
      coinsOther,
      countedTotal,
      t.billCount,
      t.grandTotal,
      t.cashTotal,
      t.transferTotal,
      t.creditTotal,
      expectedCash,
      difference,
      p.note?.trim() || null,
      user.id
    )

  return readClose(p.date) as CashCloseView
}

/* ---------- reports ---------- */

function unitList(map: Map<string, number>): { unit: string; qty: number }[] {
  return [...map.entries()]
    .map(([unit, qty]) => ({ unit, qty: round2(qty) }))
    .sort((a, b) => b.qty - a.qty)
}

// Group key for "the same product" across bills: catalogue items by id, typed
// free text by its trimmed wording.
const LINE_KEY = `(CASE WHEN l.product_id IS NOT NULL THEN 'p:' || l.product_id ELSE 't:' || TRIM(l.description) END)`
const LINE_AMOUNT = `COALESCE(l.amount, COALESCE(l.qty, 0) * COALESCE(l.unit_price, 0))`

function topProducts(dateFrom: string, dateTo: string, limit: number): ProductSalesRow[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT ${LINE_KEY} AS k,
              MAX(l.product_id) AS productId,
              MAX(p.barcode) AS barcode,
              COALESCE(MAX(p.description), MAX(TRIM(l.description))) AS description,
              COUNT(DISTINCT o.id) AS billCount,
              SUM(${LINE_AMOUNT}) AS amount
       FROM order_doc_lines l
       JOIN order_docs o ON o.id = l.order_id
       LEFT JOIN products p ON p.id = l.product_id
       WHERE o.voided = 0 AND ${DAY} BETWEEN ? AND ?
       GROUP BY k
       ORDER BY amount DESC
       LIMIT ?`
    )
    .all(dateFrom, dateTo, limit) as {
    k: string
    productId: number | null
    barcode: string | null
    description: string
    billCount: number
    amount: number
  }[]

  // Quantities only add up within one unit (3 กล่อง + 5 ชิ้น is not 8 of
  // anything), so they are reported per unit.
  const qtyRows = db
    .prepare(
      `SELECT ${LINE_KEY} AS k, COALESCE(NULLIF(TRIM(l.unit_name), ''), '-') AS unit, SUM(COALESCE(l.qty, 0)) AS qty
       FROM order_doc_lines l JOIN order_docs o ON o.id = l.order_id
       WHERE o.voided = 0 AND ${DAY} BETWEEN ? AND ?
       GROUP BY k, unit`
    )
    .all(dateFrom, dateTo) as { k: string; unit: string; qty: number }[]
  const qtyByKey = new Map<string, Map<string, number>>()
  for (const q of qtyRows) {
    const m = qtyByKey.get(q.k) ?? new Map<string, number>()
    m.set(q.unit, (m.get(q.unit) ?? 0) + q.qty)
    qtyByKey.set(q.k, m)
  }

  return rows.map((r) => ({
    key: r.k,
    productId: r.productId,
    barcode: r.barcode,
    description: r.description,
    billCount: r.billCount,
    amount: round2(r.amount ?? 0),
    qtyByUnit: unitList(qtyByKey.get(r.k) ?? new Map())
  }))
}

function productTrend(year: number, key: string): ProductTrendRow[] {
  const db = getDb()
  const k = String(key ?? '')
  if (!/^[pt]:/.test(k)) throw new Error('ไม่รู้จักสินค้าที่เลือก')
  const where = `o.voided = 0 AND strftime('%Y', ${DAY}) = ? AND ${LINE_KEY} = ?`
  const head = db
    .prepare(
      `SELECT CAST(strftime('%m', ${DAY}) AS INTEGER) AS month, COUNT(DISTINCT o.id) AS billCount,
              SUM(${LINE_AMOUNT}) AS amount
       FROM order_doc_lines l JOIN order_docs o ON o.id = l.order_id
       WHERE ${where} GROUP BY month`
    )
    .all(String(year), k) as { month: number; billCount: number; amount: number }[]
  const qty = db
    .prepare(
      `SELECT CAST(strftime('%m', ${DAY}) AS INTEGER) AS month,
              COALESCE(NULLIF(TRIM(l.unit_name), ''), '-') AS unit, SUM(COALESCE(l.qty, 0)) AS qty
       FROM order_doc_lines l JOIN order_docs o ON o.id = l.order_id
       WHERE ${where} GROUP BY month, unit`
    )
    .all(String(year), k) as { month: number; unit: string; qty: number }[]

  return Array.from({ length: 12 }, (_, i) => {
    const month = i + 1
    const h = head.find((r) => r.month === month)
    const units = new Map<string, number>()
    for (const q of qty.filter((r) => r.month === month)) units.set(q.unit, q.qty)
    return { month, billCount: h?.billCount ?? 0, amount: round2(h?.amount ?? 0), qtyByUnit: unitList(units) }
  })
}

/* ---------- handlers ---------- */

export function registerSalesHandlers(): void {
  // Next number to key for each book. Keying follows the paper, so the
  // suggestion comes from what has been KEYED, not from the print counter —
  // the print counter is shown alongside so the gap is visible.
  handle('sales:nextNumbers', 1, (): BookNextNumber[] => {
    const yy = yearPart()
    return BOOK_TYPES.map((book) => {
      const rows = getDb()
        .prepare('SELECT doc_number FROM order_docs WHERE doc_number LIKE ?')
        .all(`${book}${yy}-%`) as { doc_number: string }[]
      let max = 0
      for (const r of rows) {
        const m = r.doc_number.match(/-(\d+)$/)
        if (m) max = Math.max(max, Number(m[1]))
      }
      const printed = readCounter(counterKey(book, yy))
      return {
        book,
        next: formatDocNumber(book, yy, max + 1),
        lastKeyed: max ? formatDocNumber(book, yy, max) : null,
        lastPrinted: printed ? formatDocNumber(book, yy, printed) : null
      }
    })
  })

  handle('sales:list', 1, (filter: SaleFilter) => listSales(filter ?? {}))

  handle('sales:get', 1, (id: number) => {
    const sale = getSale(id)
    const lines = getDb()
      .prepare(
        `SELECT line_no AS lineNo, product_id AS productId, description, qty,
                unit_name AS unitName, unit_price AS unitPrice, amount
         FROM order_doc_lines WHERE order_id = ? ORDER BY line_no`
      )
      .all(id) as SaleLineView[]
    return { sale, lines }
  })

  handle('sales:save', 1, (payload: SalePayload) => saveSale(payload))

  handle('sales:void', 1, (p: { id: number; reason: string }) => {
    const reason = String(p.reason ?? '').trim()
    if (!reason) throw new Error('กรุณาระบุเหตุผลที่ยกเลิกบิล')
    const sale = getSale(p.id)
    if (sale.voided) throw new Error('บิลนี้ถูกยกเลิกไปแล้ว')
    assertDayOpen(sale.docDate)
    getDb()
      .prepare(
        'UPDATE order_docs SET voided = 1, void_reason = ?, voided_at = CURRENT_TIMESTAMP, voided_by = ? WHERE id = ?'
      )
      .run(reason, getSession()!.id, p.id)
  })

  handle('sales:restore', 2, (id: number) => {
    const sale = getSale(id)
    assertDayOpen(sale.docDate)
    getDb()
      .prepare('UPDATE order_docs SET voided = 0, void_reason = NULL, voided_at = NULL, voided_by = NULL WHERE id = ?')
      .run(id)
  })

  handle('sales:transfers', 2, (filter: SaleFilter) =>
    listSales({ ...(filter ?? {}), includeVoided: false }, { transfersOnly: true, order: 'asc' })
  )

  // Matching against the bank statement. Allowed on locked days too — it
  // normally happens days after the cash-up.
  handle('sales:setTransferStatus', 2, (p: { ids: number[]; status: TransferStatus; note: string }) => {
    if (!TRANSFER_STATUSES.includes(p.status)) throw new Error('สถานะไม่ถูกต้อง')
    const ids = (p.ids ?? []).map(Number).filter((n) => n > 0)
    if (!ids.length) throw new Error('กรุณาเลือกบิลอย่างน้อย 1 ใบ')
    const note = String(p.note ?? '').trim()
    const user = getSession()!
    const db = getDb()
    // Only live bills that actually carry a transfer can be marked.
    const upd = db.prepare(
      `UPDATE order_docs SET
         transfer_status = ?,
         transfer_verified_at = CASE WHEN ? = 'PENDING' THEN NULL ELSE CURRENT_TIMESTAMP END,
         transfer_verified_by = CASE WHEN ? = 'PENDING' THEN NULL ELSE ? END,
         transfer_note = COALESCE(NULLIF(?, ''), transfer_note)
       WHERE id IN (SELECT o.id FROM order_docs o WHERE o.id = ? AND o.voided = 0 AND ${TRANSFER} > 0)`
    )
    let changed = 0
    db.transaction(() => {
      for (const id of ids) changed += upd.run(p.status, p.status, p.status, user.id, note, id).changes
    })()
    return { changed }
  })

  handle('sales:day', 1, (date: string) => daySummary(date))

  handle('sales:saveClose', 1, (p: CashClosePayload) => saveClose(p))

  handle('sales:ownerCheck', 3, (p: { date: string; checked: boolean; note: string }) => {
    const db = getDb()
    const exists = db.prepare('SELECT id FROM cash_closes WHERE close_date = ?').get(p.date)
    if (!exists) throw new Error('ยังไม่ได้บันทึกปิดยอดของวันนี้ — ต้องปิดยอดก่อนเจ้าของจึงตรวจได้')
    if (p.checked) {
      db.prepare(
        `UPDATE cash_closes SET owner_checked_by = ?, owner_checked_at = CURRENT_TIMESTAMP, owner_note = ?
         WHERE close_date = ?`
      ).run(getSession()!.id, String(p.note ?? '').trim() || null, p.date)
    } else {
      db.prepare(
        'UPDATE cash_closes SET owner_checked_by = NULL, owner_checked_at = NULL WHERE close_date = ?'
      ).run(p.date)
    }
  })

  handle('sales:years', 2, () => {
    const rows = getDb()
      .prepare(`SELECT DISTINCT CAST(strftime('%Y', ${DAY}) AS INTEGER) AS y FROM order_docs o WHERE o.voided = 0`)
      .all() as { y: number | null }[]
    const years = new Set(rows.map((r) => r.y).filter((y): y is number => !!y))
    years.add(new Date().getFullYear())
    return [...years].sort((a, b) => b - a)
  })

  handle('sales:monthly', 2, (year: number): MonthlyRow[] => {
    const rows = getDb()
      .prepare(
        `SELECT CAST(strftime('%m', ${DAY}) AS INTEGER) AS month,
                COUNT(*) AS billCount,
                SUM(o.grand_total) AS grandTotal,
                SUM(${CASH}) AS cashTotal,
                SUM(${TRANSFER}) AS transferTotal,
                SUM(${CREDIT}) AS creditTotal
         FROM order_docs o
         WHERE o.voided = 0 AND strftime('%Y', ${DAY}) = ?
         GROUP BY month`
      )
      .all(String(year)) as MonthlyRow[]
    return Array.from({ length: 12 }, (_, i) => {
      const r = rows.find((x) => x.month === i + 1)
      return {
        month: i + 1,
        billCount: r?.billCount ?? 0,
        grandTotal: round2(r?.grandTotal ?? 0),
        cashTotal: round2(r?.cashTotal ?? 0),
        transferTotal: round2(r?.transferTotal ?? 0),
        creditTotal: round2(r?.creditTotal ?? 0)
      }
    })
  })

  handle('sales:topProducts', 2, (p: { dateFrom: string; dateTo: string; limit?: number }) => {
    if (!isIsoDate(p.dateFrom) || !isIsoDate(p.dateTo)) throw new Error('ช่วงวันที่ไม่ถูกต้อง')
    return topProducts(p.dateFrom, p.dateTo, Math.min(Math.max(p.limit ?? 30, 1), 500))
  })

  handle('sales:productTrend', 2, (p: { year: number; key: string }) => productTrend(Number(p.year), p.key))
}
