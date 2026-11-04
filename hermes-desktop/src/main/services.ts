import path from 'node:path'
import { MemoryStore } from './memory'
import { SkillRegistry } from './skills/registry'

/** Memory + skills storage, created once the user-data directory is known. */
export const services = {
  memory: undefined as unknown as MemoryStore,
  skills: undefined as unknown as SkillRegistry
}

export function initServices(userData: string): void {
  services.memory = new MemoryStore(path.join(userData, 'memory.json'))
  services.skills = new SkillRegistry(path.join(userData, 'skills'))
}
