import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/types'

// Every call goes through the { ok, data | error } envelope from the main
// process; unwrap it here so the renderer gets clean promises that reject
// with a readable Thai error message.
async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, payload)) as
    | { ok: true; data: T }
    | { ok: false; error: string }
  if (!res.ok) throw new Error(res.error)
  return res.data
}

const api: Api = {
  auth: {
    login: (username, password) => call('auth:login', { username, password }),
    logout: () => call('auth:logout'),
    isFirstRun: () => call('auth:isFirstRun')
  },
  lookups: {
    categories: () => call('lookups:categories'),
    addCategory: (name) => call('lookups:addCategory', name),
    locations: () => call('lookups:locations'),
    suppliers: () => call('lookups:suppliers'),
    roles: () => call('lookups:roles')
  },
  products: {
    list: () => call('products:list'),
    save: (payload) => call('products:save', payload)
  },
  receiving: {
    nextDocNumber: () => call('receiving:nextDocNumber'),
    post: (payload) => call('receiving:post', payload)
  },
  stocktake: {
    nextDocNumber: () => call('stocktake:nextDocNumber'),
    save: (payload) => call('stocktake:save', payload),
    recordPrinted: (payload) => call('stocktake:recordPrinted', payload),
    pending: () => call('stocktake:pending')
  },
  transfer: {
    nextDocNumber: () => call('transfer:nextDocNumber'),
    post: (payload) => call('transfer:post', payload)
  },
  users: {
    list: () => call('users:list'),
    create: (data) => call('users:create', data),
    setActive: (id, active) => call('users:setActive', { id, active }),
    resetPassword: (id, newPassword) => call('users:resetPassword', { id, newPassword })
  },
  db: {
    export: () => call('db:export'),
    import: () => call('db:import')
  },
  history: {
    list: () => call('history:list'),
    sessions: () => call('history:sessions'),
    sessionLines: (sessionId) => call('history:sessionLines', sessionId),
    amendSession: (payload) => call('history:amendSession', payload)
  },
  exchange: {
    exportCatalog: () => call('exchange:exportCatalog'),
    pickBatch: () => call('exchange:pickBatch'),
    apply: (filePath) => call('exchange:apply', filePath),
    history: () => call('exchange:history')
  },
  print: {
    listPrinters: () => call('print:listPrinters'),
    run: (opts) => call('print:run', opts),
    toPdf: (opts) => call('print:toPdf', opts)
  },
  zones: {
    list: () => call('zones:list'),
    products: (zoneId) => call('zones:products', zoneId),
    search: (query) => call('zones:search', query),
    assign: (payload) => call('zones:assign', payload),
    assignMany: (payload) => call('zones:assignMany', payload),
    unassign: (payload) => call('zones:unassign', payload),
    setNote: (payload) => call('zones:setNote', payload)
  },
  orders: {
    nextNumber: (bookType) => call('orders:nextNumber', bookType),
    reserveNumbers: (payload) => call('orders:reserveNumbers', payload),
    save: (payload) => call('orders:save', payload),
    list: () => call('orders:list'),
    get: (id) => call('orders:get', id)
  }
}

contextBridge.exposeInMainWorld('api', api)
