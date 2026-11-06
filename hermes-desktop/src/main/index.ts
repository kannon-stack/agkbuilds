import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { APP_ID, APP_NAME } from '../shared/types'
import type { AppInfo } from '../shared/types'
import { existsSync } from 'node:fs'
import type { ConnectionResult } from '../shared/types'
import * as store from './store'
import * as chat from './chat'
import { fetchModels } from './openai'
import { listClaudeModels } from './anthropic'
import type { ProviderKind } from '../shared/anthropic'
import { mcp } from './mcp/instance'
import { parseImport } from './mcp/util'
import { CallbackServer, OAuthStore } from './mcp/oauth'
import { OAUTH_REDIRECT_PORT } from '../shared/mcp'
import { resolveAppearance } from '../shared/theme'
import { initServices, services } from './services'
import { MemoryError } from './memory'
import { SkillError, summarize, withEnabled } from './skills/registry'
import type { Result } from '../shared/types'

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']

/** Window/taskbar icon: shipped as an extra resource when packaged, from build/ in dev. */
function iconPath(): string | undefined {
  const p = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(app.getAppPath(), 'build', 'icon.png')
  return existsSync(p) ? p : undefined
}

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
    icon: iconPath(),
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
  return testConnection(p.baseUrl, store.decryptKey(p), p.kind)
}

async function testConnection(baseUrl: string, apiKey?: string, kind: ProviderKind = 'openai'): Promise<ConnectionResult> {
  try {
    return { ok: true, models: kind === 'anthropic' ? await listClaudeModels(baseUrl, apiKey) : await fetchModels(baseUrl, apiKey) }
  } catch (e) {
    return { ok: false, models: [], error: (e as Error).message }
  }
}

/** Push the saved MCP config to the manager (connects/disconnects as needed). */
async function syncMcp() {
  const [records, settings] = await Promise.all([store.getMcpRecords(), store.getSettings()])
  mcp.sync(records, settings.tools.workspace)
}

/** Run a service call, turning expected failures into { ok:false, error } for the UI. */
async function guarded<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    if (e instanceof MemoryError || e instanceof SkillError) return { ok: false, error: e.message }
    throw e
  }
}

function broadcast(kind: 'memory' | 'skills') {
  BrowserWindow.getAllWindows().forEach((w) => !w.isDestroyed() && w.webContents.send('data:changed', kind))
}

async function skillSummaries() {
  const [settings] = await Promise.all([store.getSettings()])
  const recs = await services.skills.scan(settings.tools.workspace)
  return { recs, settings, list: recs.map((r) => summarize(r, settings.skills)) }
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
  // ---- about / diagnostics
  h('app:info', (): AppInfo => ({
    name: app.getName(), version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    node: process.versions.node, platform: process.platform, arch: process.arch, packaged: app.isPackaged, dataDir: app.getPath('userData')
  }))
  h('app:openDataFolder', async () => void (await shell.openPath(app.getPath('userData'))))

  // ---- memory
  h('memory:list', () => services.memory.list())
  h('memory:add', async (_e, text: string, scope: 'global' | 'project') => {
    const ws = (await store.getSettings()).tools.workspace
    if (scope === 'project' && !ws) return { ok: false, error: 'Choose a workspace folder first (Settings → Tools) to save project notes.' } as Result<never>
    return guarded(async () => (await services.memory.add(text, { source: 'user', workspace: scope === 'project' ? ws : undefined })).item)
  })
  h('memory:update', (_e, id: string, patch) => guarded(() => services.memory.update(id, patch)))
  h('memory:remove', (_e, id: string) => guarded(async () => void (await services.memory.remove(id))))
  h('memory:clear', () => services.memory.clear())

  // ---- skills
  h('skills:list', async () => (await skillSummaries()).list)
  h('skills:get', async (_e, name: string) => {
    const { recs, settings } = await skillSummaries()
    const rec = recs.find((r) => r.name === name)
    return rec ? { ...summarize(rec, settings.skills), body: rec.body } : null
  })
  h('skills:save', (_e, input) =>
    guarded(async () => {
      const rec = await services.skills.save(input, 'user', { overwrite: !!input.originalName })
      const { settings } = await skillSummaries()
      return summarize(rec, settings.skills)
    })
  )
  h('skills:remove', (_e, name: string) => guarded(() => services.skills.remove(name)))
  h('skills:setEnabled', (_e, name: string, enabled: boolean) =>
    guarded(async () => {
      const { recs, settings } = await skillSummaries()
      const rec = recs.find((r) => r.name === name)
      if (!rec) throw new SkillError(`No skill named "${name}".`)
      if (rec.invalid) throw new SkillError('This skill is invalid and can’t be enabled.')
      await store.updateSettings({ skills: withEnabled(rec, enabled, settings.skills) })
    })
  )
  h('skills:import', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Choose a skill folder (it must contain SKILL.md)', properties: ['openDirectory'] as 'openDirectory'[] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    return guarded(async () => {
      const rec = await services.skills.importFolder(r.filePaths[0])
      return summarize(rec, (await store.getSettings()).skills)
    })
  })
  h('skills:openFolder', async () => {
    await fsp.mkdir(services.skills.userDir, { recursive: true })
    await shell.openPath(services.skills.userDir)
  })

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
  h('mcp:signIn', (_e, id: string) => mcp.signIn(id))
  h('mcp:signOut', (_e, id: string) => mcp.signOut(id))
  h('mcp:cancelAuth', (_e, id: string) => mcp.cancelAuth(id))
  h('mcp:reopenAuth', (_e, id: string) => mcp.reopenAuth(id))
  h('mcp:parseImport', (_e, text: string) => parseImport(String(text)))

  h('settings:pickWorkspace', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Choose workspace folder', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0] ?? null
  })

  h('models:list', (_e, providerId: string) => listFor(providerId))
  h('models:test', async (_e, baseUrl: string, apiKey: string | undefined, providerId?: string, kind?: ProviderKind) => {
    // Blank key field while editing an existing provider = use its saved key.
    let key = apiKey
    if (!key && providerId) {
      const p = await store.getProviderRecord(providerId)
      key = p ? store.decryptKey(p) : undefined
    }
    return testConnection(baseUrl, key, kind === 'anthropic' ? 'anthropic' : 'openai')
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
    if (process.platform === 'win32') app.setAppUserModelId(APP_ID) // taskbar grouping, pinning, notifications
    if (process.platform === 'darwin' && !app.isPackaged) { const i = iconPath(); if (i) app.dock?.setIcon(i) }
    await store.initStore()
    initServices(app.getPath('userData'))
    await store.pruneEmptyConversations()
    nativeTheme.themeSource = (await store.getSettings()).theme
    registerIpc()
    // OAuth for remote MCP servers: tokens live encrypted in userData; the browser is the system browser.
    const oauthStore = new OAuthStore(path.join(app.getPath('userData'), 'mcp-oauth.json'), { encrypt: store.encryptSecret, decrypt: store.decryptSecret })
    await oauthStore.init()
    mcp.initOAuth({
      store: oauthStore,
      callback: new CallbackServer({ preferredPort: OAUTH_REDIRECT_PORT }),
      openBrowser: (url) => shell.openExternal(url)
    })
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
