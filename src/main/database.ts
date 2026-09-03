import { app } from 'electron'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { join } from 'path'
import { copyFileSync, existsSync, rmSync } from 'fs'
// Bundled as a string at build time so the packaged app carries its own schema.
import schemaSql from './schema.sql?raw'

let db: Database.Database | null = null
let dbPath = ''
let firstRun = false

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function getDbPath(): string {
  return dbPath
}

export function isFirstRun(): boolean {
  return firstRun
}

function openConnection(): void {
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  // SQLite disables FK enforcement by default — must be per-connection.
  db.pragma('foreign_keys = ON')
}

export function initDatabase(): void {
  // userData survives app updates and is always writable (install dir may not be).
  dbPath = join(app.getPath('userData'), 'stockkeep.db')
  const isNew = !existsSync(dbPath)

  openConnection()

  if (isNew) {
    getDb().exec(schemaSql)
  }

  runMigrations()
  seedDefaultAdmin()
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

// Export: flush the WAL into the main file, then copy it. In this single-process
// app there are no other writers, so the copy is a consistent snapshot.
export function backupDatabaseTo(destPath: string): void {
  getDb().pragma('wal_checkpoint(TRUNCATE)')
  copyFileSync(dbPath, destPath)
}

// Rejects anything that isn't a real StockKeep database, so a wrong file can't
// silently wipe the user's data.
export function validateDatabaseFile(sourcePath: string): void {
  if (!existsSync(sourcePath)) throw new Error('ไม่พบไฟล์ที่เลือก')
  let test: Database.Database
  try {
    test = new Database(sourcePath, { readonly: true, fileMustExist: true })
  } catch {
    throw new Error('ไฟล์นี้ไม่ใช่ฐานข้อมูล SQLite ที่ถูกต้อง')
  }
  try {
    const names = (test.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name
    )
    for (const t of ['products', 'stock_movements', 'users', 'roles', 'locations']) {
      if (!names.includes(t)) {
        throw new Error(`ไฟล์ฐานข้อมูลไม่สมบูรณ์ (ขาดตาราง ${t}) — อาจไม่ใช่ไฟล์สำรองของ StockKeep`)
      }
    }
  } finally {
    test.close()
  }
}

// Import: back up the current DB, then overwrite it with the imported file and
// reopen. validateDatabaseFile() should be called first.
export function replaceDatabaseFrom(sourcePath: string): void {
  // Safety copy of the current data before we overwrite it.
  try {
    getDb().pragma('wal_checkpoint(TRUNCATE)')
    copyFileSync(dbPath, dbPath + '.before-import')
  } catch {
    // proceed even if the safety copy fails — validation already passed
  }

  getDb().close()
  db = null
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(dbPath + ext)) rmSync(dbPath + ext)
  }

  copyFileSync(sourcePath, dbPath)

  openConnection()
  runMigrations()
  seedDefaultAdmin()
}

