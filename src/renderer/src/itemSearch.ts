// Item search shared by the bill page and the name clean-up page (v1.6.16).
//
// What it finds: stock products AND "sale items" (agreed names for things that
// are sold but not stock-counted — see ipc/itemNames.ts), plus every spelling
// that was pointed at either of them.
//
// How it matches: through normText()/textKey() from shared/textMatch, so
// น๊อต finds น็อต, `2x1` finds `2 x 1`, `ตะปู 2 1/2` finds `ตะปู 2-1/2"`, and
// the words can come in any order. Items sold more often come first.

import { state } from './state'
import { normText, textKey } from '../../shared/textMatch'
import type { ItemSearchIndex, ProductView } from '../../shared/types'

export type SaleItemEntry = ItemSearchIndex['saleItems'][number]

export type Found = { kind: 'product'; p: ProductView; uses: number } | { kind: 'saleItem'; s: SaleItemEntry; uses: number }

interface Entry {
  found: Found
  name: string
  nameKey: string
  bar: string
  hay: string // normalised, words separated by one space
  compact: string // same text with no spaces or quote marks
}

let extra: ItemSearchIndex = { saleItems: [], productUses: {}, productAliases: {} }
let builtFor: { products: ProductView[]; extra: ItemSearchIndex } | null = null
let entries: Entry[] = []
let saleByKey = new Map<string, SaleItemEntry>()

// Pulls the agreed names and how often each item is sold. Cheap; called when
// the bill page opens and after the clean-up page changes something.
export async function refreshItemIndex(): Promise<void> {
  try {
    extra = await window.api.names.searchIndex()
  } catch {
    // Searching stock products still works without it.
  }
}

function ensureIndex(): void {
  if (builtFor && builtFor.products === state.products && builtFor.extra === extra) return
  builtFor = { products: state.products, extra }
  entries = []
  saleByKey = new Map()
  for (const p of state.products) {
    const text = `${p.barcode ?? ''} ${p.subBarcode ?? ''} ${p.description} ${(extra.productAliases[p.id] ?? []).join(' ')}`
    entries.push({
      found: { kind: 'product', p, uses: extra.productUses[p.id] ?? 0 },
      name: p.description,
      nameKey: textKey(p.description),
      bar: (p.barcode ?? '').toLowerCase(),
      hay: normText(text),
      compact: textKey(text)
    })
  }
  for (const s of extra.saleItems) {
    const text = `${s.name} ${s.aliases.join(' ')}`
    entries.push({
      found: { kind: 'saleItem', s, uses: s.uses },
      name: s.name,
      nameKey: textKey(s.name),
      bar: '',
      hay: normText(text),
      compact: textKey(text)
    })
    saleByKey.set(textKey(s.name), s)
    for (const a of s.aliases) saleByKey.set(textKey(a), s)
  }
}

// The sale item a typed name already belongs to, if any (for the hint under a bill line).
export function saleItemForName(name: string): SaleItemEntry | undefined {
  ensureIndex()
  const k = textKey(name)
  return k ? saleByKey.get(k) : undefined
}

export function searchItems(text: string, limit = 12, opts: { productsOnly?: boolean } = {}): Found[] {
  const raw = text.trim().toLowerCase()
  if (!raw) return []
  ensureIndex()
  const words = normText(raw).split(' ').filter(Boolean)
  if (!words.length) return []
  const wordKeys = words.map((w) => textKey(w))
  const qKey = textKey(raw)

  const scored: { e: Entry; score: number }[] = []
  for (const e of entries) {
    if (opts.productsOnly && e.found.kind !== 'product') continue
    let ok = true
    for (let i = 0; i < words.length; i++) {
      if (e.hay.includes(words[i])) continue
      if (wordKeys[i] && e.compact.includes(wordKeys[i])) continue
      ok = false
      break
    }
    if (!ok) continue
    let score = 3
    if (e.bar && e.bar === raw) score = 0 // a scanned / typed barcode + Enter picks that item
    else if (qKey && e.nameKey.startsWith(qKey)) score = 1
    else if (e.bar && e.bar.startsWith(raw)) score = 2
    scored.push({ e, score })
  }
  scored.sort(
    (a, b) => a.score - b.score || b.e.found.uses - a.e.found.uses || a.e.name.length - b.e.name.length || a.e.name.localeCompare(b.e.name, 'th')
  )
  return scored.slice(0, limit).map((s) => s.e.found)
}
