import { getDb } from '../database'
import { getSession } from '../session'
import { handle } from './helpers'
import type { OrderPayload } from '../../shared/types'

const BOOK_TYPES = ['A', 'B', 'C', 'D']

// Buddhist year only (2 digits). The month was dropped from the serial —
// print volume varies month to month, so a per-month counter kept restarting
// at low numbers. Book 'A' in 2569 -> key 'A-69', numbers 'A69-0001'.
function yearPart(): string {
  const now = new Date()
  return String((now.getFullYear() + 543) % 100).padStart(2, '0')
}

function counterKey(bookType: string, yy: string): string {
  return `${bookType}-${yy}`
}

function readCounter(key: string): number {
  const row = getDb().prepare('SELECT counter FROM order_counters WHERE key = ?').get(key) as
    | { counter: number }
    | undefined
  return row?.counter ?? 0
}

function formatDocNumber(bookType: string, yy: string, counter: number): string {
  return `${bookType}${yy}-${String(counter).padStart(4, '0')}`
}

function validateBookType(bookType: string): string {
  const t = String(bookType ?? '').trim().toUpperCase()
  if (!BOOK_TYPES.includes(t)) throw new Error('เล่มบิลต้องเป็น A, B, C หรือ D')
  return t
}

export function registerOrderHandlers(): void {
  // Suggest the next number WITHOUT consuming it — the number is only locked in
  // when the ticket is saved, so previewing a book never burns a number.
  handle('orders:nextNumber', 2, (bookType: string) => {
    const t = validateBookType(bookType)
    const yy = yearPart()
    return formatDocNumber(t, yy, readCounter(counterKey(t, yy)) + 1)
  })

  // Reserve a run of numbers for BLANK forms that get printed and filled in by
  // hand. Like the old Apps Script, printing consumes the numbers — the counter
  // moves so the same number is never handed out twice.
  handle(
    'orders:reserveNumbers',
    2,
    (payload: { bookType: string; startNumber?: string; count: number }) => {
      const t = validateBookType(payload.bookType)
      const count = Math.floor(Number(payload.count))
      if (!(count >= 1 && count <= 100)) throw new Error('จำนวนใบต้องอยู่ระหว่าง 1 ถึง 100')

      const yy = yearPart()
      const key = counterKey(t, yy)

      // Honour a typed starting number when it belongs to this book+year,
      // otherwise continue from the stored counter.
      let start = readCounter(key) + 1
      const typed = String(payload.startNumber ?? '').trim()
      if (typed) {
        const m = typed.match(new RegExp(`^${t}${yy}-(\\d{1,5})$`)) ?? typed.match(/^(\d{1,5})$/)
        if (!m) throw new Error(`เลขที่เริ่มต้นต้องอยู่ในรูปแบบ ${t}${yy}-0001`)
        start = Number(m[1])
        if (start < 1) throw new Error('เลขที่เริ่มต้นต้องมากกว่า 0')
      }

      const numbers: string[] = []
      for (let i = 0; i < count; i++) numbers.push(formatDocNumber(t, yy, start + i))

      const last = start + count - 1
      if (last > readCounter(key)) {
        getDb()
          .prepare(
            `INSERT INTO order_counters (key, counter) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET counter = excluded.counter`
          )
          .run(key, last)
      }

      return { numbers }
    }
  )

  handle('orders:save', 2, (payload: OrderPayload) => {
    const docNumber = String(payload.docNumber ?? '').trim()
    if (!docNumber) throw new Error('กรุณาระบุเลขที่เอกสาร')
    const bookType = validateBookType(payload.bookType)
    const lines = (payload.lines ?? []).filter((l) => (l.description ?? '').trim() !== '')
    if (lines.length === 0) throw new Error('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ')

    const db = getDb()
    const user = getSession()!

    const save = db.transaction((): { id: number; docNumber: string } => {
      if (db.prepare('SELECT id FROM order_docs WHERE doc_number = ?').get(docNumber)) {
        throw new Error(`เลขที่เอกสาร ${docNumber} ถูกใช้ไปแล้ว`)
      }

      const info = db
        .prepare(
          `INSERT INTO order_docs
             (doc_number, book_type, doc_date, doc_time, customer_code, customer_name, customer_contact,
              delivery_method, vehicle_plate, payment_method, cash_received, cash_change,
              transfer_amount, transfer_ref, note, subtotal, delivery_fee, grand_total, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          docNumber,
          bookType,
          payload.docDate || null,
          payload.docTime || null,
          payload.customerCode?.trim() || null,
          payload.customerName?.trim() || null,
          payload.customerContact?.trim() || null,
          payload.deliveryMethod || null,
          payload.vehiclePlate?.trim() || null,
          payload.paymentMethod || null,
          payload.cashReceived ?? null,
          payload.cashChange ?? null,
          payload.transferAmount ?? null,
          payload.transferRef?.trim() || null,
          payload.note?.trim() || null,
          payload.subtotal || 0,
          payload.deliveryFee || 0,
          payload.grandTotal || 0,
          user.id
        )
      const orderId = Number(info.lastInsertRowid)

      lines.forEach((l, i) => {
        db.prepare(
          `INSERT INTO order_doc_lines
             (order_id, line_no, product_id, description, location_name, qty, unit_name, unit_price, amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          orderId,
          i + 1,
          l.productId ?? null,
          l.description.trim(),
          l.locationName?.trim() || null,
          l.qty ?? null,
          l.unitName?.trim() || null,
          l.unitPrice ?? null,
          l.amount ?? null
        )
      })

      // Keep the counter in step with whatever number was actually used, even
      // when it was typed by hand — so the next suggestion continues correctly
      // instead of handing back a number already printed on paper.
      const yy = yearPart()
      const match = docNumber.match(new RegExp(`^${bookType}${yy}-(\\d{1,5})$`))
      if (match) {
        const used = Number(match[1])
        const key = counterKey(bookType, yy)
        if (used > readCounter(key)) {
          db.prepare(
            `INSERT INTO order_counters (key, counter) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET counter = excluded.counter`
          ).run(key, used)
        }
      }

      return { id: orderId, docNumber }
    })

    return save()
  })

  handle('orders:list', 2, () =>
    getDb()
      .prepare(
        `SELECT o.id,
                o.doc_number      AS docNumber,
                o.book_type       AS bookType,
                o.doc_date        AS docDate,
                o.doc_time        AS docTime,
                o.customer_code   AS customerCode,
                o.customer_name   AS customerName,
                o.customer_contact AS customerContact,
                o.delivery_method AS deliveryMethod,
                o.vehicle_plate   AS vehiclePlate,
                o.payment_method  AS paymentMethod,
                o.cash_received   AS cashReceived,
                o.cash_change     AS cashChange,
                o.transfer_amount AS transferAmount,
                o.transfer_ref    AS transferRef,
                o.note,
                o.subtotal, o.delivery_fee AS deliveryFee, o.grand_total AS grandTotal,
                o.created_at      AS createdAt,
                u.display_name    AS userName,
                (SELECT COUNT(*) FROM order_doc_lines l WHERE l.order_id = o.id) AS lineCount
         FROM order_docs o
         LEFT JOIN users u ON u.id = o.created_by
         ORDER BY o.id DESC
         LIMIT 300`
      )
      .all()
  )

  handle('orders:get', 2, (id: number) => {
    const db = getDb()
    const doc = db
      .prepare(
        `SELECT o.id,
                o.doc_number      AS docNumber,
                o.book_type       AS bookType,
                o.doc_date        AS docDate,
                o.doc_time        AS docTime,
                o.customer_code   AS customerCode,
                o.customer_name   AS customerName,
                o.customer_contact AS customerContact,
                o.delivery_method AS deliveryMethod,
                o.vehicle_plate   AS vehiclePlate,
                o.payment_method  AS paymentMethod,
                o.cash_received   AS cashReceived,
                o.cash_change     AS cashChange,
                o.transfer_amount AS transferAmount,
                o.transfer_ref    AS transferRef,
                o.note,
                o.subtotal, o.delivery_fee AS deliveryFee, o.grand_total AS grandTotal,
                o.created_at      AS createdAt,
                u.display_name    AS userName,
                (SELECT COUNT(*) FROM order_doc_lines l WHERE l.order_id = o.id) AS lineCount
         FROM order_docs o
         LEFT JOIN users u ON u.id = o.created_by
         WHERE o.id = ?`
      )
      .get(id)
    if (!doc) throw new Error('ไม่พบเอกสาร')

    const lines = db
      .prepare(
        `SELECT line_no AS lineNo, product_id AS productId, description,
                location_name AS locationName, qty, unit_name AS unitName,
                unit_price AS unitPrice, amount
         FROM order_doc_lines WHERE order_id = ? ORDER BY line_no`
      )
      .all(id)

    return { doc, lines }
  })
}
