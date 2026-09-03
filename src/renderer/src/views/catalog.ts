import type { CatalogPreview } from '../../../shared/types'
import { $, esc } from '../format'
import { showToast, toastError } from '../ui'

// นำเข้ารายการสินค้าจากไฟล์ Excel ของ 4POS — เลือกไฟล์ ดูสรุปก่อน แล้วค่อยยืนยัน
// รูปแบบเดียวกับหน้า "เชื่อมระบบบิล" เพราะพิสูจน์แล้วว่าใช้งานเข้าใจง่าย
let pending: CatalogPreview | null = null
let refreshAfterImport: () => Promise<void> = async () => {}

function fmtDateTime(value: string | null): string {
  if (!value) return '-'
  // created_at เก็บเป็น UTC — แสดงเป็นเวลาเครื่อง
  const d = new Date(String(value).replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return String(value)
  return d.toLocaleString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function renderPreview(): void {
  const box = $('catalog-preview')
  if (!pending) {
    box.style.display = 'none'
    $('catalog-file-name').textContent = ''
    return
  }
  const p = pending
  box.style.display = 'block'
  $('catalog-file-name').textContent = p.fileName

  const nothingToAdd = p.addedCount === 0

  box.innerHTML = `
    <div class="kpi-row" style="margin-bottom:14px;">
      <div class="kpi-card"><div class="kpi-label">รายการในไฟล์</div><div class="kpi-value">${p.rowCount.toLocaleString('th-TH')}</div></div>
      <div class="kpi-card${p.addedCount ? ' alert-warn' : ''}"><div class="kpi-label">จะเพิ่มใหม่</div><div class="kpi-value">${p.addedCount.toLocaleString('th-TH')}</div><div class="kpi-sub">บาร์โค้ดที่ยังไม่มีในระบบ</div></div>
      <div class="kpi-card"><div class="kpi-label">มีอยู่แล้ว</div><div class="kpi-value">${p.existingCount.toLocaleString('th-TH')}</div><div class="kpi-sub">ชื่อ/ราคาไม่ถูกแตะ</div></div>
      <div class="kpi-card"><div class="kpi-label">หมวดหมู่ / หน่วย ใหม่</div><div class="kpi-value">${p.newCategories.length} / ${p.newUnits.length}</div></div>
    </div>

    ${
      p.lastImportedAt
        ? `<div class="field-hint" style="margin:0 0 12px;">เคยนำเข้าครั้งล่าสุดเมื่อ <b>${esc(fmtDateTime(p.lastImportedAt))}</b></div>`
        : ''
    }

    ${
      nothingToAdd
        ? `<div class="alert-banner"><i class="ti ti-circle-check alert-icon"></i>
             <div class="alert-text">ทุกบาร์โค้ดในไฟล์นี้มีอยู่ในระบบแล้ว &mdash; ไม่มีสินค้าใหม่ให้เพิ่ม${
               p.withStockCount ? ' (ยังนำเข้ายอดคงเหลืออย่างเดียวได้)' : ''
             }</div></div>`
        : ''
    }

    ${
      p.problems.length
        ? `<div class="alert-banner warn"><i class="ti ti-alert-circle alert-icon"></i>
             <div class="alert-text">${p.problems.map((t) => esc(t)).join('<br>')}</div></div>`
        : ''
    }

    ${
      p.newCategories.length
        ? `<div class="field-hint" style="margin:12px 0 0;"><b>หมวดหมู่ใหม่ที่จะถูกสร้าง:</b> ${p.newCategories.map((c) => esc(c)).join(' &middot; ')}</div>`
        : ''
    }
    ${
      p.newUnits.length
        ? `<div class="field-hint" style="margin:6px 0 0;"><b>หน่วยใหม่ที่จะถูกสร้าง:</b> ${p.newUnits.map((c) => esc(c)).join(' &middot; ')}</div>`
        : ''
    }

    ${
      p.matches.length
        ? `<div class="panel" style="margin:16px 0 0;">
             <div class="panel-head"><h2>บาร์โค้ดที่ตรงกับของเดิม (${p.existingCount.toLocaleString('th-TH')})</h2>
               <span class="panel-head-sub">ชื่อ/ราคาของเดิมไม่ถูกแตะ &mdash; แต่ถ้าเลือกนำเข้ายอด ยอดคงเหลือจะถูกทับ</span></div>
             <div style="padding:10px 18px 0;" class="field-hint">
               บาร์โค้ดตรงกันไม่ได้แปลว่าเป็นสินค้าตัวเดียวกันเสมอ โดยเฉพาะรหัสสั้นๆ ที่เคยคีย์มือไว้
               &mdash; ถ้าเจอคู่ที่ชื่อคนละเรื่องกัน <b>ยอดของตัวนั้นจะถูกทับด้วยเลขของสินค้าคนละตัว</b>
               ให้ไปแก้บาร์โค้ดที่หน้าสินค้าก่อน แล้วค่อยนำเข้าใหม่
             </div>
             <div class="table-scroll" style="max-height:260px;overflow-y:auto;"><table>
               <thead><tr><th>บาร์โค้ด</th><th>ชื่อในระบบตอนนี้</th><th>ชื่อในไฟล์ 4POS</th></tr></thead>
               <tbody>${p.matches
                 .map(
                   (m) =>
                     `<tr><td class="mono">${esc(m.barcode)}</td><td>${esc(m.mine)}</td><td>${esc(m.theirs)}</td></tr>`
                 )
                 .join('')}</tbody>
             </table></div>
             ${
               p.existingCount > p.matches.length
                 ? `<div class="field-hint" style="padding:0 18px 12px;">แสดง ${p.matches.length} รายการแรกจากทั้งหมด ${p.existingCount.toLocaleString('th-TH')}</div>`
                 : ''
             }
           </div>`
        : ''
    }

    <label class="st-recv-chk" style="margin:16px 0 8px;display:flex;align-items:center;gap:8px;">
      <input type="checkbox" id="catalog-with-stock" style="width:auto;height:auto;margin:0;">
      นำเข้ายอดคงเหลือจาก 4POS ด้วย (${p.withStockCount.toLocaleString('th-TH')} รายการที่ยอดไม่เป็นศูนย์)
    </label>
    <div style="display:flex;align-items:center;gap:10px;margin:0 0 8px;">
      <label style="margin:0;">ลงที่</label>
      <select id="catalog-location" style="width:auto;min-width:170px;">
        ${p.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
      </select>
    </div>
    <div class="field-hint" style="margin:0 0 14px;line-height:1.7;">
      <b style="color:var(--danger);">ยอดเดิมของสถานที่นี้จะถูกทับด้วยเลขจากไฟล์</b>
      สินค้าที่เคยนับไว้แล้วจะกลายเป็นตัวเลขของ 4POS<br>
      ระบบลงเป็น<b>รายการปรับตามส่วนต่าง</b> ไม่ได้เขียนทับยอดตรงๆ จึงย้อนดูได้ในหน้าประวัติสต๊อก
      ว่าการนำเข้าครั้งนี้เปลี่ยนอะไรไปเท่าไหร่ และนำเข้าไฟล์เดิมซ้ำก็ไม่บวกทบ<br>
      สินค้าที่<b>ไม่มี</b>ในไฟล์จะไม่ถูกแตะ ยอดยังอยู่เหมือนเดิม
    </div>

    <div style="display:flex;justify-content:flex-end;gap:8px;">
      <button class="btn" id="btn-cancel-catalog">ยกเลิก</button>
      <button class="btn primary" id="btn-apply-catalog"><i class="ti ti-check"></i>ยืนยันนำเข้า</button>
    </div>`

  $('btn-cancel-catalog').addEventListener('click', () => {
    pending = null
    renderPreview()
  })
  $('btn-apply-catalog').addEventListener('click', () => void applyCatalog())
}

async function applyCatalog(): Promise<void> {
  if (!pending) return
  const p = pending
  const withStock = ($('catalog-with-stock') as HTMLInputElement).checked
  const locationId = Number(($('catalog-location') as HTMLSelectElement).value)
  const locationName = p.locations.find((l) => l.id === locationId)?.name ?? ''
  if (p.addedCount === 0 && !withStock) {
    showToast('ไม่มีอะไรให้นำเข้า — ไม่มีสินค้าใหม่ และไม่ได้เลือกนำเข้ายอดคงเหลือ', true)
    return
  }
  if (
    !confirm(
      `ยืนยันนำเข้า?\n\n` +
        `• เพิ่มสินค้าใหม่ ${p.addedCount.toLocaleString('th-TH')} รายการ\n` +
        `• ของเดิม ${p.existingCount.toLocaleString('th-TH')} รายการ จะไม่ถูกแตะ\n` +
        `• ยอดคงเหลือ: ${
          withStock ? `ตั้งยอดที่ "${locationName}" ให้เท่ากับไฟล์ (ยอดเดิมถูกทับ)` : 'ไม่นำเข้า'
        }`
    )
  ) {
    return
  }

  const btn = $('btn-apply-catalog') as HTMLButtonElement
  btn.disabled = true
  try {
    const res = await window.api.catalog.apply({ filePath: p.filePath, withStock, locationId })
    pending = null
    renderPreview()
    await renderCatalogHistory()
    await refreshAfterImport()
    showToast(
      `นำเข้าเรียบร้อย — เพิ่มสินค้าใหม่ ${res.added.toLocaleString('th-TH')} รายการ` +
        (res.stockRows ? `, ตั้งยอดที่ "${locationName}" ${res.stockRows.toLocaleString('th-TH')} รายการ` : '')
    )
  } catch (err) {
    toastError(err)
  } finally {
    btn.disabled = false
  }
}

export async function renderCatalogHistory(): Promise<void> {
  let rows
  try {
    rows = await window.api.catalog.history()
  } catch {
    return // ระดับต่ำกว่าแอดมินเรียกไม่ได้ ไม่ต้องขึ้น error
  }
  $('catalog-history-body').innerHTML =
    rows
      .map(
        (r) => `<tr>
        <td style="white-space:nowrap;">${esc(fmtDateTime(r.importedAt))}</td>
        <td>${esc(r.fileName)}</td>
        <td class="num">${r.rowCount.toLocaleString('th-TH')}</td>
        <td class="num">${r.addedCount.toLocaleString('th-TH')}</td>
        <td class="num">${r.existingCount.toLocaleString('th-TH')}</td>
        <td>${
          r.withStock
            ? `<span class="badge warn">${r.stockRows.toLocaleString('th-TH')} รายการ</span>${r.locationName ? ' → ' + esc(r.locationName) : ''}`
            : '<span class="text-muted">ไม่ได้นำเข้า</span>'
        }</td>
        <td>${esc(r.userName ?? '—')}</td>
      </tr>`
      )
      .join('') ||
    `<tr><td colspan="7"><div class="empty-state"><i class="ti ti-file-off"></i>ยังไม่เคยนำเข้าไฟล์จากระบบเดิม</div></td></tr>`
}

export function initCatalog(refresh: () => Promise<void>): void {
  refreshAfterImport = refresh

  $('btn-pick-catalog').addEventListener('click', async () => {
    try {
      const res = await window.api.catalog.pickFile()
      if (res.canceled || !res.preview) return
      pending = res.preview
      renderPreview()
    } catch (err) {
      toastError(err)
    }
  })
}
