// The owner ticking a day on the cash-up page locks that day: its bills AND its
// expenses become read-only until the tick is removed. Both sales.ts and
// expenses.ts need the check, so it lives here rather than in either of them.

import { getDb } from '../database'

export function isDayLocked(date: string): boolean {
  const row = getDb()
    .prepare('SELECT owner_checked_at FROM cash_closes WHERE close_date = ?')
    .get(date) as { owner_checked_at: string | null } | undefined
  return !!row?.owner_checked_at
}

// '2026-09-24' -> '24/09/2569'
export function thaiDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d}/${m}/${Number(y) + 543}` : iso
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
