/**
 * Reflection Engine — 执行后自我报告
 * 工具调用失败后自动诊断原因，给出建议。
 */

export class ReflectionEngine {
  constructor() {
    this.failureCounts = new Map(); // tool -> consecutive failure count
  }

  /** 分析一次工具调用结果 */
  analyze(toolCall, result) {
    const failureType = this.classifyFailure(result);

    if (failureType === 'success') {
      this.failureCounts.set(toolCall.name, 0);
      return { success: true };
    }

    // 连续失败计数
    const count = (this.failureCounts.get(toolCall.name) || 0) + 1;
    this.failureCounts.set(toolCall.name, count);

    const report = {
      success: false,
      tool: toolCall.name,
      failure_type: failureType,
      consecutive_failures: count,
      diagnosis: '',
      suggestions: [],
      should_retry: false,
      should_escalate: false,
    };

    switch (failureType) {
      case 'permission_denied':
        report.diagnosis = `权限不足: ${result.error || '操作被拒绝'}`;
        report.suggestions = [
          '检查文件/目录权限设置',
          '该操作可能需要用户手动执行',
        ];
        break;

      case 'network_timeout':
        report.diagnosis = `网络超时: ${result.error || '连接超时'}`;
        report.suggestions = [
          '目标站点可能反爬或不可达',
          '换一个数据源试试',
          '稍后重试',
        ];
        report.should_retry = count < 2;
        break;

      case 'rate_limited':
        report.diagnosis = '触发频率限制';
        report.suggestions = ['等待一分钟后重试', '降低请求频率'];
        report.should_retry = true;
        report.retry_after_ms = 60000;
        break;

      case 'not_found':
        report.diagnosis = `资源不存在: ${result.error || ''}`;
        report.suggestions = ['检查路径/参数是否正确', '目标可能已被删除或移动'];
        break;

      case 'invalid_params':
        report.diagnosis = `参数错误: ${result.error || ''}`;
        report.suggestions = ['检查参数格式和类型', '查看工具文档确认参数要求'];
        break;

      case 'consecutive_failures':
        report.diagnosis = `工具 "${toolCall.name}" 连续失败 ${count} 次，可能暂时不可用`;
        report.suggestions = [
          '换用完全不同的方案完成任务',
          '告知用户该工具当前不可用，建议手动处理',
        ];
        report.should_escalate = true;
        break;

      default:
        report.diagnosis = `未知错误: ${result.error || '未分类的失败'}`;
        report.suggestions = ['重试一次', '如仍失败则换方案'];
        report.should_retry = count < 2;
    }

    // 连续失败 3 次自动升级
    if (count >= 3 && !report.should_escalate) {
      report.should_escalate = true;
      report.diagnosis += `（已连续失败 ${count} 次）`;
    }

    return report;
  }

  classifyFailure(result) {
    if (!result || result.success !== false) return 'success';
    const err = (result.error || '').toLowerCase();
    const code = result.code || result.status;

    if (code === 403 || err.includes('permission') || err.includes('denied') || err.includes('forbidden'))
      return 'permission_denied';
    if (code === 404 || err.includes('not found') || err.includes('no such'))
      return 'not_found';
    if (code === 429 || err.includes('rate limit') || err.includes('too many'))
      return 'rate_limited';
    if (err.includes('timeout') || err.includes('timed out') || err.includes('econnrefused') || err.includes('network'))
      return 'network_timeout';
    if (code === 400 || err.includes('invalid') || err.includes('bad request') || err.includes('参数'))
      return 'invalid_params';
    
    return 'unknown';
  }

  /** 格式化报告给用户看 */
  formatReport(report) {
    if (report.success) return null;
    const lines = [`⚠️ ${report.tool} 执行失败`, `诊断：${report.diagnosis}`];
    if (report.suggestions.length > 0) {
      lines.push('建议：');
      report.suggestions.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }
    return lines.join('\n');
  }
}
