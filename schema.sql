-- ============================================================================
-- STOCKKEEP — CURRENT DATABASE STRUCTURE (SQLite)
-- ============================================================================
-- This is the COMPLETE, up-to-date schema of the running StockKeep app as of
-- v1.1.3 — the original design schema PLUS every table added later through
-- migrations (see src/main/database.ts runMigrations()).
--
-- Use this file as the reference when building a NEW program that relates to
-- StockKeep's data. The live database file is at:
--     %APPDATA%\stockkeep\stockkeep.db   (Windows)
--
-- Notes for a related program:
--   * Enable foreign keys on every connection:  PRAGMA foreign_keys = ON;
--   * The DB runs in WAL mode. If you open it read-only from another process
--     while StockKeep is running, that is safe. Do NOT have two processes
--     WRITE to it at once (SQLite is single-writer) — prefer read-only access,
--     or coordinate writes.
--   * Stock is a LEDGER: never store a running total. Current stock is always
--     SUM(stock_movements.qty_change) per product per location. All quantities
--     are in the product's BASE unit.
--   * Prices/cost visibility is enforced in the app layer by role, not in SQL.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- Lookup tables
-- ----------------------------------------------------------------------------

CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE units (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE          -- 'ชิ้น', 'กล่อง', 'พาเลท', 'ม้วน', ...
);

CREATE TABLE suppliers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    contact_info TEXT,
    credit_days INTEGER DEFAULT 0
);

-- Where stock physically sits. A real table (not an enum) so adding a branch
-- later is just an INSERT.
CREATE TABLE locations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE          -- 'คลังสินค้า', 'หน้าร้าน'
);

-- ----------------------------------------------------------------------------
-- Product master
-- ----------------------------------------------------------------------------

CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    barcode TEXT NOT NULL UNIQUE,
    -- 1 = created from a BillKeep import and still carries a temporary
    -- 'TMP-xxxxxx' code; clears automatically when a real barcode is saved.
    barcode_pending INTEGER NOT NULL DEFAULT 0 CHECK (barcode_pending IN (0,1)),
    sub_barcode TEXT,
    description TEXT NOT NULL,
    short_name TEXT,
    category_id INTEGER REFERENCES categories(id),
    -- min/max are in BASE units, comparable directly to movement totals.
    min_stock REAL DEFAULT 0,
    max_stock REAL DEFAULT 0,
    latest_cost REAL DEFAULT 0,        -- cost per BASE unit (visible to role level >= 2 only)
    vat_type TEXT NOT NULL DEFAULT 'NONE' CHECK (vat_type IN ('INC','EXC','NONE')),
    discontinued INTEGER NOT NULL DEFAULT 0 CHECK (discontinued IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_description ON products(description);

-- Per-product unit hierarchy, largest -> smallest. Exactly one row has
-- is_base_unit = 1 with qty_per_base = 1. qty_per_base = how many BASE units
-- one of THIS unit equals (box = 24, pallet = 480, ...).
CREATE TABLE product_units (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),
    qty_per_base REAL NOT NULL CHECK (qty_per_base > 0),
    sort_order INTEGER NOT NULL,       -- 0 = largest unit, increasing = smaller
    is_base_unit INTEGER NOT NULL DEFAULT 0 CHECK (is_base_unit IN (0,1)),
    UNIQUE(product_id, unit_id)
);

CREATE INDEX idx_product_units_product ON product_units(product_id, sort_order);

-- ----------------------------------------------------------------------------
-- Stock ledger — the heart of the system. Every change is one row, in BASE
-- units, tied to a location. Current stock = SUM(qty_change). Never UPDATE a
-- running total.
-- ----------------------------------------------------------------------------

CREATE TABLE stock_movements (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),
    movement_type TEXT NOT NULL CHECK (
        movement_type IN ('OPENING','RECEIVE','ADJUST','ISSUE','TRANSFER_IN','TRANSFER_OUT')
    ),
    qty_change REAL NOT NULL,          -- BASE units; positive = in, negative = out
    unit_cost REAL,                    -- cost per BASE unit at time of movement
    reference_type TEXT,               -- 'stock_receiving', 'transfer', 'stocktake', 'manual', 'bill'
    reference_id INTEGER,              -- links to the source doc / TRANSFER pair / stocktake session / bill_imports row
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES users(id)   -- who performed it
);

