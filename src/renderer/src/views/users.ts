import type { UserView } from '../../../shared/types'
import { $, esc } from '../format'
import { level, state } from '../state'
import { promptModal, showToast, toastError } from '../ui'

let users: UserView[] = []

export async function renderUsersView(): Promise<void> {
  if (level() < 3) return
  try {
    users = await window.api.users.list()
  } catch {
    users = []
  }

  $('users-body').innerHTML = users
    .map(
      (u) => `<tr>
      <td class="mono">${esc(u.username)}</td>
      <td>${esc(u.displayName)}</td>
      <td><span class="badge role">${esc(u.roleLabel)}</span></td>
      <td>${u.active ? '<span class="badge ok">ใช้งานอยู่</span>' : '<span class="badge muted">ปิดการใช้งาน</span>'}</td>
      <td style="white-space:nowrap;">
        <button class="btn small btn-user-reset" data-id="${u.id}"><i class="ti ti-key"></i>รีเซ็ตรหัสผ่าน</button>
        ${
          u.id === state.user?.id
            ? ''
            : `<button class="btn small btn-user-toggle" data-id="${u.id}">${u.active ? '<i class="ti ti-ban"></i>ปิดการใช้งาน' : '<i class="ti ti-check"></i>เปิดการใช้งาน'}</button>`
        }
      </td>
    </tr>`
    )
    .join('')

  $('users-body')
    .querySelectorAll<HTMLButtonElement>('.btn-user-reset')
    .forEach((btn) => btn.addEventListener('click', () => void resetPassword(Number(btn.dataset.id))))
  $('users-body')
    .querySelectorAll<HTMLButtonElement>('.btn-user-toggle')
    .forEach((btn) => btn.addEventListener('click', () => void toggleActive(Number(btn.dataset.id))))
}

async function resetPassword(id: number): Promise<void> {
  const user = users.find((u) => u.id === id)
  if (!user) return
  const result = await promptModal(
    `รีเซ็ตรหัสผ่านของ "${user.displayName}"`,
    [
      { key: 'password', label: 'รหัสผ่านใหม่', type: 'password' },
      { key: 'confirm', label: 'ยืนยันรหัสผ่านใหม่', type: 'password' }
    ],
    (v) => {
      if (!v.password || v.password.length < 4) return 'รหัสผ่านต้องยาวอย่างน้อย 4 ตัวอักษร'
      if (v.password !== v.confirm) return 'รหัสผ่านทั้งสองช่องไม่ตรงกัน'
      return null
    }
  )
  if (!result) return
  try {
    await window.api.users.resetPassword(id, result.password)
    showToast(`รีเซ็ตรหัสผ่านของ "${user.displayName}" แล้ว`)
  } catch (err) {
    toastError(err)
  }
}

async function toggleActive(id: number): Promise<void> {
  const user = users.find((u) => u.id === id)
  if (!user) return
  try {
    await window.api.users.setActive(id, !user.active)
    await renderUsersView()
    showToast(user.active ? `ปิดการใช้งานบัญชี "${user.username}" แล้ว` : `เปิดการใช้งานบัญชี "${user.username}" แล้ว`)
  } catch (err) {
    toastError(err)
  }
}

async function addUser(): Promise<void> {
  let roles
  try {
    roles = await window.api.lookups.roles()
  } catch (err) {
    toastError(err)
    return
  }
  const result = await promptModal(
    'เพิ่มผู้ใช้งานใหม่',
    [
      { key: 'username', label: 'ชื่อผู้ใช้ (ภาษาอังกฤษ)', placeholder: 'เช่น somchai' },
      { key: 'displayName', label: 'ชื่อที่แสดง', placeholder: 'เช่น สมชาย ใจดี' },
      { key: 'password', label: 'รหัสผ่าน', type: 'password' },
      {
        key: 'roleId',
        label: 'สิทธิ์การใช้งาน',
        type: 'select',
        options: roles.map((r) => ({ value: String(r.id), label: r.label })),
        value: String(roles[0]?.id ?? '')
      }
    ],
    (v) => {
      if (!v.username.trim()) return 'กรุณาระบุชื่อผู้ใช้'
      if (!v.displayName.trim()) return 'กรุณาระบุชื่อที่แสดง'
      if (!v.password || v.password.length < 4) return 'รหัสผ่านต้องยาวอย่างน้อย 4 ตัวอักษร'
      return null
    }
  )
  if (!result) return
  try {
    await window.api.users.create({
      username: result.username.trim(),
      password: result.password,
      displayName: result.displayName.trim(),
      roleId: Number(result.roleId)
    })
    await renderUsersView()
    showToast(`เพิ่มผู้ใช้งาน "${result.username.trim()}" แล้ว`)
  } catch (err) {
    toastError(err)
  }
}

async function exportDb(): Promise<void> {
  try {
    const res = await window.api.db.export()
    if (res.canceled) return
    showToast(`สำรองข้อมูลเรียบร้อยแล้ว — บันทึกไปที่ ${res.path}`)
  } catch (err) {
    toastError(err)
  }
}

async function importDb(): Promise<void> {
  // window.confirm is supported in Electron (unlike window.prompt).
  const ok = window.confirm(
    'การนำเข้าข้อมูลจะเขียนทับข้อมูลปัจจุบันทั้งหมดในเครื่องนี้\n\n' +
      'ระบบจะสำรองข้อมูลเดิมไว้ให้อัตโนมัติก่อนเขียนทับ และหลังนำเข้าเสร็จจะให้เข้าสู่ระบบใหม่\n\n' +
      'ต้องการดำเนินการต่อหรือไม่?'
  )
  if (!ok) return
  try {
    const res = await window.api.db.import()
    if (res.canceled) return
    showToast('นำเข้าข้อมูลสำเร็จ — กำลังเข้าสู่ระบบใหม่...')
    // The signed-in account may not exist in the imported data, so reload the
    // whole renderer to return to a clean login screen backed by the new DB.
    setTimeout(() => {
      window.api.auth.logout().finally(() => location.reload())
    }, 1400)
  } catch (err) {
    toastError(err)
  }
}

export function initUsers(): void {
  $('btn-add-user').addEventListener('click', () => void addUser())
  $('btn-export-db').addEventListener('click', () => void exportDb())
  $('btn-import-db').addEventListener('click', () => void importDb())
}
