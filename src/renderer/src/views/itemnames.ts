// ขายหน้าร้าน — จัดชื่อสินค้าในบิล (v1.6.16)
//
// Bill lines typed by hand end up under many spellings. This page walks the
// owner through them, most-sold first: each card is one name with the ways it
// was typed, and three possible answers —
//   1. it is this stock product,
//   2. it is this sale item (an agreed name for something not stock-counted),
//   3. make it a new sale item under the correct name.
// The matching only suggests; nothing is changed until "ยืนยัน" is pressed, and
// the second tab can rename or undo any decision. Amounts never change.

import { $, esc, input } from '../format'
import { promptModal, showToast, toastError } from '../ui'
import { refreshItemIndex, searchItems } from '../itemSearch'
import type { NamedItem, NameGroup, NamePage, NameTarget } from '../../../shared/types'
import { money, thaiDate } from './salesCommon'

const PAGE = 15

let tab: 'pending' | 'done' = 'pending'
let page: NamePage | null = null
let offset = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined
let doneItems: NamedItem[] = []
// A product picked through "ค้นหาสินค้าอื่น" on a card: group key -> product.
const found = new Map<string, { id: number; name: string; barcode: string }>()

/* ---------- pending ---------- */

function progress(p: NamePage): void {
  const all = p.pendingLines + p.doneLines
  const pct = all ? Math.round((p.doneLines / all) * 100) : 100
  $('nm-progress-text').innerHTML = p.pendingNames
    ? `เหลือ <b>${p.pendingNames.toLocaleString('th-TH')}</b> ชื่อที่ยังไม่ได้จัด (${p.pendingLines.toLocaleString('th-TH')} บรรทัดในบิล) · จัดแล้ว <b>${p.doneLines.toLocaleString('th-TH')}</b> บรรทัด (${pct}%)`
    : 'จัดครบทุกชื่อแล้ว'
  ;($('nm-progress-bar') as HTMLElement).style.width = `${pct}%`
}

function meta(g: NameGroup): string {
  const parts = [`ขาย ${g.lines} ครั้ง`, `${g.bills} บิล`]
  if (g.units) parts.push(`หน่วย ${esc(g.units)}`)
  if (g.priceHigh > 0) parts.push(g.priceLow === g.priceHigh ? `ราคา ${money(g.priceHigh)}` : `ราคา ${money(g.priceLow)} – ${money(g.priceHigh)}`)
  if (g.lastSold) parts.push(`ล่าสุด ${thaiDate(g.lastSold)}`)
  return parts.join(' · ')
}

