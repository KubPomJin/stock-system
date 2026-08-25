import { getDb } from '../database'
import { getSession } from '../session'
import { handle } from './helpers'
import type { ReceivingPayload, StocktakePayload, TransferPayload } from '../../shared/types'

const VAT_RATE = 0.07

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function nextReceivingDocNumber(): string {
  const prefix = `REC-${today()}`
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM stock_receiving WHERE doc_number LIKE ?')
    .get(`${prefix}-%`) as { c: number }
  return `${prefix}-${String(row.c + 1).padStart(4, '0')}`
}

function nextStocktakeDocNumber(): string {
  const prefix = `STK-${today()}`
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM stocktake_sessions WHERE doc_number LIKE ?')
    .get(`${prefix}-%`) as { c: number }
  return `${prefix}-${String(row.c + 1).padStart(4, '0')}`
}

function nextTransferRef(): number {
  const row = getDb()
    .prepare(
      "SELECT COALESCE(MAX(reference_id), 0) + 1 AS next FROM stock_movements WHERE reference_type = 'transfer'"
    )
    .get() as { next: number }
  return row.next
}

function qtyPerBase(productId: number, unitId: number): number {
  const row = getDb()
    .prepare('SELECT qty_per_base FROM product_units WHERE product_id = ? AND unit_id = ?')
    .get(productId, unitId) as { qty_per_base: number } | undefined
  if (!row) throw new Error('หน่วยที่เลือกไม่ตรงกับโครงสร้างหน่วยของสินค้า')
  return row.qty_per_base
}

function stockAt(productId: number, locationId: number): number {
  const row = getDb()
    .prepare(
      'SELECT COALESCE(SUM(qty_change), 0) AS q FROM stock_movements WHERE product_id = ? AND location_id = ?'
    )
    .get(productId, locationId) as { q: number }
  return row.q
}

function productName(productId: number): string {
  const row = getDb().prepare('SELECT description FROM products WHERE id = ?').get(productId) as
    | { description: string }
    | undefined
  return row?.description ?? `#${productId}`
}

