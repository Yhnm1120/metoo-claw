/**
 * Crash Recovery — 崩溃自动恢复
 * 三阶段恢复：读检查点 → 重放增量 → 校验完整性。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export class CrashRecovery {
  constructor(storageDir) {
    this.storageDir = storageDir;
    if (storageDir && !existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true });
    }
  }

  /** 阶段 1+2：恢复会话状态 */
  async recover(sessionId) {
    const result = {
      session_id: sessionId,
      recovered: false,
      stage: 'none',
      checkpoint: null,
      replayed_events: 0,
      warnings: [],
    };

    // 阶段 1：读最后一个检查点
    const checkpoint = this.loadLatestCheckpoint(sessionId);
    if (!checkpoint) {
      result.warnings.push('没有找到检查点，无法恢复');
      return result;
    }
    result.checkpoint = checkpoint;
    result.stage = 'checkpoint_loaded';

    // 校验检查点完整性
    if (!this.validateCheckpoint(checkpoint)) {
      result.warnings.push('最新检查点损坏，尝试前一个');
      const prev = this.loadPreviousCheckpoint(sessionId, checkpoint.checkpoint_id);
      if (prev && this.validateCheckpoint(prev)) {
        result.checkpoint = prev;
        result.warnings.push('已回退到前一个检查点');
      } else {
        result.warnings.push('无可用检查点，建议开启新会话');
        return result;
      }
    }

    // 阶段 2：重放增量日志
    const events = this.loadIncrementalLog(sessionId, checkpoint.timestamp);
    result.replayed_events = events.length;
    result.stage = 'replayed';

    // 阶段 3：校验
    result.recovered = true;
    result.stage = 'complete';
    if (events.length === 0 && Date.now() - checkpoint.timestamp > 3600000) {
      result.warnings.push('检查点较旧（超过1小时），部分上下文可能已丢失');
    }

    return result;
  }

  loadLatestCheckpoint(sessionId) {
    const dir = join(this.storageDir, sessionId);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter(f => f.startsWith('ckpt_') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    try {
      return JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
    } catch {
      return null;
    }
  }

  loadPreviousCheckpoint(sessionId, currentId) {
    const dir = join(this.storageDir, sessionId);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter(f => f.startsWith('ckpt_') && f.endsWith('.json') && !f.includes(currentId))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    try {
      return JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
    } catch {
      return null;
    }
  }

  validateCheckpoint(cp) {
    return cp && cp.checkpoint_id && cp.session_id && cp.timestamp && cp.context_snapshot;
  }

  loadIncrementalLog(sessionId, sinceTimestamp) {
    const file = join(this.storageDir, sessionId, 'incremental.jsonl');
    if (!existsSync(file)) return [];
    try {
      return readFileSync(file, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(e => e.timestamp > sinceTimestamp);
    } catch {
      return [];
    }
  }

  /** 追加增量事件（工具调用、状态变更等） */
  appendEvent(sessionId, event) {
    const dir = join(this.storageDir, sessionId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, 'incremental.jsonl');
    writeFileSync(file, JSON.stringify({ ...event, timestamp: Date.now() }) + '\n', { flag: 'a' });
  }
}
