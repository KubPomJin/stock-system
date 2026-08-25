import { getDb } from '../database'
import { getSession, requireLevel } from '../session'
import { handle } from './helpers'
import type { ProductPayload, ProductView } from '../../shared/types'

interface ProductRow {
  id: number
  barcode: string
  barcode_pending: number
  sub_barcode: string | null
  description: string
  category_id: number | null
  category_name: string | null
  min_stock: number
  max_stock: number
  latest_cost: number
}

// Builds the full product list with units, per-location stock and prices.
// SECURITY: price/cost visibility is enforced HERE, not in the UI — a level-1
// user never receives latest_cost or restricted price tiers over IPC at all.
export function listProducts(): ProductView[] {
  const user = requireLevel(1)
  const db = getDb()

  const products = db
    .prepare(
      `SELECT p.id, p.barcode, p.barcode_pending, p.sub_barcode, p.description, p.category_id,
              c.name AS category_name, p.min_stock, p.max_stock, p.latest_cost
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.discontinued = 0
       ORDER BY p.id`
    )
    .all() as ProductRow[]

  const unitRows = db
    .prepare(
      `SELECT pu.product_id, pu.unit_id, u.name, pu.qty_per_base, pu.is_base_unit
       FROM product_units pu JOIN units u ON u.id = pu.unit_id
       ORDER BY pu.product_id, pu.sort_order`
    )
    .all() as { product_id: number; unit_id: number; name: string; qty_per_base: number; is_base_unit: number }[]

  const stockRows = db
    .prepare(
      `SELECT product_id, location_id, COALESCE(SUM(qty_change), 0) AS qty
       FROM stock_movements GROUP BY product_id, location_id`
    )
    .all() as { product_id: number; location_id: number; qty: number }[]

  const priceRows = db
    .prepare(
      `SELECT pp.product_id, pt.code, pt.min_role_level, pp.price
       FROM product_prices pp JOIN price_tiers pt ON pt.id = pp.price_tier_id
       ORDER BY pt.sort_order`
    )
    .all() as { product_id: number; code: string; min_role_level: number; price: number }[]

  // Warehouse bays the item sits in. Purely locational — no price data — so it
  // is safe to hand to a level-1 picker along with the rest of the list.
  const zoneRows = db
    .prepare(
      `SELECT pz.product_id, z.id AS zone_id, z.code
         FROM product_zones pz JOIN zones z ON z.id = pz.zone_id
        ORDER BY z.sort_order`
    )
    .all() as { product_id: number; zone_id: number; code: string }[]

  const byId = new Map<number, ProductView>()
  for (const p of products) {
    byId.set(p.id, {
      id: p.id,
      barcode: p.barcode,
      barcodePending: p.barcode_pending === 1,
      subBarcode: p.sub_barcode,
      description: p.description,
      categoryId: p.category_id,
      categoryName: p.category_name ?? 'ทั่วไป',
      minStock: p.min_stock,
      maxStock: p.max_stock,
      ...(user.roleLevel >= 2 ? { cost: p.latest_cost } : {}),
      prices: {},
      units: [],
      stockByLocation: {},
      totalOnHand: 0,
      zoneIds: [],
      zoneCodes: []
    })
  }
  for (const u of unitRows) {
    byId.get(u.product_id)?.units.push({
      unitId: u.unit_id,
      name: u.name,
      qtyPerBase: u.qty_per_base,
      isBase: u.is_base_unit === 1
    })
  }
  for (const s of stockRows) {
    const p = byId.get(s.product_id)
    if (p) {
      p.stockByLocation[s.location_id] = s.qty
      p.totalOnHand += s.qty
    }
  }
  for (const pr of priceRows) {
    if (user.roleLevel >= pr.min_role_level) {
      const p = byId.get(pr.product_id)
      if (p) p.prices[pr.code] = pr.price
    }
  }
  for (const z of zoneRows) {
    const p = byId.get(z.product_id)
    if (p) {
      p.zoneIds.push(z.zone_id)
      p.zoneCodes.push(z.code)
    }
  }
  return [...byId.values()]
}

function validatePayload(payload: ProductPayload): void {
  if (!payload.barcode?.trim()) throw new Error('กรุณาระบุบาร์โค้ด')
  if (!payload.description?.trim()) throw new Error('กรุณาระบุคำอธิบายสินค้า')
  if (!payload.units?.length) throw new Error('ต้องมีหน่วยอย่างน้อย 1 ระดับ')
  const base = payload.units[payload.units.length - 1]
  if (base.qtyPerBase !== 1) throw new Error('หน่วยฐาน (แถวล่างสุด) ต้องมีค่าคูณเท่ากับ 1')
  for (const u of payload.units) {
    if (!u.name?.trim()) throw new Error('กรุณาระบุชื่อหน่วยให้ครบทุกระดับ')
    if (!(u.qtyPerBase > 0)) throw new Error(`ค่าคูณของหน่วย "${u.name}" ต้องมากกว่า 0`)
  }
  const names = payload.units.map((u) => u.name.trim())
  if (new Set(names).size !== names.length) throw new Error('ชื่อหน่วยซ้ำกันในสินค้าเดียว')
}

function unitIdByName(name: string): number {
  const db = getDb()
  const clean = name.trim()
  const row = db.prepare('SELECT id FROM units WHERE name = ?').get(clean) as { id: number } | undefined
  if (row) return row.id
  return Number(db.prepare('INSERT INTO units (name) VALUES (?)').run(clean).lastInsertRowid)
}

