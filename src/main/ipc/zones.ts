import { getDb } from '../database'
import { handle } from './helpers'

// Warehouse zones are a picking aid, not a stock dimension — see the migration
// in database.ts. Everything here is therefore read-cheap and price-free:
// the whole point is that a picker (role level 1) can look up where an item
// lives, and level 1 must never receive cost or trade prices over IPC.

interface ZoneRow {
  id: number
  code: string
  label: string
  kind: string
  note: string | null
  gridCol: number
  gridRow: number
  gridW: number
  gridH: number
  productCount: number
}

const ZONE_SELECT = `
  SELECT z.id,
         z.code,
         z.label,
         z.kind,
         z.note,
         z.grid_col  AS gridCol,
         z.grid_row  AS gridRow,
         z.grid_w    AS gridW,
         z.grid_h    AS gridH,
         (SELECT COUNT(*) FROM product_zones pz WHERE pz.zone_id = z.id) AS productCount
    FROM zones z
   ORDER BY z.sort_order, z.code`

// Base unit name, so a picker sees "ลูก" / "เส้น" rather than a bare number.
const PRODUCT_IN_ZONE_SELECT = `
  SELECT p.id,
         p.barcode,
         p.description,
         p.barcode_pending AS barcodePending,
         (SELECT u.name
            FROM product_units pu
            JOIN units u ON u.id = pu.unit_id
           WHERE pu.product_id = p.id AND pu.is_base_unit = 1
           LIMIT 1) AS baseUnit
    FROM product_zones pz
    JOIN products p ON p.id = pz.product_id
   WHERE pz.zone_id = ?
   ORDER BY p.description`

function assertRealZone(zoneId: number): void {
  const row = getDb().prepare("SELECT kind FROM zones WHERE id = ?").get(zoneId) as
    | { kind: string }
    | undefined
  if (!row) throw new Error('ไม่พบโซนที่เลือก')
  if (row.kind !== 'zone') throw new Error('ช่องนี้เป็นประตู/พื้นที่ว่าง ไม่ใช่โซนเก็บสินค้า')
}

export function registerZoneHandlers(): void {
  // Level 1: finding stock is exactly what the shop floor needs this for.
  handle('zones:list', 1, () => getDb().prepare(ZONE_SELECT).all() as ZoneRow[])

  handle('zones:products', 1, (zoneId: number) =>
    getDb().prepare(PRODUCT_IN_ZONE_SELECT).all(Number(zoneId))
  )

  // Search by name or barcode, returning every zone each match sits in. A
  // product with no zone still appears — "ยังไม่ได้ระบุโซน" is useful to see.
  handle('zones:search', 1, (rawQuery: string) => {
    const q = String(rawQuery ?? '').trim()
    if (q.length < 1) return []
    const like = `%${q}%`
    const rows = getDb()
      .prepare(
        `SELECT p.id,
                p.barcode,
                p.description,
                p.barcode_pending AS barcodePending,
                (SELECT u.name
                   FROM product_units pu
                   JOIN units u ON u.id = pu.unit_id
                  WHERE pu.product_id = p.id AND pu.is_base_unit = 1
                  LIMIT 1) AS baseUnit,
                (SELECT GROUP_CONCAT(z.code, ',')
                   FROM product_zones pz
                   JOIN zones z ON z.id = pz.zone_id
                  WHERE pz.product_id = p.id) AS zoneCodes
           FROM products p
          WHERE p.description LIKE ? OR p.barcode LIKE ?
          ORDER BY p.description
          LIMIT 100`
      )
      .all(like, like) as { zoneCodes: string | null }[]
    return rows.map((r) => ({
      ...r,
      zoneCodes: r.zoneCodes ? r.zoneCodes.split(',') : []
    }))
  })

  // Editing the plan is a stock-manager job.
  handle('zones:assign', 2, (payload: { productId: number; zoneId: number }) => {
    const productId = Number(payload?.productId)
    const zoneId = Number(payload?.zoneId)
    assertRealZone(zoneId)
    if (!getDb().prepare('SELECT id FROM products WHERE id = ?').get(productId)) {
      throw new Error('ไม่พบสินค้าที่เลือก')
    }
    getDb()
      .prepare('INSERT OR IGNORE INTO product_zones (product_id, zone_id) VALUES (?, ?)')
      .run(productId, zoneId)
    return { ok: true }
  })

  // Bulk version of assign/unassign — the whole point is not having to edit
  // items one at a time. Runs in a single transaction so a bad id in the middle
  // cannot leave half the batch applied.
  handle(
    'zones:assignMany',
    2,
    (payload: { productIds: number[]; zoneId: number; mode?: 'add' | 'remove' }) => {
      const zoneId = Number(payload?.zoneId)
      assertRealZone(zoneId)
      const ids = (payload?.productIds ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0)
      if (!ids.length) throw new Error('ยังไม่ได้เลือกสินค้า')

      const db = getDb()
      const remove = payload?.mode === 'remove'
      const exists = db.prepare('SELECT id FROM products WHERE id = ?')
      const add = db.prepare('INSERT OR IGNORE INTO product_zones (product_id, zone_id) VALUES (?, ?)')
      const del = db.prepare('DELETE FROM product_zones WHERE product_id = ? AND zone_id = ?')

      const run = db.transaction(() => {
        let changed = 0
        for (const id of ids) {
          if (!exists.get(id)) throw new Error(`ไม่พบสินค้ารหัส ${id}`)
          const info = remove ? del.run(id, zoneId) : add.run(id, zoneId)
          changed += info.changes
        }
        return changed
      })
      const changed = run()
      // ids.length - changed = rows that were already in (or already out of) the
      // zone, which is not an error — just report it so the toast can say so.
      return { changed, skipped: ids.length - changed }
    }
  )

  handle('zones:unassign', 2, (payload: { productId: number; zoneId: number }) => {
    getDb()
      .prepare('DELETE FROM product_zones WHERE product_id = ? AND zone_id = ?')
      .run(Number(payload?.productId), Number(payload?.zoneId))
    return { ok: true }
  })

  // Free-text note per zone, e.g. "เหล็กเส้นยาว 6 ม." — helps when the number
  // alone does not say enough.
  handle('zones:setNote', 2, (payload: { zoneId: number; note: string }) => {
    assertRealZone(Number(payload?.zoneId))
    getDb()
      .prepare('UPDATE zones SET note = ? WHERE id = ?')
      .run(String(payload?.note ?? '').trim() || null, Number(payload?.zoneId))
    return { ok: true }
  })
}
