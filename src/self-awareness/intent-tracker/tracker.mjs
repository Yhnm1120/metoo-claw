/**
 * Intent Tracker — 意图持久化
 * 跨会话追踪用户的长期意图，防止"说到一半忘了要干嘛"。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class IntentTracker {
  constructor(storageDir) {
    this.storageDir = storageDir;
    this.intents = new Map();
    if (storageDir && !existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true });
    }
    this.load();
  }

  /** 创建新意图 */
  createIntent(originalRequest, context = {}) {
    const intentId = `int_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const intent = {
      intent_id: intentId,
      original_request: originalRequest,
      created_at: Date.now(),
      status: 'in_progress', // in_progress | completed | abandoned
      progress: {
        completed_steps: [],
        current_step: null,
        pending_steps: [],
      },
      checkpoints: [],
      context_refs: context.refs || [],
      last_active_at: Date.now(),
    };
    this.intents.set(intentId, intent);
    this.save();
    return intentId;
  }

  /** 更新意图进度 */
  updateProgress(intentId, update) {
    const intent = this.intents.get(intentId);
    if (!intent) return false;

    if (update.complete_step) {
      intent.progress.completed_steps.push({
        step: update.complete_step,
        completed_at: Date.now(),
      });
      if (intent.progress.current_step?.step === update.complete_step) {
        intent.progress.current_step = null;
      }
    }
    if (update.start_step) {
      intent.progress.current_step = { step: update.start_step, started_at: Date.now() };
    }
    if (update.add_pending) {
      intent.progress.pending_steps.push(update.add_pending);
    }
    if (update.checkpoint) {
      intent.checkpoints.push({ ...update.checkpoint, timestamp: Date.now() });
    }
    intent.last_active_at = Date.now();
    this.save();
    return true;
  }

  /** 完成意图 */
  completeIntent(intentId) {
    const intent = this.intents.get(intentId);
    if (!intent) return false;
    intent.status = 'completed';
    intent.completed_at = Date.now();
    this.save();
    return true;
  }

  /** 获取活跃意图（新会话启动时调用） */
  getActiveIntents(maxAgeMs = 7 * 24 * 3600 * 1000) {
    const now = Date.now();
    return Array.from(this.intents.values())
      .filter(i => i.status === 'in_progress' && (now - i.last_active_at) < maxAgeMs)
      .sort((a, b) => b.last_active_at - a.last_active_at);
  }

  /** 生成会话恢复提示（新会话开场白） */
  getResumeHint() {
    const active = this.getActiveIntents();
    if (active.length === 0) return null;
    const latest = active[0];
    const current = latest.progress.current_step;
    return {
      intent: latest.original_request,
      progress: `已完成 ${latest.progress.completed_steps.length} 步`,
      current_step: current ? current.step : null,
      hint: current
        ? `上次我们在做「${latest.original_request}」，进行到「${current.step}」，要继续吗？`
        : `上次我们在做「${latest.original_request}」，要继续吗？`,
    };
  }

  get(intentId) {
    return this.intents.get(intentId);
  }

  save() {
    if (!this.storageDir) return;
    const file = join(this.storageDir, 'intents.json');
    const data = Array.from(this.intents.values());
    writeFileSync(file, JSON.stringify(data, null, 2));
  }

  load() {
    if (!this.storageDir) return;
    const file = join(this.storageDir, 'intents.json');
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      for (const intent of data) {
        this.intents.set(intent.intent_id, intent);
      }
    } catch { /* 损坏则从空开始 */ }
  }
}
