import { readFile, unlink } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { saveModelSettingsSchema, type SaveModelSettings } from '@flux-agent/contracts';
import type { ModelSettingsStore } from '../settings/model-settings-store.js';
import { modelSettings } from './schema.js';

export class SqliteModelSettingsStore implements ModelSettingsStore {
  constructor(private readonly database: BetterSQLite3Database) {}

  load(): SaveModelSettings | undefined {
    const row = this.database.select().from(modelSettings).where(eq(modelSettings.id, 'default')).get();
    return row
      ? {
          baseUrl: row.baseUrl,
          model: row.model,
          apiKey: row.apiKey,
          contextWindowTokens: row.contextWindowTokens,
          maxOutputTokens: row.maxOutputTokens,
        }
      : undefined;
  }

  save(settings: SaveModelSettings): void {
    const row = { ...settings, id: 'default', updatedAt: new Date().toISOString() };
    this.database.insert(modelSettings).values(row).onConflictDoUpdate({ target: modelSettings.id, set: row }).run();
  }

  /**
   * 旧版配置仅导入一次，提交成功才删除旧文件；中断后重试不会覆盖数据库新配置。
   */
  async migrateLegacy(path: string): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!this.load()) {
      let value: unknown;
      try {
        value = JSON.parse(contents);
      } catch {
        throw new Error('旧版模型配置格式错误，尚未迁移。');
      }
      const result = saveModelSettingsSchema
        .extend({ apiKey: saveModelSettingsSchema.shape.apiKey.unwrap().min(1) })
        .safeParse(value);
      if (!result.success) throw new Error('旧版模型配置格式错误，尚未迁移。');
      this.save(result.data);
    }
    await unlink(path);
  }
}
