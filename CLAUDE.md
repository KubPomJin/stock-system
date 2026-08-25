# CLAUDE.md — StockKeep (ระบบจัดการสต๊อกสินค้า)

> สถานะ: โปรแกรมนี้ **สร้างเสร็จและใช้งานจริงแล้ว** (ปัจจุบัน v1.5.1) — ไฟล์นี้อธิบาย
> โครงสร้างและการทำงานจริงของระบบ ณ ปัจจุบัน (ไม่ใช่เอกสารช่วงออกแบบแล้ว)
> ใช้เป็น context เมื่อจะแก้ StockKeep ต่อ หรือสร้าง **โปรแกรมใหม่ที่เชื่อมโยงกับข้อมูลของ StockKeep**
> โครงสร้างฐานข้อมูลปัจจุบันทั้งหมดอยู่ใน `schema.sql` (ในโฟลเดอร์นี้)

---

## 1. ภาพรวม

Desktop app จัดการสต๊อกสำหรับร้าน/โกดังวัสดุก่อสร้าง (เหล็ก, ตาข่าย, น็อต ฯลฯ) ในไทย
แทนระบบเก่า (Real 4POS) ที่เก็บสต๊อกเป็นตัวเลขเดียวแก้ทับ ทำให้ยอดติดลบโดยไม่มีประวัติ

- **standalone** — ฐานข้อมูลของตัวเอง ไม่เชื่อม 4POS
- **UI ภาษาไทยทั้งหมด / โค้ด-คอมเมนต์-ชื่อตารางเป็นอังกฤษ**
- แต่ละเครื่องมีฐานข้อมูลแยกของตัวเอง (ยังไม่ได้ทำ shared DB — ดูข้อ 8)

---

## 2. Tech Stack

| ส่วน | เทคโนโลยี |
|---|---|
| Runtime | Electron (desktop, Windows) |
| ภาษา | TypeScript |
| UI | HTML/CSS/JS (renderer) — vanilla, ไม่มี framework |
| Build | electron-vite + electron-builder (NSIS installer) |
| Database | SQLite ผ่าน better-sqlite3 (synchronous) |
| Password | bcryptjs (pure JS) |

**ตำแหน่งฐานข้อมูลจริง:** `%APPDATA%\stockkeep\stockkeep.db` (Windows) — อยู่ใน `app.getPath('userData')`
เพื่อให้รอด app update และเขียนได้เสมอ สร้างอัตโนมัติจาก `src/main/schema.sql` ตอนเปิดครั้งแรก
แล้วปรับโครงสร้างเพิ่มเติมด้วย `runMigrations()` ทุกครั้งที่เปิด (idempotent)

---

## 3. โครงสร้างโปรเจกต์จริง

```
stock-system/
├── src/
│   ├── main/                      # main process
│   │   ├── index.ts               # entry, BrowserWindow, single-instance lock
│   │   ├── database.ts            # เปิด DB, runMigrations(), seed admin, backup/restore
│   │   ├── session.ts             # session ผู้ใช้ (ตัวแปรใน main + requireLevel())
│   │   ├── schema.sql             # base schema (รันตอน DB ใหม่)
│   │   └── ipc/                   # IPC handlers แยก domain
│   │       ├── helpers.ts         # handle() — gate role + ห่อผลลัพธ์ { ok, data|error }
│   │       ├── auth.ts            # login / logout / isFirstRun
│   │       ├── lookups.ts         # categories / locations / suppliers / roles
│   │       ├── products.ts        # CRUD สินค้า + กรองราคาตาม role
│   │       ├── stock.ts           # receiving / stocktake / transfer (movements)
│   │       ├── history.ts         # ledger + count sessions + session lines
│   │       ├── exchange.ts        # เชื่อมกับ BillKeep (ส่งออกสินค้า / นำเข้าผลปิดวัน)
│   │       ├── users.ts           # จัดการผู้ใช้ (admin)
│   │       ├── zones.ts           # ผังโกดัง + ค้นหาที่เก็บสินค้า (ไม่แตะ ledger)
│   │       └── backup.ts          # export / import ฐานข้อมูล (dialog)
│   ├── preload/index.ts           # contextBridge — expose window.api (typed)
│   ├── renderer/
│   │   ├── index.html             # ทุกหน้าอยู่ในไฟล์เดียว (view สลับด้วย class)
│   │   └── src/
│   │       ├── main.ts            # nav (role-aware), login flow, refreshData()
│   │       ├── state.ts, format.ts, ui.ts
│   │       └── views/             # dashboard, products, receiving, stocktake,
│   │                              #   transfer, history, users
│   └── shared/types.ts            # types ใช้ร่วม main + renderer (รวม Api surface)
├── schema.sql                     # โครงสร้าง DB ปัจจุบันทั้งหมด (ไฟล์อ้างอิงนี้)
├── CHANGELOG.md
├── docs/NETWORK-PLAN.md           # แผน shared DB หลายเครื่อง (ยังไม่ทำ)
└── release/                       # installer .exe
```

