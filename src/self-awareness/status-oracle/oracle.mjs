/**
 * Status Oracle — 状态先知
 * 让 Agent 和用户随时知道系统当前的真实状态。
 */

export class StatusOracle {
  constructor(components = {}) {
    // components: { registry, competenceMap, intentTracker, learningLoop, checkpoint, watcher }
    this.components = components;
    this.startTime = Date.now();
  }

  /** 生成完整状态报告 */
  getStatus() {
    const { registry, competenceMap, intentTracker, learningLoop, checkpoint } = this.components;

    const status = {
      uptime_ms: Date.now() - this.startTime,
      timestamp: new Date().toISOString(),
      identity: registry?.identity || null,
      capabilities: registry ? registry.getStats() : null,
      competence: competenceMap ? competenceMap.getStats() : null,
      active_intents: intentTracker ? intentTracker.getActiveIntents().length : 0,
      learning: learningLoop ? learningLoop.getStats() : null,
      session: checkpoint ? {
        checkpoints: checkpoint.getChain().checkpoints.length,
        last_checkpoint: checkpoint.getChain().last_checkpoint_id || null,
      } : null,
      health: this.assessHealth(),
    };
    return status;
  }

  assessHealth() {
    const { registry } = this.components;
    if (!registry) return 'unknown';
    const stats = registry.getStats();
    if (stats.total === 0) return 'degraded'; // 没有注册任何能力
    return 'healthy';
  }

  /** 格式化文本报告（/status 命令用） */
  formatReport() {
    const s = this.getStatus();
    const lines = ['📊 系统状态报告', ''];

    if (s.identity) {
      lines.push(`身份: ${s.identity.name} — ${s.identity.role}`);
    }
    if (s.capabilities) {
      lines.push(`能力: 共 ${s.capabilities.total} 个，可用 ${s.capabilities.available} 个，受限 ${s.capabilities.restricted} 个`);
    }
    if (s.competence) {
      lines.push(`能力地图: 擅长 ${s.competence.high} 项，一般 ${s.competence.medium} 项，不擅长 ${s.competence.low} 项，不能做 ${s.competence.incompetent} 项`);
    }
    lines.push(`活跃意图: ${s.active_intents} 个`);
    if (s.session) {
      lines.push(`会话: ${s.session.checkpoints} 个检查点`);
    }
    lines.push(`运行时长: ${Math.round(s.uptime_ms / 60000)} 分钟`);
    lines.push(`健康: ${s.health === 'healthy' ? '✅ 良好' : s.health === 'degraded' ? '⚠️ 降级' : '❓ 未知'}`);

    return lines.join('\n');
  }
}