CREATE INDEX idx_movements_product_location ON stock_movements(product_id, location_id);

-- ----------------------------------------------------------------------------
-- Stock receiving (goods-in documents)
-- ----------------------------------------------------------------------------

CREATE TABLE stock_receiving (
    id INTEGER PRIMARY KEY,
    doc_number TEXT NOT NULL UNIQUE,   -- 'REC-YYYYMMDD-NNNN'
    doc_date TEXT NOT NULL,
    supplier_id INTEGER REFERENCES suppliers(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),
    notes TEXT,
    subtotal REAL NOT NULL DEFAULT 0,
    discount_total REAL NOT NULL DEFAULT 0,
    vat_amount REAL NOT NULL DEFAULT 0,
    grand_total REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES users(id)
);

-- Entered in whatever unit the supplier invoices in. qty_base is the converted
-- BASE amount, snapshotted so historical docs stay accurate if qty_per_base is
-- edited later.
CREATE TABLE stock_receiving_lines (
    id INTEGER PRIMARY KEY,
    receiving_id INTEGER NOT NULL REFERENCES stock_receiving(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),
    qty REAL NOT NULL,                 -- qty in the line's unit (e.g. 5 boxes)
    qty_base REAL NOT NULL,            -- snapshot: qty * qty_per_base
    unit_cost REAL NOT NULL,           -- cost per the line's unit
    discount_pct REAL NOT NULL DEFAULT 0,
    discount_amt REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL
);

-- ----------------------------------------------------------------------------
-- Stocktake (physical count rounds)  [added via migration]
-- ----------------------------------------------------------------------------
-- Each save = one count round = one stocktake_sessions row, holding the FULL
-- snapshot of what was counted (every line, matched or not) in stocktake_lines.
-- Two times are kept: (count_date + count_time) = when the person physically
-- counted; created_at = when it was entered into the system.
-- Rows with a difference also post an ADJUST stock_movements row that links
-- back via reference_type='stocktake', reference_id = session id.

CREATE TABLE stocktake_sessions (
    id INTEGER PRIMARY KEY,
    doc_number TEXT UNIQUE,            -- 'STK-YYYYMMDD-NNNN', or NULL for quick-adjust rounds
    count_date TEXT,                  -- date the person counted (from the paper)
    count_time TEXT,                  -- time the person counted ('HH:MM')
    location_id INTEGER NOT NULL REFERENCES locations(id),
    category TEXT,                    -- category filter used for the round (or NULL = all)
    note TEXT,
    counted_count INTEGER NOT NULL DEFAULT 0,   -- number of items counted in the round
    adjusted_count INTEGER NOT NULL DEFAULT 0,  -- number that differed (posted ADJUST)
    is_quick INTEGER NOT NULL DEFAULT 0,        -- 1 = quick adjust (no serial, no print)
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP   -- system entry time
);

-- One row per counted item in a round — the full snapshot, matched or not.
CREATE TABLE stocktake_lines (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES stocktake_sessions(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    system_qty REAL NOT NULL,         -- BASE units in system at count time
    counted_qty REAL NOT NULL,        -- BASE units counted
    diff REAL NOT NULL,               -- counted_qty - system_qty
    note TEXT
);

-- ----------------------------------------------------------------------------
-- BillKeep exchange (bill program import log)  [added via migration, v1.2.0]
-- ----------------------------------------------------------------------------
-- One row per daily-close .json file imported from BillKeep (the front-of-store
-- bill program). batch_id is UNIQUE so the same file can never be applied twice
-- and double-deduct stock. Every sale posted from that file is an ISSUE row in
-- stock_movements with reference_type='bill', reference_id = this row's id.

CREATE TABLE bill_imports (
    id INTEGER PRIMARY KEY,
    batch_id TEXT NOT NULL UNIQUE,     -- รหัสชุดข้อมูลจาก BillKeep
    close_date TEXT,                   -- วันที่ปิดการขายของไฟล์นั้น
    file_path TEXT,
    issue_count INTEGER NOT NULL DEFAULT 0,        -- จำนวนบรรทัดที่ตัดสต๊อกสำเร็จ
    new_product_count INTEGER NOT NULL DEFAULT 0,  -- สินค้าใหม่ที่สร้างจากไฟล์นี้
    skipped_count INTEGER NOT NULL DEFAULT 0,      -- จับคู่สินค้า/สถานที่ไม่ได้ จึงข้าม
    total_qty REAL NOT NULL DEFAULT 0,             -- จำนวนรวม (หน่วยฐาน)
    note TEXT,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    imported_by INTEGER REFERENCES users(id)
);

-- ----------------------------------------------------------------------------
-- Roles & users
-- ----------------------------------------------------------------------------
-- Access is a level comparison: "user.role_level >= X.min_role_level".

CREATE TABLE roles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,          -- 'staff', 'stock_manager', 'admin'
    level INTEGER NOT NULL UNIQUE       -- 1, 2, 3 (higher = more access)
);

CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,        -- bcrypt hash (bcryptjs) — never plain text
    display_name TEXT NOT NULL,
    role_id INTEGER NOT NULL REFERENCES roles(id),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- Price tiers (multi-level pricing tied to role visibility)
-- ----------------------------------------------------------------------------

CREATE TABLE price_tiers (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,          -- 'RETAIL', 'TRADESMAN', 'WHOLESALE'
    name TEXT NOT NULL,                 -- 'ราคาขายหน้าร้าน', 'ราคาช่าง', 'ราคาส่ง'
    min_role_level INTEGER NOT NULL DEFAULT 1,   -- lowest roles.level allowed to view
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE product_prices (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    price_tier_id INTEGER NOT NULL REFERENCES price_tiers(id),
    price REAL NOT NULL,               -- per BASE unit
    UNIQUE(product_id, price_tier_id)
);
CREATE INDEX idx_product_prices_product ON product_prices(product_id);

-- ----------------------------------------------------------------------------
-- Views
-- ----------------------------------------------------------------------------

-- Stock on hand per product PER LOCATION (base units).
CREATE VIEW current_stock AS
SELECT
    p.id            AS product_id,
    p.barcode,
    p.description,
    l.id            AS location_id,
    l.name          AS location_name,
    COALESCE(SUM(m.qty_change), 0) AS qty_on_hand_base
FROM products p
CROSS JOIN locations l
LEFT JOIN stock_movements m ON m.product_id = p.id AND m.location_id = l.id
GROUP BY p.id, l.id;

-- Products whose total across all locations is below min_stock.
CREATE VIEW low_stock_alert AS
SELECT
    p.id AS product_id, p.barcode, p.description, p.min_stock,
    COALESCE(SUM(m.qty_change), 0) AS qty_on_hand_base
FROM products p
LEFT JOIN stock_movements m ON m.product_id = p.id
GROUP BY p.id
HAVING qty_on_hand_base < p.min_stock;

-- ----------------------------------------------------------------------------
-- Trigger
-- ----------------------------------------------------------------------------

CREATE TRIGGER trg_products_updated_at
AFTER UPDATE ON products
FOR EACH ROW
BEGIN
    UPDATE products SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

-- ----------------------------------------------------------------------------
-- Seed data (lookup rows + role/tier definitions)
-- ----------------------------------------------------------------------------

INSERT INTO units (name) VALUES ('ชิ้น'), ('กล่อง'), ('พาเลท'), ('ม้วน'), ('แผ่น'), ('กก.');
INSERT INTO categories (name) VALUES ('ท่อเหล็ก'), ('ตาข่ายเหล็ก'), ('เหล็กเส้น'), ('น็อตและสกรู'), ('ทั่วไป');
INSERT INTO locations (name) VALUES ('คลังสินค้า'), ('หน้าร้าน');

INSERT INTO roles (name, level) VALUES ('staff', 1), ('stock_manager', 2), ('admin', 3);

INSERT INTO price_tiers (code, name, min_role_level, sort_order) VALUES
    ('RETAIL',    'ราคาขายหน้าร้าน', 1, 0),   -- everyone (incl. staff)
    ('TRADESMAN', 'ราคาช่าง',        2, 1),   -- stock_manager and up
    ('WHOLESALE', 'ราคาส่ง',         2, 2);   -- stock_manager and up

-- On first run the app also seeds an initial admin user (admin / admin123,
-- bcrypt-hashed) — see src/main/database.ts seedDefaultAdmin().

-- ============================================================================
-- REMOVED / NOT USED (kept out of this current schema on purpose):
--   * import_batches — belonged to a CSV-import feature that was cut. The
--     original schema.sql created it; the live DB may still contain an empty
--     copy on old installs, but the app never uses it.
-- ============================================================================
