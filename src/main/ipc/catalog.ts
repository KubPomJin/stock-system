// นำเข้ารายการสินค้าจากไฟล์ Excel ของระบบเดิม (Real 4POS)
//
// 4POS ยังถูกใช้งานอยู่และมีสินค้าเพิ่มเรื่อยๆ หน้านี้จึงมีไว้ให้เอาไฟล์
// "รายงานสินค้าคงคลัง" ที่ export ออกมาใหม่ มาเติมของที่ StockKeep ยังไม่มี
// ได้เองโดยไม่ต้องพิมพ์มือทีละรายการ (4,660 รายการพิมพ์มือไม่ไหว)
//
// กติกาที่ยึด — ตกลงกับเจ้าของร้านไว้:
//   * จับคู่ด้วย "บาร์โค้ด" เท่านั้น
//   * บาร์โค้ดที่มีอยู่แล้ว = ไม่แตะ ชื่อ ราคา ทุน หน่วย (ของที่แก้ไว้เองไม่โดนทับ)
//     แต่ "ยอดคงเหลือ" จะถูกทับ ถ้าเลือกนำเข้ายอดด้วย
//   * บาร์โค้ดใหม่ = เพิ่มเข้ามา พร้อมสร้างหมวดหมู่/หน่วยที่ยังไม่มี
//   * ยอดคงเหลือจาก 4POS เป็น "ตัวเลือก" ตอนนำเข้า เลือกได้ว่าจะลงสถานที่ไหน
//     (ปกติคือคลังสินค้า) ถ้าสินค้านั้นมียอดอยู่แล้ว ยอดจะถูกทับด้วยเลขจาก 4POS
//   * "ทับ" ในที่นี้ยังเป็น ledger — คิดส่วนต่างจากยอดปัจจุบันแล้วลงเป็น movement
//     ไม่มีการ UPDATE ยอดตรงๆ ที่ไหน (กติกาข้อ 1 ของโปรเจกต์) ผลลัพธ์เท่ากัน
//     แต่ยังรู้ได้ว่าใครเปลี่ยนเมื่อไหร่ และย้อนดูได้ในหน้าประวัติสต๊อก
import { BrowserWindow, dialog } from 'electron'
import { basename } from 'path'
import * as XLSX from 'xlsx'
import { getDb } from '../database'
import { getSession } from '../session'
import { handle } from './helpers'
import type { CatalogImportView, CatalogPreview } from '../../shared/types'

const REF_TYPE = 'import-4pos'

interface CatalogRow {
  barcode: string
  subBarcode: string | null
  description: string
  category: string | null
  unit: string
  cost: number
  priceRetail: number
  priceExtra1: number
  priceExtra2: number
  qty: number
  minStock: number
  maxStock: number
}

interface ParsedFile {
  rows: CatalogRow[]
  problems: string[]
}

// ชื่อคอลัมน์ที่ 4POS ใช้ (ตรงตามหัวตารางในไฟล์ export)
const COL = {
  barcode: 'Barcode',
  subBarcode: 'Sub_Barcode',
  description: 'Description_1',
  category: 'Group_Description_1',
  unit: 'Unit_Description_2',
  cost: 'Cost',
  retail: 'Price_1',
  extra1: 'Price_2',
  extra2: 'Price_5',
  qty: 'Quantity',
  contain: 'Contain',
  min: 'Minimum',
  max: 'Maximum'
}

function text(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v).trim()
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

