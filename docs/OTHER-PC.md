# Continuing StockKeep on another PC

> Written 28 Nov 2026 on the PC where the code lives at `C:\Claude\stock-system`.
> For the other development PC (code at `D:\Claude Code\Home\Program\stock-system`).
> Read this first, then `docs/HANDOFF.md` for the full status.

---

## 1. Get the latest code

Nothing here is merged into `main` yet. The newest work is on the branch `feature/item-names`.

```bash
cd "D:\Claude Code\Home\Program\stock-system"
git status                       # make sure there is no unsaved work here first
git fetch origin
git checkout feature/item-names
git pull
npm install
npm run dev
```

If `git status` shows changes on that PC that were never pushed, commit or stash them before `git checkout`.

`npm install` is needed because the versions moved from 1.6.13 to 1.6.16 (no new dependency was added,
but it also rebuilds `better-sqlite3` for Electron).

## 2. Where everything is

| What | Where |
|---|---|
| Repo | https://github.com/KubPomJin/stock-system |
| Branches (each one is built on the one before) | `main` (v1.6.13) ← `feature/dark-mode` (v1.6.14, PR #1 open) ← `feature/daily-expenses` (v1.6.15) ← `feature/item-names` (v1.6.16) |
| Latest installer | `G:\My Drive\Home\release update\StockKeep Setup 1.6.16.exe` — includes 1.6.14 + 1.6.15 + 1.6.16 |
| Shop backup used for the analysis | `G:\My Drive\Home\Stock update\stockkeep-backup-2026-11-27_0524.db` |

**To merge:** merging `feature/item-names` into `main` brings all three versions at once
(PR #1 only covers dark mode). Nothing has been merged because the owner wants to use it for real first.

**The shop PC is still on an older version.** Before installing 1.6.16 there: export a backup from
the Users page, then run the installer. The database upgrades itself on first start. Never install an
older version over a newer one.

## 3. What was added since v1.6.13

- **v1.6.14 — dark mode.** Moon/sun button on the top bar, remembered per PC. Printing is unchanged.
- **v1.6.15 — daily expenses** (รายจ่ายประจำวัน). Fuel, paying for stock (cash or cheque), staff cash
  advances, other. Cash expenses are subtracted in the daily cash-up automatically. Advance summary per person.
- **v1.6.16 — item names in bills** (จัดชื่อสินค้าในบิล). Groups the different spellings typed on bills,
  suggests the matching stock item, and the owner confirms, fixes or skips. Names can be renamed or undone
  later. The item search on the bill entry page now also finds these agreed names and shows best sellers first.

Rules for each of these are in `CLAUDE.md` section 6. History is in `CHANGELOG.md`.

## 4. Still open

1. **Two choices made for v1.6.16 that the owner has not confirmed** — change them if the owner disagrees:
   - Things sold but not kept in stock (sand, stone, thinner…) are saved as "sale names" with no stock count,
     not as full products.
   - Names can be tidied on days the owner already checked (locked), because no money amount changes.
2. **Phase 2 (not started):** a separate phone box on the bill, shown as `0XX-XXX-XXXX`; move the 48 phone
   numbers typed into the name/address boxes (with a list to approve first); remember past customers.
3. **Phase 3 (plan only):** phone-sized web page served by the shop PC over the shop Wi-Fi.
   Needs the server work in `docs/NETWORK-PLAN.md` first.
4. Staff-level (level 1) login was not tested directly against the new item-names pages.
5. Known limit: a sale name keeps one unit and one price (ทรายหยาบ is sold by bag and by scoop).

## 5. Things that differ between the two PCs

- **Paths in `docs/HANDOFF.md` are written for the D: PC.** On the other PC the code is at `C:\Claude\stock-system`.
- **Never run the dev build against the real shop database.** If the installed StockKeep is on the same PC,
  start dev with its own data folder:
  ```bash
  npx electron-vite dev -- --user-data-dir=C:/some/empty/folder
  ```
  To try something on real data, copy a backup `.db` into that folder as `stockkeep.db` first
  (log in with the real users in that backup; `admin` / `admin123` only works on a brand-new empty database).
- **Test folders on the C: PC only** (not in git, not needed elsewhere): `C:\Claude\stockkeep-dev-data` (sample data),
  `C:\Claude\stockkeep-try-data` (copy of the 27 Nov backup).
- **Setup problems met on the C: PC** — only relevant if the same errors show up:
  - `npm install` fails building `better-sqlite3` (no Python): run `npm install --ignore-scripts`, then
    `node node_modules/electron/install.js`, then `npx electron-builder install-app-deps`.
  - `npm run dist` fails with "Cannot create symbolic link" in winCodeSign: extract the downloaded `.7z` in
    `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` by hand into a folder named `winCodeSign-2.6.0`.
  - The GitHub `gh` tool is not installed there; pull requests were opened in the browser.
- **Files use Windows line endings (CRLF).** Keep them that way when editing by script.

## 6. First message for a new Claude chat on the other PC

```
Continue the StockKeep project in this folder. I worked on it on another PC.
Read docs/OTHER-PC.md, docs/HANDOFF.md, CLAUDE.md and docs/BACKLOG.md first,
then tell me the current status before changing anything.
```
