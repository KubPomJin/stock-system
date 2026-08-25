import { getDb } from '../database'
import { handle } from './helpers'
import { ROLE_LABELS } from '../../shared/types'

export function registerLookupHandlers(): void {
  handle('lookups:categories', 1, () =>
    getDb().prepare('SELECT id, name FROM categories ORDER BY id').all()
  )

  handle('lookups:addCategory', 2, (name: string) => {
    const clean = String(name ?? '').trim()
    if (!clean) throw new Error('กรุณาระบุชื่อหมวดหมู่')
    const db = getDb()
    const existing = db.prepare('SELECT id, name FROM categories WHERE name = ?').get(clean)
    if (existing) return existing
    const info = db.prepare('INSERT INTO categories (name) VALUES (?)').run(clean)
    return { id: Number(info.lastInsertRowid), name: clean }
  })

  handle('lookups:locations', 1, () =>
    getDb().prepare('SELECT id, name FROM locations ORDER BY id').all()
  )

  handle('lookups:suppliers', 2, () =>
    getDb().prepare('SELECT id, name FROM suppliers ORDER BY name').all()
  )

  handle('lookups:roles', 3, () =>
    (getDb().prepare('SELECT id, name, level FROM roles ORDER BY level').all() as {
      id: number
      name: string
      level: number
    }[]).map((r) => ({ ...r, label: ROLE_LABELS[r.name] ?? r.name }))
  )
}
