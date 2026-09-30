import type { Skill, StoredMcpServer } from '@flux-agent/contracts';

export interface CapabilityStore {
  skills(): Skill[];
  mcps(): StoredMcpServer[];
  saveSkill(skill: Skill): void;
  saveMcp(server: StoredMcpServer): void;
  deleteSkill(name: string): void;
  deleteMcp(name: string): void;
}

export class InMemoryCapabilityStore implements CapabilityStore {
  private readonly skillEntries = new Map<string, Skill>();
  private readonly mcpEntries = new Map<string, StoredMcpServer>();

  skills() {
    return structuredClone([...this.skillEntries.values()]);
  }
  mcps() {
    return structuredClone([...this.mcpEntries.values()]);
  }
  saveSkill(skill: Skill) {
    this.skillEntries.set(skill.name, structuredClone(skill));
  }
  saveMcp(server: StoredMcpServer) {
    this.mcpEntries.set(server.name, structuredClone(server));
  }
  deleteSkill(name: string) {
    this.skillEntries.delete(name);
  }
  deleteMcp(name: string) {
    this.mcpEntries.delete(name);
  }
}
