/**
 * Capability Registry — 能力注册表
 * Agent 的"身份证"：知道自己是谁、有什么工具、能做什么、不能做什么。
 * 启动时全量注册，skill/plugin 变更时增量注册，用户可手动刷新。
 */

export interface CapabilityEntry {
  id: string;
  type: 'tool' | 'skill' | 'memory' | 'channel' | 'model';
  name: string;
  description: string;
  version?: string;
  prerequisites: string[];
  success_rate: number;
  avg_latency_ms: number;
  limitations: string[];
  danger_level: 'none' | 'low' | 'medium' | 'high';
  source: 'builtin' | 'skill_install' | 'plugin' | 'config';
  registered_at: string;
}

export interface PermissionRule {
  action: string;
  reason: string;
  requires_approval?: boolean;
  auto_fixable?: boolean;
}

export interface AgentIdentity {
  agent_id: string;
  name: string;
  role: string;
  personality: string;
  user_profile_ref: string;
}

export class CapabilityRegistry {
  private capabilities: Map<string, CapabilityEntry> = new Map();
  private permissionRules: PermissionRule[] = [];
  private identity: AgentIdentity | null = null;

  constructor(private readonly agentId: string) {}

  /** 注册一个能力 */
  register(entry: CapabilityEntry): void {
    this.capabilities.set(entry.id, entry);
  }

  /** 批量注册 */
  registerAll(entries: CapabilityEntry[]): void {
    for (const entry of entries) this.register(entry);
  }

  /** 注销一个能力 */
  unregister(id: string): boolean {
    return this.capabilities.delete(id);
  }

  /** 获取能力 */
  get(id: string): CapabilityEntry | undefined {
    return this.capabilities.get(id);
  }

  /** 检查能力是否存在且可用 */
  hasCapability(name: string): boolean {
    return Array.from(this.capabilities.values()).some(c => c.name === name);
  }

  /** 获取所有能力 */
  getAll(): CapabilityEntry[] {
    return Array.from(this.capabilities.values());
  }

  /** 按类型获取能力 */
  getByType(type: CapabilityEntry['type']): CapabilityEntry[] {
    return this.getAll().filter(c => c.type === type);
  }

  /** 检查前置条件是否满足 */
  checkPrerequisites(capabilityId: string, availablePrereqs: Set<string>): string[] {
    const cap = this.get(capabilityId);
    if (!cap) return [`capability ${capabilityId} not found`];
    return cap.prerequisites.filter(p => !availablePrereqs.has(p));
  }

  /** 获取能力描述（注入 system prompt 用） */
  toPromptDescription(): string {
    const lines: string[] = [];
    if (this.identity) {
      lines.push(`你是 ${this.identity.name}，${this.identity.role}。`);
      lines.push(`你的性格：${this.identity.personality}。`);
    }
    lines.push('你拥有以下能力：');
    for (const cap of this.getAll()) {
      const limits = cap.limitations.length > 0 ? `（限制：${cap.limitations.join('、')}）` : '';
      const danger = cap.danger_level === 'high' ? ' [高风险，需确认]' : '';
      lines.push(`- ${cap.name}: ${cap.description}${limits}${danger}`);
    }
    if (this.permissionRules.length > 0) {
      lines.push('你不能：');
      for (const rule of this.permissionRules) {
        lines.push(`- ${rule.action}（${rule.reason}）`);
      }
    }
    return lines.join('\n');
  }

  /** 设置身份信息 */
  setIdentity(identity: AgentIdentity): void {
    this.identity = identity;
  }

  /** 添加权限规则 */
  addPermissionRule(rule: PermissionRule): void {
    this.permissionRules.push(rule);
  }

  /** 获取统计信息 */
  getStats(): { total: number; available: number; restricted: number; highRisk: number } {
    const all = this.getAll();
    return {
      total: all.length,
      available: all.filter(c => c.danger_level !== 'high').length,
      restricted: all.filter(c => c.danger_level === 'high').length,
      highRisk: all.filter(c => c.danger_level === 'high').length,
    };
  }
}

/** 从配置文件加载能力注册表 */
export async function loadCapabilityRegistryFromConfig(
  configPath: string,
  agentId: string
): Promise<CapabilityRegistry> {
  const registry = new CapabilityRegistry(agentId);
  // TODO: 从 openclaw.json + skill 目录扫描加载
  return registry;
}