function cardHtml(g: NameGroup, i: number): string {
  const spellings = g.spellings
    .map(
      (s, k) => `<label class="nm-sp${s.same ? '' : ' maybe'}"><input type="checkbox" data-sp="${k}"${s.same ? ' checked' : ''}>
        ${esc(s.name)} <small>${s.lines} ครั้ง</small>${s.same ? '' : '<em>คล้าย — ติ๊กถ้าใช่ตัวเดียวกัน</em>'}</label>`
    )
    .join('')

  // Preselect a suggestion only when it is near-certain; otherwise default to
  // "new sale item" — a wrong automatic link is worse than one more click.
  const top = g.suggestions[0]
  const sure = !!top?.sure
  const sugg = g.suggestions
    .map(
      (s, k) => `<label class="nm-choice"><input type="radio" name="nm-c-${i}" value="s${k}"${sure && k === 0 ? ' checked' : ''}>
        <span class="nm-kind${s.kind === 'saleItem' ? ' sale' : ''}">${s.kind === 'saleItem' ? 'ชื่อขาย' : 'ในสต๊อก'}</span>
        <span class="nm-cname">${esc(s.name)}${s.barcode ? ` <span class="nm-cbar mono">${esc(s.barcode)}</span>` : ''}</span>
        <span class="nm-score">คล้าย ${Math.round(s.score * 100)}%</span></label>`
    )
    .join('')
  const picked = found.get(g.key)

  return `<div class="nm-card${g.skipped ? ' skipped' : ''}" data-i="${i}">
    <div class="nm-head"><span class="nm-name">${esc(g.name)}</span><span class="nm-meta">${meta(g)}${g.skipped ? ' · <b>ข้ามไว้</b>' : ''}</span></div>

    <div class="nm-step">1. ชื่อที่พิมพ์ไว้ — ติ๊กทุกแบบที่เป็นของตัวเดียวกัน</div>
    <div class="nm-spellings">${spellings}</div>

    <div class="nm-step">2. ของชิ้นนี้คืออะไร</div>
    <div class="nm-choices">
      ${sugg}
      <label class="nm-choice"><input type="radio" name="nm-c-${i}" value="find"${picked ? ' checked' : ''}>
        <span class="nm-kind">ในสต๊อก</span>
        <div class="nm-find">
          <input type="text" class="nm-find-input" placeholder="ค้นหาสินค้าอื่นในสต๊อก — พิมพ์ชื่อหรือบาร์โค้ด" autocomplete="off" value="${picked ? esc(picked.name) : ''}">
          <div class="nm-find-list" style="display:none;"></div>
        </div></label>
      <label class="nm-choice"><input type="radio" name="nm-c-${i}" value="new"${!sure && !picked ? ' checked' : ''}>
        <span class="nm-kind sale">ชื่อขายใหม่</span>
        <div class="nm-new-fields">
          <input type="text" class="nm-new-name" value="${esc(g.name)}" title="ชื่อที่ถูกต้อง — แก้ได้" autocomplete="off">
          <input type="text" class="nm-new-unit" value="${esc(g.commonUnit)}" placeholder="หน่วย" title="หน่วยที่ขายบ่อย" autocomplete="off">
          <input type="number" class="nm-new-price" value="${g.lastPrice || ''}" placeholder="ราคา" title="ราคาล่าสุดของหน่วยนี้" step="0.01" min="0">
        </div></label>
    </div>

    <div class="nm-actions">
      <span class="nm-summary"></span>
      ${
        g.skipped
          ? '<button class="btn" data-act="unskip"><i class="ti ti-arrow-back-up"></i>เลิกข้าม</button>'
          : '<button class="btn" data-act="skip" title="ยังไม่จัดชื่อนี้ — ซ่อนไว้ก่อน">ข้าม</button>'
      }
      <button class="btn primary" data-act="apply"><i class="ti ti-check"></i>ยืนยัน</button>
    </div>
  </div>`
}

function tickedNames(card: HTMLElement, g: NameGroup): string[] {
  return [...card.querySelectorAll<HTMLInputElement>('input[data-sp]')].filter((c) => c.checked).map((c) => g.spellings[Number(c.dataset.sp)].name)
}

function summarise(card: HTMLElement, g: NameGroup): void {
  const ticked = [...card.querySelectorAll<HTMLInputElement>('input[data-sp]')].filter((c) => c.checked)
  const lines = ticked.reduce((s, c) => s + g.spellings[Number(c.dataset.sp)].lines, 0)
  card.querySelector('.nm-summary')!.textContent = ticked.length ? `จะจัด ${ticked.length} ชื่อ รวม ${lines} บรรทัดในบิล` : 'ยังไม่ได้ติ๊กชื่อ'
}

