/**
 * Context Window Manager — 上下文窗口管理
 * 分层压缩策略：超限时不丢关键信息。
 */

export class ContextWindowManager {
  constructor(config = {}) {
    this.limits = {
      totalTokens: config.totalTokens || 128000,
      fixedHeader: config.fixedHeader || 8000,      // 系统指令+用户画像+当前意图
      coreContext: config.coreContext || 40000,     // 最近对话+高优先级记忆
      compressedZone: config.compressedZone || 60000, // 历史摘要
      recyclable: config.recyclable || 20000,       // 可回收区
    };
    this.usageThreshold = config.usageThreshold || 0.9; // 90% 触发压缩
  }

  /** 估算文本 token 数（粗略：中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token） */
  estimateTokens(text) {
    if (!text) return 0;
    const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const other = text.length - chinese;
    return chinese + Math.ceil(other / 4);
  }

  /** 检查当前使用量并返回建议动作 */
  checkUsage(currentTokens) {
    const usage = currentTokens / this.limits.totalTokens;
    if (usage >= 1.0) return { action: 'emergency', usage };
    if (usage >= this.usageThreshold) return { action: 'compress', usage };
    if (usage >= 0.75) return { action: 'trim_recyclable', usage };
    return { action: 'ok', usage };
  }

  /** 分层处理上下文 */
  manage(context) {
    // context: { header, core, compressed, recyclable }
    const tokens = {
      header: this.estimateTokens(context.header || ''),
      core: this.estimateTokens(context.core || ''),
      compressed: this.estimateTokens(context.compressed || ''),
      recyclable: this.estimateTokens(context.recyclable || ''),
    };
    const total = Object.values(tokens).reduce((a, b) => a + b, 0);
    const check = this.checkUsage(total);

    const result = {
      action: check.action,
      usage: check.usage,
      tokens,
      context: { ...context },
      dropped: [],
    };

    // 第 1 步：裁可回收区（零损失）
    if (check.action !== 'ok' && tokens.recyclable > 0) {
      result.dropped.push({ zone: 'recyclable', tokens: tokens.recyclable });
      result.context.recyclable = '';
      tokens.recyclable = 0;
    }

    // 第 2 步：压缩区超限 → 标记需要 LLM 重写摘要
    const newTotal = Object.values(tokens).reduce((a, b) => a + b, 0);
    if (newTotal / this.limits.totalTokens >= this.usageThreshold) {
      result.needs_summarization = true;
      result.summarize_target = 'compressed';
    }

    // 第 3 步：还不够 → 最旧的核心上下文降级
    if (newTotal / this.limits.totalTokens >= 1.0) {
      result.needs_core_demotion = true;
    }

    // 紧急情况
    if (check.action === 'emergency') {
      result.emergency = true;
      result.advice = '建议立即写检查点并考虑开启新会话';
    }

    return result;
  }
}
