// จัดระเบียบชื่อสินค้าในบิล (v1.6.16)
//
// More than half of the shop's sales are bill lines typed by hand: things the
// 4POS product list never had (sand, stone, thinner, nails by weight ...) and
// stock items typed from the paper ticket instead of picked. The same item ends
// up under many spellings, so nothing can be searched or summed.
//
// This module gives every such name ONE agreed form, always by a person's
// decision — the matching only suggests:
//
//  * sale_items    — a name that is sold but not stock-counted ("ทรายหยาบ").
//                    Not a product: it never appears in stocktakes, low-stock
//                    warnings, the BillKeep catalogue or any stock view.
//  * item_aliases  — "this spelling means that item" (a sale item or a stock
//                    product). Used to tidy old lines, to link NEW lines as
//                    they are saved (resolveTypedName) and by the bill search.
//  * item_name_skips — names the owner chose to leave alone.
//
// What a tidy-up changes on a bill line: description, the link
// (product_id / sale_item_id) and orig_description (the text as it was typed,
// kept so the change can be undone). Never qty, unit, price or amount — so
// totals, cash-ups and reports' figures do not move, which is why lines on
// owner-checked (locked) days are tidied too. Nothing here touches stock.

import { getDb } from '../database'
import { getSession } from '../session'
import { handle } from './helpers'
import { dice, grams, matchScore, sameSizes, sizeTokens, textKey, type Grams } from '../../shared/textMatch'
import type {
  ItemSearchIndex,
  NameApplyPayload,
  NamedItem,
  NameFilter,
  NameGroup,
  NamePage,
  NameSpelling,
  NameSuggestion
} from '../../shared/types'

const UNSORTED = 'l.product_id IS NULL AND l.sale_item_id IS NULL'

/* ---------- linking a typed line when a bill is saved (called from sales.ts) ---------- */

export interface ResolvedName {
  productId: number | null
  saleItemId: number | null
  description: string
}

// A typed name that has an alias gets its agreed name and link. Anything else
// stays exactly as typed (and shows up on the clean-up page later).
export function resolveTypedName(description: string): ResolvedName | null {
  const key = textKey(description)
  if (!key) return null
  const r = getDb()
    .prepare(
      `SELECT a.product_id AS productId, a.sale_item_id AS saleItemId, COALESCE(p.description, s.name) AS name
       FROM item_aliases a
       LEFT JOIN products p ON p.id = a.product_id
       LEFT JOIN sale_items s ON s.id = a.sale_item_id
       WHERE a.alias_key = ?`
    )
    .get(key) as { productId: number | null; saleItemId: number | null; name: string | null } | undefined
  if (!r || !r.name) return null
  return { productId: r.productId, saleItemId: r.saleItemId, description: r.name }
}

/* ---------- pending names ---------- */

interface Typed {
  name: string
  lines: number
  key: string
  G: Grams
  S: Set<string>
}

interface Cluster {
  key: string // key of the most-used spelling
  lines: number
  members: (Typed & { same: boolean })[]
}

let clusterCache: { stamp: string; clusters: Cluster[] } | null = null
let productCache: { stamp: string; rows: { id: number; name: string; barcode: string; G: Grams; S: Set<string> }[] } | null = null

