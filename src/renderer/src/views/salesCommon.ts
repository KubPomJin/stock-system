// Shared bits for the ขายหน้าร้าน pages (sales entry, cash-up, transfers, report).
import type { SaleView } from '../../../shared/types'

export const PAY_LABEL: Record<string, string> = {
  CASH: 'เงินสด',
  TRANSFER: 'โอน',
  MIXED: 'เงินสด+โอน',
  CREDIT: 'เครดิต'
}

export function payLabel(m: string | null): string {
  return (m && PAY_LABEL[m]) || 'ไม่ระบุ'
}

export const TRANSFER_STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'รอตรวจ', cls: 'warn' },
  VERIFIED: { label: 'พบยอดแล้ว', cls: 'ok' },
  NOT_FOUND: { label: 'ไม่พบยอด', cls: 'danger' }
}

export function transferBadge(status: string | null): string {
  if (!status) return '<span class="text-muted">—</span>'
  const s = TRANSFER_STATUS[status]
  return `<span class="badge ${s?.cls ?? 'muted'}">${s?.label ?? status}</span>`
}

export const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
]

export function todayIso(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function nowTime(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// '2026-09-24' -> '24/09/2569'
export function thaiDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}/${m}/${Number(y) + 543}`
}

// SQLite CURRENT_TIMESTAMP is UTC 'YYYY-MM-DD HH:MM:SS' — show it in local time.
export function thaiDateTime(utc: string | null | undefined): string {
  if (!utc) return '—'
  const t = Date.parse(utc.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return utc
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear() + 543} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Plain number with 2 decimals, no currency sign (for dense tables / paper).
export function money(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function qtyText(n: number): string {
  return n.toLocaleString('th-TH', { maximumFractionDigits: 3 })
}

// "เงินสด 500 + โอน 700" — how a bill was actually paid, in one short line.
export function splitText(s: SaleView): string {
  const parts: string[] = []
  if (s.cashAmount > 0) parts.push(`สด ${money(s.cashAmount)}`)
  if (s.transferAmount > 0) parts.push(`โอน ${money(s.transferAmount)}`)
  if (s.creditAmount > 0) parts.push(`เครดิต ${money(s.creditAmount)}`)
  return parts.join(' + ')
}
