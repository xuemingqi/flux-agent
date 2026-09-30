import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Skill, StoredMcpServer } from '@flux-agent/contracts';
import { skillEntries, mcpServers } from './schema.js';
import type { CapabilityStore } from './capability-store.js';

export class SqliteCapabilityStore implements CapabilityStore {
  constructor(private readonly database: BetterSQLite3Database) {}

  skills(): Skill[] {
    return this.database
      .select()
      .from(skillEntries)
      .all()
      .map((row) => row.snapshot);
  }
  mcps(): StoredMcpServer[] {
    return this.database
      .select()
      .from(mcpServers)
      .all()
      .map((row) => row.snapshot);
  }
  saveSkill(skill: Skill): void {
    this.database
      .insert(skillEntries)
      .values({ name: skill.name, snapshot: skill })
      .onConflictDoUpdate({ target: skillEntries.name, set: { snapshot: skill } })
      .run();
  }
  saveMcp(server: StoredMcpServer): void {
    this.database
      .insert(mcpServers)
      .values({ name: server.name, snapshot: server })
      .onConflictDoUpdate({ target: mcpServers.name, set: { snapshot: server } })
      .run();
  }
  deleteSkill(name: string): void {
    this.database.delete(skillEntries).where(eq(skillEntries.name, name)).run();
  }
  deleteMcp(name: string): void {
    this.database.delete(mcpServers).where(eq(mcpServers.name, name)).run();
  }
}
