import type { MovementView, StocktakeLineView, StocktakeSessionView } from '../../../shared/types'
import { $, esc, input } from '../format'
import { savePdf } from '../print'
import { showToast, toastError } from '../ui'

const TYPE_LABELS: Record<string, string> = {
  OPENING: 'สต๊อกตั้งต้น',
  RECEIVE: 'รับของ',
  ADJUST: 'ปรับสต๊อก',
  ISSUE: 'จ่ายออก',
  TRANSFER_IN: 'โอนเข้า',
  TRANSFER_OUT: 'โอนออก'
}

let activeTab: 'sessions' | 'movements' = 'sessions'

// ---------- shared time formatting ----------

// created_at is stored as UTC ('YYYY-MM-DD HH:MM:SS'); show it in local time.
function fmtSystemTime(raw: string): string {
  const d = new Date(raw.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return raw
  return d.toLocaleString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// The person's count time — from the date + time fields they entered.
function fmtCountTime(dateStr: string | null, timeStr: string | null): string {
  if (!dateStr) return '-'
  const d = new Date(dateStr + 'T00:00:00')
  const ds = isNaN(d.getTime())
    ? dateStr
    : d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' })
  return timeStr ? `${ds} ${timeStr} น.` : ds
}

// ---------- count rounds (sessions) ----------

let sessions: StocktakeSessionView[] = []

function renderSessions(): void {
  $('sessions-body').innerHTML =
    sessions
      .map((s) => {
        const doc =
          s.isQuick || !s.docNumber
            ? '<span class="badge muted">ปรับด่วน</span>'
            : `<span class="mono">${esc(s.docNumber)}</span>`
        const changed =
          s.adjustedCount > 0
            ? `<span style="color:var(--warn);font-weight:600;">${s.adjustedCount}</span>`
            : '0'
        return `<tr>
        <td style="white-space:nowrap;">${esc(fmtCountTime(s.countDate, s.countTime))}</td>
        <td style="white-space:nowrap;">${esc(fmtSystemTime(s.createdAt))}</td>
        <td>${doc}</td>
        <td>${esc(s.locationName)}</td>
        <td>${esc(s.category ?? 'ทั้งหมด')}</td>
        <td class="num">${s.countedCount}</td>
        <td class="num">${changed}</td>
        <td>${s.counterName ? esc(s.counterName) : '<span style="color:var(--text-secondary);">—</span>'}</td>
        <td>${esc(s.userName ?? '—')}</td>
        <td><button class="btn small btn-view-session" data-id="${s.id}"><i class="ti ti-list-details"></i>ดูรายการ</button></td>
      </tr>`
      })
      .join('') ||
    `<tr><td colspan="10"><div class="empty-state"><i class="ti ti-clipboard-list"></i>ยังไม่มีรอบการตรวจนับที่บันทึกไว้</div></td></tr>`

  document.querySelectorAll<HTMLButtonElement>('.btn-view-session').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = sessions.find((x) => x.id === Number(btn.dataset.id))
      if (s) void openSessionDetail(s)
    })
  })

  $('sessions-result-count').textContent = `แสดง ${sessions.length} รอบล่าสุด`
}

async function openSessionDetail(s: StocktakeSessionView): Promise<void> {
  let lines
  try {
    lines = await window.api.history.sessionLines(s.id)
  } catch (err) {
    toastError(err)
    return
  }

  const docText = s.isQuick || !s.docNumber ? 'ปรับด่วน (ไม่มีเลขที่เอกสาร)' : s.docNumber
  $('session-detail-meta').innerHTML =
    `เอกสาร: <b>${esc(docText)}</b> · สถานที่: <b>${esc(s.locationName)}</b> · หมวดหมู่: <b>${esc(s.category ?? 'ทั้งหมด')}</b><br>` +
    `เวลาที่นับ (คนตรวจ): <b>${esc(fmtCountTime(s.countDate, s.countTime))}</b> · บันทึกเข้าระบบ: <b>${esc(fmtSystemTime(s.createdAt))}</b><br>` +
    `ผู้นับ: <b>${esc(s.counterName ?? '—')}</b> · ผู้บันทึกเข้าระบบ: <b>${esc(s.userName ?? '—')}</b>` +
    (s.note ? `<br>หมายเหตุ: ${esc(s.note)}` : '')

  currentLines = lines
  currentSession = s
  renderDetailTable()
  $('session-detail-modal').classList.add('active')
}