function bindCard(card: HTMLElement, g: NameGroup, i: number): void {
  summarise(card, g)
  card.querySelectorAll<HTMLInputElement>('input[data-sp]').forEach((c) => c.addEventListener('change', () => summarise(card, g)))

  const radio = (v: string): HTMLInputElement | null => card.querySelector<HTMLInputElement>(`input[name="nm-c-${i}"][value="${v}"]`)
  // Typing in a field selects its answer.
  card.querySelectorAll<HTMLInputElement>('.nm-new-fields input').forEach((el) =>
    el.addEventListener('focus', () => {
      const r = radio('new')
      if (r) r.checked = true
    })
  )

  const findInput = card.querySelector<HTMLInputElement>('.nm-find-input')!
  const findList = card.querySelector<HTMLElement>('.nm-find-list')!
  const showFound = (): void => {
    const r = radio('find')
    if (r) r.checked = true
    found.delete(g.key)
    const hits = searchItems(findInput.value, 8, { productsOnly: true })
    findList.style.display = hits.length ? '' : 'none'
    findList.innerHTML = hits
      .map((h) => (h.kind === 'product' ? `<div class="nm-find-opt" data-id="${h.p.id}"><span class="nm-cbar mono">${esc(h.p.barcode)}</span><span>${esc(h.p.description)}</span></div>` : ''))
      .join('')
    findList.querySelectorAll<HTMLElement>('.nm-find-opt').forEach((o) =>
      o.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        const h = hits.find((x) => x.kind === 'product' && x.p.id === Number(o.dataset.id))
        if (h?.kind !== 'product') return
        found.set(g.key, { id: h.p.id, name: h.p.description, barcode: h.p.barcode })
        findInput.value = h.p.description
        findList.style.display = 'none'
      })
    )
  }
  findInput.addEventListener('input', showFound)
  findInput.addEventListener('focus', () => {
    if (findInput.value.trim() && !found.has(g.key)) showFound()
  })
  findInput.addEventListener('blur', () => setTimeout(() => (findList.style.display = 'none'), 150))

  card.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.act === 'apply') void applyCard(card, g, i)
      else void skipCard(g, b.dataset.act === 'skip')
    })
  )
}

function targetOf(card: HTMLElement, g: NameGroup, i: number): NameTarget | string {
  const v = card.querySelector<HTMLInputElement>(`input[name="nm-c-${i}"]:checked`)?.value
  if (!v) return 'เลือกก่อนว่าของชิ้นนี้คืออะไร'
  if (v === 'new') {
    const name = card.querySelector<HTMLInputElement>('.nm-new-name')!.value.trim()
    if (!name) return 'กรุณาพิมพ์ชื่อที่ถูกต้อง'
    return {
      type: 'new',
      name,
      unitName: card.querySelector<HTMLInputElement>('.nm-new-unit')!.value.trim(),
      unitPrice: parseFloat(card.querySelector<HTMLInputElement>('.nm-new-price')!.value) || 0
    }
  }
  if (v === 'find') {
    const p = found.get(g.key)
    return p ? { type: 'product', productId: p.id } : 'ค้นหาแล้วกดเลือกสินค้าจากรายการก่อน'
  }
  const s = g.suggestions[Number(v.slice(1))]
  if (!s) return 'เลือกก่อนว่าของชิ้นนี้คืออะไร'
  return s.kind === 'product' ? { type: 'product', productId: s.id } : { type: 'saleItem', saleItemId: s.id }
}

async function applyCard(card: HTMLElement, g: NameGroup, i: number): Promise<void> {
  const names = tickedNames(card, g)
  if (!names.length) return showToast('ติ๊กชื่อที่จะจัดอย่างน้อย 1 ชื่อ', true)
  const target = targetOf(card, g, i)
  if (typeof target === 'string') return showToast(target, true)
  const btn = card.querySelector<HTMLButtonElement>('button[data-act="apply"]')!
  btn.disabled = true
  try {
    const r = await window.api.names.apply({ names, target })
    found.delete(g.key)
    showToast(`จัด ${r.lines} บรรทัดเป็น "${r.name}" แล้ว`)
    await refreshItemIndex()
    await renderPending()
  } catch (err) {
    toastError(err)
    btn.disabled = false
  }
}

async function skipCard(g: NameGroup, skipped: boolean): Promise<void> {
  try {
    await window.api.names.skip({ names: g.spellings.map((s) => s.name), skipped })
    await renderPending()
  } catch (err) {
    toastError(err)
  }
}

