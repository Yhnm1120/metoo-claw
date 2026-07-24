/**
 * Incremental Compaction — 增量压缩
 * 解决 OpenClaw issue #92043：180s 超时死循环。
 * 核心思想：每个 chunk 完成立即落盘，超时后从断点续跑。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class IncrementalCompactor {
  constructor(storageDir, config = {}) {
    this.storageDir = storageDir;
    this.timeoutMs = config.timeoutMs || 180000;
    this.estimatedChunkMs = config.estimatedChunkMs || 15000;
    if (storageDir && !existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true });
    }
  }

  /** 增量压缩主流程 */
  async compact(sessionId, chunks, summarizeFn) {
    const progressFile = this.getProgressFile(sessionId);
    const progress = this.loadProgress(progressFile);
    const startTime = Date.now();
    const completed = [...progress.completed];

    for (let i = progress.nextIndex; i < chunks.length; i++) {
      const chunk = chunks[i];

      // 跳过已完成的（断点续跑）
      if (progress.completedIds.includes(chunk.id)) {
        continue;
      }

      // 时间预算检查：不够做下一个 chunk 就保存进度退出
      const elapsed = Date.now() - startTime;
      const remaining = this.timeoutMs - elapsed;
      if (remaining < this.estimatedChunkMs) {
        this.saveProgress(progressFile, {
          completedIds: completed.map(c => c.chunk_id),
          nextIndex: i,
          completed,
          updated_at: Date.now(),
        });
        return {
          status: 'partial',
          completed: completed.length,
          remaining: chunks.length - completed.length,
          resume_hint: `已保存进度，下次从第 ${i + 1} 块继续`,
          partial_summary: this.mergeSummaries(completed),
        };
      }

      // 处理当前 chunk（带单块超时保护）
      try {
        const summary = await this.withTimeout(
          summarizeFn(chunk, remaining),
          remaining
        );
        const record = { chunk_id: chunk.id, summary, completed_at: Date.now() };
        completed.push(record);
        // 每个 chunk 完成立即落盘
        this.saveChunkSummary(sessionId, record);
      } catch (e) {
        // 单块失败不致命：记录并继续
        completed.push({
          chunk_id: chunk.id,
          summary: `[本块压缩失败: ${e.message}]`,
          failed: true,
          completed_at: Date.now(),
        });
      }
    }

    // 全部完成
    this.clearProgress(progressFile);
    return {
      status: 'complete',
      completed: completed.length,
      summary: this.mergeSummaries(completed),
    };
  }

  mergeSummaries(completed) {
    return completed
      .map(c => c.summary)
      .filter(Boolean)
      .join('\n\n');
  }

  withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`chunk timeout after ${ms}ms`)), ms)
      ),
    ]);
  }

  getProgressFile(sessionId) {
    return join(this.storageDir, `${sessionId}.progress.json`);
  }

  saveChunkSummary(sessionId, record) {
    const file = join(this.storageDir, `${sessionId}.chunks.jsonl`);
    writeFileSync(file, JSON.stringify(record) + '\n', { flag: 'a' });
  }

  loadProgress(file) {
    if (!existsSync(file)) {
      return { completedIds: [], nextIndex: 0, completed: [] };
    }
    try {
      return JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      return { completedIds: [], nextIndex: 0, completed: [] };
    }
  }

  saveProgress(file, progress) {
    writeFileSync(file, JSON.stringify(progress, null, 2));
  }

  clearProgress(file) {
    if (existsSync(file)) {
      writeFileSync(file, JSON.stringify({ completedIds: [], nextIndex: 0, completed: [] }));
    }
  }
}
