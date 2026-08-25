// Shared types between main process and renderer.

export interface SessionUser {
  id: number
  username: string
  displayName: string
  roleName: string
  roleLabel: string
  roleLevel: number
}

export interface Lookup {
  id: number
  name: string
}

export interface ProductUnitView {
  unitId: number
  name: string
  qtyPerBase: number
  isBase: boolean
}

// Prices/cost fields are filtered by role at the main process:
// cost is undefined for role level < 2, and prices only contains
// tiers the current user's role is allowed to see.
export interface ProductView {
  id: number
  barcode: string
  barcodePending: boolean // สร้างจากบิล — บาร์โค้ดยังเป็นรหัสชั่วคราว
  subBarcode: string | null
  description: string
  categoryId: number | null
  categoryName: string
  minStock: number
  maxStock: number
  cost?: number
  prices: Record<string, number>
  units: ProductUnitView[]
  stockByLocation: Record<number, number>
  totalOnHand: number
  // Warehouse bays this item sits in (see zones). Locational only, no prices —
  // safe for level 1. Empty = ยังไม่ระบุโซน.
  zoneIds: number[]
  zoneCodes: string[]
}

export interface ProductPayload {
  id?: number
  barcode: string
  subBarcode: string
  description: string
  categoryId: number
  units: { name: string; qtyPerBase: number }[] // sorted largest -> smallest, last = base
  minStock: number
  maxStock: number
  cost: number
  prices: Record<string, number> // tier code -> price (per base unit)
  openingStock?: Record<number, number> // locationId -> qty in base units (create only)
  // Counted-now quantity per location, in base units, used when EDITING. The
  // difference against the ledger is posted as an ADJUST movement — the balance
  // itself is never written to.
  currentStock?: Record<number, number>
  // Bays to store this item in. Omit to leave existing assignments untouched;
  // pass [] to clear them (the product form always sends an explicit array).
  zoneIds?: number[]
}

export interface ReceivingLinePayload {
  productId: number
  unitId: number
  qty: number
  unitCost: number // cost per the receiving unit (e.g. per box)
}

export interface ReceivingPayload {
  docDate: string
  supplierId: number | null
  supplierName: string
  locationId: number
  notes: string
  lines: ReceivingLinePayload[]
}

export interface TransferLinePayload {
  productId: number
  unitId: number
  qty: number
}

export interface TransferPayload {
  fromLocationId: number
  toLocationId: number
  lines: TransferLinePayload[]
}

export interface StocktakeEntry {
  productId: number
  locationId: number // counts are per product PER LOCATION now
  counted: number // in base units
  // What was actually tallied, one entry per unit level, e.g.
  // [{unit:'กล่อง', qty:4}, {unit:'ชิ้น', qty:2}]. Stored verbatim because
  // "4 sealed boxes + 2 loose" is a different observation from "202 loose",
  // and the base-unit total alone cannot tell them apart.
  countedParts?: { unit: string; qty: number }[]
  note: string
  // Goods-in written on the sheet by the counter — informational, explains a
  // variance. Never posts stock on its own.
  hasReceived: boolean
  receivedQty: number | null
  receivedDate: string
}

export interface StocktakePayload {
  // Set when filling in a sheet that was printed earlier — keeps that sheet's
  // serial number instead of issuing a new one.
  sessionId?: number | null
  docNumber?: string // manual override when not using a printed sheet
  countDate: string
  countTime: string
  category: string
  generalNote: string
  counterName: string // ผู้นับ — may differ from the user keying it in
  noSerial: boolean // true = quick adjust, no document/serial number
  entries: StocktakeEntry[]
}

export interface PrinterInfo {
  name: string
  displayName: string
  isDefault: boolean
  status: number
}

// A sheet that has been printed but not yet keyed in.
export interface PendingSheetView {
  id: number
  docNumber: string | null
  countDate: string | null
  countTime: string | null
  category: string | null
  counterName: string | null
  printedAt: string | null
}

export interface MovementView {
  id: number
  createdAt: string
  barcode: string
  description: string
  locationName: string
  movementType: string
  qtyChange: number
  baseUnit: string | null
  reference: string | null
  note: string | null
  userName: string | null
}

