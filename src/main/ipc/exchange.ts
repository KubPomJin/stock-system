// เชื่อมกับ BillKeep (ระบบเก็บบิลหน้าร้าน)
//
// สองทิศทาง:
//   ส่งออก — เขียนรายการสินค้า + หน่วย + ยอดคงเหลือ เป็นไฟล์ .json ให้ BillKeep
//            (ใช้เมื่ออยู่คนละเครื่อง; ถ้าเครื่องเดียวกัน BillKeep อ่าน .db ตรงได้เลย)
//   นำเข้า — อ่านไฟล์ผลการปิดวันจาก BillKeep แล้วลงเป็น ISSUE movements
//            + สร้างสินค้าที่ยังไม่มี (บาร์โค้ดเว้นไว้ ใส่รหัสชั่วคราว TMP-xxxxxx)
//
// StockKeep เป็นฝ่ายเดียวที่เขียนฐานข้อมูลนี้เสมอ — BillKeep อ่านอย่างเดียว
// จึงไม่มีปัญหา single-writer ของ SQLite

import { BrowserWindow, dialog } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { getDb } from '../database'
import { getSession } from '../session'
import { handle } from './helpers'
import type { BillBatchPreview, BillImportView } from '../../shared/types'

/* ---------- ส่งออกรายการสินค้าให้ BillKeep ---------- */

function buildCatalogJson(): string {
  const db = getDb()
  const products = db
    .prepare(
      `SELECT p.id, p.barcode, p.description, c.name AS category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.discontinued = 0 ORDER BY p.description`
    )
    .all() as { id: number; barcode: string; description: string; category: string | null }[]

  const unitRows = db
    .prepare(
      `SELECT pu.product_id, u.name, pu.qty_per_base, pu.sort_order, pu.is_base_unit
       FROM product_units pu JOIN units u ON u.id = pu.unit_id
       ORDER BY pu.product_id, pu.sort_order`
    )
    .all() as { product_id: number; name: string; qty_per_base: number; sort_order: number; is_base_unit: number }[]

  const prices = db
    .prepare(
      `SELECT pp.product_id, pp.price FROM product_prices pp
       JOIN price_tiers pt ON pt.id = pp.price_tier_id WHERE pt.code = 'RETAIL'`
    )
    .all() as { product_id: number; price: number }[]
  const priceById = new Map(prices.map((p) => [p.product_id, p.price]))

  const unitsByProduct = new Map<number, { unitName: string; qtyPerBase: number; sortOrder: number; isBase: boolean }[]>()
  for (const u of unitRows) {
    const list = unitsByProduct.get(u.product_id) ?? []
    list.push({ unitName: u.name, qtyPerBase: u.qty_per_base, sortOrder: u.sort_order, isBase: u.is_base_unit === 1 })
    unitsByProduct.set(u.product_id, list)
  }

  const locations = (db.prepare('SELECT name FROM locations ORDER BY id').all() as { name: string }[]).map((l) => l.name)

  const stock = db
    .prepare(
      `SELECT m.product_id, l.name AS location_name, COALESCE(SUM(m.qty_change), 0) AS qty
       FROM stock_movements m JOIN locations l ON l.id = m.location_id
       GROUP BY m.product_id, l.id`
    )
    .all() as { product_id: number; location_name: string; qty: number }[]

  return JSON.stringify(
    {
      format: 'stockkeep-catalog',
      version: 1,
      generated_at: new Date().toISOString(),
      products: products.map((p) => {
        const units = unitsByProduct.get(p.id) ?? []
        return {
          productId: p.id,
          barcode: p.barcode,
          description: p.description,
          category: p.category,
          baseUnit: units.find((u) => u.isBase)?.unitName ?? units[units.length - 1]?.unitName ?? null,
          retailPrice: priceById.get(p.id) ?? 0,
          units
        }
      }),
      locations,
      stock: stock.map((s) => ({ productId: s.product_id, locationName: s.location_name, qty: s.qty }))
    },
    null,
    2
  )
}

/* ---------- นำเข้าไฟล์ผลการปิดวันจาก BillKeep ---------- */

interface BatchIssue {
  product_id: number | null
  barcode: string | null
  description: string | null
  location: string | null
  qty_base: number
  doc_number: string | null
  bill_date: string | null
}

interface BatchNewProduct {
  description: string
  barcode: string | null
  base_unit: string | null
  category: string | null
  retail_price: number
}

interface BillBatch {
  format?: string
  version?: number
  batch_id?: string
  close_date?: string
  note?: string | null
  issues?: BatchIssue[]
  new_products?: BatchNewProduct[]
}

function parseBatchFile(path: string): BillBatch {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('อ่านไฟล์ไม่ได้ — ไฟล์ไม่ใช่ JSON ที่ถูกต้อง')
  }
  const data = raw as BillBatch
  if (data.format !== 'billkeep-batch') throw new Error('ไฟล์นี้ไม่ใช่ไฟล์ที่ส่งออกจากระบบเก็บบิล (BillKeep)')
  if (!data.batch_id) throw new Error('ไฟล์ไม่สมบูรณ์ — ไม่มีรหัสชุดข้อมูล (batch_id)')
  if (!Array.isArray(data.issues)) data.issues = []
  if (!Array.isArray(data.new_products)) data.new_products = []
  return data
}

