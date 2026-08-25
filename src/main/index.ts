import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { initDatabase } from './database'
import { registerAuthHandlers } from './ipc/auth'
import { registerLookupHandlers } from './ipc/lookups'
import { registerProductHandlers } from './ipc/products'
import { registerStockHandlers } from './ipc/stock'
import { registerUserHandlers } from './ipc/users'
import { registerBackupHandlers } from './ipc/backup'
import { registerHistoryHandlers } from './ipc/history'
import { registerExchangeHandlers } from './ipc/exchange'
import { registerOrderHandlers } from './ipc/orders'
import { registerPrintHandlers } from './ipc/print'
import { registerZoneHandlers } from './ipc/zones'

const isDev = !!process.env['ELECTRON_RENDERER_URL']

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  if (isDev) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] as string)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    if (!isDev) Menu.setApplicationMenu(null)
    initDatabase()
    registerAuthHandlers()
    registerLookupHandlers()
    registerProductHandlers()
    registerStockHandlers()
    registerUserHandlers()
    registerBackupHandlers()
    registerHistoryHandlers()
    registerExchangeHandlers()
    registerOrderHandlers()
    registerPrintHandlers()
    registerZoneHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