function closeSessionDetail(): void {
  if (editing) setEditing(false)
  $('session-detail-modal').classList.remove('active')
}

// ---------- full ledger (movements) ----------

let movements: MovementView[] = []
let typeFilter = 'ALL'
let searchText = ''

function renderTypeChips(): void {
  const types = ['ALL', ...Object.keys(TYPE_LABELS)]
  $('history-type-chips').innerHTML = types
    .map((t) => {
      const label = t === 'ALL' ? 'ทั้งหมด' : TYPE_LABELS[t]
      return `<button type="button" class="chip${typeFilter === t ? ' active' : ''}" data-type="${t}">${label}</button>`
    })
    .join('')
  document.querySelectorAll<HTMLButtonElement>('#history-type-chips .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      typeFilter = btn.dataset.type as string
      renderTypeChips()
      renderMovements()
    })
  })
}

function renderMovements(): void {
  const q = searchText.trim().toLowerCase()
  const list = movements.filter((m) => {
    if (typeFilter !== 'ALL' && m.movementType !== typeFilter) return false
    if (
      q &&
      !m.barcode.toLowerCase().includes(q) &&
      !m.description.toLowerCase().includes(q) &&
      !(m.note ?? '').toLowerCase().includes(q)
    )
      return false
    return true
  })

  $('history-body').innerHTML =
    list
      .map((m) => {
        const positive = m.qtyChange > 0
        const color = positive ? 'var(--ok)' : m.qtyChange < 0 ? 'var(--danger)' : 'var(--text-secondary)'
        const sign = positive ? '+' : ''
        const label = TYPE_LABELS[m.movementType] ?? m.movementType
        return `<tr>
        <td style="white-space:nowrap;">${esc(fmtSystemTime(m.createdAt))}</td>
        <td class="mono">${esc(m.barcode)}</td>
        <td>${esc(m.description)}</td>
        <td>${esc(m.locationName)}</td>
        <td><span class="badge muted">${esc(label)}</span></td>
        <td class="num" style="color:${color};font-weight:600;">${sign}${m.qtyChange} ${esc(m.baseUnit ?? '')}</td>
        <td class="mono">${m.reference ? esc(m.reference) : '<span style="color:var(--text-secondary);">—</span>'}</td>
        <td>${m.note ? esc(m.note) : '<span style="color:var(--text-secondary);">—</span>'}</td>
        <td>${m.userName ? esc(m.userName) : '<span style="color:var(--text-secondary);">—</span>'}</td>
      </tr>`
      })
      .join('') ||
    `<tr><td colspan="9"><div class="empty-state"><i class="ti ti-history"></i>ยังไม่มีประวัติการเคลื่อนไหวสต๊อกตามตัวกรองที่เลือก</div></td></tr>`

  $('history-result-count').textContent = `แสดง ${list.length} จาก ${movements.length} รายการ`
}

// ---------- tabs + load ----------

function switchTab(tab: 'sessions' | 'movements'): void {
  activeTab = tab
  document.querySelectorAll<HTMLButtonElement>('.history-tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab)
  )
  $('history-sessions-tab').style.display = tab === 'sessions' ? '' : 'none'
  $('history-movements-tab').style.display = tab === 'movements' ? '' : 'none'
}

export async function renderHistory(): Promise<void> {
  try {
    ;[sessions, movements] = await Promise.all([window.api.history.sessions(), window.api.history.list()])
  } catch {
    sessions = []
    movements = []
  }
  renderSessions()
  renderTypeChips()
  renderMovements()
}