// หา product ที่ตรงกับบรรทัดในไฟล์: id (ยืนยันด้วยบาร์โค้ด) > บาร์โค้ด > คำอธิบาย
function matchProduct(issue: BatchIssue): { id: number; description: string } | null {
  const db = getDb()
  if (issue.product_id != null) {
    const row = db.prepare('SELECT id, barcode, description FROM products WHERE id = ?').get(issue.product_id) as
      | { id: number; barcode: string; description: string }
      | undefined
    if (row && (!issue.barcode || row.barcode === issue.barcode)) return { id: row.id, description: row.description }
  }
  if (issue.barcode) {
    const row = db.prepare('SELECT id, description FROM products WHERE barcode = ?').get(issue.barcode) as
      | { id: number; description: string }
      | undefined
    if (row) return row
  }
  if (issue.description) {
    const row = db.prepare('SELECT id, description FROM products WHERE description = ?').get(issue.description) as
      | { id: number; description: string }
      | undefined
    if (row) return row
  }
  return null
}

function locationIdByName(name: string | null): number | null {
  if (!name) return null
  const row = getDb().prepare('SELECT id FROM locations WHERE name = ?').get(name) as { id: number } | undefined
  return row?.id ?? null
}

function previewBatch(path: string): BillBatchPreview {
  const db = getDb()
  const batch = parseBatchFile(path)
  const already = db.prepare('SELECT imported_at FROM bill_imports WHERE batch_id = ?').get(batch.batch_id) as
    | { imported_at: string }
    | undefined

  let resolved = 0
  const problems: string[] = []
  const seenMissingLocation = new Set<string>()
  for (const issue of batch.issues ?? []) {
    const product = matchProduct(issue)
    if (!product) {
      if (problems.length < 30) problems.push(`ไม่พบสินค้า "${issue.description ?? issue.barcode ?? '-'}" (บิล ${issue.doc_number ?? '-'})`)
      continue
    }
    if (locationIdByName(issue.location) == null) {
      if (issue.location && !seenMissingLocation.has(issue.location)) {
        seenMissingLocation.add(issue.location)
        problems.push(`ไม่พบสถานที่เก็บชื่อ "${issue.location}" ในระบบ`)
      }
      continue
    }
    resolved++
  }

  const newProducts = (batch.new_products ?? []).map((np) => {
    const exists = db.prepare('SELECT id FROM products WHERE description = ?').get(np.description) as
      | { id: number }
      | undefined
    return { description: np.description, baseUnit: np.base_unit ?? 'ชิ้น', exists: !!exists }
  })

  return {
    filePath: path,
    batchId: batch.batch_id as string,
    closeDate: batch.close_date ?? null,
    note: batch.note ?? null,
    issueCount: batch.issues?.length ?? 0,
    resolvedCount: resolved,
    unresolvedCount: (batch.issues?.length ?? 0) - resolved,
    totalQty: (batch.issues ?? []).reduce((s, i) => s + (i.qty_base || 0), 0),
    newProducts,
    problems,
    alreadyImported: already ? already.imported_at : null
  }
}

function lookupOrCreateUnit(name: string): number {
  const db = getDb()
  const clean = (name || 'ชิ้น').trim()
  const row = db.prepare('SELECT id FROM units WHERE name = ?').get(clean) as { id: number } | undefined
  if (row) return row.id
  return Number(db.prepare('INSERT INTO units (name) VALUES (?)').run(clean).lastInsertRowid)
}

function lookupOrCreateCategory(name: string | null): number | null {
  const clean = (name ?? '').trim()
  if (!clean) return null
  const db = getDb()
  const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(clean) as { id: number } | undefined
  if (row) return row.id
  return Number(db.prepare('INSERT INTO categories (name) VALUES (?)').run(clean).lastInsertRowid)
}

// สินค้าที่มาจากบิลยังไม่มีบาร์โค้ดจริง — ใส่รหัสชั่วคราวไว้ก่อน (คอลัมน์ barcode
// เป็น NOT NULL UNIQUE) แล้วทำเครื่องหมาย barcode_pending = 1 ให้ตามแก้ทีหลัง
function nextTempBarcode(): string {
  const row = getDb()
    .prepare("SELECT barcode FROM products WHERE barcode LIKE 'TMP-%' ORDER BY barcode DESC LIMIT 1")
    .get() as { barcode: string } | undefined
  const last = row ? Number(row.barcode.slice(4)) || 0 : 0
  return `TMP-${String(last + 1).padStart(6, '0')}`
}

