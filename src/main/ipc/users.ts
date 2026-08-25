import bcrypt from 'bcryptjs'
import { getDb } from '../database'
import { getSession } from '../session'
import { handle } from './helpers'
import { ROLE_LABELS } from '../../shared/types'

export function registerUserHandlers(): void {
  handle('users:list', 3, () =>
    (getDb()
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role_id, u.active,
                r.name AS role_name, r.level AS role_level
         FROM users u JOIN roles r ON r.id = u.role_id
         ORDER BY r.level DESC, u.username`
      )
      .all() as {
      id: number
      username: string
      display_name: string
      role_id: number
      active: number
      role_name: string
      role_level: number
    }[]).map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      roleId: u.role_id,
      roleName: u.role_name,
      roleLabel: ROLE_LABELS[u.role_name] ?? u.role_name,
      roleLevel: u.role_level,
      active: u.active === 1
    }))
  )

  handle('users:create', 3, (data: { username: string; password: string; displayName: string; roleId: number }) => {
    const username = data.username?.trim()
    const displayName = data.displayName?.trim()
    if (!username) throw new Error('กรุณาระบุชื่อผู้ใช้')
    if (!displayName) throw new Error('กรุณาระบุชื่อที่แสดง')
    if (!data.password || data.password.length < 4) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 4 ตัวอักษร')

    const db = getDb()
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      throw new Error('มีชื่อผู้ใช้นี้ในระบบอยู่แล้ว')
    }
    if (!db.prepare('SELECT id FROM roles WHERE id = ?').get(data.roleId)) {
      throw new Error('สิทธิ์การใช้งานไม่ถูกต้อง')
    }
    const info = db
      .prepare('INSERT INTO users (username, password_hash, display_name, role_id) VALUES (?, ?, ?, ?)')
      .run(username, bcrypt.hashSync(data.password, 10), displayName, data.roleId)
    return { id: Number(info.lastInsertRowid) }
  })

  handle('users:setActive', 3, (data: { id: number; active: boolean }) => {
    const me = getSession()!
    if (data.id === me.id && !data.active) throw new Error('ไม่สามารถปิดการใช้งานบัญชีของตัวเองได้')
    const info = getDb()
      .prepare('UPDATE users SET active = ? WHERE id = ?')
      .run(data.active ? 1 : 0, data.id)
    if (info.changes === 0) throw new Error('ไม่พบผู้ใช้งาน')
  })

  handle('users:resetPassword', 3, (data: { id: number; newPassword: string }) => {
    if (!data.newPassword || data.newPassword.length < 4) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 4 ตัวอักษร')
    const info = getDb()
      .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(bcrypt.hashSync(data.newPassword, 10), data.id)
    if (info.changes === 0) throw new Error('ไม่พบผู้ใช้งาน')
  })
}