export function initHistory(): void {
  document.querySelectorAll<HTMLButtonElement>('.history-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab as 'sessions' | 'movements'))
  })
  input('history-search').addEventListener('input', (e) => {
    searchText = (e.target as HTMLInputElement).value
    renderMovements()
  })
  document.querySelectorAll<HTMLButtonElement>('#session-view-toggle .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      if (editing) return // switching views mid-edit would discard the typing
      detailView = (b.dataset.view as 'grid' | 'list') ?? 'grid'
      syncViewToggle()
      renderDetailTable()
    })
  )
  $('btn-session-edit').addEventListener('click', () => setEditing(true))
  $('btn-session-cancel-edit').addEventListener('click', () => setEditing(false))
  $('btn-session-save').addEventListener('click', () => void saveAmendment())
  $('btn-session-pdf').addEventListener('click', () => void exportSessionPdf())

  $('btn-close-session-detail').addEventListener('click', closeSessionDetail)
  $('btn-close-session-detail-2').addEventListener('click', closeSessionDetail)
  $('session-detail-modal').addEventListener('click', (e) => {
    if (e.target === $('session-detail-modal')) closeSessionDetail()
  })
  switchTab('sessions')
}


/* ---------- session detail: grid view, editing, PDF ---------- */

// Counting is keyed คลัง and หน้าร้าน together, so reviewing a round shows them
// together too. The flat list is kept as a second view because it is the only
// one that can show per-line notes and goods-in without getting very wide.
let currentLines: StocktakeLineView[] = []
let currentSession: StocktakeSessionView | null = null
let detailView: 'grid' | 'list' = 'grid'
let editing = false

interface PivotRow {
  productId: number
  barcode: string
  description: string
  baseUnit: string
  byLoc: Record<string, StocktakeLineView>
  // The count screen writes note / goods-in once per product (it applies them
  // to every location), so they belong on the row, not inside a location cell.
  // Collected as distinct values in case an older round stored them per line.
  notes: string[]
  received: string[]
}

function pivot(lines: StocktakeLineView[]): { locs: string[]; rows: PivotRow[] } {
  const locs = [...new Set(lines.map((l) => l.locationName ?? '—'))]
  const map = new Map<number, PivotRow>()
  for (const l of lines) {
    let row = map.get(l.productId)
    if (!row) {
      row = {
        productId: l.productId,
        barcode: l.barcode,
        description: l.description,
        baseUnit: l.baseUnit ?? '',
        byLoc: {},
        notes: [],
        received: []
      }
      map.set(l.productId, row)
    }
    row.byLoc[l.locationName ?? '—'] = l
    const note = (l.note ?? '').trim()
    if (note && !row.notes.includes(note)) row.notes.push(note)
    if (l.hasReceived) {
      const txt = `มีของเข้า${l.receivedQty ? ` ${l.receivedQty}` : ''}${l.receivedDate ? ` (${l.receivedDate})` : ''}`
      if (!row.received.includes(txt)) row.received.push(txt)
    }
  }
  return { locs, rows: [...map.values()] }
}

// The tally exactly as it was written down. Falls back to the plain total for
// rounds recorded before this was stored, so old history still reads sensibly.
function countedText(ln: StocktakeLineView): string {
  if (ln.countedParts) {
    try {
      const parts = JSON.parse(ln.countedParts) as { unit: string; qty: number }[]
      const shown = parts.filter((p) => p.qty)
      if (shown.length) return shown.map((p) => `${p.qty} ${p.unit}`).join(' + ')
      return `0 ${parts[parts.length - 1]?.unit ?? ''}`
    } catch {
      // Malformed JSON should never hide the number that matters.
    }
  }
  return `${ln.countedQty}${ln.baseUnit ? ' ' + ln.baseUnit : ''}`
}

function diffBadge(diff: number, unit: string): string {
  if (diff === 0) return '<span class="badge ok">ตรงกัน</span>'
  return diff < 0
    ? `<span class="badge danger">ขาด ${Math.abs(diff)} ${esc(unit)}</span>`
    : `<span class="badge warn">เกิน ${diff} ${esc(unit)}</span>`
}

