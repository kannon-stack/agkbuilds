import { contextBridge, ipcRenderer } from 'electron'
import type { Api, ChatEvent } from '../shared/types'
import type { McpServerStatus } from '../shared/mcp'

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: Api = {
  conversations: {
    list: () => invoke('conversations:list'),
    get: (id) => invoke('conversations:get', id),
    create: () => invoke('conversations:create'),
    rename: (id, title) => invoke('conversations:rename', id, title),
    remove: (id) => invoke('conversations:remove', id),
    setModel: (id, providerId, model) => invoke('conversations:setModel', id, providerId, model)
  },
  chat: {
    send: (req) => invoke('chat:send', req),
    regenerate: (req) => invoke('chat:regenerate', req),
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
  app: {
    rendered: async () => ipcRenderer.send('app:rendered')
  },
  mcp: {
    status: () => invoke('mcp:status'),
    save: (input) => invoke('mcp:save', input),
    remove: (id) => invoke('mcp:remove', id),
    restart: (id) => invoke('mcp:restart', id),
    parseImport: (text) => invoke('mcp:parseImport', text),
    onStatus: (cb) => {
      const listener = (_: unknown, s: McpServerStatus[]) => cb(s)
      ipcRenderer.on('mcp:status', listener)
      return () => ipcRenderer.removeListener('mcp:status', listener)
    }
  },
  models: {
    list: (providerId) => invoke('models:list', providerId),
    test: (baseUrl, apiKey, providerId) => invoke('models:test', baseUrl, apiKey, providerId)
  }
}

contextBridge.exposeInMainWorld('api', api)
