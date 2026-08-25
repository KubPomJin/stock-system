import type { ProductView } from '../../shared/types'
import { state } from './state'

export function $(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing element #${id}`)
  return el
}

export function input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement
}

export function select(id: string): HTMLSelectElement {
  return $(id) as HTMLSelectElement
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Stock is stored in base units; convert to "6 กล่อง 19 ชิ้น" for display.
// units are sorted largest -> smallest (sort_order ASC), last = base unit.
export function formatStock(qtyBase: number, units: { name: string; qtyPerBase: number }[]): string {
  if (!units.length) return String(qtyBase)
  let remaining = Math.abs(qtyBase)
  const parts: string[] = []
  for (const u of units) {
    const count = Math.floor(remaining / u.qtyPerBase)
    if (count > 0) {
      parts.push(`${count} ${u.name}`)
      remaining -= count * u.qtyPerBase
    }
  }
  const body = parts.length ? parts.join(' ') : `0 ${units[units.length - 1].name}`
  return (qtyBase < 0 ? '-' : '') + body
}

export function baht(n: number): string {
  return '฿' + n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export type StockStatus = 'ok' | 'warn' | 'danger'

export function stockStatus(p: ProductView): StockStatus {
  if (p.totalOnHand < 0) return 'danger'
  if (p.totalOnHand < p.minStock) return 'warn'
  return 'ok'
}

export function statusLabel(s: StockStatus): string {
  return s === 'danger' ? 'ติดลบ' : s === 'warn' ? 'ต่ำ' : 'ปกติ'
}

function statusIcon(s: StockStatus): string {
  return s === 'danger' ? 'ti-alert-triangle-filled' : s === 'warn' ? 'ti-alert-circle-filled' : 'ti-circle-check-filled'
}

export function statusBadge(s: StockStatus, large: boolean): string {
  return `<span class="badge ${s}${large ? ' badge-lg' : ''}"><i class="ti ${statusIcon(s)}"></i>${statusLabel(s)}</span>`
}

function gaugeHtml(p: ProductView): string {
  const total = p.totalOnHand
  const range = Math.max(p.maxStock, p.minStock * 1.4, total, 1)
  const fillPct = Math.max(Math.min((total / range) * 100, 100), 0)
  const minPct = Math.min((p.minStock / range) * 100, 100)
  const status = stockStatus(p)
  return `<div class="gauge-track">
      <div class="gauge-fill ${status}" style="width:${fillPct}%"></div>
      <div class="gauge-min-marker" style="left:${minPct}%"></div>
    </div>`
}

export function stockCellHtml(p: ProductView): string {
  const breakdown = state.locations
    .map((l) => `${l.short}: ${formatStock(p.stockByLocation[l.id] ?? 0, p.units)}`)
    .join(' · ')
  return `<div class="stock-cell">
      ${gaugeHtml(p)}
      <div class="stock-total">${formatStock(p.totalOnHand, p.units)}</div>
      <div class="stock-breakdown">${esc(breakdown)}</div>
    </div>`
}

export function baseUnitName(p: ProductView): string {
  return p.units[p.units.length - 1]?.name ?? ''
}
