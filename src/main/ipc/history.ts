import { getDb } from '../database'
import { getSession } from '../session'
import { handle } from './helpers'

export function registerHistoryHandlers(): void {
  // The stock ledger, newest first. Gated to level 2+ (stock managers/admin) —
  // this is a management view, not something staff see.
  handle('history:list', 2, () =>
    getDb()
      .prepare(
        `SELECT m.id,
                m.created_at   AS createdAt,
                p.barcode,
                p.description,
                l.name         AS locationName,
                m.movement_type AS movementType,
                m.qty_change   AS qtyChange,
                m.note,
                u.display_name AS userName,
                (SELECT un.name FROM product_units pu JOIN units un ON un.id = pu.unit_id
                 WHERE pu.product_id = p.id AND pu.is_base_unit = 1 LIMIT 1) AS baseUnit,
                st.doc_number  AS reference
         FROM stock_movements m
         JOIN products p  ON p.id = m.product_id
         JOIN locations l ON l.id = m.location_id
         LEFT JOIN users u ON u.id = m.created_by
         LEFT JOIN stocktake_sessions st ON m.reference_type = 'stocktake' AND st.id = m.reference_id
         ORDER BY m.id DESC
         LIMIT 500`
      )
      .all()
  )

  // Count rounds, newest first — each row is one save (one physical count).
  handle('history:sessions', 2, () =>
    (
      getDb()
        .prepare(
          `SELECT s.id,
                  s.doc_number    AS docNumber,
                  s.count_date    AS countDate,
                  s.count_time    AS countTime,
                  s.created_at    AS createdAt,
                  l.name          AS locationName,
                  s.category,
                  s.note,
                  s.counted_count AS countedCount,
                  s.adjusted_count AS adjustedCount,
                  s.is_quick      AS isQuick,
                  s.counter_name  AS counterName,
                s.amends_session_id AS amendsSessionId,
                  u.display_name  AS userName
           FROM stocktake_sessions s
           JOIN locations l ON l.id = s.location_id
           LEFT JOIN users u ON u.id = s.created_by
           ORDER BY s.id DESC
           LIMIT 300`
        )
        .all() as { isQuick: number }[]
    ).map((r) => ({ ...r, isQuick: r.isQuick === 1 }))
  )

  // Every counted line of one round — the full snapshot for that check.
  // Correcting a round: writes a NEW round that points back at the original and
  // posts the difference as ADJUST movements. The original round is never
  // touched, so "what was counted then" and "what we now believe" both survive.
  //
  // The delta is (new count - ORIGINAL count), not (new count - stock now):
  // anything that legitimately moved after the count keeps its effect.
  handle(
    'history:amendSession',
    2,
    (payload: { sessionId: number; note: string; lines: { lineId: number; countedQty: number }[] }) => {
      const db = getDb()
      const user = getSession()!
      const sessionId = Number(payload?.sessionId)

      const original = db
        .prepare('SELECT id, doc_number, count_date, count_time, location_id, category, counter_name FROM stocktake_sessions WHERE id = ?')
        .get(sessionId) as
        | { id: number; doc_number: string | null; count_date: string | null; count_time: string | null; location_id: number; category: string | null; counter_name: string | null }
        | undefined
      if (!original) throw new Error('ไม่พบรอบการตรวจนับที่ต้องการแก้ไข')

      const originalLines = db
        .prepare('SELECT id, product_id, location_id, system_qty, counted_qty FROM stocktake_lines WHERE session_id = ?')
        .all(sessionId) as { id: number; product_id: number; location_id: number; system_qty: number; counted_qty: number }[]
      const byId = new Map(originalLines.map((l) => [l.id, l]))

      const changes = (payload?.lines ?? [])
        .map((c) => ({ line: byId.get(Number(c.lineId)), wanted: Number(c.countedQty) }))
        .filter((c) => c.line && Number.isFinite(c.wanted) && c.wanted !== c.line!.counted_qty)
      if (!changes.length) throw new Error('ไม่มีตัวเลขที่เปลี่ยน')

      const run = db.transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO stocktake_sessions
               (doc_number, count_date, count_time, location_id, category, note, counted_count,
                adjusted_count, is_quick, counter_name, amends_session_id, created_by)
             VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
          )
          .run(
            original.count_date,
            original.count_time,
            original.location_id,
            original.category,
            payload?.note?.trim() || `แก้ไขรอบ ${original.doc_number ?? '#' + original.id}`,
            changes.length,
            changes.length,
            original.counter_name,
            sessionId,
            user.id
          )
        const newSessionId = Number(info.lastInsertRowid)

        const addLine = db.prepare(
          `INSERT INTO stocktake_lines
             (session_id, product_id, location_id, system_qty, counted_qty, diff, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        const post = db.prepare(
          `INSERT INTO stock_movements
             (product_id, location_id, movement_type, qty_change, reference_type, reference_id, note, created_by)
           VALUES (?, ?, 'ADJUST', ?, 'stocktake', ?, ?, ?)`
        )

        for (const c of changes) {
          const line = c.line!
          const delta = c.wanted - line.counted_qty
          addLine.run(
            newSessionId,
            line.product_id,
            line.location_id,
            line.counted_qty, // "ระบบ" for the correction = what was recorded before
            c.wanted,
            delta,
            `แก้จาก ${line.counted_qty} เป็น ${c.wanted}`
          )
          post.run(line.product_id, line.location_id, delta, newSessionId, 'แก้ไขผลการตรวจนับย้อนหลัง', user.id)
        }
        return newSessionId
      })

      return { sessionId: run(), changed: changes.length }
    }
  )

  handle('history:sessionLines', 2, (sessionId: number) =>
    getDb()
      .prepare(
        `SELECT sl.id AS lineId,
                sl.product_id AS productId,
                p.barcode,
                p.description,
                l.name         AS locationName,
                sl.system_qty  AS systemQty,
                sl.counted_qty AS countedQty,
                sl.counted_parts AS countedParts,
                sl.diff,
                sl.note,
                sl.has_received  AS hasReceived,
                sl.received_qty  AS receivedQty,
                sl.received_date AS receivedDate,
                (SELECT un.name FROM product_units pu JOIN units un ON un.id = pu.unit_id
                 WHERE pu.product_id = p.id AND pu.is_base_unit = 1 LIMIT 1) AS baseUnit
         FROM stocktake_lines sl
         JOIN products p ON p.id = sl.product_id
         LEFT JOIN locations l ON l.id = sl.location_id
         WHERE sl.session_id = ?
         ORDER BY sl.id`
      )
      .all(sessionId)
  )
}