// One count round (morning/evening/etc.). Keeps both times: countDate+countTime
// is when the person physically counted; createdAt is when it was saved.
export interface StocktakeSessionView {
  id: number
  docNumber: string | null
  countDate: string | null
  countTime: string | null
  createdAt: string
  locationName: string
  category: string | null
  note: string | null
  countedCount: number
  adjustedCount: number
  isQuick: boolean
  counterName: string | null // ผู้นับ — คนที่เดินนับของจริง
  userName: string | null // คนที่คีย์เข้าระบบ
  // Set when this round is a correction of an earlier one. The original is
  // never edited, so both figures remain on the record.
  amendsSessionId: number | null
}

export interface StocktakeLineView {
  lineId: number
  // JSON of the as-counted breakdown; null on rounds recorded before v1.5.1.
  countedParts: string | null
  productId: number
  barcode: string
  description: string
  locationName: string | null
  baseUnit: string | null
  systemQty: number
  countedQty: number
  diff: number
  note: string | null
  hasReceived: number
  receivedQty: number | null
  receivedDate: string | null
}

/* ---------- เชื่อมกับ BillKeep (ระบบเก็บบิลหน้าร้าน) ---------- */

// สรุปไฟล์ผลการปิดวันจาก BillKeep ก่อนกดนำเข้าจริง
export interface BillBatchPreview {
  filePath: string
  batchId: string
  closeDate: string | null
  note: string | null
  issueCount: number
  resolvedCount: number
  unresolvedCount: number
  totalQty: number
  newProducts: { description: string; baseUnit: string; exists: boolean }[]
  problems: string[]
  alreadyImported: string | null // เวลาที่เคยนำเข้า (ถ้าเคย)
}

export interface BillImportView {
  id: number
  batchId: string
  closeDate: string | null
  filePath: string | null
  issueCount: number
  newProductCount: number
  skippedCount: number
  totalQty: number
  importedAt: string
  userName: string | null
}

export interface UserView {
  id: number
  username: string
  displayName: string
  roleId: number
  roleName: string
  roleLabel: string
  roleLevel: number
  active: boolean
}

export interface RoleView {
  id: number
  name: string
  label: string
  level: number
}

export const ROLE_LABELS: Record<string, string> = {
  staff: 'พนักงาน',
  stock_manager: 'คนจัดสต็อก',
  admin: 'แอดมิน / เจ้าของร้าน'
}

/* ---------- ผังโกดัง (warehouse zones) ---------- */

// A cell on the floor plan. kind='zone' holds products and is clickable;
// 'label' is a door/office caption; 'space' is an empty cell that only shapes
// the plan. Zones are a picking aid and never touch the stock ledger.
export interface ZoneView {
  id: number
  code: string
  label: string
  kind: 'zone' | 'label' | 'space'
  note: string | null
  gridCol: number
  gridRow: number
  gridW: number
  gridH: number
  productCount: number
}

// Deliberately price-free — level 1 uses this screen, so no cost may appear.
export interface ZoneProductView {
  id: number
  barcode: string
  description: string
  barcodePending: number
  baseUnit: string | null
}

export interface ZoneSearchHit extends ZoneProductView {
  zoneCodes: string[] // every bay this item sits in; empty = not assigned yet
}

