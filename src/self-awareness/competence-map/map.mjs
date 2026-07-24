/**
 * Competence Map — 能力地图
 * Agent 知道自己擅长什么、不擅长什么，动态更新。
 */

export class CompetenceMap {
  constructor() {
    this.domains = new Map(); // domain -> { confidence, evidence, note, reason, fallback, no_fallback }
    this.history = []; // 任务结果记录，用于动态调整
  }

  /** 设置领域能力 */
  setDomain(domain, level, meta = {}) {
    // level: 'high' | 'medium' | 'low' | 'incompetent'
    const defaults = {
      high: { confidence: 0.9 },
      medium: { confidence: 0.7 },
      low: { confidence: 0.4 },
      incompetent: { confidence: 0 },
    };
    this.domains.set(domain, {
      level,
      ...defaults[level],
      ...meta,
    });
  }

  /** 记录一次任务结果，动态调整信心分 */
  recordOutcome(domain, success, detail = '') {
    this.history.push({ domain, success, detail, timestamp: Date.now() });
    
    const entry = this.domains.get(domain);
    if (!entry || entry.level === 'incompetent') return;

    // 动态调整：成功 +0.02，失败 -0.05，范围 [0, 1]
    const delta = success ? 0.02 : -0.05;
    entry.confidence = Math.max(0, Math.min(1, entry.confidence + delta));

    // 根据信心分自动调整 level
    if (entry.confidence >= 0.85) entry.level = 'high';
    else if (entry.confidence >= 0.6) entry.level = 'medium';
    else if (entry.confidence < 0.3) entry.level = 'low';
  }

  /** 判断某领域是否胜任 */
  isCompetent(domain, threshold = 0.6) {
    const entry = this.domains.get(domain);
    if (!entry) return { competent: false, reason: '未知领域，未评估过' };
    if (entry.level === 'incompetent') {
      return {
        competent: false,
        reason: entry.reason || '明确不能做的领域',
        no_fallback: entry.no_fallback,
      };
    }
    if (entry.confidence < threshold) {
      return {
        competent: false,
        reason: entry.note || `信心不足 (${(entry.confidence * 100).toFixed(0)}%)`,
        fallback: entry.fallback,
      };
    }
    return { competent: true, confidence: entry.confidence };
  }

  /** 生成能力描述（注入 prompt 用） */
  toPromptDescription() {
    const lines = ['你的能力地图：'];
    const byLevel = { high: [], medium: [], low: [], incompetent: [] };
    
    for (const [domain, entry] of this.domains) {
      byLevel[entry.level].push({ domain, ...entry });
    }

    if (byLevel.high.length) {
      lines.push('擅长：' + byLevel.high.map(d => d.domain).join('、'));
    }
    if (byLevel.medium.length) {
      lines.push('可以做：' + byLevel.medium.map(d => d.domain).join('、'));
    }
    if (byLevel.low.length) {
      lines.push('不擅长（建议替代方案）：');
      for (const d of byLevel.low) {
        lines.push(`  - ${d.domain}${d.fallback ? ` → 建议: ${d.fallback}` : ''}`);
      }
    }
    if (byLevel.incompetent.length) {
      lines.push('不能做：');
      for (const d of byLevel.incompetent) {
        lines.push(`  - ${d.domain}（${d.reason || '策略禁止'}）`);
      }
    }
    return lines.join('\n');
  }

  getStats() {
    const all = Array.from(this.domains.values());
    return {
      total_domains: all.length,
      high: all.filter(e => e.level === 'high').length,
      medium: all.filter(e => e.level === 'medium').length,
      low: all.filter(e => e.level === 'low').length,
      incompetent: all.filter(e => e.level === 'incompetent').length,
      history_size: this.history.length,
    };
  }
}
