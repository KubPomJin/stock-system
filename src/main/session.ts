import type { SessionUser } from '../shared/types'

// Single-machine desktop app: the session is just a variable in the main
// process, set after a successful login. No tokens needed.
let currentUser: SessionUser | null = null

export function setSession(user: SessionUser | null): void {
  currentUser = user
}

export function getSession(): SessionUser | null {
  return currentUser
}

export function requireLevel(minLevel: number): SessionUser {
  if (!currentUser) throw new Error('ยังไม่ได้เข้าสู่ระบบ')
  if (currentUser.roleLevel < minLevel) throw new Error('สิทธิ์การใช้งานไม่เพียงพอ')
  return currentUser
}