// Typed surface of window.api exposed by the preload script.
export interface Api {
  auth: {
    login(username: string, password: string): Promise<SessionUser>
    logout(): Promise<void>
    isFirstRun(): Promise<boolean>
  }
  lookups: {
    categories(): Promise<Lookup[]>
    addCategory(name: string): Promise<Lookup>
    locations(): Promise<Lookup[]>
    suppliers(): Promise<Lookup[]>
    roles(): Promise<RoleView[]>
  }
  products: {
    list(): Promise<ProductView[]>
    save(payload: ProductPayload): Promise<{ id: number }>
  }
  receiving: {
    nextDocNumber(): Promise<string>
    post(payload: ReceivingPayload): Promise<{ docNumber: string }>
  }
  stocktake: {
    nextDocNumber(): Promise<string>
    save(payload: StocktakePayload): Promise<{ adjusted: number; docNumber: string }>
    recordPrinted(payload: {
      docNumber: string
      countDate: string
      countTime: string
      category: string
      counterName: string
    }): Promise<{ id: number; docNumber: string }>
    pending(): Promise<PendingSheetView[]>
  }
  transfer: {
    nextDocNumber(): Promise<string>
    post(payload: TransferPayload): Promise<{ docNumber: string }>
  }
  users: {
    list(): Promise<UserView[]>
    create(data: { username: string; password: string; displayName: string; roleId: number }): Promise<{ id: number }>
    setActive(id: number, active: boolean): Promise<void>
    resetPassword(id: number, newPassword: string): Promise<void>
  }
  db: {
    export(): Promise<{ canceled: boolean; path?: string }>
    import(): Promise<{ canceled: boolean }>
  }
  history: {
    list(): Promise<MovementView[]>
    sessions(): Promise<StocktakeSessionView[]>
    sessionLines(sessionId: number): Promise<StocktakeLineView[]>
    // Correct an earlier round: writes a new round linked to it and posts the
    // difference as ADJUST movements. Never edits the original.
    amendSession(payload: {
      sessionId: number
      note: string
      lines: { lineId: number; countedQty: number }[]
    }): Promise<{ sessionId: number; changed: number }>
  }
  exchange: {
    exportCatalog(): Promise<{ canceled: boolean; path?: string }>
    pickBatch(): Promise<{ canceled: boolean; preview?: BillBatchPreview }>
    apply(filePath: string): Promise<{ imported: number; skipped: number; created: number }>
    history(): Promise<BillImportView[]>
  }
  print: {
    listPrinters(): Promise<PrinterInfo[]>
    run(opts: {
      deviceName?: string
      copies?: number
      landscape?: boolean
      pageCount?: number
      pageSize?: 'A4' | { widthIn: number; heightIn: number }
      // Optional on purpose — 'none' means borderless, which A4 printers refuse.
      margins?: { marginType: 'default' | 'none' | 'printableArea' | 'custom' }
    }): Promise<{ ok: boolean; canceled?: boolean }>
    // Renders the PDF in-process and writes it via a save dialog. Used instead
    // of run() whenever the chosen "printer" is a PDF writer.
    toPdf(opts: {
      landscape?: boolean
      defaultFileName?: string
    }): Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>
  }
  zones: {
    list(): Promise<ZoneView[]>
    products(zoneId: number): Promise<ZoneProductView[]>
    search(query: string): Promise<ZoneSearchHit[]>
    assign(payload: { productId: number; zoneId: number }): Promise<{ ok: boolean }>
    // Bulk add/remove for a whole selection at once.
    assignMany(payload: {
      productIds: number[]
      zoneId: number
      mode?: 'add' | 'remove'
    }): Promise<{ changed: number; skipped: number }>
    unassign(payload: { productId: number; zoneId: number }): Promise<{ ok: boolean }>
    setNote(payload: { zoneId: number; note: string }): Promise<{ ok: boolean }>
  }
  orders: {
    nextNumber(bookType: string): Promise<string>
    reserveNumbers(payload: { bookType: string; startNumber?: string; count: number }): Promise<{ numbers: string[] }>
    save(payload: OrderPayload): Promise<{ id: number; docNumber: string }>
    list(): Promise<OrderDocView[]>
    get(id: number): Promise<{ doc: OrderDocView; lines: OrderLineView[] }>
  }
}

// ---------------------------------------------------------------------------
// Order tickets (ใบสั่งสินค้า)
// ---------------------------------------------------------------------------

export type DeliveryMethod = 'DELIVER' | 'PICKUP' | ''
export type PaymentMethod = 'CASH' | 'TRANSFER' | 'CREDIT' | ''

export interface OrderLinePayload {
  productId: number | null
  description: string
  locationName: string
  qty: number | null
  unitName: string
  unitPrice: number | null
  amount: number | null
}

export interface OrderPayload {
  docNumber: string
  bookType: string
  docDate: string
  docTime: string
  customerCode: string
  customerName: string
  customerContact: string
  deliveryMethod: DeliveryMethod
  vehiclePlate: string
  paymentMethod: PaymentMethod
  cashReceived: number | null
  cashChange: number | null
  transferAmount: number | null
  transferRef: string
  note: string
  subtotal: number
  deliveryFee: number
  grandTotal: number
  lines: OrderLinePayload[]
}

export interface OrderDocView {
  id: number
  docNumber: string
  bookType: string | null
  docDate: string | null
  docTime: string | null
  customerCode: string | null
  customerName: string | null
  customerContact: string | null
  deliveryMethod: string | null
  vehiclePlate: string | null
  paymentMethod: string | null
  cashReceived: number | null
  cashChange: number | null
  transferAmount: number | null
  transferRef: string | null
  note: string | null
  subtotal: number
  deliveryFee: number
  grandTotal: number
  createdAt: string
  userName: string | null
  lineCount: number
}

export interface OrderLineView {
  lineNo: number
  productId: number | null
  description: string
  locationName: string | null
  qty: number | null
  unitName: string | null
  unitPrice: number | null
  amount: number | null
}
