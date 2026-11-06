import path from 'node:path'
import { MemoryStore } from './memory'
import { SkillRegistry } from './skills/registry'
import { AttachmentStore } from './attachments'

/** Memory + skills storage, created once the user-data directory is known. */
export const services = {
  memory: undefined as unknown as MemoryStore,
  skills: undefined as unknown as SkillRegistry,
  attachments: undefined as unknown as AttachmentStore
}

export function initServices(userData: string): void {
  services.memory = new MemoryStore(path.join(userData, 'memory.json'))
  services.attachments = new AttachmentStore(path.join(userData, 'attachments'))
  services.skills = new SkillRegistry(path.join(userData, 'skills'))
}
