import { BrowserWindow, dialog } from 'electron'
import { backupDatabaseTo, replaceDatabaseFrom, validateDatabaseFile } from '../database'
import { handle } from './helpers'

function timestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

export function registerBackupHandlers(): void {
  // Export — pick a destination and copy the database there.
  handle('db:export', 3, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showSaveDialog(win, {
      title: 'สำรองข้อมูล StockKeep',
      defaultPath: `stockkeep-backup-${timestamp()}.db`,
      filters: [{ name: 'StockKeep Database', extensions: ['db'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true }
    backupDatabaseTo(res.filePath)
    return { canceled: false, path: res.filePath }
  })

  // Import — pick a backup, validate it, then replace the current database.
  handle('db:import', 3, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      title: 'นำเข้าข้อมูลจากไฟล์สำรอง',
      properties: ['openFile'],
      filters: [{ name: 'StockKeep Database', extensions: ['db'] }]
    })
    if (res.canceled || !res.filePaths[0]) return { canceled: true }
    const source = res.filePaths[0]
    validateDatabaseFile(source) // throws (with a Thai message) if not a valid StockKeep db
    replaceDatabaseFrom(source)
    return { canceled: false }
  })
}
