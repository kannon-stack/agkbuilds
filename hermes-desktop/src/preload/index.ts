import { contextBridge, ipcRenderer } from 'electron'
import type { Api, ChatEvent } from '../shared/types'
import type { McpServerStatus } from '../shared/mcp'

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: Api = {
  attachments: {
    save: (name, bytes) => invoke('attachments:save', name, bytes),
    pick: () => invoke('attachments:pick'),
    dataUrl: (a) => invoke('attachments:dataUrl', a)
  },
  conversations: {
    list: () => invoke('conversations:list'),
    get: (id) => invoke('conversations:get', id),
    create: () => invoke('conversations:create'),
    rename: (id, title) => invoke('conversations:rename', id, title),
    remove: (id) => invoke('conversations:remove', id),
    setModel: (id, providerId, model) => invoke('conversations:setModel', id, providerId, model),
    context: (id) => invoke('conversations:context', id),
    search: (q) => invoke('conversations:search', q),
    reveal: (id, messageId) => invoke('conversations:reveal', id, messageId),
    export: (id, how) => invoke('conversations:export', id, how)
  },
  chat: {
    send: (req) => invoke('chat:send', req),
    regenerate: (req) => invoke('chat:regenerate', req),
    edit: (req) => invoke('chat:edit', req),
    switchBranch: (id, messageId) => invoke('chat:switchBranch', id, messageId),
    compact: (id, instructions) => invoke('chat:compact', id, instructions),
    stop: (id) => invoke('chat:stop', id),
    decide: (callId, decision) => invoke('chat:decide', callId, decision),
    onEvent: (cb) => {
      const listener = (_: unknown, e: ChatEvent) => cb(e)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener)
    }
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    saveProvider: (input) => invoke('settings:saveProvider', input),
    removeProvider: (id) => invoke('settings:removeProvider', id),
    pickWorkspace: () => invoke('settings:pickWorkspace')
  },
  memory: {
    list: () => invoke('memory:list'),
    add: (text, scope) => invoke('memory:add', text, scope),
    update: (id, patch) => invoke('memory:update', id, patch),
    remove: (id) => invoke('memory:remove', id),
    clear: () => invoke('memory:clear')
  },
  skills: {
    list: () => invoke('skills:list'),
    get: (name) => invoke('skills:get', name),
    save: (input) => invoke('skills:save', input),
    remove: (name) => invoke('skills:remove', name),
    setEnabled: (name, enabled) => invoke('skills:setEnabled', name, enabled),
    importFolder: () => invoke('skills:import'),
    openFolder: () => invoke('skills:openFolder')
  },
  onDataChanged: (cb) => {
    const listener = (_: unknown, kind: 'memory' | 'skills') => cb(kind)
    ipcRenderer.on('data:changed', listener)
    return () => ipcRenderer.removeListener('data:changed', listener)
  },
  app: {
    info: () => invoke('app:info'),
    openDataFolder: () => invoke('app:openDataFolder'),
    rendered: async () => ipcRenderer.send('app:rendered')
  },
  mcp: {
    status: () => invoke('mcp:status'),
    save: (input) => invoke('mcp:save', input),
    remove: (id) => invoke('mcp:remove', id),
    restart: (id) => invoke('mcp:restart', id),
    signIn: (id) => invoke('mcp:signIn', id),
    signOut: (id) => invoke('mcp:signOut', id),
    cancelAuth: (id) => invoke('mcp:cancelAuth', id),
    reopenAuth: (id) => invoke('mcp:reopenAuth', id),
    parseImport: (text) => invoke('mcp:parseImport', text),
    onStatus: (cb) => {
      const listener = (_: unknown, s: McpServerStatus[]) => cb(s)
      ipcRenderer.on('mcp:status', listener)
      return () => ipcRenderer.removeListener('mcp:status', listener)
    }
  },
  models: {
    list: (providerId) => invoke('models:list', providerId),
    test: (baseUrl, apiKey, providerId, kind) => invoke('models:test', baseUrl, apiKey, providerId, kind)
  }
}

contextBridge.exposeInMainWorld('api', api)
