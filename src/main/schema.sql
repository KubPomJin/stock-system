-- ============================================================================
-- STOCK MANAGEMENT SYSTEM — SQLite SCHEMA (v2 — multi-level units + locations)
-- ============================================================================
-- Comments in English (dev-facing), UI-facing strings are Thai.
-- MySQL DIFF notes kept from v1 where still relevant.
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

-- Where stock physically sits. Start with 2 rows (warehouse / storefront) but
-- this is a real table, not a hardcoded enum, so adding a second branch later
-- is just an INSERT, not a schema change.
CREATE TABLE locations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE          -- 'คลังสินค้า', 'หน้าร้าน'
);

-- ----------------------------------------------------------------------------
-- Product master
-- ----------------------------------------------------------------------------
-- NOTE (v2 change): main_unit_id / sub_unit_id / pack_size from v1 are gone.
-- They assumed every product has exactly 2 unit levels. Real products range
-- from 1 level (loose piece) to 3+ (pallet > box > piece), so unit structure
-- moved into its own table below (product_units) instead of columns here.

CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    barcode TEXT NOT NULL UNIQUE,
    sub_barcode TEXT,
    description TEXT NOT NULL,
    short_name TEXT,

    category_id INTEGER REFERENCES categories(id),

    -- min_stock / max_stock are always expressed in BASE units (the
    -- product's smallest unit — see product_units.is_base_unit), so they
    -- compare directly against stock_movements totals without conversion.
    min_stock REAL DEFAULT 0,
    max_stock REAL DEFAULT 0,

    latest_cost REAL DEFAULT 0,        -- cost per BASE unit, kept normalized (see stock_receiving_lines)
    -- selling prices moved to product_prices (see v3 additions below) —
    -- a fixed price_1/price_2/price_3 here can't express "who's allowed to see this price"

    vat_type TEXT NOT NULL DEFAULT 'NONE' CHECK (vat_type IN ('INC','EXC','NONE')),
    discontinued INTEGER NOT NULL DEFAULT 0 CHECK (discontinued IN (0,1)),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_description ON products(description);

-- ----------------------------------------------------------------------------
-- Unit hierarchy per product — this is the answer to "main/sub unit"
-- ----------------------------------------------------------------------------
-- Each product gets its own list of unit levels, sorted largest -> smallest.
-- A simple product (sold only as loose pieces) has exactly ONE row here
-- (is_base_unit = 1, qty_per_base = 1). A boxed product might have two rows
-- (box, piece). A palletized product might have three (pallet, box, piece).
-- The table doesn't care how many levels a product has — that's the whole
-- point: it's not fixed at 2 like the old main/sub design.

CREATE TABLE product_units (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),

    -- How many BASE units does one of THIS unit equal.
    -- e.g. for a product whose base unit is 'ชิ้น':
    --   'กล่อง' row -> qty_per_base = 24   (1 box = 24 pieces)
    --   'พาเลท' row -> qty_per_base = 480  (1 pallet = 20 boxes = 480 pieces)
    qty_per_base REAL NOT NULL CHECK (qty_per_base > 0),

    sort_order INTEGER NOT NULL,       -- 0 = largest unit, increasing = smaller
    is_base_unit INTEGER NOT NULL DEFAULT 0 CHECK (is_base_unit IN (0,1)),

    UNIQUE(product_id, unit_id)
);

CREATE INDEX idx_product_units_product ON product_units(product_id, sort_order);

-- ----------------------------------------------------------------------------
-- Stock ledger — every change is a row, always in BASE units, always tied to
-- a location. Current stock is derived (SUM), never stored directly.
-- ----------------------------------------------------------------------------

CREATE TABLE stock_movements (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),
    movement_type TEXT NOT NULL CHECK (
        movement_type IN ('OPENING','RECEIVE','ADJUST','ISSUE','TRANSFER_IN','TRANSFER_OUT')
    ),
    qty_change REAL NOT NULL,          -- always in BASE units; positive = in, negative = out
    unit_cost REAL,                    -- cost per BASE unit at time of this movement
    reference_type TEXT,               -- 'stock_receiving', 'import_batch', 'transfer', 'manual'
    reference_id INTEGER,              -- links TRANSFER_OUT/TRANSFER_IN pairs together too
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_movements_product_location ON stock_movements(product_id, location_id);

-- ----------------------------------------------------------------------------
-- Stock receiving (goods-in documents)
-- ----------------------------------------------------------------------------

