import { $, esc } from '../format'
import { showToast, toastError } from '../ui'
import type { BillBatchPreview } from '../../../shared/types'

let pending: BillBatchPreview | null = null
let refreshAfterImport: () => Promise<void> = async () => {}

function fmtDateTime(value: string | null): string {
  if (!value) return '-'
  const [d, t] = value.split(/[ T]/)
  return `${d ?? ''} ${t ? t.slice(0, 5) : ''}`.trim()
}

function renderPreview(): void {
  const box = $('batch-preview')
  if (!pending) {
    box.style.display = 'none'
    $('batch-empty').style.display = 'block'
    return
  }
  const p = pending
  $('batch-empty').style.display = 'none'
  box.style.display = 'block'

  const newToCreate = p.newProducts.filter((n) => !n.exists)
  const blocked = !!p.alreadyImported || p.resolvedCount === 0

  box.innerHTML = `
    <div class="kpi-row" style="margin-bottom:16px;">
      <div class="kpi-card"><div class="kpi-label">รายการที่จะตัดสต๊อก</div><div class="kpi-value">${p.resolvedCount}</div><div class="kpi-sub">จากทั้งหมด ${p.issueCount} รายการ</div></div>
      <div class="kpi-card${p.unresolvedCount ? ' alert-warn' : ''}"><div class="kpi-label">จับคู่สินค้าไม่ได้</div><div class="kpi-value">${p.unresolvedCount}</div><div class="kpi-sub">จะข้ามไป</div></div>
      <div class="kpi-card"><div class="kpi-label">สินค้าใหม่ที่จะสร้าง</div><div class="kpi-value">${newToCreate.length}</div><div class="kpi-sub">บาร์โค้ดเว้นไว้ก่อน</div></div>
      <div class="kpi-card"><div class="kpi-label">จำนวนรวม (หน่วยฐาน)</div><div class="kpi-value">${p.totalQty.toLocaleString('th-TH')}</div></div>
    </div>

    <div class="field-hint" style="margin-bottom:14px;line-height:1.8;">
      <b>ไฟล์:</b> <span class="mono">${esc(p.filePath)}</span><br>
      <b>รหัสชุดข้อมูล:</b> <span class="mono">${esc(p.batchId)}</span> · <b>วันที่ปิดการขาย:</b> ${esc(p.closeDate ?? '-')}
      ${p.note ? `<br><b>หมายเหตุ:</b> ${esc(p.note)}` : ''}
    </div>

    ${
      p.alreadyImported
        ? `<div class="alert-banner danger"><i class="ti ti-alert-triangle alert-icon"></i>
             <div class="alert-text">ไฟล์ชุดนี้เคยนำเข้าไปแล้วเมื่อ <b>${esc(fmtDateTime(p.alreadyImported))}</b> — นำเข้าซ้ำไม่ได้ เพื่อไม่ให้สต๊อกถูกตัดสองรอบ</div></div>`
        : ''
    }

    ${
      newToCreate.length
        ? `<div class="panel" style="margin-bottom:14px;">
             <div class="panel-head"><h2>สินค้าใหม่ที่จะถูกสร้าง</h2><span class="panel-head-sub">ได้รหัสชั่วคราว TMP-xxxxxx และติดธง "รอใส่บาร์โค้ด"</span></div>
             <div class="table-scroll"><table>
               <thead><tr><th>ชื่อสินค้า</th><th>หน่วยฐาน</th></tr></thead>
               <tbody>${newToCreate.map((n) => `<tr><td>${esc(n.description)}</td><td>${esc(n.baseUnit)}</td></tr>`).join('')}</tbody>
             </table></div>
           </div>`
        : ''
    }

    ${
      p.problems.length
        ? `<div class="panel" style="margin-bottom:14px;">
             <div class="panel-head"><h2>รายการที่จะถูกข้าม</h2><span class="panel-head-sub">แสดงสูงสุด 30 รายการ</span></div>
             <div style="padding:14px 18px;font-size:12.5px;line-height:1.8;color:var(--text-secondary);">
               ${p.problems.map((t) => `• ${esc(t)}`).join('<br>')}
             </div>
           </div>`
        : ''
    }

    <div style="display:flex;justify-content:flex-end;gap:8px;">
      <button class="btn" id="btn-cancel-batch">ยกเลิก</button>
      <button class="btn primary" id="btn-apply-batch"${blocked ? ' disabled' : ''}><i class="ti ti-check"></i>ยืนยันนำเข้าและตัดสต๊อก</button>
    </div>`

  $('btn-cancel-batch').addEventListener('click', () => {
    pending = null
    renderPreview()
  })
  $('btn-apply-batch').addEventListener('click', () => void applyBatch())
}

async function applyBatch(): Promise<void> {
  if (!pending) return
  const p = pending
  if (
    !confirm(
      `ยืนยันนำเข้า?\n\n• ตัดสต๊อก ${p.resolvedCount} รายการ\n• ข้าม ${p.unresolvedCount} รายการ\n• สร้างสินค้าใหม่ ${p.newProducts.filter((n) => !n.exists).length} รายการ\n\nการตัดสต๊อกจะถูกบันทึกเป็นการเคลื่อนไหวแบบ ISSUE (ย้อนดูได้ในประวัติสต๊อก)`
    )
  ) {
    return
  }
  try {
    const res = await window.api.exchange.apply(p.filePath)
    pending = null
    renderPreview()
    await renderImportHistory()
    await refreshAfterImport()
    showToast(`นำเข้าเรียบร้อย — ตัดสต๊อก ${res.imported} รายการ, สร้างสินค้าใหม่ ${res.created} รายการ, ข้าม ${res.skipped} รายการ`)
  } catch (err) {
    toastError(err)
  }
}

export async function renderImportHistory(): Promise<void> {
  try {
    const rows = await window.api.exchange.history()
    $('imports-body').innerHTML = rows.length
      ? rows
          .map(
            (r) => `<tr>
              <td>${esc(fmtDateTime(r.importedAt))}</td>
              <td>${esc(r.closeDate ?? '-')}</td>
              <td class="num">${r.issueCount}</td>
              <td class="num">${r.skippedCount}</td>
              <td class="num">${r.newProductCount}</td>
              <td class="num">${r.totalQty.toLocaleString('th-TH')}</td>
              <td>${esc(r.userName ?? '-')}</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="7"><div class="empty-state"><i class="ti ti-file-off"></i>ยังไม่เคยนำเข้าไฟล์จากระบบบิล</div></td></tr>`
  } catch (err) {
    toastError(err)
  }
}

export function initExchange(refresh: () => Promise<void>): void {
  refreshAfterImport = refresh

  $('btn-pick-batch').addEventListener('click', async () => {
    try {
      const res = await window.api.exchange.pickBatch()
      if (res.canceled || !res.preview) return
      pending = res.preview
      renderPreview()
    } catch (err) {
      toastError(err)
    }
  })

  $('btn-export-catalog').addEventListener('click', async () => {
    try {
      const res = await window.api.exchange.exportCatalog()
      if (!res.canceled) showToast(`ส่งออกรายการสินค้าไปที่ ${res.path}`)
    } catch (err) {
      toastError(err)
    }
  })
}
