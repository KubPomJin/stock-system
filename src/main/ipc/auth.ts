import bcrypt from 'bcryptjs'
import { getDb, isFirstRun } from '../database'
import { setSession } from '../session'
import { handle } from './helpers'
import { ROLE_LABELS, type SessionUser } from '../../shared/types'

interface UserRow {
  id: number
  username: string
  password_hash: string
  display_name: string
  active: number
  role_name: string
  role_level: number
}

export function registerAuthHandlers(): void {
  handle('auth:login', 0, (payload: { username: string; password: string }) => {
    const row = getDb()
      .prepare(
        `SELECT u.id, u.username, u.password_hash, u.display_name, u.active,
                r.name AS role_name, r.level AS role_level
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.username = ?`
      )
      .get(payload.username?.trim()) as UserRow | undefined

    if (!row || !bcrypt.compareSync(payload.password ?? '', row.password_hash)) {
      throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')
    }
    if (!row.active) {
      throw new Error('บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแลระบบ')
    }

    const user: SessionUser = {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      roleName: row.role_name,
      roleLabel: ROLE_LABELS[row.role_name] ?? row.role_name,
      roleLevel: row.role_level
    }
    setSession(user)
    return user
  })

  handle('auth:logout', 0, () => {
    setSession(null)
  })

  handle('auth:isFirstRun', 0, () => isFirstRun())
}
