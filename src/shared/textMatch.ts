// Text matching for item names (v1.6.16). Shared by the main process (name
// clean-up, linking a typed bill line to its item) and the renderer (item
// search on the bill page), so both sides agree on what "the same name" is.
//
// Bill lines are typed by hand from paper tickets, so one item turns up as
// `ตะปู 2-1/2`, `ตะปู 2 1/2"`, `ทินเนอร์ ACC0` / `ACCO`, `น๊อต` / `น็อต` ...
// normText() irons out those differences; textKey() also drops every space
// and quote mark, which is what "the same name typed differently" compares.

export function normText(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[“”″]|''|นิ้ว/g, '"')
    .replace(/[๊็]/g, '') // น๊อต / น็อต, แด๊ป / แด็ป
    .replace(/แกลลอน/g, 'แกลอน')
    .replace(/ป[ีิ][๊้]?[ปบ]/g, 'ปีบ') // ปี๊ป / ปีป / ปี้ป / ปีบ
    .replace(/ซั[่้]ม/g, 'ซัม') // ยิปซั่ม / ยิปซัม
    .replace(/acc[o0]/g, 'acco')
    .replace(/[×*]/g, 'x')
    .replace(/(มม|mm|ซม|cm|กก|kg)\./g, '$1')
    .replace(/[\s.,()\-_/#+:]+/g, ' ')
    .trim()
}

export function textKey(s: string): string {
  return normText(s).replace(/[ "]/g, '')
}

// Size-like tokens (2-1/2, 3/4, 4, 1.5 ...). Two names with different sizes
// are different items however alike the rest of the text is.
export function sizeTokens(s: string): Set<string> {
  const t = (s ?? '').toLowerCase().replace(/(\d)\s*-\s*(\d+\/\d+)/g, '$1_$2')
  return new Set((t.match(/\d+_\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?/g) ?? []).map((x) => x.replace(/^0+(?=\d)/, '')))
}

export function sameSizes(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

export function sizesWithin(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false
  return true
}

export interface Grams {
  g: Map<string, number>
  n: number
}

// Character pairs of the key — cheap, and it copes with Thai (no word breaks).
export function grams(s: string): Grams {
  const k = textKey(s)
  const g = new Map<string, number>()
  for (let i = 0; i < k.length - 1; i++) {
    const b = k.slice(i, i + 2)
    g.set(b, (g.get(b) ?? 0) + 1)
  }
  return { g, n: Math.max(1, k.length - 1) }
}

function overlap(a: Grams, b: Grams): number {
  let o = 0
  const [s, l] = a.g.size < b.g.size ? [a, b] : [b, a]
  for (const [k, v] of s.g) o += Math.min(v, l.g.get(k) ?? 0)
  return o
}

// 0..1 — how alike two names are overall.
export function dice(a: Grams, b: Grams): number {
  return (2 * overlap(a, b)) / (a.n + b.n)
}

// 0..1 — how much of `a` is found inside `b` (a short typed name inside a long catalogue name).
export function contained(a: Grams, b: Grams): number {
  return overlap(a, b) / a.n
}

// Score of a typed name against a catalogue name, as used by the clean-up page.
export function matchScore(typed: Grams, typedSizes: Set<string>, item: Grams, itemSizes: Set<string>): number {
  let score = Math.max(dice(typed, item), typed.n >= 4 ? contained(typed, item) * 0.92 : 0)
  if (!sizesWithin(typedSizes, itemSizes)) score *= 0.6
  return score
}
