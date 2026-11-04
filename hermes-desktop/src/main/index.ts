import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import path from 'node:path'
import { APP_NAME } from '../shared/types'
import type { ConnectionResult } from '../shared/types'
import * as store from './store'
import * as chat from './chat'
import { fetchModels } from './openai'
import { mcp } from './mcp/instance'
import { parseImport } from './mcp/util'
import { resolveAppearance } from '../shared/theme'

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']

/** Window background matching the active theme (so resize/overscroll never flashes the wrong colour). */
async function themeBackground(): Promise<string> {
  const s = await store.getSettings()
  return resolveAppearance(s.theme, s.appearance, nativeTheme.shouldUseDarkColors).colors.bg
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    title: APP_NAME,
    backgroundColor: await themeBackground(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // Stay hidden until the renderer has applied the saved theme (avoids a flash of the default
  // theme); fall back to showing after 2.5 s so a renderer failure can never leave no window.
  const reveal = () => !win.isDestroyed() && !win.isVisible() && win.show()
  const fallback = setTimeout(reveal, 2500)
  win.once('closed', () => clearTimeout(fallback))
  win.webContents.ipc.once('app:rendered', reveal)

  // Never let the app window navigate away; open links in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  if (isDev) void win.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  return win
}

async function listFor(providerId: string): Promise<ConnectionResult> {
  const p = await store.getProviderRecord(providerId)
  if (!p) return { ok: false, models: [], error: 'Unknown provider' }
  return testConnection(p.baseUrl, store.decryptKey(p))
}

async function testConnection(baseUrl: string, apiKey?: string): Promise<ConnectionResult> {
  try {
    return { ok: true, models: await fetchModels(baseUrl, apiKey) }
  } catch (e) {
    return { ok: false, models: [], error: (e as Error).message }
  }
}

/** Push the saved MCP config to the manager (connects/disconnects as needed). */
async function syncMcp() {
  const [records, settings] = await Promise.all([store.getMcpRecords(), store.getSettings()])
  mcp.sync(records, settings.tools.workspace)
}

function registerIpc() {
  const h = ipcMain.handle.bind(ipcMain)
  h('conversations:list', () => store.listConversations())
  h('conversations:get', (_e, id: string) => store.getConversation(id))
  h('conversations:create', () => store.createConversation())
  h('conversations:rename', async (_e, id: string, title: string) => {
    const c = await store.getConversation(id)
    if (c) {
      c.title = title.trim() || c.title
      await store.saveConversation(c)
    }
  })
  h('conversations:remove', (_e, id: string) => {
    chat.stop(id)
    return store.deleteConversation(id)
  })
  h('conversations:setModel', async (_e, id: string, providerId: string, model: string) => {
    const c = await store.getConversation(id)
    if (c) {
      c.providerId = providerId
      c.model = model
      await store.saveConversation(c)
    }
  })

  h('chat:send', (e, req) => chat.sendMessage(e.sender, req))
  h('chat:regenerate', (e, req) => chat.regenerate(e.sender, req))
  h('chat:stop', (_e, id: string) => chat.stop(id))
  h('chat:decide', (_e, callId: string, decision) => chat.decide(callId, decision))

  h('settings:get', () => store.getSettings())
  h('settings:update', async (_e, patch) => {
    const s = await store.updateSettings(patch)
    nativeTheme.themeSource = s.theme
    const bg = resolveAppearance(s.theme, s.appearance, nativeTheme.shouldUseDarkColors).colors.bg
    BrowserWindow.getAllWindows().forEach((w) => !w.isDestroyed() && w.setBackgroundColor(bg))
    return s
  })
  h('settings:saveProvider', (_e, input) => store.saveProvider(input))
  h('settings:removeProvider', (_e, id: string) => store.removeProvider(id))
  h('mcp:status', () => mcp.status())
  h('mcp:save', async (_e, input) => {
    const s = await store.saveMcpServer(input)
    await syncMcp()
    return s
  })
  h('mcp:remove', async (_e, id: string) => {
    const s = await store.removeMcpServer(id)
    await syncMcp()
    return s
  })
  h('mcp:restart', (_e, id: string) => mcp.restart(id))
  h('mcp:parseImport', (_e, text: string) => parseImport(String(text)))

  h('settings:pickWorkspace', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Choose workspace folder', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0] ?? null
  })

  h('models:list', (_e, providerId: string) => listFor(providerId))
  h('models:test', async (_e, baseUrl: string, apiKey: string | undefined, providerId?: string) => {
    // Blank key field while editing an existing provider = use its saved key.
    let key = apiKey
    if (!key && providerId) {
      const p = await store.getProviderRecord(providerId)
      key = p ? store.decryptKey(p) : undefined
    }
    return testConnection(baseUrl, key)
  })
}

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w) {
      if (w.isMinimized()) w.restore()
      w.focus()
    }
  })

  app.whenReady().then(async () => {
    app.setName(APP_NAME)
    await store.initStore()
    await store.pruneEmptyConversations()
    nativeTheme.themeSource = (await store.getSettings()).theme
    registerIpc()
    mcp.onStatus = (status) => BrowserWindow.getAllWindows().forEach((w) => !w.isDestroyed() && w.webContents.send('mcp:status', status))
    void syncMcp() // connect enabled servers in the background
    await createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })

  // Make sure local MCP servers (child processes) never outlive the app.
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    void mcp.closeAll().finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
