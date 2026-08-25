import type { Lookup, ProductView, SessionUser } from '../../shared/types'

export interface LocationInfo extends Lookup {
  short: string
}

interface AppState {
  user: SessionUser | null
  products: ProductView[]
  categories: Lookup[]
  locations: LocationInfo[]
  suppliers: Lookup[]
}

export const state: AppState = {
  user: null,
  products: [],
  categories: [],
  locations: [],
  suppliers: []
}

const SHORT_NAMES: Record<string, string> = {
  'คลังสินค้า': 'คลัง',
  'หน้าร้าน': 'หน้าร้าน'
}

export function level(): number {
  return state.user?.roleLevel ?? 0
}

export async function reloadProducts(): Promise<void> {
  state.products = await window.api.products.list()
}

export async function reloadLookups(): Promise<void> {
  const [categories, locations] = await Promise.all([
    window.api.lookups.categories(),
    window.api.lookups.locations()
  ])
  state.categories = categories
  state.locations = locations.map((l) => ({ ...l, short: SHORT_NAMES[l.name] ?? l.name }))
  if (level() >= 2) {
    state.suppliers = await window.api.lookups.suppliers()
  } else {
    state.suppliers = []
  }
}

export function productById(id: number): ProductView | undefined {
  return state.products.find((p) => p.id === id)
}
