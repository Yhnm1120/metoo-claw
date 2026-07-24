/**
 * Capability Registry — 能力注册表（JavaScript 版本）
 */

export class CapabilityRegistry {
  constructor(agentId) {
    this.agentId = agentId;
    this.capabilities = new Map();
    this.permissionRules = [];
    this.identity = null;
  }

  register(entry) {
    this.capabilities.set(entry.id, entry);
  }

  registerAll(entries) {
    for (const entry of entries) this.register(entry);
  }

  unregister(id) {
    return this.capabilities.delete(id);
  }

  get(id) {
    return this.capabilities.get(id);
  }

  hasCapability(name) {
    return Array.from(this.capabilities.values()).some(c => c.name === name);
  }

  getAll() {
    return Array.from(this.capabilities.values());
  }

  getByType(type) {
    return this.getAll().filter(c => c.type === type);
  }

  checkPrerequisites(capabilityId, availablePrereqs) {
    const cap = this.get(capabilityId);
    if (!cap) return [`capability ${capabilityId} not found`];
    return cap.prerequisites.filter(p => !availablePrereqs.has(p));
  }

  toPromptDescription() {
    const lines = [];
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

  setIdentity(identity) {
    this.identity = identity;
  }

  addPermissionRule(rule) {
    this.permissionRules.push(rule);
  }

  getStats() {
    const all = this.getAll();
    return {
      total: all.length,
      available: all.filter(c => c.danger_level !== 'high').length,
      restricted: all.filter(c => c.danger_level === 'high').length,
      highRisk: all.filter(c => c.danger_level === 'high').length,
    };
  }
}