function renderDetailTable(): void {
  const wrap = $('session-detail-wrap')
  if (detailView === 'list') {
    wrap.innerHTML = `<table>
      <thead><tr><th>บาร์โค้ด</th><th>สินค้า</th><th>สถานที่</th><th class="num">ในระบบ</th><th class="num">นับได้จริง</th><th>ผลต่าง</th><th>ของเข้า</th><th>หมายเหตุ</th></tr></thead>
      <tbody>${
        currentLines
          .map((ln) => {
            const unit = esc(ln.baseUnit ?? '')
            const received = ln.hasReceived
              ? `<span class="badge warn">มีของเข้า${ln.receivedQty ? ` ${ln.receivedQty}` : ''}${ln.receivedDate ? ` (${esc(ln.receivedDate)})` : ''}</span>`
              : '<span class="text-muted">—</span>'
            return `<tr>
              <td class="mono">${esc(ln.barcode)}</td><td>${esc(ln.description)}</td>
              <td>${esc(ln.locationName ?? '—')}</td>
              <td class="num">${ln.systemQty} ${unit}</td>
              <td class="num">${esc(countedText(ln))}</td>
              <td>${diffBadge(ln.diff, ln.baseUnit ?? '')}</td>
              <td>${received}</td>
              <td>${ln.note ? esc(ln.note) : '<span class="text-muted">—</span>'}</td>
            </tr>`
          })
          .join('') || `<tr><td colspan="8"><div class="empty-state"><i class="ti ti-list"></i>ไม่มีรายการในรอบนี้</div></td></tr>`
      }</tbody></table>`
    return
  }

  const { locs, rows } = pivot(currentLines)
  const head =
    `<tr><th rowspan="2">บาร์โค้ด</th><th rowspan="2">สินค้า</th>` +
    locs.map((l) => `<th class="loc-group" colspan="3">${esc(l)}</th>`).join('') +
    `<th rowspan="2" class="num">รวมนับได้</th><th rowspan="2">ของเข้า</th><th rowspan="2">หมายเหตุ</th></tr><tr>` +
    locs.map(() => `<th class="num loc-first">ในระบบ</th><th class="num">นับได้</th><th>ผลต่าง</th>`).join('') +
    `</tr>`

  const body =
    rows
      .map((r) => {
        let total = 0
        const cells = locs
          .map((loc) => {
            const ln = r.byLoc[loc]
            if (!ln) return `<td class="loc-first">—</td><td>—</td><td>—</td>`
            total += ln.countedQty
            const counted = editing
              ? `<input type="number" class="sd-edit" data-line="${ln.lineId}" value="${ln.countedQty}">`
              : esc(countedText(ln))
            return `<td class="num loc-first">${ln.systemQty}</td><td class="num">${counted}</td><td>${diffBadge(ln.diff, r.baseUnit)}</td>`
          })
          .join('')
        const recv = r.received.length
          ? r.received.map((t) => `<span class="badge warn">${esc(t)}</span>`).join(' ')
          : '<span class="text-muted">—</span>'
        const note = r.notes.length ? esc(r.notes.join(' · ')) : '<span class="text-muted">—</span>'
        return `<tr><td class="mono">${esc(r.barcode)}</td><td>${esc(r.description)}</td>${cells}<td class="num"><b>${total}</b> ${esc(r.baseUnit)}</td><td>${recv}</td><td>${note}</td></tr>`
      })
      .join('') ||
    `<tr><td colspan="${2 + locs.length * 3 + 3}"><div class="empty-state"><i class="ti ti-list"></i>ไม่มีรายการในรอบนี้</div></td></tr>`

  wrap.innerHTML = `<table class="sd-grid"><thead>${head}</thead><tbody>${body}</tbody></table>`
}

function setEditing(on: boolean): void {
  editing = on
  $('btn-session-edit').style.display = on ? 'none' : ''
  $('btn-session-pdf').style.display = on ? 'none' : ''
  $('btn-session-save').style.display = on ? '' : 'none'
  $('btn-session-cancel-edit').style.display = on ? '' : 'none'
  if (on) detailView = 'grid'
  syncViewToggle()
  renderDetailTable()
}