async function renderPending(): Promise<void> {
  try {
    page = await window.api.names.pending({
      search: input('nm-search').value,
      showSkipped: input('nm-show-skipped').checked,
      offset,
      limit: PAGE
    })
  } catch (err) {
    toastError(err)
    return
  }
  // The last card of the last page was just sorted — step back a page.
  if (!page.groups.length && offset > 0) {
    offset = Math.max(0, offset - PAGE)
    return renderPending()
  }
  const p = page
  progress(p)
  $('nm-list').innerHTML = p.groups.length
    ? p.groups.map(cardHtml).join('')
    : `<div class="empty-state"><i class="ti ti-circle-check"></i>${
        input('nm-search').value.trim() ? 'ไม่พบชื่อที่ค้นหา' : 'ไม่มีชื่อที่รอจัดแล้ว'
      }</div>`
  $('nm-list')
    .querySelectorAll<HTMLElement>('.nm-card')
    .forEach((card) => {
      const i = Number(card.dataset.i)
      bindCard(card, p.groups[i], i)
    })

  const from = p.total ? offset + 1 : 0
  const to = Math.min(offset + PAGE, p.total)
  $('nm-pager').innerHTML = p.total
    ? `<button class="btn" id="nm-prev"${offset <= 0 ? ' disabled' : ''}><i class="ti ti-chevron-left"></i>ก่อนหน้า</button>
       <span class="text-muted">${from}–${to} จาก ${p.total.toLocaleString('th-TH')} กลุ่มชื่อ (ขายบ่อยขึ้นก่อน)</span>
       <button class="btn" id="nm-next"${to >= p.total ? ' disabled' : ''}>ถัดไป<i class="ti ti-chevron-right"></i></button>`
    : ''
  document.getElementById('nm-prev')?.addEventListener('click', () => turn(-PAGE))
  document.getElementById('nm-next')?.addEventListener('click', () => turn(PAGE))
}

function turn(by: number): void {
  offset = Math.max(0, offset + by)
  void renderPending().then(() => $('view-itemnames').scrollIntoView({ block: 'start' }))
}

/* ---------- agreed names ---------- */

function renderDoneRows(): void {
  const q = input('nm-done-search').value.trim().toLowerCase()
  const rows = q ? doneItems.filter((d) => `${d.name} ${d.aliases.join(' ')} ${d.barcode ?? ''}`.toLowerCase().includes(q)) : doneItems
  $('nm-done-body').innerHTML = rows.length
    ? rows
        .map((d) => {
          const sale = d.kind === 'saleItem'
          return `<tr>
            <td><b>${esc(d.name)}</b>${d.barcode ? `<div class="pl-tag mono">${esc(d.barcode)}</div>` : ''}</td>
            <td><span class="badge ${sale ? 'ok' : 'muted'}">${sale ? 'ชื่อขาย' : 'สินค้าในสต๊อก'}</span></td>
            <td>${sale ? `${esc(d.unitName || '—')} · ${d.unitPrice ? money(d.unitPrice) : '—'}` : '<span class="text-muted">ตามรายการสินค้า</span>'}</td>
            <td class="num">${d.lines}${d.lastSold ? `<div class="pl-tag">ล่าสุด ${thaiDate(d.lastSold)}</div>` : ''}</td>
            <td>${d.aliases.map((a) => `<span class="nm-alias">${esc(a)}</span>`).join('') || '<span class="text-muted">—</span>'}</td>
            <td style="white-space:nowrap;text-align:right;">
              ${
                sale
                  ? `<button class="btn small" data-act="rename" data-kind="${d.kind}" data-id="${d.id}"><i class="ti ti-pencil"></i>เปลี่ยนชื่อ</button>
                     <button class="btn small" data-act="price" data-kind="${d.kind}" data-id="${d.id}">หน่วย / ราคา</button>`
                  : ''
              }
              <button class="btn small" data-act="undo" data-kind="${d.kind}" data-id="${d.id}" style="color:var(--danger);"><i class="ti ti-arrow-back-up"></i>ยกเลิกการจัด</button>
            </td>
          </tr>`
        })
        .join('')
    : `<tr><td colspan="6"><div class="empty-state"><i class="ti ti-tags"></i>${
        doneItems.length ? 'ไม่พบชื่อที่ค้นหา' : 'ยังไม่มีชื่อที่จัดแล้ว — เริ่มที่แท็บ "รอจัด"'
      }</div></td></tr>`

  $('nm-done-body')
    .querySelectorAll<HTMLButtonElement>('button[data-act]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        const d = doneItems.find((x) => x.kind === b.dataset.kind && x.id === Number(b.dataset.id))
        if (!d) return
        if (b.dataset.act === 'rename') void rename(d)
        if (b.dataset.act === 'price') void editPrice(d)
        if (b.dataset.act === 'undo') void undo(d)
      })
    )
}