// Idempotent schema changes applied to BOTH new and existing databases,
// so an installed app that already has data gains new tables on next launch
// without losing anything.
function runMigrations(): void {
  const d = getDb()

  // Stocktake sessions — one row per count round. New installs get the final
  // shape directly. doc_number is nullable (quick-adjust rounds have no serial).
  d.exec(`
    CREATE TABLE IF NOT EXISTS stocktake_sessions (
      id INTEGER PRIMARY KEY,
      doc_number TEXT UNIQUE,
      count_date TEXT,
      count_time TEXT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      category TEXT,
      note TEXT,
      counted_count INTEGER NOT NULL DEFAULT 0,
      adjusted_count INTEGER NOT NULL DEFAULT 0,
      is_quick INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // Add newer columns to installs that predate them (SQLite can't add
  // conditionally, so check PRAGMA first).
  const info = d.prepare('PRAGMA table_info(stocktake_sessions)').all() as { name: string; notnull: number }[]
  const names = info.map((c) => c.name)
  if (!names.includes('count_time')) d.exec('ALTER TABLE stocktake_sessions ADD COLUMN count_time TEXT')
  if (!names.includes('counted_count'))
    d.exec('ALTER TABLE stocktake_sessions ADD COLUMN counted_count INTEGER NOT NULL DEFAULT 0')
  if (!names.includes('is_quick')) d.exec('ALTER TABLE stocktake_sessions ADD COLUMN is_quick INTEGER NOT NULL DEFAULT 0')
  // A correction never edits the original round — it is stored as a new round
  // pointing back at the one it fixes, so both figures stay on the record.
  if (!names.includes('amends_session_id'))
    d.exec('ALTER TABLE stocktake_sessions ADD COLUMN amends_session_id INTEGER REFERENCES stocktake_sessions(id)')

  // Older installs created doc_number as NOT NULL. Rebuild the table to make it
  // nullable so quick-adjust rounds (no serial) can be stored. Existing rows
  // (all with a doc_number) copy over unchanged.
  const docCol = info.find((c) => c.name === 'doc_number')
  if (docCol && docCol.notnull === 1) {
    d.pragma('foreign_keys = OFF')
    d.transaction(() => {
      d.exec(`
        CREATE TABLE stocktake_sessions_new (
          id INTEGER PRIMARY KEY,
          doc_number TEXT UNIQUE,
          count_date TEXT,
          count_time TEXT,
          location_id INTEGER NOT NULL REFERENCES locations(id),
          category TEXT,
          note TEXT,
          counted_count INTEGER NOT NULL DEFAULT 0,
          adjusted_count INTEGER NOT NULL DEFAULT 0,
          is_quick INTEGER NOT NULL DEFAULT 0,
          created_by INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `)
      d.exec(`
        INSERT INTO stocktake_sessions_new
          (id, doc_number, count_date, count_time, location_id, category, note, counted_count, adjusted_count, is_quick, created_by, created_at)
        SELECT id, doc_number, count_date, count_time, location_id, category, note,
               COALESCE(counted_count, 0), COALESCE(adjusted_count, 0), COALESCE(is_quick, 0), created_by, created_at
        FROM stocktake_sessions;
      `)
      d.exec('DROP TABLE stocktake_sessions;')
      d.exec('ALTER TABLE stocktake_sessions_new RENAME TO stocktake_sessions;')
    })()
    d.pragma('foreign_keys = ON')
  }

  // Every counted line of every round is stored here — the full snapshot,
  // whether or not the count matched the system.
  d.exec(`
    CREATE TABLE IF NOT EXISTS stocktake_lines (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES stocktake_sessions(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      system_qty REAL NOT NULL,
      counted_qty REAL NOT NULL,
      diff REAL NOT NULL,
      note TEXT
    );
  `)

  // ---- Stocktake: the tally as it was actually counted (v1.5.1) ---------
  // counted_qty is a base-unit total, which cannot say whether the shelf held
  // "4 sealed boxes and 2 loose" or "202 loose". The shop counts those as two
  // separate observations, so the breakdown is stored verbatim as JSON
  // ([{unit, qty}]) alongside the total instead of being re-derived later.
  const lineCols = d.prepare('PRAGMA table_info(stocktake_lines)').all() as { name: string }[]
  if (!lineCols.some((c) => c.name === 'counted_parts'))
    d.exec('ALTER TABLE stocktake_lines ADD COLUMN counted_parts TEXT')

  // ---- Stocktake: multi-location sheets + goods-in notes (v1.3.0) --------
  // The printed count sheet now covers every location at once and carries the
  // goods-in columns, so lines are per (product, location) and the sheet can be
  // printed one day and keyed in on another.
  const stSessCols = (d.prepare('PRAGMA table_info(stocktake_sessions)').all() as { name: string }[]).map((c) => c.name)
  if (!stSessCols.includes('counter_name')) d.exec('ALTER TABLE stocktake_sessions ADD COLUMN counter_name TEXT')
  // 'PRINTED' = sheet issued but not keyed in yet, 'SAVED' = counts entered.
  if (!stSessCols.includes('status')) d.exec("ALTER TABLE stocktake_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'SAVED'")
  if (!stSessCols.includes('printed_at')) d.exec('ALTER TABLE stocktake_sessions ADD COLUMN printed_at TEXT')

  const stLineCols = (d.prepare('PRAGMA table_info(stocktake_lines)').all() as { name: string }[]).map((c) => c.name)
  if (!stLineCols.includes('location_id')) {
    d.exec('ALTER TABLE stocktake_lines ADD COLUMN location_id INTEGER REFERENCES locations(id)')
    // Existing rows all belonged to their session's single location.
    d.exec(`UPDATE stocktake_lines
            SET location_id = (SELECT s.location_id FROM stocktake_sessions s WHERE s.id = stocktake_lines.session_id)
            WHERE location_id IS NULL`)
  }
  // Goods-in noted by the counter — informational only. It explains a variance;
  // it never moves stock by itself (รับสินค้า is what posts RECEIVE movements).
  if (!stLineCols.includes('has_received'))
    d.exec('ALTER TABLE stocktake_lines ADD COLUMN has_received INTEGER NOT NULL DEFAULT 0')
  if (!stLineCols.includes('received_qty')) d.exec('ALTER TABLE stocktake_lines ADD COLUMN received_qty REAL')
  if (!stLineCols.includes('received_date')) d.exec('ALTER TABLE stocktake_lines ADD COLUMN received_date TEXT')

  // ---- BillKeep exchange (v1.2.0) ----------------------------------------
  // One row per imported daily-close file from the bill program. batch_id is
  // UNIQUE so the same file can never be applied twice (double-deducted stock).
  d.exec(`
    CREATE TABLE IF NOT EXISTS bill_imports (
      id INTEGER PRIMARY KEY,
      batch_id TEXT NOT NULL UNIQUE,
      close_date TEXT,
      file_path TEXT,
      issue_count INTEGER NOT NULL DEFAULT 0,
      new_product_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      total_qty REAL NOT NULL DEFAULT 0,
      note TEXT,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      imported_by INTEGER REFERENCES users(id)
    );
  `)

  // Products created from a bill have no real barcode yet — they get a
  // temporary TMP-xxxxxx code and this flag, so they can be found and fixed.
  const productCols = (d.prepare('PRAGMA table_info(products)').all() as { name: string }[]).map((c) => c.name)
  if (!productCols.includes('barcode_pending')) {
    d.exec('ALTER TABLE products ADD COLUMN barcode_pending INTEGER NOT NULL DEFAULT 0')
  }

  // ---- Catalogue import from the old POS (v1.5.5) ------------------------
  // The shop still runs Real 4POS alongside StockKeep, so its product list
  // keeps growing. One row per spreadsheet imported, purely as a record of
  // what was brought in and when — the import itself is safe to repeat
  // because it only ever ADDS barcodes that are not here yet.
  d.exec(`
    CREATE TABLE IF NOT EXISTS catalog_imports (
      id INTEGER PRIMARY KEY,
      file_name TEXT,
      file_path TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      added_count INTEGER NOT NULL DEFAULT 0,
      existing_count INTEGER NOT NULL DEFAULT 0,
      stock_rows INTEGER NOT NULL DEFAULT 0,
      with_stock INTEGER NOT NULL DEFAULT 0,
      location_id INTEGER REFERENCES locations(id),
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      imported_by INTEGER REFERENCES users(id)
    );
  `)
  // location_id came a little after the table itself, while the feature was
  // still being built — add it where the table already exists.
  const catalogCols = (d.prepare('PRAGMA table_info(catalog_imports)').all() as { name: string }[]).map((c) => c.name)
  if (!catalogCols.includes('location_id')) {
    d.exec('ALTER TABLE catalog_imports ADD COLUMN location_id INTEGER REFERENCES locations(id)')
  }

  // ---- Order tickets / ใบสั่งสินค้า (v1.3.0) ------------------------------
  // Printable customer order form (9 x 5.5 in continuous paper), replacing the
  // old Google Sheets + Apps Script setup.
  //
  // NOTE: BillKeep issues its own bill numbers for the same A/B/C/D paper books.
  // These counters are SEPARATE — the doc number here is editable so the user
  // stays in control and can avoid clashing with a book BillKeep is numbering.
  d.exec(`
    CREATE TABLE IF NOT EXISTS order_docs (
      id INTEGER PRIMARY KEY,
      doc_number TEXT NOT NULL UNIQUE,
      book_type TEXT,                    -- 'A' | 'B' | 'C' | 'D'
      doc_date TEXT,                     -- date on the ticket (YYYY-MM-DD)
      doc_time TEXT,                     -- time on the ticket ('HH:MM')
      customer_code TEXT,
      customer_name TEXT,
      customer_contact TEXT,             -- ที่อยู่ / โทร
      delivery_method TEXT,              -- 'DELIVER' | 'PICKUP'
      vehicle_plate TEXT,
      payment_method TEXT,               -- 'CASH' | 'TRANSFER' | 'CREDIT'
      cash_received REAL,
      cash_change REAL,
      transfer_amount REAL,
      transfer_ref TEXT,                 -- เบอร์โทร / เลขบัญชี
      note TEXT,
      subtotal REAL NOT NULL DEFAULT 0,
      delivery_fee REAL NOT NULL DEFAULT 0,
      grand_total REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER REFERENCES users(id)
    );
  `)

  // Lines mirror the paper columns. product_id is nullable so a hand-written
  // item that isn't in the catalogue can still be printed.
  d.exec(`
    CREATE TABLE IF NOT EXISTS order_doc_lines (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES order_docs(id),
      line_no INTEGER NOT NULL,
      product_id INTEGER REFERENCES products(id),
      description TEXT NOT NULL,
      location_name TEXT,                -- คลัง (free text snapshot)
      qty REAL,
      unit_name TEXT,
      unit_price REAL,
      amount REAL
    );
  `)

  // One counter per book letter per month — same keying as the old Apps Script
  // Settings sheet ('A-6907' = book A, Buddhist year 69, month 07).
  d.exec(`
    CREATE TABLE IF NOT EXISTS order_counters (
      key TEXT PRIMARY KEY,
      counter INTEGER NOT NULL DEFAULT 0
    );
  `)

  // ---------------------------------------------------------------------------
  // Warehouse zones — a FINDING AID, deliberately NOT a stock dimension.
  // ---------------------------------------------------------------------------
  // The shop groups goods into numbered bays (1-13) so pickers know where to
  // walk. That is separate from `locations`, which is what the ledger counts
  // against (คลังสินค้า vs หน้าร้าน). Keeping zones out of stock_movements means
  // the ledger rules are untouched — a zone is just "where this item sits".
  //
  // grid_* place the cell on the map. Storing the layout as data means the plan
  // can be re-arranged later without a code change.
  d.exec(`
    CREATE TABLE IF NOT EXISTS zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      -- 'zone' holds products and is clickable; 'label' is a door/office
      -- caption; 'space' is an empty bordered cell that only shapes the plan.
      kind TEXT NOT NULL DEFAULT 'zone',
      note TEXT,
      grid_col INTEGER NOT NULL,
      grid_row INTEGER NOT NULL,
      grid_w INTEGER NOT NULL DEFAULT 1,
      grid_h INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `)

  // Many-to-many on purpose: a line of goods is sometimes split across two bays,
  // and the search has to be able to report both.
  d.exec(`
    CREATE TABLE IF NOT EXISTS product_zones (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      zone_id    INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
      PRIMARY KEY (product_id, zone_id)
    );
  `)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_product_zones_zone ON product_zones(zone_id);`)

  seedZoneLayout()
  migrateZoneLayout()
}

// The floor plan the owner drew, oriented the way it is actually seen when
// standing in a doorway looking in: the doors run along the BOTTOM, bays 6-13
// across the top wall, bays 1-5 down the left-hand wall (1 nearest the office),
// office bottom-left, back door top-right.
//
// This is the same sketch turned 180 degrees. It was first entered the other
// way up, which matched the paper drawing but read backwards to anyone standing
// at the door — left on screen was right in the building.
//
// The grid is 40 columns wide because the door strip divides into 5 cells and
// the top strip into 8 — 40 is the smallest width both fit exactly.
type ZoneCell = [string, string, string, number, number, number, number, number]

function zoneLayout(): ZoneCell[] {
  const rows: ZoneCell[] = [
    // code, label, kind, col, row, w, h, sort
    ['OFFICE', 'Office', 'label', 1, 8, 8, 2, 104],
    ['DOOR2', 'Door 2', 'label', 9, 9, 8, 1, 103],
    ['DOOR3', 'Door 3', 'label', 17, 9, 8, 1, 102],
    ['DOOR4', 'Door 4', 'label', 25, 9, 8, 1, 101],
    ['DOOR5', 'Door 5', 'label', 33, 9, 8, 1, 100],
    ['BACKDOOR', 'Back Door', 'label', 33, 2, 8, 1, 105]
  ]

  // Right-hand wall: six unnumbered cells, exactly as drawn. The codes stay
  // W2..W7 so every row keeps its identity across the re-orientation below.
  for (let r = 2; r <= 7; r++) rows.push([`W${r}`, '', 'space', 33, 10 - r, 8, 1, 200 + r])

  // Bays 1-5 stacked up the left-hand wall, 1 nearest the office.
  for (let i = 1; i <= 5; i++) rows.push([String(i), String(i), 'zone', 9, 8 - i, 4, 1, i])

  // Bays 6-13 along the top, left to right as drawn.
  for (let n = 6; n <= 13; n++) rows.push([String(n), String(n), 'zone', 9 + (n - 6) * 4, 1, 4, 1, n])

  return rows
}

function seedZoneLayout(): void {
  const d = getDb()
  const existing = (d.prepare('SELECT COUNT(*) AS c FROM zones').get() as { c: number }).c
  if (existing > 0) return

  const ins = d.prepare(
    `INSERT INTO zones (code, label, kind, grid_col, grid_row, grid_w, grid_h, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  d.transaction(() => zoneLayout().forEach((r) => ins.run(...r)))()
}

// Re-orients an install that still carries the original upside-down plan.
// Cells are UPDATEd in place, keyed by code — rows are never deleted and
// re-inserted, so product_zones assignments survive the move untouched.
//
// The back door is the marker: it sat bottom-left in the old plan and sits
// top-right now, so its row says which way round this database is. That makes
// the migration self-limiting — it can run on every launch, fires at most once,
// and leaves a plan that has been re-arranged by hand alone.
function migrateZoneLayout(): void {
  const d = getDb()
  const back = d.prepare("SELECT grid_row FROM zones WHERE code = 'BACKDOOR'").get() as
    | { grid_row: number }
    | undefined
  if (!back || back.grid_row !== 8) return

  const upd = d.prepare(
    'UPDATE zones SET grid_col = ?, grid_row = ?, grid_w = ?, grid_h = ?, sort_order = ? WHERE code = ?'
  )
  d.transaction(() => {
    for (const [code, , , col, row, w, h, sort] of zoneLayout()) upd.run(col, row, w, h, sort, code)
  })()
}

function seedDefaultAdmin(): void {
  const d = getDb()
  const count = (d.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
  if (count === 0) {
    const adminRole = d.prepare("SELECT id FROM roles WHERE name = 'admin'").get() as { id: number }
    d.prepare(
      'INSERT INTO users (username, password_hash, display_name, role_id) VALUES (?, ?, ?, ?)'
    ).run('admin', bcrypt.hashSync('admin123', 10), 'ผู้ดูแลระบบ', adminRole.id)
    firstRun = true
  } else {
    // Still "first run" if the only account is the untouched seeded admin —
    // keeps the login hint visible until a real user is added or password changed.
    firstRun = false
  }
}
