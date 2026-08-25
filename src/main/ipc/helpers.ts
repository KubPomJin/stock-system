import { ipcMain } from 'electron'
import { requireLevel } from '../session'

// Registers an IPC handler that (1) enforces a minimum role level in the main
// process — never trust the renderer for access control — and (2) wraps the
// result in { ok, data | error } so expected failures reach the renderer as
// readable messages instead of opaque IPC errors.
export function handle(
  channel: string,
  minLevel: number,
  fn: (payload: any) => unknown
): void {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      if (minLevel > 0) requireLevel(minLevel)
      return { ok: true, data: await fn(payload) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