### กฎความปลอดภัยที่ยึดไว้

1. **กรองราคา/ต้นทุนตาม role ที่ main process เท่านั้น** — IPC handler ตัด field ที่ role ไม่มีสิทธิ์ออกก่อนส่ง (staff ไม่เคยได้รับ `latest_cost` / ราคาช่าง / ราคาส่ง ผ่าน IPC)
2. **Session อยู่ใน main process** (ตัวแปรธรรมดา) — ไม่มี token
3. **รหัสผ่าน bcrypt hash เท่านั้น**
4. **DB ใน userData** — รอด update
5. **`PRAGMA foreign_keys = ON` ทุก connection**

---

## 4. ฐานข้อมูล (ดู `schema.sql` เป็นหลัก)

ตารางหลัก: `categories`, `units`, `suppliers`, `locations`, `products`, `product_units`,
`stock_movements`, `stock_receiving(+_lines)`, `stocktake_sessions(+ _lines)`,
`bill_imports`, `roles`, `users`, `price_tiers`, `product_prices`, `zones`, `product_zones`
Views: `current_stock`, `low_stock_alert`

**หัวใจ 3 อย่างที่ต้องไม่พลาด:**
- **Ledger** — สต๊อกคงเหลือ = `SUM(stock_movements.qty_change)` เสมอ ห้ามเก็บยอดตรงๆ ห้าม UPDATE ยอด
- **หน่วยฐาน** — ทุก qty/price/min/max เก็บเป็นหน่วยเล็กสุด แปลงเป็นกล่อง/พาเลทตอนแสดงผลด้วย `formatStock()` เท่านั้น
- **สิทธิ์แบบ level** — `user.role_level >= requirement` (staff=1, stock_manager=2, admin=3)

`movement_type`: `OPENING`, `RECEIVE`, `ADJUST`, `ISSUE`, `TRANSFER_IN`, `TRANSFER_OUT`

---

## 5. ฟีเจอร์ที่ทำแล้ว (ปัจจุบัน)