// อ่านไฟล์ .xls (Excel 97 แบบไบนารี) หรือ .xlsx ก็ได้ — 4POS ส่งออกมาเป็น .xls
// หัวตารางไม่ได้อยู่บรรทัดแรกเสมอ (บรรทัดแรกเป็นชื่อรายงาน + วันที่) จึงไล่หา
// บรรทัดที่มีคำว่า Barcode แทนการ hard-code เลขบรรทัด
function parseCatalogFile(path: string): ParsedFile {
  let grid: unknown[][]
  try {
    const wb = XLSX.readFile(path)
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) throw new Error('no sheet')
    grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' }) as unknown[][]
  } catch {
    throw new Error('อ่านไฟล์ไม่ได้ — ต้องเป็นไฟล์ Excel (.xls หรือ .xlsx) ที่ไม่เสียหาย')
  }

  const headerIdx = grid.findIndex((r) => r.some((c) => text(c) === COL.barcode))
  if (headerIdx < 0) {
    throw new Error(`ไม่พบหัวตาราง "${COL.barcode}" ในไฟล์ — ไฟล์นี้อาจไม่ใช่รายงานสินค้าคงคลังของ 4POS`)
  }
  const header = grid[headerIdx].map(text)
  const at = (name: string): number => header.indexOf(name)

  const missing = [COL.barcode, COL.description, COL.qty].filter((c) => at(c) < 0)
  if (missing.length) throw new Error(`ไฟล์ขาดคอลัมน์ที่จำเป็น: ${missing.join(', ')}`)

  const cell = (row: unknown[], name: string): unknown => {
    const i = at(name)
    return i < 0 ? '' : row[i]
  }

  const problems: string[] = []
  const rows: CatalogRow[] = []
  const seen = new Set<string>()
  let multiUnit = 0

  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r]
    const barcode = text(cell(row, COL.barcode))
    const description = text(cell(row, COL.description))
    if (!barcode && !description) continue // บรรทัดว่างท้ายไฟล์
    if (!barcode) {
      if (problems.length < 20) problems.push(`บรรทัดที่ ${r + 1}: ไม่มีบาร์โค้ด ("${description || '-'}") — จะข้ามไป`)
      continue
    }
    if (seen.has(barcode)) {
      if (problems.length < 20) problems.push(`บาร์โค้ด ${barcode} ซ้ำกันเองในไฟล์ — ใช้บรรทัดแรกที่เจอ`)
      continue
    }
    seen.add(barcode)

    // ทุกอย่างในระบบตอนนี้เป็นสินค้าหน่วยเดียว (BACKLOG 3.0) เพราะยังไม่รู้
    // ตัวคูณจริง ถ้าไฟล์เริ่มมี Contain != 1 แปลว่าสมมติฐานนี้ใช้ไม่ได้แล้ว
    // ต้องบอกก่อน ไม่ใช่สร้างหน่วยผิดๆ ไว้เงียบๆ
    const contain = num(cell(row, COL.contain))
    if (contain && contain !== 1) multiUnit++

    const sub = text(cell(row, COL.subBarcode))
    rows.push({
      barcode,
      subBarcode: sub && sub !== barcode ? sub : null,
      description: description || barcode,
      category: text(cell(row, COL.category)) || null,
      unit: text(cell(row, COL.unit)) || 'ชิ้น',
      cost: num(cell(row, COL.cost)),
      priceRetail: num(cell(row, COL.retail)),
      priceExtra1: num(cell(row, COL.extra1)),
      priceExtra2: num(cell(row, COL.extra2)),
      qty: num(cell(row, COL.qty)),
      minStock: num(cell(row, COL.min)),
      maxStock: num(cell(row, COL.max))
    })
  }

  if (multiUnit > 0) {
    problems.push(
      `มี ${multiUnit} รายการที่ช่อง Contain ไม่เท่ากับ 1 — ระบบจะยังสร้างเป็นสินค้าหน่วยเดียว ` +
        `ต้องไปตั้งระดับหน่วยเองภายหลัง`
    )
  }
  if (!rows.length) throw new Error('ไม่พบรายการสินค้าในไฟล์')
  return { rows, problems }
}

function buildPreview(path: string): CatalogPreview {
  const db = getDb()
  const { rows, problems } = parseCatalogFile(path)

  const existing = new Map(
    (db.prepare('SELECT barcode, id, description FROM products').all() as {
      barcode: string
      id: number
      description: string
    }[]).map((p) => [String(p.barcode), p])
  )
  const knownCats = new Set(
    (db.prepare('SELECT name FROM categories').all() as { name: string }[]).map((c) => c.name)
  )
  const knownUnits = new Set((db.prepare('SELECT name FROM units').all() as { name: string }[]).map((u) => u.name))

  const newCats = new Set<string>()
  const newUnits = new Set<string>()
  const matches: CatalogPreview['matches'] = []
  let added = 0
  let withStock = 0

  for (const r of rows) {
    const hit = existing.get(r.barcode)
    if (hit) {
      // บาร์โค้ดตรงกันไม่ได้แปลว่าเป็นสินค้าตัวเดียวกันเสมอ — รหัสสั้นๆ ที่คีย์มือ
      // ชนกับรหัสจริงของ 4POS ได้ง่าย จึงส่งชื่อทั้งสองฝั่งไปให้คนดูก่อน
      if (matches.length < 200) {
        matches.push({ barcode: r.barcode, mine: hit.description, theirs: r.description, qty: r.qty })
      }
    } else {
      added++
      if (r.category && !knownCats.has(r.category)) newCats.add(r.category)
      if (!knownUnits.has(r.unit)) newUnits.add(r.unit)
    }
    if (r.qty !== 0) withStock++
  }

  const locations = db.prepare('SELECT id, name FROM locations ORDER BY id').all() as {
    id: number
    name: string
  }[]

  const last = db
    .prepare('SELECT imported_at FROM catalog_imports ORDER BY id DESC LIMIT 1')
    .get() as { imported_at: string } | undefined

  return {
    filePath: path,
    fileName: basename(path),
    rowCount: rows.length,
    addedCount: added,
    existingCount: rows.length - added,
    newCategories: [...newCats].sort(),
    newUnits: [...newUnits].sort(),
    withStockCount: withStock,
    locations,
    matches,
    problems,
    lastImportedAt: last ? last.imported_at : null
  }
}