export function registerStockHandlers(): void {
  // ---------- Receiving (goods-in) ----------
  handle('receiving:nextDocNumber', 2, () => nextReceivingDocNumber())

  handle('receiving:post', 2, (payload: ReceivingPayload) => {
    if (!payload.lines?.length) throw new Error('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ')
    const db = getDb()
    const user = getSession()!

    const post = db.transaction((): string => {
      // Supplier: existing id, or find-or-create by typed name (combobox add-new).
      let supplierId: number | null = payload.supplierId ?? null
      const name = payload.supplierName?.trim()
      if (!supplierId && name) {
        const existing = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(name) as
          | { id: number }
          | undefined
        supplierId = existing
          ? existing.id
          : Number(db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(name).lastInsertRowid)
      }

      const docNumber = nextReceivingDocNumber()
      const recInfo = db
        .prepare(
          `INSERT INTO stock_receiving
             (doc_number, doc_date, supplier_id, location_id, notes, subtotal, discount_total, vat_amount, grand_total, status, created_by)
           VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 'POSTED', ?)`
        )
        .run(docNumber, payload.docDate, supplierId, payload.locationId, payload.notes?.trim() || null, user.id)
      const receivingId = Number(recInfo.lastInsertRowid)

      let subtotal = 0
      for (const line of payload.lines) {
        if (!(line.qty > 0)) throw new Error('จำนวนที่รับต้องมากกว่าศูนย์')
        const qpb = qtyPerBase(line.productId, line.unitId)
        // Snapshot base qty on the line so historical docs stay accurate even
        // if product_units.qty_per_base is edited later.
        const qtyBase = line.qty * qpb
        const lineTotal = line.qty * line.unitCost
        subtotal += lineTotal

        db.prepare(
          `INSERT INTO stock_receiving_lines
             (receiving_id, product_id, unit_id, qty, qty_base, unit_cost, discount_pct, discount_amt, line_total)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`
        ).run(receivingId, line.productId, line.unitId, line.qty, qtyBase, line.unitCost, lineTotal)

        const costPerBase = line.unitCost / qpb
        db.prepare(
          `INSERT INTO stock_movements
             (product_id, location_id, movement_type, qty_change, unit_cost, reference_type, reference_id, note, created_by)
           VALUES (?, ?, 'RECEIVE', ?, ?, 'stock_receiving', ?, ?, ?)`
        ).run(line.productId, payload.locationId, qtyBase, costPerBase, receivingId, `รับของเข้า ${docNumber}`, user.id)

        // latest_cost is always kept per BASE unit.
        db.prepare('UPDATE products SET latest_cost = ? WHERE id = ?').run(costPerBase, line.productId)
      }

      const vat = subtotal * VAT_RATE
      db.prepare(
        'UPDATE stock_receiving SET subtotal = ?, vat_amount = ?, grand_total = ? WHERE id = ?'
      ).run(subtotal, vat, subtotal + vat, receivingId)

      return docNumber
    })

    return { docNumber: post() }
  })

  // ---------- Stocktake (count -> ADJUST movements) ----------
  handle('stocktake:nextDocNumber', 2, () => nextStocktakeDocNumber())

  // Record a sheet at print time so it can be filled in later — this is what
  // lets a sheet printed today be keyed in tomorrow under its own number,
  // instead of the number having moved on.
  handle(
    'stocktake:recordPrinted',
    2,
    (payload: { docNumber: string; countDate: string; countTime: string; category: string; counterName: string }) => {
      const db = getDb()
      const user = getSession()!
      const docNumber = String(payload.docNumber ?? '').trim() || nextStocktakeDocNumber()
      if (db.prepare('SELECT id FROM stocktake_sessions WHERE doc_number = ?').get(docNumber)) {
        throw new Error(`เลขที่เอกสาร ${docNumber} ถูกใช้ไปแล้ว`)
      }
      const firstLocation = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get() as { id: number }
      const info = db
        .prepare(
          `INSERT INTO stocktake_sessions
             (doc_number, count_date, count_time, location_id, category, counter_name, status, printed_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'PRINTED', CURRENT_TIMESTAMP, ?)`
        )
        .run(
          docNumber,
          payload.countDate || null,
          payload.countTime?.trim() || null,
          firstLocation.id,
          payload.category?.trim() || null,
          payload.counterName?.trim() || null,
          user.id
        )
      return { id: Number(info.lastInsertRowid), docNumber }
    }
  )

  // Sheets printed but not yet keyed in.
  handle('stocktake:pending', 2, () =>
    getDb()
      .prepare(
        `SELECT id, doc_number AS docNumber, count_date AS countDate, count_time AS countTime,
                category, counter_name AS counterName, printed_at AS printedAt
         FROM stocktake_sessions
         WHERE status = 'PRINTED'
         ORDER BY id DESC
         LIMIT 100`
      )
      .all()
  )

  handle('stocktake:save', 2, (payload: StocktakePayload) => {
    if (!payload.entries?.length) throw new Error('กรุณานับสินค้าอย่างน้อย 1 รายการก่อนบันทึก')
    const db = getDb()
    const user = getSession()!

    const save = db.transaction((): { adjusted: number; docNumber: string } => {
      const firstLocation = payload.entries[0].locationId
      let sessionId: number
      let docNumber: string | null

      if (payload.sessionId) {
        // Filling in a sheet that was printed earlier — keep its serial number.
        const existing = db
          .prepare("SELECT id, doc_number, status FROM stocktake_sessions WHERE id = ?")
          .get(payload.sessionId) as { id: number; doc_number: string | null; status: string } | undefined
        if (!existing) throw new Error('ไม่พบใบตรวจนับที่เลือก')
        if (existing.status !== 'PRINTED') throw new Error('ใบตรวจนับนี้ถูกบันทึกไปแล้ว')
        sessionId = existing.id
        docNumber = existing.doc_number
        db.prepare(
          `UPDATE stocktake_sessions
             SET count_date = ?, count_time = ?, location_id = ?, category = ?, note = ?,
                 counter_name = ?, status = 'SAVED', created_by = ?, created_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).run(
          payload.countDate,
          payload.countTime?.trim() || null,
          firstLocation,
          payload.category?.trim() || null,
          payload.generalNote?.trim() || null,
          payload.counterName?.trim() || null,
          user.id,
          sessionId
        )
      } else {
        // New round. Quick-adjust mode has no serial number at all; otherwise a
        // typed number wins over the auto-suggested one.
        docNumber = payload.noSerial ? null : String(payload.docNumber ?? '').trim() || nextStocktakeDocNumber()
        if (docNumber && db.prepare('SELECT id FROM stocktake_sessions WHERE doc_number = ?').get(docNumber)) {
          throw new Error(`เลขที่เอกสาร ${docNumber} ถูกใช้ไปแล้ว`)
        }
        const sessionInfo = db
          .prepare(
            `INSERT INTO stocktake_sessions
               (doc_number, count_date, count_time, location_id, category, note, counter_name, is_quick, status, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SAVED', ?)`
          )
          .run(
            docNumber,
            payload.countDate,
            payload.countTime?.trim() || null,
            firstLocation,
            payload.category?.trim() || null,
            payload.generalNote?.trim() || null,
            payload.counterName?.trim() || null,
            payload.noSerial ? 1 : 0,
            user.id
          )
        sessionId = Number(sessionInfo.lastInsertRowid)
      }

      let adjusted = 0
      let counted = 0
      for (const entry of payload.entries) {
        const system = stockAt(entry.productId, entry.locationId)
        const diff = entry.counted - system

        // Record EVERY counted line as a snapshot of this round — matched or not.
        db.prepare(
          `INSERT INTO stocktake_lines
             (session_id, product_id, location_id, system_qty, counted_qty, diff, note,
              has_received, received_qty, received_date, counted_parts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          sessionId,
          entry.productId,
          entry.locationId,
          system,
          entry.counted,
          diff,
          entry.note?.trim() || null,
          entry.hasReceived ? 1 : 0,
          entry.receivedQty ?? null,
          entry.receivedDate?.trim() || null,
          // Stored as typed, so history can show "4 กล่อง + 2 ชิ้น" rather than
          // a figure re-derived from the base total.
          entry.countedParts?.length ? JSON.stringify(entry.countedParts) : null
        )
        counted++

        // Only actual differences move stock (post an ADJUST) and link back to
        // this session so the change is traceable to the round that caused it.
        // Goods-in noted above is context for the variance, not a movement —
        // receiving stock is what รับสินค้า does, so nothing is double-counted.
        if (diff !== 0) {
          const received = entry.hasReceived
            ? `มีของเข้า${entry.receivedQty ? ` ${entry.receivedQty}` : ''}${entry.receivedDate ? ` (${entry.receivedDate})` : ''}`
            : ''
          const note =
            [docNumber, entry.note?.trim(), received, payload.generalNote?.trim()].filter(Boolean).join(' — ') || null
          db.prepare(
            `INSERT INTO stock_movements
               (product_id, location_id, movement_type, qty_change, reference_type, reference_id, note, created_by)
             VALUES (?, ?, 'ADJUST', ?, 'stocktake', ?, ?, ?)`
          ).run(entry.productId, entry.locationId, diff, sessionId, note, user.id)
          adjusted++
        }
      }

      db.prepare('UPDATE stocktake_sessions SET counted_count = ?, adjusted_count = ? WHERE id = ?').run(
        counted,
        adjusted,
        sessionId
      )
      return { adjusted, docNumber: docNumber ?? '' }
    })

    return save()
  })

  // ---------- Transfer between locations ----------
  handle('transfer:nextDocNumber', 2, () => `TRF-${today()}-${String(nextTransferRef()).padStart(4, '0')}`)

  handle('transfer:post', 2, (payload: TransferPayload) => {
    if (!payload.lines?.length) throw new Error('กรุณาเพิ่มรายการที่จะเบิกอย่างน้อย 1 รายการ')
    if (payload.fromLocationId === payload.toLocationId) throw new Error('ต้นทางและปลายทางต้องไม่ใช่ที่เดียวกัน')
    const db = getDb()
    const user = getSession()!

    const post = db.transaction((): string => {
      // Validate availability per product across all lines combined.
      const totals = new Map<number, number>()
      for (const line of payload.lines) {
        if (!(line.qty > 0)) throw new Error('จำนวนที่เบิกต้องมากกว่าศูนย์')
        const qtyBase = line.qty * qtyPerBase(line.productId, line.unitId)
        totals.set(line.productId, (totals.get(line.productId) ?? 0) + qtyBase)
      }
      for (const [productId, needed] of totals) {
        const available = stockAt(productId, payload.fromLocationId)
        if (available < needed) {
          throw new Error(`สต๊อกต้นทางไม่พอสำหรับ "${productName(productId)}" (มี ${available} ต้องการ ${needed} หน่วยฐาน)`)
        }
      }

      const refId = nextTransferRef()
      const docNumber = `TRF-${today()}-${String(refId).padStart(4, '0')}`
      // Paired OUT/IN rows share reference_id, so total stock is conserved
      // and both halves can always be traced back to the same transfer.
      for (const line of payload.lines) {
        const qtyBase = line.qty * qtyPerBase(line.productId, line.unitId)
        db.prepare(
          `INSERT INTO stock_movements
             (product_id, location_id, movement_type, qty_change, reference_type, reference_id, note, created_by)
           VALUES (?, ?, 'TRANSFER_OUT', ?, 'transfer', ?, ?, ?)`
        ).run(line.productId, payload.fromLocationId, -qtyBase, refId, `เบิกของ ${docNumber}`, user.id)
        db.prepare(
          `INSERT INTO stock_movements
             (product_id, location_id, movement_type, qty_change, reference_type, reference_id, note, created_by)
           VALUES (?, ?, 'TRANSFER_IN', ?, 'transfer', ?, ?, ?)`
        ).run(line.productId, payload.toLocationId, qtyBase, refId, `เบิกของ ${docNumber}`, user.id)
      }
      return docNumber
    })

    return { docNumber: post() }
  })
}
