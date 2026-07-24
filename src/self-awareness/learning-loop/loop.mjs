/**
 * Learning Loop — 学习反馈
 * 记录工具使用效果，优化后续选择。越用越聪明。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class LearningLoop {
  constructor(storageDir) {
    this.storageDir = storageDir;
    this.toolStats = new Map(); // tool -> stats
    this.combinations = new Map(); // sequence_key -> stats
    this.preferences = new Map(); // key -> value
    if (storageDir && !existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true });
    }
    this.load();
  }

  /** 记录一次工具使用结果 */
  recordToolUse(toolName, success, latencyMs, context = '') {
    if (!this.toolStats.has(toolName)) {
      this.toolStats.set(toolName, {
        total: 0, success: 0, failure: 0,
        total_latency: 0, failures_by_reason: {},
        contexts: {},
      });
    }
    const stats = this.toolStats.get(toolName);
    stats.total++;
    stats.total_latency += latencyMs;
    if (success) {
      stats.success++;
    } else {
      stats.failure++;
      if (context) {
        stats.failures_by_reason[context] = (stats.failures_by_reason[context] || 0) + 1;
      }
    }
    if (context) {
      stats.contexts[context] = stats.contexts[context] || { total: 0, success: 0 };
      stats.contexts[context].total++;
      if (success) stats.contexts[context].success++;
    }
    this.save();
  }

  /** 记录工具组合使用效果 */
  recordCombination(toolSequence, success, taskType = '') {
    const key = toolSequence.join('->');
    if (!this.combinations.has(key)) {
      this.combinations.set(key, { uses: 0, success: 0, tasks: {} });
    }
    const stats = this.combinations.get(key);
    stats.uses++;
    if (success) stats.success++;
    if (taskType) {
      stats.tasks[taskType] = (stats.tasks[taskType] || 0) + 1;
    }
    this.save();
  }

  /** 工具评分：用于在多个工具间选择 */
  scoreTool(toolName, context = '') {
    const stats = this.toolStats.get(toolName);
    if (!stats || stats.total === 0) return 0.5; // 没用过给中性分

    let score = stats.success / stats.total;

    // 有上下文数据时，优先用上下文成功率
    if (context && stats.contexts[context] && stats.contexts[context].total >= 3) {
      const ctxScore = stats.contexts[context].success / stats.contexts[context].total;
      score = score * 0.3 + ctxScore * 0.7;
    }

    // 延迟惩罚：超过 10s 的工具降分
    const avgLatency = stats.total_latency / stats.total;
    if (avgLatency > 10000) score *= 0.9;

    return score;
  }

  /** 在候选工具中选最优 */
  selectBestTool(candidates, context = '') {
    if (candidates.length === 0) return null;
    return candidates
      .map(name => ({ name, score: this.scoreTool(name, context) }))
      .sort((a, b) => b.score - a.score)[0];
  }

  /** 学习用户偏好 */
  learnPreference(key, value) {
    this.preferences.set(key, value);
    this.save();
  }

  getPreference(key) {
    return this.preferences.get(key);
  }

  /** 获取统计概览 */
  getStats() {
    const tools = {};
    for (const [name, s] of this.toolStats) {
      tools[name] = {
        success_rate: s.total > 0 ? (s.success / s.total).toFixed(2) : 'n/a',
        total_uses: s.total,
        avg_latency_ms: s.total > 0 ? Math.round(s.total_latency / s.total) : 0,
      };
    }
    return {
      tools,
      combinations_tracked: this.combinations.size,
      preferences_learned: this.preferences.size,
    };
  }

  save() {
    if (!this.storageDir) return;
    const file = join(this.storageDir, 'learning.json');
    writeFileSync(file, JSON.stringify({
      tools: Object.fromEntries(this.toolStats),
      combinations: Object.fromEntries(this.combinations),
      preferences: Object.fromEntries(this.preferences),
    }, null, 2));
  }

  load() {
    if (!this.storageDir) return;
    const file = join(this.storageDir, 'learning.json');
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      this.toolStats = new Map(Object.entries(data.tools || {}));
      this.combinations = new Map(Object.entries(data.combinations || {}));
      this.preferences = new Map(Object.entries(data.preferences || {}));
    } catch { /* 损坏则从空开始 */ }
  }
}