function syncViewToggle(): void {
  document.querySelectorAll<HTMLButtonElement>('#session-view-toggle .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === detailView)
  )
}

async function saveAmendment(): Promise<void> {
  if (!currentSession) return
  const edits = [...document.querySelectorAll<HTMLInputElement>('.sd-edit')].map((el) => ({
    lineId: Number(el.dataset.line),
    countedQty: parseFloat(el.value) || 0
  }))
  try {
    const res = await window.api.history.amendSession({
      sessionId: currentSession.id,
      note: '',
      lines: edits
    })
    setEditing(false)
    closeSessionDetail()
    await renderHistory()
    showToast(`บันทึกการแก้ไข ${res.changed} รายการแล้ว — ระบบสร้างรอบใหม่และลงรายการปรับตามส่วนต่าง`)
  } catch (err) {
    toastError(err)
  }
}

async function exportSessionPdf(): Promise<void> {
  if (!currentSession) return
  const s = currentSession
  const { locs, rows } = pivot(currentLines)
  const head =
    `<tr><th rowspan="2">บาร์โค้ด</th><th rowspan="2">สินค้า</th>` +
    locs.map((l) => `<th colspan="3">${esc(l)}</th>`).join('') +
    `<th rowspan="2">รวมนับได้</th><th rowspan="2">ของเข้า</th><th rowspan="2">หมายเหตุ</th></tr><tr>` +
    locs.map(() => `<th>ในระบบ</th><th>นับได้</th><th>ผลต่าง</th>`).join('') +
    `</tr>`
  const body = rows
    .map((r) => {
      let total = 0
      const cells = locs
        .map((loc) => {
          const ln = r.byLoc[loc]
          if (!ln) return `<td>—</td><td>—</td><td>—</td>`
          total += ln.countedQty
          return `<td class="n">${ln.systemQty}</td><td class="n">${esc(countedText(ln))}</td><td class="n">${ln.diff === 0 ? '—' : ln.diff > 0 ? '+' + ln.diff : ln.diff}</td>`
        })
        .join('')
      return `<tr><td>${esc(r.barcode)}</td><td>${esc(r.description)}</td>${cells}<td class="n">${total} ${esc(r.baseUnit)}</td><td>${esc(r.received.join(' · ') || '—')}</td><td>${esc(r.notes.join(' · ') || '—')}</td></tr>`
    })
    .join('')

  $('history-print-area').innerHTML = `<div class="hp-sheet">
    <h1>บันทึกผลการตรวจนับสต๊อก</h1>
    <div class="hp-meta">
      เลขที่เอกสาร: <b>${esc(s.docNumber ?? '(ปรับด่วน — ไม่มีเลขที่)')}</b><br>
      วันที่นับ: <b>${esc(fmtCountTime(s.countDate, s.countTime))}</b> · บันทึกเข้าระบบ: <b>${esc(fmtSystemTime(s.createdAt))}</b><br>
      ผู้นับ: <b>${esc(s.counterName ?? '—')}</b> · ผู้บันทึก: <b>${esc(s.userName ?? '—')}</b><br>
      นับทั้งหมด <b>${currentLines.length}</b> รายการ · มีผลต่าง <b>${currentLines.filter((l) => l.diff !== 0).length}</b> รายการ
      ${s.amendsSessionId ? '<br><b>รอบนี้เป็นการแก้ไขรอบก่อนหน้า</b>' : ''}
    </div>
    <table class="hp-table"><thead>${head}</thead><tbody>${body}</tbody></table>
  </div>`

  try {
    const res = await savePdf({
      bodyClass: 'printing-history',
      pageCss: '@media print{@page{size:A4 landscape;margin:10mm;}}',
      landscape: true,
      defaultFileName: `ตรวจนับ-${s.docNumber ?? s.id}.pdf`
    })
    if (res.ok) showToast('บันทึกไฟล์ PDF แล้ว')
  } catch (err) {
    toastError(err)
  } finally {
    $('history-print-area').innerHTML = ''
  }
}
