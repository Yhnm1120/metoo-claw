/**
 * Hard Boundary Declarer — 自我边界声明
 * 事前主动声明不能做什么，而不是调用失败才报错。
 */

export class HardBoundaryDeclarer {
  constructor(capabilityRegistry, competenceMap) {
    this.registry = capabilityRegistry;
    this.competenceMap = competenceMap;
  }

  /** 检查请求是否触碰硬边界，返回声明文本（没触碰返回 null） */
  declare(requestText) {
    const lower = requestText.toLowerCase();

    // 1. 检查权限规则（禁止类）
    for (const rule of this.registry.permissionRules) {
      if (this.matches(lower, rule.action)) {
        return {
          blocked: true,
          type: 'permission',
          declaration: `我不能${rule.action}——${rule.reason}。`,
          suggestion: this.suggestAlternative(rule.action),
        };
      }
    }

    // 2. 检查能力地图（不能做类）
    for (const [domain, entry] of this.competenceMap.domains) {
      if (entry.level === 'incompetent' && this.matches(lower, domain)) {
        return {
          blocked: true,
          type: 'incompetent',
          declaration: `这件事我做不了：${domain}（${entry.reason || '超出能力范围'}）。`,
          suggestion: entry.no_fallback ? null : (entry.fallback || null),
        };
      }
    }

    // 3. 检查能力地图（不擅长类）— 不拦截，但提示
    for (const [domain, entry] of this.competenceMap.domains) {
      if (entry.level === 'low' && this.matches(lower, domain)) {
        return {
          blocked: false,
          type: 'low_confidence',
          declaration: `这个我不是最擅长（信心 ${(entry.confidence * 100).toFixed(0)}%），可以试试，但${entry.fallback ? `更建议：${entry.fallback}` : '效果可能一般'}。`,
        };
      }
    }

    return null;
  }

  matches(text, keyword) {
    // 简单匹配：包含关键词或其分词
    const cleaned = keyword.replace(/^(delete_|modify_|send_)/, '').replace(/_/g, ' ');
    return text.includes(keyword) || text.includes(cleaned) ||
           text.includes(this.toChineseHint(keyword));
  }

  toChineseHint(action) {
    // 常见动作的中文提示词映射
    const hints = {
      delete_email: '删除邮件',
      modify_config: '修改配置',
      send_message: '发消息',
      delete: '删除',
    };
    return hints[action] || action;
  }

  suggestAlternative(action) {
    const alternatives = {
      delete_email: '我可以帮你把邮件标记为垃圾邮件，或告诉你手动删除的步骤',
    };
    return alternatives[action] || '我可以帮你找替代方案';
  }

  /** 生成完整边界声明（注入 prompt 用） */
  toPromptDescription() {
    const lines = ['你的硬边界（绝不能做）：'];
    for (const rule of this.registry.permissionRules) {
      lines.push(`- ${rule.action}：${rule.reason}`);
    }
    for (const [domain, entry] of this.competenceMap.domains) {
      if (entry.level === 'incompetent') {
        lines.push(`- ${domain}：${entry.reason || '超出能力范围'}`);
      }
    }
    return lines.join('\n');
  }
}
