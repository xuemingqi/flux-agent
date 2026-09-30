import type { SkillInput, SkillUpdate, McpInput, McpUpdate } from '@flux-agent/contracts';
import type { SkillService } from '../skills/skill-service.js';
import { publicMcp, type McpService } from '../mcp/mcp-service.js';

/** 页面应用层：用户的管理动作直接调用基础能力，并转换为页面安全视图。 */
export class CapabilityPageService {
  constructor(
    private readonly skills: SkillService,
    private readonly mcps: McpService,
  ) {}

  listSkills() {
    return this.skills.list();
  }
  getSkill(name: string) {
    return this.skills.get(name);
  }
  createSkill(input: SkillInput) {
    return this.skills.create(input);
  }
  updateSkill(name: string, input: SkillUpdate) {
    return this.skills.update(name, input);
  }
  deleteSkill(name: string, version: number) {
    this.skills.delete(name, version);
    return { deleted: true };
  }
  importSkill(filename: string, content: string) {
    return this.skills.import(filename, content);
  }
  exportSkill(name: string) {
    return this.skills.export(name);
  }
  listMcps() {
    return this.mcps.list();
  }
  createMcp(input: McpInput) {
    return publicMcp(this.mcps.create(input));
  }
  updateMcp(name: string, input: McpUpdate) {
    return publicMcp(this.mcps.update(name, input));
  }
  deleteMcp(name: string, version: number) {
    this.mcps.delete(name, version);
    return { deleted: true };
  }
  testMcp(name: string, signal: AbortSignal) {
    return this.mcps.listTools(name, signal);
  }
}