function writeUnitsAndPrices(productId: number, payload: ProductPayload): void {
  const db = getDb()
  db.prepare('DELETE FROM product_units WHERE product_id = ?').run(productId)
  payload.units.forEach((u, i) => {
    db.prepare(
      `INSERT INTO product_units (product_id, unit_id, qty_per_base, sort_order, is_base_unit)
       VALUES (?, ?, ?, ?, ?)`
    ).run(productId, unitIdByName(u.name), u.qtyPerBase, i, i === payload.units.length - 1 ? 1 : 0)
  })

  db.prepare('DELETE FROM product_prices WHERE product_id = ?').run(productId)
  const tiers = db.prepare('SELECT id, code FROM price_tiers').all() as { id: number; code: string }[]
  for (const tier of tiers) {
    const price = payload.prices?.[tier.code]
    if (typeof price === 'number' && price >= 0) {
      db.prepare(
        'INSERT INTO product_prices (product_id, price_tier_id, price) VALUES (?, ?, ?)'
      ).run(productId, tier.id, price)
    }
  }
}

export function registerProductHandlers(): void {
  handle('products:list', 1, () => listProducts())

  handle('products:save', 2, (payload: ProductPayload) => {
    validatePayload(payload)
    const db = getDb()
    const user = getSession()!

    const save = db.transaction((): number => {
      const dup = db
        .prepare('SELECT id FROM products WHERE barcode = ? AND id IS NOT ?')
        .get(payload.barcode.trim(), payload.id ?? null) as { id: number } | undefined
      if (dup) throw new Error('มีบาร์โค้ดนี้ในระบบอยู่แล้ว')

      let productId: number
      if (payload.id) {
        const exists = db.prepare('SELECT id FROM products WHERE id = ?').get(payload.id)
        if (!exists) throw new Error('ไม่พบสินค้าที่ต้องการแก้ไข')
        // แก้บาร์โค้ดจากรหัสชั่วคราว (TMP-...) เป็นบาร์โค้ดจริงเมื่อไร ธงรอใส่บาร์โค้ดก็ปลดเอง
        db.prepare(
          `UPDATE products SET barcode = ?, sub_barcode = ?, description = ?, category_id = ?,
             min_stock = ?, max_stock = ?, latest_cost = ?,
             barcode_pending = CASE WHEN ? LIKE 'TMP-%' THEN 1 ELSE 0 END WHERE id = ?`
        ).run(
          payload.barcode.trim(),
          payload.subBarcode?.trim() || null,
          payload.description.trim(),
          payload.categoryId,
          payload.minStock || 0,
          payload.maxStock || 0,
          payload.cost || 0,
          payload.barcode.trim(),
          payload.id
        )
        productId = payload.id
      } else {
        const info = db
          .prepare(
            `INSERT INTO products (barcode, sub_barcode, description, category_id, min_stock, max_stock, latest_cost)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            payload.barcode.trim(),
            payload.subBarcode?.trim() || null,
            payload.description.trim(),
            payload.categoryId,
            payload.minStock || 0,
            payload.maxStock || 0,
            payload.cost || 0
          )
        productId = Number(info.lastInsertRowid)
      }

      writeUnitsAndPrices(productId, payload)

      // Bays are optional: an omitted zoneIds means "form did not touch this",
      // an empty array means "no bay assigned" — so blank really clears it.
      if (payload.zoneIds) {
        db.prepare('DELETE FROM product_zones WHERE product_id = ?').run(productId)
        const link = db.prepare('INSERT OR IGNORE INTO product_zones (product_id, zone_id) VALUES (?, ?)')
        for (const zoneId of payload.zoneIds) {
          const z = db.prepare("SELECT kind FROM zones WHERE id = ?").get(Number(zoneId)) as
            | { kind: string }
            | undefined
          if (!z) throw new Error('ไม่พบโซนที่เลือก')
          if (z.kind !== 'zone') throw new Error('เลือกได้เฉพาะโซนเก็บสินค้า ไม่ใช่ประตูหรือพื้นที่ว่าง')
          link.run(productId, Number(zoneId))
        }
      }

      // Correcting the on-hand figure of an EXISTING product. The balance is
      // never overwritten: we read what the ledger currently says, and post the
      // difference as an ADJUST row. That keeps SUM(qty_change) authoritative
      // and leaves an auditable trail of who changed what and when — the exact
      // failure of the old 4POS system this app replaced.
      if (payload.id && payload.currentStock) {
        const currentQty = db.prepare(
          `SELECT COALESCE(SUM(qty_change), 0) AS qty
             FROM stock_movements WHERE product_id = ? AND location_id = ?`
        )
        const post = db.prepare(
          `INSERT INTO stock_movements
             (product_id, location_id, movement_type, qty_change, unit_cost, reference_type, note, created_by)
           VALUES (?, ?, 'ADJUST', ?, ?, 'manual', ?, ?)`
        )
        for (const [locId, wanted] of Object.entries(payload.currentStock)) {
          const locationId = Number(locId)
          const now = (currentQty.get(productId, locationId) as { qty: number }).qty
          const delta = Number(wanted) - now
          if (delta !== 0) {
            post.run(productId, locationId, delta, payload.cost || 0, 'ปรับจำนวนจากหน้าสินค้า', user.id)
          }
        }
      }

      // Opening stock only applies on create — later corrections go through
      // the ADJUST path above so every change stays explainable in the ledger.
      if (!payload.id && payload.openingStock) {
        for (const [locationId, qty] of Object.entries(payload.openingStock)) {
          if (qty && qty !== 0) {
            db.prepare(
              `INSERT INTO stock_movements
                 (product_id, location_id, movement_type, qty_change, unit_cost, reference_type, note, created_by)
               VALUES (?, ?, 'OPENING', ?, ?, 'manual', ?, ?)`
            ).run(productId, Number(locationId), qty, payload.cost || 0, 'สต๊อกตั้งต้นตอนเพิ่มสินค้า', user.id)
          }
        }
      }
      return productId
    })

    return { id: save() }
  })
}