function pendingStamp(): string {
  const r = getDb()
    .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(l.id), 0) AS m, COALESCE(SUM(LENGTH(l.description)), 0) AS s FROM order_doc_lines l WHERE ${UNSORTED}`)
    .get() as { n: number; m: number; s: number }
  return `${r.n}:${r.m}:${r.s}`
}

// Spellings that differ only by spaces / quotes / the usual misspellings share
// a key and are certainly the same thing. Keys that merely look alike (and
// carry the same sizes) are put in the same group as "maybe" — a person ticks
// them, because โครงผนังเบาตัวซี and ...ตัวยู look alike and are not the same.
function buildClusters(): Cluster[] {
  const stamp = pendingStamp()
  if (clusterCache?.stamp === stamp) return clusterCache.clusters

  const rows = getDb()
    .prepare(
      `SELECT TRIM(l.description) AS name, COUNT(*) AS lines
       FROM order_doc_lines l WHERE ${UNSORTED} AND TRIM(l.description) <> ''
       GROUP BY TRIM(l.description)`
    )
    .all() as { name: string; lines: number }[]

  const byKey = new Map<string, Typed[]>()
  for (const r of rows) {
    const key = textKey(r.name)
    if (!key) continue
    const t: Typed = { ...r, key, G: grams(r.name), S: sizeTokens(r.name) }
    const list = byKey.get(key)
    if (list) list.push(t)
    else byKey.set(key, [t])
  }
  const reps = [...byKey.values()].map((list) => {
    list.sort((a, b) => b.lines - a.lines)
    return { head: list[0], lines: list.reduce((s, x) => s + x.lines, 0), list }
  })
  reps.sort((a, b) => b.lines - a.lines)

  // Each key joins the most-used key it resembles (no chaining through a
  // third name, which is how unrelated items would drift into one group).
  const owner = reps.map((_, i) => i)
  for (let i = 0; i < reps.length; i++) {
    if (owner[i] !== i) continue
    const a = reps[i].head
    for (let j = i + 1; j < reps.length; j++) {
      if (owner[j] !== j) continue
      const b = reps[j].head
      if (Math.abs(a.G.n - b.G.n) > 6 || !sameSizes(a.S, b.S)) continue
      if (dice(a.G, b.G) >= 0.86) owner[j] = i
    }
  }
  const clusters = new Map<number, Cluster>()
  reps.forEach((r, i) => {
    const o = owner[i]
    let c = clusters.get(o)
    if (!c) clusters.set(o, (c = { key: reps[o].head.key, lines: 0, members: [] }))
    c.lines += r.lines
    for (const t of r.list) c.members.push({ ...t, same: o === i })
  })
  const out = [...clusters.values()].sort((a, b) => b.lines - a.lines || a.key.localeCompare(b.key))
  clusterCache = { stamp, clusters: out }
  return out
}

function productRows(): NonNullable<typeof productCache>['rows'] {
  const s = getDb().prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), \'\') AS u, COALESCE(MAX(id), 0) AS m FROM products').get() as {
    n: number
    u: string
    m: number
  }
  const stamp = `${s.n}:${s.u}:${s.m}`
  if (productCache?.stamp === stamp) return productCache.rows
  const rows = (
    getDb().prepare('SELECT id, description AS name, barcode FROM products WHERE discontinued = 0').all() as {
      id: number
      name: string
      barcode: string
    }[]
  ).map((p) => ({ ...p, G: grams(p.name), S: sizeTokens(p.name) }))
  productCache = { stamp, rows }
  return rows
}

function suggestionsFor(name: string): NameSuggestion[] {
  const G = grams(name)
  const S = sizeTokens(name)
  const out: NameSuggestion[] = []
  for (const p of productRows()) {
    const score = matchScore(G, S, p.G, p.S)
    if (score >= 0.6) out.push({ kind: 'product', id: p.id, name: p.name, barcode: p.barcode, score, sure: dice(G, p.G) >= 0.93 && sameSizes(S, p.S) })
  }
  const items = getDb().prepare('SELECT id, name FROM sale_items').all() as { id: number; name: string }[]
  for (const s of items) {
    const sG = grams(s.name)
    const sS = sizeTokens(s.name)
    const score = matchScore(G, S, sG, sS)
    // An agreed sale item is the likelier answer than a look-alike stock item.
    if (score >= 0.6) {
      out.push({ kind: 'saleItem', id: s.id, name: s.name, barcode: null, score: Math.min(1, score + 0.03), sure: dice(G, sG) >= 0.9 && sameSizes(S, sS) })
    }
  }
  return out
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => ({ ...s, score: Math.round(s.score * 100) / 100 }))
}

function groupDetail(c: Cluster, skipped: Set<string>): NameGroup {
  const db = getDb()
  const names = c.members.map((m) => m.name)
  const marks = names.map(() => '?').join(',')
  const agg = db
    .prepare(
      `SELECT COUNT(DISTINCT l.order_id) AS bills, MAX(o.doc_date) AS lastSold,
              MIN(l.unit_price) AS lo, MAX(l.unit_price) AS hi
       FROM order_doc_lines l JOIN order_docs o ON o.id = l.order_id
       WHERE ${UNSORTED} AND TRIM(l.description) IN (${marks})`
    )
    .get(...names) as { bills: number; lastSold: string | null; lo: number | null; hi: number | null }
  const units = db
    .prepare(
      `SELECT TRIM(COALESCE(l.unit_name, '')) AS unit, COUNT(*) AS n
       FROM order_doc_lines l WHERE ${UNSORTED} AND TRIM(l.description) IN (${marks})
       GROUP BY unit ORDER BY n DESC`
    )
    .all(...names) as { unit: string; n: number }[]
  const commonUnit = units.find((u) => u.unit)?.unit ?? ''
  const last = db
    .prepare(
      `SELECT l.unit_price AS p FROM order_doc_lines l JOIN order_docs o ON o.id = l.order_id
       WHERE ${UNSORTED} AND TRIM(l.description) IN (${marks}) AND TRIM(COALESCE(l.unit_name, '')) = ? AND l.unit_price > 0
       ORDER BY o.doc_date DESC, l.id DESC LIMIT 1`
    )
    .get(...names, commonUnit) as { p: number } | undefined
  const head = c.members[0]
  return {
    key: c.key,
    name: head.name,
    lines: c.lines,
    bills: agg.bills,
    spellings: c.members.map((m): NameSpelling => ({ name: m.name, lines: m.lines, same: m.same })),
    units: units
      .filter((u) => u.unit)
      .map((u) => u.unit)
      .join(', '),
    commonUnit,
    lastPrice: last?.p ?? 0,
    priceLow: agg.lo ?? 0,
    priceHigh: agg.hi ?? 0,
    lastSold: agg.lastSold,
    skipped: skipped.has(c.key),
    suggestions: suggestionsFor(head.name)
  }
}

function pending(f: NameFilter): NamePage {
  const db = getDb()
  const clusters = buildClusters()
  const skipped = new Set((db.prepare('SELECT name_key FROM item_name_skips').all() as { name_key: string }[]).map((r) => r.name_key))
  const q = textKey(f?.search ?? '')
  const list = clusters.filter((c) => {
    if (!f?.showSkipped && skipped.has(c.key)) return false
    if (q && !c.members.some((m) => m.key.includes(q))) return false
    return true
  })
  const offset = Math.max(0, Math.floor(Number(f?.offset) || 0))
  const limit = Math.min(100, Math.max(1, Math.floor(Number(f?.limit) || 20)))
  const done = db.prepare('SELECT COUNT(*) AS n FROM order_doc_lines WHERE orig_description IS NOT NULL').get() as { n: number }
  return {
    groups: list.slice(offset, offset + limit).map((c) => groupDetail(c, skipped)),
    total: list.length,
    pendingNames: clusters.reduce((s, c) => s + c.members.length, 0),
    pendingLines: clusters.reduce((s, c) => s + c.lines, 0),
    doneLines: done.n
  }
}

/* ---------- applying a decision ---------- */

function cleanNames(names: unknown): string[] {
  const list = Array.isArray(names) ? [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))] : []
  if (!list.length) throw new Error('ยังไม่ได้เลือกชื่อที่จะจัด')
  if (list.length > 300) throw new Error('เลือกชื่อมากเกินไปในครั้งเดียว (สูงสุด 300)')
  return list
}

function setAlias(alias: string, productId: number | null, saleItemId: number | null, userId: number): void {
  const key = textKey(alias)
  if (!key) return
  // The latest decision about a spelling wins.
  getDb()
    .prepare(
      `INSERT INTO item_aliases (alias, alias_key, product_id, sale_item_id, created_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(alias_key) DO UPDATE SET alias = excluded.alias, product_id = excluded.product_id,
         sale_item_id = excluded.sale_item_id, created_by = excluded.created_by, created_at = CURRENT_TIMESTAMP`
    )
    .run(alias, key, productId, saleItemId, userId)
}

function apply(p: NameApplyPayload): { lines: number; name: string } {
  const user = getSession()!
  const db = getDb()
  const names = cleanNames(p?.names)
  const t = p?.target
  if (!t) throw new Error('ยังไม่ได้เลือกว่าจะจัดเป็นชื่ออะไร')

  let result = { lines: 0, name: '' }
  db.transaction(() => {
    let productId: number | null = null
    let saleItemId: number | null = null
    let name = ''

    if (t.type === 'product') {
      const prod = db.prepare('SELECT id, description FROM products WHERE id = ?').get(Number(t.productId)) as
        | { id: number; description: string }
        | undefined
      if (!prod) throw new Error('ไม่พบสินค้านี้ในรายการสินค้า')
      productId = prod.id
      name = prod.description
    } else if (t.type === 'saleItem') {
      const item = db.prepare('SELECT id, name FROM sale_items WHERE id = ?').get(Number(t.saleItemId)) as
        | { id: number; name: string }
        | undefined
      if (!item) throw new Error('ไม่พบชื่อขายนี้')
      saleItemId = item.id
      name = item.name
    } else {
      name = String(t.name ?? '').trim().replace(/\s+/g, ' ')
      if (!name) throw new Error('กรุณาพิมพ์ชื่อที่ถูกต้อง')
      const key = textKey(name)
      if (!key) throw new Error('ชื่อนี้ใช้ไม่ได้')
      const unitName = String(t.unitName ?? '').trim()
      const unitPrice = Math.max(0, Math.round((Number(t.unitPrice) || 0) * 100) / 100)
      const existing = db.prepare('SELECT id, name FROM sale_items WHERE name_key = ?').get(key) as { id: number; name: string } | undefined
      if (existing) {
        // Same name already agreed earlier — add these spellings to it.
        saleItemId = existing.id
        name = existing.name
      } else {
        saleItemId = Number(
          db
            .prepare('INSERT INTO sale_items (name, name_key, unit_name, unit_price, created_by) VALUES (?, ?, ?, ?, ?)')
            .run(name, key, unitName || null, unitPrice, user.id).lastInsertRowid
        )
      }
    }

    let lines = 0
    const upd = db.prepare(
      `UPDATE order_doc_lines
       SET orig_description = COALESCE(orig_description, description), description = ?, product_id = ?, sale_item_id = ?
       WHERE product_id IS NULL AND sale_item_id IS NULL AND TRIM(description) = ?`
    )
    for (const n of names) {
      lines += upd.run(name, productId, saleItemId, n).changes
      setAlias(n, productId, saleItemId, user.id)
    }
    setAlias(name, productId, saleItemId, user.id)
    result = { lines, name }
  })()
  clusterCache = null
  return result
}

function skip(p: { names: string[]; skipped: boolean }): void {
  const user = getSession()!
  const db = getDb()
  const names = cleanNames(p?.names)
  db.transaction(() => {
    for (const n of names) {
      const key = textKey(n)
      if (!key) continue
      if (p.skipped) {
        db.prepare('INSERT OR REPLACE INTO item_name_skips (name_key, name, skipped_by) VALUES (?, ?, ?)').run(key, n, user.id)
      } else {
        db.prepare('DELETE FROM item_name_skips WHERE name_key = ?').run(key)
      }
    }
  })()
}

/* ---------- agreed names: list, rename, undo ---------- */

function items(): NamedItem[] {
  const db = getDb()
  const aliases = db
    .prepare('SELECT alias, product_id AS productId, sale_item_id AS saleItemId FROM item_aliases ORDER BY alias')
    .all() as { alias: string; productId: number | null; saleItemId: number | null }[]
  // Spellings that differ only by spacing / quotes share ONE alias row (same
  // key), so the list a person reads is taken from the bills themselves: every
  // text that was actually typed and then tidied into this item.
  const typed = db
    .prepare(
      `SELECT DISTINCT TRIM(orig_description) AS alias, product_id AS productId, sale_item_id AS saleItemId
       FROM order_doc_lines WHERE orig_description IS NOT NULL`
    )
    .all() as { alias: string; productId: number | null; saleItemId: number | null }[]
  const aliasOf = (kind: 'p' | 's', id: number, name: string): string[] => [
    ...new Set(
      [...typed, ...aliases]
        .filter((a) => (kind === 'p' ? a.productId === id && a.saleItemId == null : a.saleItemId === id) && a.alias !== name)
        .map((a) => a.alias)
    )
  ]

  const sale = db
    .prepare(
      `SELECT s.id, s.name, COALESCE(s.unit_name, '') AS unitName, s.unit_price AS unitPrice,
              COUNT(l.id) AS lines, COALESCE(SUM(l.orig_description IS NOT NULL), 0) AS tidied, MAX(o.doc_date) AS lastSold
       FROM sale_items s
       LEFT JOIN order_doc_lines l ON l.sale_item_id = s.id
       LEFT JOIN order_docs o ON o.id = l.order_id
       GROUP BY s.id`
    )
    .all() as { id: number; name: string; unitName: string; unitPrice: number; lines: number; tidied: number; lastSold: string | null }[]

  // Stock products only show up here when a typed spelling was pointed at them.
  const prods = db
    .prepare(
      `SELECT p.id, p.description AS name, p.barcode,
              (SELECT COUNT(*) FROM order_doc_lines l WHERE l.product_id = p.id) AS lines,
              (SELECT COUNT(*) FROM order_doc_lines l WHERE l.product_id = p.id AND l.orig_description IS NOT NULL) AS tidied,
              (SELECT MAX(o.doc_date) FROM order_doc_lines l JOIN order_docs o ON o.id = l.order_id WHERE l.product_id = p.id) AS lastSold
       FROM products p WHERE p.id IN (SELECT product_id FROM item_aliases WHERE product_id IS NOT NULL)`
    )
    .all() as { id: number; name: string; barcode: string; lines: number; tidied: number; lastSold: string | null }[]

  return [
    ...sale.map((s): NamedItem => ({ kind: 'saleItem', ...s, barcode: null, aliases: aliasOf('s', s.id, s.name) })),
    ...prods.map((p): NamedItem => ({ kind: 'product', ...p, unitName: '', unitPrice: 0, aliases: aliasOf('p', p.id, p.name) }))
  ].sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name, 'th'))
}

function renameItem(p: { id: number; name: string }): { lines: number } {
  const user = getSession()!
  const db = getDb()
  const name = String(p?.name ?? '').trim().replace(/\s+/g, ' ')
  if (!name) throw new Error('กรุณาพิมพ์ชื่อใหม่')
  const key = textKey(name)
  if (!key) throw new Error('ชื่อนี้ใช้ไม่ได้')
  const item = db.prepare('SELECT id, name FROM sale_items WHERE id = ?').get(Number(p.id)) as { id: number; name: string } | undefined
  if (!item) throw new Error('ไม่พบชื่อขายนี้')
  const clash = db.prepare('SELECT id, name FROM sale_items WHERE name_key = ? AND id <> ?').get(key, item.id) as { name: string } | undefined
  if (clash) throw new Error(`มีชื่อขาย "${clash.name}" อยู่แล้ว — ใช้ชื่ออื่น`)

  let lines = 0
  db.transaction(() => {
    db.prepare('UPDATE sale_items SET name = ?, name_key = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, key, user.id, item.id)
    // Every bill that carries the item follows the new name. The text as first
    // typed stays in orig_description; lines keyed straight from the search
    // (no orig yet) remember the old name so the rename can be undone too.
    lines = db
      .prepare('UPDATE order_doc_lines SET orig_description = COALESCE(orig_description, description), description = ? WHERE sale_item_id = ?')
      .run(name, item.id).changes
    setAlias(name, null, item.id, user.id) // the old name keeps working as an alias
  })()
  return { lines }
}

function updateItem(p: { id: number; unitName: string; unitPrice: number }): void {
  const user = getSession()!
  const price = Math.round((Number(p?.unitPrice) || 0) * 100) / 100
  if (price < 0) throw new Error('ราคาติดลบไม่ได้')
  const r = getDb()
    .prepare('UPDATE sale_items SET unit_name = ?, unit_price = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(String(p?.unitName ?? '').trim() || null, price, user.id, Number(p?.id))
  if (!r.changes) throw new Error('ไม่พบชื่อขายนี้')
}

// Puts the tidied lines back to the text that was typed and forgets the
// aliases, so the names return to the "to sort" list.
function undo(p: { saleItemId?: number; productId?: number }): { lines: number } {
  const db = getDb()
  let lines = 0
  db.transaction(() => {
    if (p?.saleItemId) {
      const id = Number(p.saleItemId)
      if (!db.prepare('SELECT id FROM sale_items WHERE id = ?').get(id)) throw new Error('ไม่พบชื่อขายนี้')
      lines = db
        .prepare(
          `UPDATE order_doc_lines SET description = COALESCE(orig_description, description), orig_description = NULL, sale_item_id = NULL
           WHERE sale_item_id = ?`
        )
        .run(id).changes
      db.prepare('DELETE FROM item_aliases WHERE sale_item_id = ?').run(id)
      db.prepare('DELETE FROM sale_items WHERE id = ?').run(id)
    } else if (p?.productId) {
      const id = Number(p.productId)
      // Only lines the clean-up pointed at the product — never ones picked from the product list.
      lines = db
        .prepare(
          `UPDATE order_doc_lines SET description = orig_description, orig_description = NULL, product_id = NULL
           WHERE product_id = ? AND orig_description IS NOT NULL`
        )
        .run(id).changes
      db.prepare('DELETE FROM item_aliases WHERE product_id = ?').run(id)
    } else {
      throw new Error('ไม่ได้ระบุรายการที่จะยกเลิก')
    }
  })()
  clusterCache = null
  return { lines }
}

/* ---------- search index for the bill page ---------- */

function searchIndex(): ItemSearchIndex {
  const db = getDb()
  const aliases = db
    .prepare('SELECT alias, product_id AS productId, sale_item_id AS saleItemId FROM item_aliases')
    .all() as { alias: string; productId: number | null; saleItemId: number | null }[]
  const saleItems = (
    db
      .prepare(
        `SELECT s.id, s.name, COALESCE(s.unit_name, '') AS unitName, s.unit_price AS unitPrice,
                (SELECT COUNT(*) FROM order_doc_lines l WHERE l.sale_item_id = s.id) AS uses
         FROM sale_items s`
      )
      .all() as { id: number; name: string; unitName: string; unitPrice: number; uses: number }[]
  ).map((s) => ({ ...s, aliases: aliases.filter((a) => a.saleItemId === s.id && a.alias !== s.name).map((a) => a.alias) }))

  const productUses: Record<number, number> = {}
  for (const r of db
    .prepare('SELECT product_id AS id, COUNT(*) AS n FROM order_doc_lines WHERE product_id IS NOT NULL GROUP BY product_id')
    .all() as { id: number; n: number }[])
    productUses[r.id] = r.n
  const productAliases: Record<number, string[]> = {}
  for (const a of aliases) if (a.productId) (productAliases[a.productId] ??= []).push(a.alias)
  return { saleItems, productUses, productAliases }
}

export function registerItemNameHandlers(): void {
  // Deciding what a name means is for the owner / manager.
  handle('names:pending', 2, (f: NameFilter) => pending(f ?? {}))
  handle('names:apply', 2, (p: NameApplyPayload) => apply(p))
  handle('names:skip', 2, (p: { names: string[]; skipped: boolean }) => skip(p))
  handle('names:items', 2, () => items())
  handle('names:renameItem', 2, (p: { id: number; name: string }) => renameItem(p))
  handle('names:updateItem', 2, (p: { id: number; unitName: string; unitPrice: number }) => updateItem(p))
  handle('names:undo', 2, (p: { saleItemId?: number; productId?: number }) => undo(p))
  // The counter needs the agreed names to search with (names, units, retail prices only).
  handle('names:searchIndex', 1, () => searchIndex())
}
