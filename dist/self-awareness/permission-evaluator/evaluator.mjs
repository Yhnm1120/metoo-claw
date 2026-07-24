/**
 * Permission Evaluator — 权限评估器
 * 每次工具调用前检查资格：事前拦截，不是事后报错。
 */

export class PermissionEvaluator {
  constructor(capabilityRegistry) {
    this.registry = capabilityRegistry;
    this.rateLimits = new Map(); // tool -> { count, resetAt }
    this.defaultRateLimit = { maxCalls: 30, windowMs: 60000 };
  }

  evaluate(toolCall, agentState = {}) {
    const cap = this.registry.get(toolCall.name) 
      || this.findByName(toolCall.name);

    // 1. 工具是否存在
    if (!cap) {
      return {
        allowed: false,
        reason: `工具 "${toolCall.name}" 未注册，不可用`,
        alternatives: this.findAlternatives(toolCall.name),
      };
    }

    // 2. 前置条件检查（只检查明确传入的 agentState 中标记为缺失的）
    const missing = (agentState.missingPrerequisites || []).filter(p => cap.prerequisites.includes(p));
    if (missing.length > 0) {
      return {
        allowed: false,
        reason: `缺少前置条件: ${missing.join(', ')}`,
      };
    }

    // 3. 危险操作检查
    if (cap.danger_level === 'high' && !agentState.userApproved) {
      return {
        allowed: false,
        requiresApproval: true,
        reason: `高风险操作需要用户确认: ${cap.description}`,
      };
    }

    // 4. 禁止规则检查
    const rule = this.registry.permissionRules.find(
      r => r.action === toolCall.name
    );
    if (rule) {
      return {
        allowed: false,
        reason: `安全策略禁止: ${rule.reason}`,
      };
    }

    // 5. 频率限制
    if (!this.checkRateLimit(toolCall.name)) {
      return {
        allowed: false,
        reason: '频率限制，请稍后重试',
        retryAfterMs: this.getRateLimitResetIn(toolCall.name),
      };
    }

    return { allowed: true };
  }

  findByName(name) {
    return this.registry.getAll().find(c => c.name === name);
  }

  findAlternatives(name) {
    // 简单实现：返回同类型的其他能力
    const cap = this.findByName(name);
    if (!cap) return this.registry.getAll().slice(0, 3).map(c => c.name);
    return this.registry.getByType(cap.type)
      .filter(c => c.name !== name)
      .map(c => c.name)
      .slice(0, 3);
  }

  checkRateLimit(toolName) {
    const now = Date.now();
    const limit = this.rateLimits.get(toolName);
    if (!limit || now > limit.resetAt) {
      this.rateLimits.set(toolName, {
        count: 1,
        resetAt: now + this.defaultRateLimit.windowMs,
      });
      return true;
    }
    if (limit.count >= this.defaultRateLimit.maxCalls) return false;
    limit.count++;
    return true;
  }

  getRateLimitResetIn(toolName) {
    const limit = this.rateLimits.get(toolName);
    if (!limit) return 0;
    return Math.max(0, limit.resetAt - Date.now());
  }
}
