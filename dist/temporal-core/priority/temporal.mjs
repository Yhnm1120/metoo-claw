/**
 * Temporal Priority — 时间衰减优先级
 * 解决"1小时前说的和昨天说的在它眼里优先级一样"。
 */

export class TemporalPriority {
  constructor(customHalfLife = {}) {
    // 半衰期（秒）：过了一半时间，权重降一半
    this.halfLife = {
      user_explicit_request: 30 * 24 * 3600,  // 用户明确要求记住：30天
      active_project: 7 * 24 * 3600,          // 活跃项目：7天
      conversation: 24 * 3600,                // 普通对话：1天
      tool_output: 2 * 3600,                  // 工具输出：2小时
      system_state: 12 * 3600,                // 系统状态：12小时
      ...customHalfLife,
    };
  }

  /** 计算一条记忆的当前优先级分数 */
  rank(memoryItem, now = Date.now()) {
    const ageSec = (now - memoryItem.timestamp) / 1000;
    const halfLife = this.halfLife[memoryItem.category] || this.halfLife.conversation;
    
    const importance = memoryItem.user_flagged_importance || 1;
    const accessBoost = Math.log((memoryItem.access_count || 0) + 1);
    const decay = Math.exp(-ageSec / halfLife);
    
    return (importance + accessBoost) * decay;
  }

  /** 对记忆列表按当前优先级排序 */
  sortByPriority(memories, now = Date.now()) {
    return memories
      .map(m => ({ ...m, priority_score: this.rank(m, now) }))
      .sort((a, b) => b.priority_score - a.priority_score);
  }

  /** 筛选出当前还"鲜活"的记忆（分数高于阈值） */
  filterAlive(memories, threshold = 0.1, now = Date.now()) {
    return memories.filter(m => this.rank(m, now) >= threshold);
  }

  /** 估算一条记忆还有多久"半衰" */
  timeToHalfLife(memoryItem) {
    const halfLife = this.halfLife[memoryItem.category] || this.halfLife.conversation;
    const ageSec = (Date.now() - memoryItem.timestamp) / 1000;
    const remaining = halfLife - ageSec;
    return Math.max(0, remaining);
  }
}