| หน้า | สิทธิ์ขั้นต่ำ | หน้าที่ |
|---|---|---|
| แดชบอร์ด | staff | KPI + แถบเตือนติดลบ/ต่ำ + ตารางต่ำกว่าขั้นต่ำ (การ์ดมูลค่าสต๊อกซ่อนจาก staff) |
| สินค้า | staff | ตาราง + ตัวกรอง (ค้นหา/หมวด/สถานะ/เรียง) + เพิ่ม-แก้สินค้า (lvl 2+) |
| รับสินค้า | stock_manager | เอกสารรับของ + combobox ผู้จำหน่าย + เลือกหน่วย/คลัง → RECEIVE |
| เบิกของ | stock_manager | โยกสต๊อกระหว่างสถานที่ + เช็คของพอ → TRANSFER_OUT/IN |
| ตรวจนับสต๊อก | stock_manager | นับจริง vs ระบบ, เลขที่เอกสาร (STK-...), วันที่+เวลาที่นับ, พิมพ์ใบตรวจนับ A4 (มี preview), โหมด "ปรับด่วน" ไม่ออกเลขเอกสาร → ADJUST |
| ประวัติสต๊อก | stock_manager | แท็บ "รอบการตรวจนับ" (แต่ละรอบเก็บรายการที่นับครบ + 2 เวลา + ดูรายการ) และ "การเคลื่อนไหวทั้งหมด" (ledger) |
| เชื่อมระบบบิล | stock_manager | นำเข้าไฟล์ปิดวันจาก BillKeep → ISSUE movements + สร้างสินค้าใหม่ (บาร์โค้ดชั่วคราว), ส่งออกรายการสินค้าเป็น .json, ประวัติการนำเข้า |
| ผังโกดัง | staff | ค้นหาสินค้าว่าอยู่โซนไหน + ผังกดได้โชว์รายการในโซนนั้น (เพิ่ม/เอาออกจากโซนต้อง lvl 2+) |
| ผู้ใช้งาน | admin | จัดการผู้ใช้ + สำรอง/กู้คืนฐานข้อมูล (export/import .db) |

**การตรวจนับ (สำคัญ):** ทุกครั้งที่บันทึก = 1 รอบ (session) เก็บ **ทุกรายการที่นับ** ลง `stocktake_lines`
(แม้ตรงกับระบบ) + เก็บ 2 เวลา: `count_date`/`count_time` = เวลาที่คนนับ, `created_at` = เวลาที่บันทึกเข้าระบบ
เฉพาะรายการที่ต่างจะ post ADJUST movement ผูกกลับ session ด้วย `reference_type='stocktake'`, `reference_id`

**สำรอง/กู้คืน:** export = checkpoint WAL แล้ว copy ไฟล์ .db, import = ตรวจไฟล์ก่อน + สำรองของเดิมอัตโนมัติ (`stockkeep.db.before-import`) แล้วเขียนทับ

---

## 6. สิ่งที่ตัดสินใจไว้ (อย่าเปลี่ยนโดยไม่ถาม)

- ไม่มี import CSV (พิมพ์มือทีละรายการ)
- สต๊อกเป็น ledger เสมอ, ทุกอย่างหน่วยฐาน, กรองราคาที่ main process
- UI ไทย / โค้ดอังกฤษ, standalone
- migration เพิ่มตาราง/คอลัมน์ใหม่ทำใน `runMigrations()` แบบ idempotent (ห้ามพึ่ง `schema.sql` เพราะรันแค่ตอน DB ใหม่)
- ขึ้นเวอร์ชันไปข้างหน้าเท่านั้น (มี migration) ห้าม downgrade ทับ
- **โซนโกดัง (`zones`) ไม่ใช่มิติของสต๊อก** — เป็นตัวช่วยหาของเท่านั้น ไม่แตะ `stock_movements`
  ยอดคงเหลือยังนับตาม `locations` เหมือนเดิม · หน้าผังโกดังพนักงาน (lvl 1) ใช้ได้
  จึง **ห้ามส่งราคา/ต้นทุนผ่าน IPC ของ zones**

---

## 7. Build / Run

```bash
npm install
npm run dev        # dev
npm start          # preview build ที่ compile แล้ว
npm run dist       # สร้าง installer .exe ใน release/
```

login ครั้งแรก: `admin` / `admin123`

---

## 8. BillKeep — ระบบเก็บบิลหน้าร้าน (โปรแกรมคู่ที่สร้างแล้ว)