CREATE TABLE stock_receiving (
    id INTEGER PRIMARY KEY,
    doc_number TEXT NOT NULL UNIQUE,
    doc_date TEXT NOT NULL,
    supplier_id INTEGER REFERENCES suppliers(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),   -- which location received this
    notes TEXT,
    subtotal REAL NOT NULL DEFAULT 0,
    discount_total REAL NOT NULL DEFAULT 0,
    vat_amount REAL NOT NULL DEFAULT 0,
    grand_total REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A receiving line is entered in WHATEVER unit the supplier invoices in
-- (usually box or pallet, not piece) — qty/unit_cost are in that unit.
-- qty_base is the converted BASE-unit amount, snapshotted at the time of
-- receiving so historical documents stay accurate even if someone edits
-- product_units.qty_per_base later.
CREATE TABLE stock_receiving_lines (
    id INTEGER PRIMARY KEY,
    receiving_id INTEGER NOT NULL REFERENCES stock_receiving(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),     -- unit used on this line, e.g. 'กล่อง'
    qty REAL NOT NULL,                                 -- qty in that unit, e.g. 5 (boxes)
    qty_base REAL NOT NULL,                             -- snapshot: qty * qty_per_base at time of entry
    unit_cost REAL NOT NULL,                            -- cost per the unit on this line (per box)
    discount_pct REAL NOT NULL DEFAULT 0,
    discount_amt REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL
);

-- ----------------------------------------------------------------------------
-- Initial stock import
-- ----------------------------------------------------------------------------

CREATE TABLE import_batches (
    id INTEGER PRIMARY KEY,
    source_filename TEXT,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    row_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0
);

-- ----------------------------------------------------------------------------
-- Views
-- ----------------------------------------------------------------------------
-- current_stock is now per product PER LOCATION — this is what answers
-- "กี่กล่องอยู่ในคลัง, กี่กล่องกี่ชิ้นอยู่หน้าร้าน". qty_on_hand_base is always
-- in base units; converting it to "5 กล่อง 3 ชิ้น" for display is app-code,
-- not SQL (see the formatStock() note below) — SQL just gives you the total.

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

-- Total across all locations, compared against min_stock for reordering
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
-- Seed data
-- ----------------------------------------------------------------------------

INSERT INTO units (name) VALUES ('ชิ้น'), ('กล่อง'), ('พาเลท'), ('ม้วน'), ('แผ่น'), ('กก.');
INSERT INTO categories (name) VALUES ('ท่อเหล็ก'), ('ตาข่ายเหล็ก'), ('เหล็กเส้น'), ('น็อตและสกรู'), ('ทั่วไป');
INSERT INTO locations (name) VALUES ('คลังสินค้า'), ('หน้าร้าน');

-- Example: a boxed product (box of 24, base unit = piece)
-- INSERT INTO products (barcode, description, category_id) VALUES ('000010', 'น็อตหกเหลี่ยม M10x40', 4);
-- INSERT INTO product_units (product_id, unit_id, qty_per_base, sort_order, is_base_unit)
--   VALUES (1, (SELECT id FROM units WHERE name='กล่อง'), 24, 0, 0),
--          (1, (SELECT id FROM units WHERE name='ชิ้น'),  1,  1, 1);

-- Example: a simple single-unit product (no packaging levels)
-- INSERT INTO products (barcode, description, category_id) VALUES ('000011', 'เหล็กฉาก 40x40x4มม. 6ม.', 1);
-- INSERT INTO product_units (product_id, unit_id, qty_per_base, sort_order, is_base_unit)
--   VALUES (2, (SELECT id FROM units WHERE name='ชิ้น'), 1, 0, 1);
-- ============================================================================
-- ADDITIONS (v3) — login / roles / price tiers
-- Run this after schema.sql (v2), or merge into one file — shown separately
-- here so the diff from v2 is easy to review.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Roles & users
-- ----------------------------------------------------------------------------
-- 'level' is what makes tier-gating a comparison instead of a hardcoded list:
-- "can this user see X" becomes "user.role_level >= X.min_role_level".
-- Collapsing to 2 roles later = just don't insert 'stock_manager', or give
-- everyone above staff the 'admin' role directly. No schema change needed.

CREATE TABLE roles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,          -- 'staff', 'stock_manager', 'admin'
    level INTEGER NOT NULL UNIQUE       -- higher = more access
);
INSERT INTO roles (name, level) VALUES ('staff', 1), ('stock_manager', 2), ('admin', 3);

CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,        -- bcrypt/argon2 hash — never store plain text
    display_name TEXT NOT NULL,
    role_id INTEGER NOT NULL REFERENCES roles(id),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- Price tiers — replaces the old price_1/price_2/price_3 columns on products
-- ----------------------------------------------------------------------------
-- Old design (v1/v2) hardcoded 3 generic price slots on the products table.
-- That doesn't carry any meaning about WHO should see each price. Splitting
-- into its own table lets each tier declare its own visibility rule.

CREATE TABLE price_tiers (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,          -- 'RETAIL', 'TRADESMAN', 'WHOLESALE'
    name TEXT NOT NULL,                 -- 'ราคาขายหน้าร้าน', 'ราคาช่าง', 'ราคาส่ง'
    min_role_level INTEGER NOT NULL DEFAULT 1,   -- lowest roles.level allowed to view this
    sort_order INTEGER NOT NULL DEFAULT 0
);
INSERT INTO price_tiers (code, name, min_role_level, sort_order) VALUES
    ('RETAIL',    'ราคาขายหน้าร้าน', 1, 0),   -- ทุก role เห็นได้ รวมพนักงาน
    ('TRADESMAN', 'ราคาช่าง',        2, 1),   -- คนจัดสต็อกขึ้นไป
    ('WHOLESALE', 'ราคาส่ง',         2, 2);   -- คนจัดสต็อกขึ้นไป

CREATE TABLE product_prices (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    price_tier_id INTEGER NOT NULL REFERENCES price_tiers(id),
    price REAL NOT NULL,
    UNIQUE(product_id, price_tier_id)
);
CREATE INDEX idx_product_prices_product ON product_prices(product_id);

-- products.latest_cost (ต้นทุน/ราคารับซื้อ) stays a plain column — it's not a
-- "tier" a customer ever sees, it's cost data. Its visibility is enforced by
-- the query layer (see note below), same way as any tier above min_role_level 2.

-- ----------------------------------------------------------------------------
-- Accountability — tie stock actions to the user who did them
-- ----------------------------------------------------------------------------
-- This is what actually answers "who changed this" (v1 already fixed
-- "why is it -2" with the movement ledger; this adds "who").

ALTER TABLE stock_movements ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE stock_receiving ADD COLUMN created_by INTEGER REFERENCES users(id);