function applyCatalog(path: string, withStock: boolean, locationId: number): {
  added: number
  skipped: number
  stockRows: number
} {
  const db = getDb()
  const user = getSession()!
  const { rows } = parseCatalogFile(path)

  if (withStock) {
    const loc = db.prepare('SELECT id FROM locations WHERE id = ?').get(locationId)
    if (!loc) throw new Error('ไม่พบสถานที่เก็บที่เลือก')
  }

  const run = db.transaction(() => {
    const byBarcode = new Map(
      (db.prepare('SELECT barcode, id FROM products').all() as { barcode: string; id: number }[]).map((p) => [
        String(p.barcode),
        p.id
      ])
    )
    const catId = new Map(
      (db.prepare('SELECT name, id FROM categories').all() as { name: string; id: number }[]).map((c) => [c.name, c.id])
    )
    const unitId = new Map(
      (db.prepare('SELECT name, id FROM units').all() as { name: string; id: number }[]).map((u) => [u.name, u.id])
    )
    const tier = new Map(
      (db.prepare('SELECT code, id FROM price_tiers').all() as { code: string; id: number }[]).map((t) => [t.code, t.id])
    )

    const insCat = db.prepare('INSERT INTO categories (name) VALUES (?)')
    const insUnit = db.prepare('INSERT INTO units (name) VALUES (?)')
    const insProd = db.prepare(
      `INSERT INTO products (barcode, sub_barcode, description, category_id, min_stock, max_stock, latest_cost, barcode_pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    )
    const insPU = db.prepare(
      `INSERT INTO product_units (product_id, unit_id, qty_per_base, sort_order, is_base_unit) VALUES (?, ?, 1, 0, 1)`
    )
    const insPrice = db.prepare('INSERT INTO product_prices (product_id, price_tier_id, price) VALUES (?, ?, ?)')

    let added = 0
    let skipped = 0
    for (const r of rows) {
      if (byBarcode.has(r.barcode)) {
        skipped++
        continue
      }
      if (r.category && !catId.has(r.category)) {
        catId.set(r.category, Number(insCat.run(r.category).lastInsertRowid))
      }
      if (!unitId.has(r.unit)) unitId.set(r.unit, Number(insUnit.run(r.unit).lastInsertRowid))

      const pid = Number(
        insProd.run(
          r.barcode,
          r.subBarcode,
          r.description,
          r.category ? catId.get(r.category) : null,
          r.minStock,
          r.maxStock,
          r.cost
        ).lastInsertRowid
      )
      insPU.run(pid, unitId.get(r.unit))
      for (const [code, val] of [
        ['RETAIL', r.priceRetail],
        ['TRADESMAN', r.priceExtra1],
        ['WHOLESALE', r.priceExtra2]
      ] as [string, number][]) {
        if (val > 0 && tier.has(code)) insPrice.run(pid, tier.get(code), val)
      }
      byBarcode.set(r.barcode, pid)
      added++
    }

    // ---- ยอดคงเหลือ (ถ้าเลือกเอา) ----------------------------------------
    // ตั้งยอดของสถานที่ที่เลือกให้ "เท่ากับ" ตัวเลขในไฟล์ ของเดิมถูกทับ
    //
    // ทับด้วยการคิดส่วนต่างแล้วลงเป็น movement ไม่ใช่ UPDATE ยอด — ยอดคงเหลือ
    // ยังเป็น SUM(qty_change) เหมือนทุกที่ในโปรแกรม และเห็นในหน้าประวัติสต๊อก
    // ว่าการนำเข้าครั้งนี้ทำให้อะไรเปลี่ยนไปเท่าไหร่ ผลข้างเคียงที่ได้มาฟรีคือ
    // นำเข้าไฟล์เดิมซ้ำแล้วยอดไม่บวกทบ เพราะส่วนต่างจะเป็นศูนย์
    //
    // สินค้าที่ไม่ได้อยู่ในไฟล์จะไม่ถูกแตะ — ของที่สร้างใน StockKeep เองต้องไม่
    // ถูกล้างยอดเพราะ 4POS ไม่รู้จักมัน
    let stockRows = 0
    if (withStock) {
      const balances = new Map(
        (db
          .prepare(
            `SELECT product_id, SUM(qty_change) q FROM stock_movements
              WHERE location_id = ? GROUP BY product_id`
          )
          .all(locationId) as { product_id: number; q: number }[]).map((b) => [b.product_id, b.q])
      )
      const insMove = db.prepare(
        `INSERT INTO stock_movements
           (product_id, location_id, movement_type, qty_change, unit_cost, reference_type, note, created_by)
         VALUES (?, ?, ?, ?, ?, '${REF_TYPE}', ?, ?)`
      )
      const note = `ตั้งยอดตามไฟล์ 4POS (${basename(path)})`
      const done = new Set<number>()
      for (const r of rows) {
        const pid = byBarcode.get(r.barcode)
        if (pid === undefined || done.has(pid)) continue
        done.add(pid)
        const had = balances.has(pid)
        const now = balances.get(pid) ?? 0
        const delta = r.qty - now
        if (delta === 0) continue
        // ไม่เคยมี movement ที่นี่มาก่อน = ยอดตั้งต้น ไม่ใช่การปรับ
        insMove.run(pid, locationId, had ? 'ADJUST' : 'OPENING', delta, r.cost || 0, note, user.id)
        stockRows++
      }
    }

    db.prepare(
      `INSERT INTO catalog_imports
         (file_name, file_path, row_count, added_count, existing_count, stock_rows, with_stock, location_id, imported_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(basename(path), path, rows.length, added, skipped, stockRows, withStock ? 1 : 0,
          withStock ? locationId : null, user.id)

    return { added, skipped, stockRows }
  })

  return run()
}

export function registerCatalogHandlers(): void {
  // ระดับ 3 (แอดมิน) — ครั้งเดียวเพิ่มสินค้าได้เป็นพันรายการ ไม่ใช่งานประจำวัน
  handle('catalog:pickFile', 3, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      title: 'เลือกไฟล์รายการสินค้าจากระบบเดิม (4POS)',
      properties: ['openFile'],
      filters: [{ name: 'ไฟล์ Excel', extensions: ['xls', 'xlsx'] }]
    })
    if (res.canceled || !res.filePaths[0]) return { canceled: true }
    return { canceled: false, preview: buildPreview(res.filePaths[0]) }
  })

  handle('catalog:apply', 3, (payload: { filePath: string; withStock: boolean; locationId: number }) =>
    applyCatalog(String(payload?.filePath ?? ''), !!payload?.withStock, Number(payload?.locationId))
  )

  handle('catalog:history', 3, () => importHistory())
}

function importHistory(): CatalogImportView[] {
  return (getDb()
    .prepare(
      `SELECT ci.id, ci.file_name, ci.row_count, ci.added_count, ci.existing_count,
              ci.stock_rows, ci.with_stock, ci.imported_at, l.name AS location_name,
              u.display_name AS user_name
         FROM catalog_imports ci
         LEFT JOIN users u ON u.id = ci.imported_by
         LEFT JOIN locations l ON l.id = ci.location_id
        ORDER BY ci.id DESC LIMIT 50`
    )
    .all() as {
    id: number
    file_name: string
    row_count: number
    added_count: number
    existing_count: number
    stock_rows: number
    with_stock: number
    imported_at: string
    location_name: string | null
    user_name: string | null
  }[]).map((r) => ({
    id: r.id,
    fileName: r.file_name,
    rowCount: r.row_count,
    addedCount: r.added_count,
    existingCount: r.existing_count,
    stockRows: r.stock_rows,
    withStock: r.with_stock === 1,
    locationName: r.location_name,
    importedAt: r.imported_at,
    userName: r.user_name
  }))
}