โค้ดอยู่ที่ `D:\Claude Code\Home\Program\order program\bill-system\` (ดู CLAUDE.md ของมันประกอบ)
เป็นโปรแกรมแยก มีฐานข้อมูลของตัวเองที่ `%APPDATA%\billkeep\billkeep.db`

**กติกาการเชื่อมที่ยึดไว้ (สำคัญ — อย่าเปลี่ยนโดยไม่คิดให้ครบ):**

- **StockKeep เป็นผู้เขียน `stockkeep.db` เพียงผู้เดียวเสมอ** — BillKeep เปิดไฟล์นี้แบบ
  `readonly: true` เพื่ออ่านสินค้า/หน่วย/ยอดคงเหลือเท่านั้น จึงไม่ชนกับข้อจำกัด single-writer ของ SQLite
- **ขาส่งกลับเป็นไฟล์ ไม่ใช่การเขียนตรง** — BillKeep ปิดวันแล้วส่งออก `.json`
  (`format: "billkeep-batch"`) → คนกดนำเข้าที่ StockKeep หน้า "เชื่อมระบบบิล"
- นำเข้าแล้วจะลง `stock_movements` แบบ `ISSUE` (`reference_type='bill'`,
  `reference_id` = `bill_imports.id`) — **ยอดสต๊อกยังเป็น ledger เหมือนเดิม ไม่มีการ UPDATE ยอด**
- `bill_imports.batch_id` เป็น UNIQUE → ไฟล์เดิมนำเข้าซ้ำไม่ได้ (กันตัดสต๊อกสองรอบ)
- **สินค้าใหม่จากบิล** สร้างด้วยบาร์โค้ดชั่วคราว `TMP-xxxxxx` + `products.barcode_pending = 1`
  (คอลัมน์ `barcode` เป็น NOT NULL UNIQUE จึงเว้นว่างจริงไม่ได้) ธงปลดอัตโนมัติเมื่อบันทึกบาร์โค้ดจริง
- รายการที่จับคู่สินค้าไม่ได้ หรือชื่อสถานที่เก็บไม่ตรง → **ข้าม** และรายงานให้เห็นก่อนยืนยัน ไม่เดาเอง
- ไฟล์ catalog ที่ส่งออกให้ BillKeep (`format: "stockkeep-catalog"`) ส่งเฉพาะ **ราคาขายหน้าร้าน (RETAIL)**
  ไม่ส่งต้นทุน/ราคาช่าง/ราคาส่ง — คงกติกาการกรองราคาตาม role ไว้

---

## 9. ถ้าจะเขียนโปรแกรมอื่นมาเชื่อมอีก — ข้อควรรู้

โปรแกรมใหม่จะ "relate" กับ StockKeep ผ่านฐานข้อมูล SQLite เดียวกันนี้ (`schema.sql` คือโครงสร้าง)

**ถ้าโปรแกรมใหม่จะอ่าน/เขียนฐานข้อมูลของ StockKeep:**
- ไฟล์อยู่ที่ `%APPDATA%\stockkeep\stockkeep.db`, เปิดด้วย `PRAGMA foreign_keys = ON`
- DB เป็น WAL mode + **single-writer**: เปิด **read-only** จากโปรแกรมใหม่ได้ปลอดภัยขณะ StockKeep รันอยู่ แต่ **ห้ามเขียนพร้อมกันสองโปรเซส** (SQLite เขียนได้ทีละตัว จะ lock/พังได้) — ถ้าต้องเขียน ให้ประสานงานหรือใช้สถาปัตยกรรม API แม่ข่าย (ดู `docs/NETWORK-PLAN.md`)
- สต๊อกคงเหลืออ่านจาก view `current_stock` (ต่อสินค้าต่อสถานที่, หน่วยฐาน) — อย่าคำนวณเองผิดวิธี
- ถ้าจะเพิ่มข้อมูลสต๊อก ต้อง insert `stock_movements` (ห้าม UPDATE ยอด) เพื่อไม่ให้ ledger เพี้ยน
- ราคา/ต้นทุน: ถ้าโปรแกรมใหม่มีเรื่องสิทธิ์ ให้ยึดกติกา `min_role_level` ของ `price_tiers` เหมือนกัน

**แผนหลายเครื่อง (shared DB):** ยังไม่ทำ — รายละเอียด/ความเสี่ยงอยู่ใน `docs/NETWORK-PLAN.md`
(สรุป: ห้ามแชร์ไฟล์ .db ผ่าน network folder เด็ดขาด, ให้ทำ API แม่ข่ายแทน)