async function renderDone(): Promise<void> {
  try {
    ;[doneItems, page] = await Promise.all([window.api.names.items(), window.api.names.pending({ limit: 1 })])
  } catch (err) {
    toastError(err)
    return
  }
  progress(page)
  renderDoneRows()
}

async function rename(d: NamedItem): Promise<void> {
  const v = await promptModal(
    `เปลี่ยนชื่อ "${d.name}"`,
    [{ key: 'name', label: `ชื่อใหม่ — บิลเก่า ${d.lines} บรรทัดจะเปลี่ยนตาม`, value: d.name }],
    (vals) => (vals.name.trim() ? null : 'กรุณาพิมพ์ชื่อใหม่')
  )
  if (!v || v.name.trim() === d.name) return
  try {
    const r = await window.api.names.renameItem({ id: d.id, name: v.name })
    showToast(`เปลี่ยนชื่อแล้ว (${r.lines} บรรทัดในบิล)`)
    await refreshItemIndex()
    await renderDone()
  } catch (err) {
    toastError(err)
  }
}

async function editPrice(d: NamedItem): Promise<void> {
  const v = await promptModal(
    `หน่วยและราคาของ "${d.name}"`,
    [
      { key: 'unit', label: 'หน่วยที่ขึ้นให้ตอนคีย์บิล', value: d.unitName },
      { key: 'price', label: 'ราคาต่อหน่วย (แก้ในบิลได้เสมอ)', value: d.unitPrice ? String(d.unitPrice) : '' }
    ],
    (vals) => (vals.price.trim() && !(parseFloat(vals.price) >= 0) ? 'ราคาไม่ถูกต้อง' : null)
  )
  if (!v) return
  try {
    await window.api.names.updateItem({ id: d.id, unitName: v.unit, unitPrice: parseFloat(v.price) || 0 })
    showToast('บันทึกแล้ว — บิลเก่าไม่เปลี่ยน')
    await refreshItemIndex()
    await renderDone()
  } catch (err) {
    toastError(err)
  }
}

async function undo(d: NamedItem): Promise<void> {
  const what =
    d.kind === 'saleItem'
      ? `ยกเลิกชื่อขาย "${d.name}"?\n\nบิล ${d.lines} บรรทัดจะกลับเป็นชื่อที่พิมพ์ไว้เดิม และชื่อจะกลับไปอยู่ในแท็บ "รอจัด"`
      : `ยกเลิกการจัดชื่อเข้ากับ "${d.name}"?\n\nบิล ${d.tidied} บรรทัดที่ถูกจัดเข้ามาจะกลับเป็นชื่อที่พิมพ์ไว้เดิม (บรรทัดที่เลือกจากรายการสินค้าโดยตรงไม่เปลี่ยน)`
  if (!confirm(what)) return
  try {
    const r = await window.api.names.undo(d.kind === 'saleItem' ? { saleItemId: d.id } : { productId: d.id })
    showToast(`ยกเลิกแล้ว — ${r.lines} บรรทัดกลับเป็นชื่อเดิม`)
    await refreshItemIndex()
    await renderDone()
  } catch (err) {
    toastError(err)
  }
}

/* ---------- init ---------- */

function applyTab(): void {
  $('nm-tabs')
    .querySelectorAll<HTMLButtonElement>('.seg-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  $('nm-pending').style.display = tab === 'pending' ? '' : 'none'
  $('nm-done').style.display = tab === 'done' ? '' : 'none'
}

export async function renderItemNames(): Promise<void> {
  applyTab()
  await refreshItemIndex()
  if (tab === 'pending') await renderPending()
  else await renderDone()
}

export function initItemNames(): void {
  $('nm-tabs')
    .querySelectorAll<HTMLButtonElement>('.seg-btn')
    .forEach((b) =>
      b.addEventListener('click', () => {
        tab = b.dataset.tab as 'pending' | 'done'
        void renderItemNames()
      })
    )
  input('nm-search').addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      offset = 0
      void renderPending()
    }, 250)
  })
  input('nm-show-skipped').addEventListener('change', () => {
    offset = 0
    void renderPending()
  })
  input('nm-done-search').addEventListener('input', renderDoneRows)
}
