import '@tabler/icons-webfont/tabler-icons.min.css'
import { $, input } from './format'
import { level, reloadLookups, reloadProducts, state } from './state'
import { toastError } from './ui'
import { renderDashboard } from './views/dashboard'
import { initProducts, renderProducts, resetProductFilters } from './views/products'
import { initReceiving, refreshReceivingDocNumber, renderReceivingSelectors } from './views/receiving'
import {
  initStocktake,
  refreshPendingSheets,
  refreshStocktakeDocNumber,
  renderStocktakeSelectors
} from './views/stocktake'
import { initTransfer, refreshTransferDocNumber, renderTransferSelectors } from './views/transfer'
import { initHistory, renderHistory } from './views/history'
import { initExchange, renderImportHistory } from './views/exchange'
import {
  initOrders,
  refreshBlankStartNumber,
  refreshOrderDocNumber,
  renderOrderHistory,
  renderOrderSelectors
} from './views/orders'
import { initUsers, renderUsersView } from './views/users'
import { initZones, renderZonesView } from './views/zones'
import { initCatalog, renderCatalogHistory } from './views/catalog'

/* ---------- navigation (role-aware) ---------- */

interface NavItem {
  view: string
  label: string
  icon: string
  minRoleLevel: number
  group: string
}

const NAV_ITEMS: NavItem[] = [
  { view: 'dashboard', label: 'แดชบอร์ด', icon: 'ti-layout-dashboard', minRoleLevel: 1, group: 'ภาพรวม' },
  { view: 'products', label: 'สินค้า', icon: 'ti-box', minRoleLevel: 1, group: 'คลังสินค้า' },
  { view: 'zones', label: 'ผังโกดัง', icon: 'ti-map-2', minRoleLevel: 1, group: 'คลังสินค้า' },
  { view: 'receiving', label: 'รับสินค้า', icon: 'ti-truck-delivery', minRoleLevel: 2, group: 'คลังสินค้า' },
  { view: 'transfer', label: 'เบิกของ', icon: 'ti-arrows-exchange', minRoleLevel: 2, group: 'คลังสินค้า' },
  { view: 'stocktake', label: 'ตรวจนับสต๊อก', icon: 'ti-clipboard-check', minRoleLevel: 2, group: 'คลังสินค้า' },
  { view: 'history', label: 'ประวัติสต๊อก', icon: 'ti-history', minRoleLevel: 2, group: 'คลังสินค้า' },
  { view: 'exchange', label: 'เชื่อมระบบบิล', icon: 'ti-arrows-exchange-2', minRoleLevel: 2, group: 'คลังสินค้า' },
  { view: 'orders', label: 'ใบสั่งสินค้า', icon: 'ti-file-invoice', minRoleLevel: 2, group: 'เอกสาร' },
  { view: 'users', label: 'ผู้ใช้งาน', icon: 'ti-users', minRoleLevel: 3, group: 'ระบบ' }
]

function renderSidebarNav(): void {
  const items = NAV_ITEMS.filter((item) => level() >= item.minRoleLevel)
  let html = ''
  let lastGroup: string | null = null
  items.forEach((item, i) => {
    if (item.group !== lastGroup) {
      html += `<div class="nav-group-label">${item.group}</div>`
      lastGroup = item.group
    }
    html += `<button class="nav-item${i === 0 ? ' active' : ''}" data-view="${item.view}"><span class="nav-dot"></span><i class="ti ${item.icon}"></i>${item.label}</button>`
  })
  $('sidebar-nav').innerHTML = html
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view as string))
  })
}

function switchView(view: string): void {
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view))
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'))
  $('view-' + view).classList.add('active')
  const item = NAV_ITEMS.find((n) => n.view === view)
  $('view-title').textContent = item ? item.label : ''
  closeSidebarDrawer()
  if (view === 'users') {
    void renderUsersView()
    void renderCatalogHistory()
  }
  if (view === 'history') void renderHistory()
  if (view === 'exchange') void renderImportHistory()
  if (view === 'orders') void renderOrderHistory()
  if (view === 'zones') void renderZonesView()
}

/* ---------- mobile sidebar drawer ---------- */

function openSidebarDrawer(): void {
  document.querySelector('.sidebar')?.classList.add('open')
  $('sidebar-overlay').classList.add('active')
}

function closeSidebarDrawer(): void {
  document.querySelector('.sidebar')?.classList.remove('open')
  $('sidebar-overlay').classList.remove('active')
}

/* ---------- data refresh ---------- */

// Re-pull products from the DB and re-render every data-driven view.
// Called after any mutation (receiving, stocktake, transfer, product save).
async function refreshData(): Promise<void> {
  await reloadProducts()
  renderDashboard()
  renderProducts()
  if (level() >= 2) {
    renderReceivingSelectors()
    renderStocktakeSelectors()
    renderTransferSelectors()
    renderOrderSelectors()
    await renderHistory()
  }
}

/* ---------- login / logout ---------- */

async function enterApp(): Promise<void> {
  const user = state.user
  if (!user) return

  $('login-screen').style.display = 'none'
  $('app-root').style.display = 'grid'
  $('login-error').style.display = 'none'
  ;(document.getElementById('login-form') as HTMLFormElement).reset()

  $('user-avatar').textContent = user.displayName.trim().charAt(0) || '-'
  $('user-name-label').textContent = user.displayName
  $('user-role-label').textContent = user.roleLabel

  renderSidebarNav()
  resetProductFilters()
  await reloadLookups()
  await refreshData()
  if (level() >= 2) {
    await Promise.all([
      refreshReceivingDocNumber(),
      refreshTransferDocNumber(),
      refreshStocktakeDocNumber(),
      refreshPendingSheets(),
      refreshOrderDocNumber(),
      refreshBlankStartNumber()
    ])
  }
  switchView('dashboard')
}

async function logout(): Promise<void> {
  try {
    await window.api.auth.logout()
  } catch {
    // session is already gone either way
  }
  state.user = null
  closeSidebarDrawer()
  $('app-root').style.display = 'none'
  $('login-screen').style.display = 'flex'
  input('login-username').focus()
}

function bindLogin(): void {
  document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const errEl = $('login-error')
    try {
      state.user = await window.api.auth.login(input('login-username').value, input('login-password').value)
      await enterApp()
    } catch (err) {
      errEl.textContent = err instanceof Error ? err.message : String(err)
      errEl.style.display = 'block'
    }
  })

  void window.api.auth
    .isFirstRun()
    .then((firstRun) => {
      $('login-hint').style.display = firstRun ? 'block' : 'none'
    })
    .catch(() => {})
}

/* ---------- bootstrap ---------- */

function bootstrap(): void {
  $('topbar-date').textContent = new Date().toLocaleDateString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  })

  // Version comes from package.json via the build, so it cannot go stale.
  $('app-version').textContent = `StockKeep v${__APP_VERSION__}`

  bindLogin()
  $('btn-logout').addEventListener('click', () => void logout())
  $('btn-menu-toggle').addEventListener('click', openSidebarDrawer)
  $('sidebar-overlay').addEventListener('click', closeSidebarDrawer)

  initProducts(refreshData)
  initReceiving(refreshData)
  initStocktake(refreshData)
  initTransfer(refreshData)
  initHistory()
  initExchange(refreshData)
  initOrders()
  initZones()
  initUsers()
  initCatalog(refreshData)

  input('login-username').focus()
}

bootstrap()
