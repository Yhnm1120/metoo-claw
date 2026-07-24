/**
 * State Consistency Checker — 状态一致性检查器
 * 对比"配置的状态"和"实际运行的状态"，发现漂移自动纠偏或报警。
 * 解决 OpenClaw issue #112252（配置 thinkingLevel=max 但实际 thinking=off）。
 */

export class StateConsistencyChecker {
  constructor() {
    this.checks = [];
    this.lastReport = null;
  }

  /** 注册一个一致性检查项 */
  registerCheck(name, getConfigured, getActual, options = {}) {
    // getConfigured: () => value  从配置读
    // getActual: () => value      从运行时读
    // options.autoFix: (actual) => void  自动修复函数
    this.checks.push({
      name,
      getConfigured,
      getActual,
      autoFixable: !!options.autoFix,
      autoFix: options.autoFix,
      severity: options.severity || 'warning', // warning | critical
    });
  }

  /** 执行所有检查 */
  async runChecks() {
    const results = [];

    for (const check of this.checks) {
      try {
        const configured = await check.getConfigured();
        const actual = await check.getActual();
        const consistent = this.valuesEqual(configured, actual);

        const result = {
          name: check.name,
          consistent,
          configured,
          actual,
          severity: check.severity,
          autoFixable: check.autoFixable,
          fixed: false,
        };

        // 不一致且可自动修复 → 修复
        if (!consistent && check.autoFixable && check.autoFix) {
          try {
            await check.autoFix(configured);
            result.fixed = true;
            result.consistent = true;
          } catch (e) {
            result.fix_error = e.message;
          }
        }

        results.push(result);
      } catch (e) {
        results.push({
          name: check.name,
          consistent: null,
          error: e.message,
          severity: 'warning',
        });
      }
    }

    this.lastReport = {
      timestamp: Date.now(),
      total: results.length,
      consistent: results.filter(r => r.consistent === true).length,
      drifted: results.filter(r => r.consistent === false).length,
      errors: results.filter(r => r.consistent === null).length,
      details: results,
    };

    return this.lastReport;
  }

  valuesEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a === 'object' && typeof b === 'object') {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
  }

  /** 获取漂移项的报告文本 */
  formatDriftReport() {
    if (!this.lastReport) return '尚未执行检查';
    const drifted = this.lastReport.details.filter(r => r.consistent === false);
    if (drifted.length === 0) return '✅ 所有状态一致，无漂移';

    const lines = [`⚠️ 发现 ${drifted.length} 处状态漂移：`];
    for (const d of drifted) {
      lines.push(`- ${d.name}: 配置=${JSON.stringify(d.configured)} 实际=${JSON.stringify(d.actual)}${d.fixed ? '（已自动修复）' : ''}`);
    }
    return lines.join('\n');
  }
}
