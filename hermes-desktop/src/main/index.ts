import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import path from 'node:path'
import { APP_NAME } from '../shared/types'
import type { ConnectionResult } from '../shared/types'
import * as store from './store'
import * as chat from './chat'
import { fetchModels } from './openai'

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    title: APP_NAME,
    backgroundColor: '#0e1014',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())

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

  h('settings:get', () => store.getSettings())
  h('settings:update', async (_e, patch) => {
    const s = await store.updateSettings(patch)
    nativeTheme.themeSource = s.theme
    return s
  })
  h('settings:saveProvider', (_e, input) => store.saveProvider(input))
  h('settings:removeProvider', (_e, id: string) => store.removeProvider(id))

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
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
