import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
}))

const store = await import('../src/main/store')

beforeEach(async () => {
  await store.initStore(mkdtempSync(path.join(os.tmpdir(), 'store-')))
})

describe('settings writes', () => {
  it('concurrent updates never drop each other (read-modify-write is serialized)', async () => {
    // Fired together, like the renderer does when you pick a model and change a setting at the same moment.
    await Promise.all([
      store.updateSettings({ context: { window: 8192 } }),
      store.saveProvider({ id: 'default', name: '9router (local)', baseUrl: 'http://localhost:20128/v1', defaultModel: 'm1' }),
      store.updateSettings({ theme: 'dark' }),
      store.updateSettings({ titles: { enabled: false } }),
      store.saveProvider({ name: 'Second', baseUrl: 'http://localhost:9999/v1', defaultModel: 'x' }),
      store.updateSettings({ temperature: 1.3 })
    ])
    const s = await store.getSettings()
    expect(s.context.window).toBe(8192)
    expect(s.theme).toBe('dark')
    expect(s.titles.enabled).toBe(false)
    expect(s.temperature).toBe(1.3)
    expect(s.providers.find((p) => p.id === 'default')?.defaultModel).toBe('m1')
    expect(s.providers.map((p) => p.name)).toContain('Second')
  })

  it('a failing write does not block the ones queued after it', async () => {
    const bad = store.removeMcpServer('does-not-exist').catch(() => 'failed')
    const good = store.updateSettings({ temperature: 0.4 })
    await bad
    expect((await good).temperature).toBe(0.4)
  })
})

describe('user name and appearance settings', () => {
  it('defaults to no name, cleans what is saved, and keeps it across reads', async () => {
    expect((await store.getSettings()).userName).toBe('')
    const s = await store.updateSettings({ userName: '  Dylan\n ' })
    expect(s.userName).toBe('Dylan')
    expect((await store.getSettings()).userName).toBe('Dylan')
    expect((await store.updateSettings({ userName: 'x'.repeat(99) })).userName).toHaveLength(40)
    expect((await store.updateSettings({ temperature: 0.5 })).userName).toHaveLength(40) // other writes leave it alone
  })
  it('glass and the modern font are the defaults and persist when changed', async () => {
    const a = (await store.getSettings()).appearance
    expect(a.glass).toBe(true)
    expect(a.uiFont).toBe('modern')
    expect((await store.updateSettings({ appearance: { glass: false } })).appearance.glass).toBe(false)
    expect((await store.getSettings()).appearance.glass).toBe(false)
  })
})