function applyBatch(path: string): { imported: number; skipped: number; created: number } {
  const db = getDb()
  const user = getSession()!
  const batch = parseBatchFile(path)

  const run = db.transaction((): { imported: number; skipped: number; created: number } => {
    const dup = db.prepare('SELECT id FROM bill_imports WHERE batch_id = ?').get(batch.batch_id)
    if (dup) throw new Error('ไฟล์ชุดนี้เคยนำเข้าไปแล้ว — ไม่นำเข้าซ้ำเพื่อไม่ให้สต๊อกถูกตัดสองรอบ')

    // 1) สร้างสินค้าใหม่ที่ยังไม่มี (บาร์โค้ดเว้นไว้)
    let created = 0
    for (const np of batch.new_products ?? []) {
      const desc = (np.description ?? '').trim()
      if (!desc) continue
      const exists = db.prepare('SELECT id FROM products WHERE description = ?').get(desc)
      if (exists) continue

      const productId = Number(
        db
          .prepare(
            `INSERT INTO products (barcode, description, category_id, min_stock, max_stock, latest_cost, barcode_pending)
             VALUES (?, ?, ?, 0, 0, 0, 1)`
          )
          .run(nextTempBarcode(), desc, lookupOrCreateCategory(np.category)).lastInsertRowid
      )
      db.prepare(
        `INSERT INTO product_units (product_id, unit_id, qty_per_base, sort_order, is_base_unit)
         VALUES (?, ?, 1, 0, 1)`
      ).run(productId, lookupOrCreateUnit(np.base_unit ?? 'ชิ้น'))

      if (np.retail_price > 0) {
        const tier = db.prepare("SELECT id FROM price_tiers WHERE code = 'RETAIL'").get() as { id: number } | undefined
        if (tier) {
          db.prepare('INSERT INTO product_prices (product_id, price_tier_id, price) VALUES (?, ?, ?)').run(
            productId,
            tier.id,
            np.retail_price
          )
        }
      }
      created++
    }

    // 2) ลงบัญชีขายเป็น ISSUE movements (ledger — ไม่แตะยอดรวมโดยตรง)
    const importId = Number(
      db
        .prepare(
          `INSERT INTO bill_imports (batch_id, close_date, file_path, issue_count, new_product_count, skipped_count, total_qty, note, imported_by)
           VALUES (?, ?, ?, 0, ?, 0, 0, ?, ?)`
        )
        .run(batch.batch_id, batch.close_date ?? null, path, created, batch.note ?? null, user.id).lastInsertRowid
    )

    let imported = 0
    let skipped = 0
    let totalQty = 0
    const insMovement = db.prepare(
      `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, reference_type, reference_id, note, created_by)
       VALUES (?, ?, 'ISSUE', ?, 'bill', ?, ?, ?)`
    )
    for (const issue of batch.issues ?? []) {
      const product = matchProduct(issue)
      const locationId = locationIdByName(issue.location)
      if (!product || locationId == null || !(issue.qty_base > 0)) {
        skipped++
        continue
      }
      insMovement.run(
        product.id,
        locationId,
        -Math.abs(issue.qty_base),
        importId,
        `ขายตามบิล ${issue.doc_number ?? '-'}`,
        user.id
      )
      imported++
      totalQty += issue.qty_base
    }

    db.prepare('UPDATE bill_imports SET issue_count = ?, skipped_count = ?, total_qty = ? WHERE id = ?').run(
      imported,
      skipped,
      totalQty,
      importId
    )

    return { imported, skipped, created }
  })

  return run()
}

export function registerExchangeHandlers(): void {
  handle('exchange:exportCatalog', 2, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const res = await dialog.showSaveDialog(win, {
      title: 'ส่งออกรายการสินค้าให้ระบบเก็บบิล',
      defaultPath: `stockkeep-catalog-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`,
      filters: [{ name: 'StockKeep Catalog', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true }
    writeFileSync(res.filePath, buildCatalogJson(), 'utf8')
    return { canceled: false, path: res.filePath }
  })

  handle('exchange:pickBatch', 2, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      title: 'เลือกไฟล์ผลการปิดวันจากระบบเก็บบิล',
      properties: ['openFile'],
      filters: [{ name: 'BillKeep Batch', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePaths[0]) return { canceled: true }
    return { canceled: false, preview: previewBatch(res.filePaths[0]) }
  })

  handle('exchange:apply', 2, (path: string) => applyBatch(path))

  handle('exchange:history', 2, () => {
    return (
      getDb()
        .prepare(
          `SELECT bi.*, u.display_name AS user_name FROM bill_imports bi
           LEFT JOIN users u ON u.id = bi.imported_by
           ORDER BY bi.id DESC LIMIT 100`
        )
        .all() as {
        id: number
        batch_id: string
        close_date: string | null
        file_path: string | null
        issue_count: number
        new_product_count: number
        skipped_count: number
        total_qty: number
        imported_at: string
        user_name: string | null
      }[]
    ).map(
      (r): BillImportView => ({
        id: r.id,
        batchId: r.batch_id,
        closeDate: r.close_date,
        filePath: r.file_path,
        issueCount: r.issue_count,
        newProductCount: r.new_product_count,
        skippedCount: r.skipped_count,
        totalQty: r.total_qty,
        importedAt: r.imported_at,
        userName: r.user_name
      })
    )
  })
}
