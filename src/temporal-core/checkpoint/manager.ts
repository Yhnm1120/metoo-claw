/**
 * Session Checkpoint — 会话检查点
 * 每次关键操作后自动写入检查点，崩溃/重启后自动恢复。
 */

export interface Checkpoint {
  checkpoint_id: string;
  session_id: string;
  timestamp: number;
  type: 'user_message' | 'agent_reply' | 'tool_call' | 'state_change';
  summary: string;
  context_snapshot: {
    active_topics: string[];
    key_facts: string[];
    current_goal: string;
    active_intents: string[];
    recent_tools: string[];
    capability_state_hash: string;
  };
  model_state: {
    temperature?: number;
    system_prompt_hash: string;
  };
  delta_from_previous: string;
}

export interface CheckpointChain {
  session_id: string;
  checkpoints: Checkpoint[];
  last_checkpoint_id?: string;
  created_at: number;
  updated_at: number;
}

export class SessionCheckpointManager {
  private chain: CheckpointChain;
  private pendingWrites: Set<Promise<void>> = new Set();

  constructor(sessionId: string) {
    this.chain = {
      session_id: sessionId,
      checkpoints: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    };
  }

  /** 写入检查点（异步，不阻塞主流程） */
  writeCheckpoint(checkpoint: Omit<Checkpoint, 'checkpoint_id' | 'delta_from_previous'>): Promise<void> {
    const checkpointId = `ckpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const delta = this.calculateDelta(checkpoint);
    
    const fullCheckpoint: Checkpoint = {
      ...checkpoint,
      checkpoint_id: checkpointId,
      delta_from_previous: delta,
    };
    
    this.chain.checkpoints.push(fullCheckpoint);
    this.chain.last_checkpoint_id = checkpointId;
    this.chain.updated_at = Date.now();
    
    // 异步落盘，不阻塞
    const writePromise = this.persistCheckpoint(fullCheckpoint);
    this.pendingWrites.add(writePromise);
    writePromise.finally(() => this.pendingWrites.delete(writePromise));
    
    return writePromise;
  }

  /** 计算与上一个检查点的差异 */
  private calculateDelta(current: Omit<Checkpoint, 'checkpoint_id' | 'delta_from_previous'>): string {
    const last = this.chain.checkpoints[this.chain.checkpoints.length - 1];
    if (!last) return 'initial checkpoint';
    
    const changes: string[] = [];
    
    // 对比 key_facts
    const newFacts = current.context_snapshot.key_facts.filter(
      f => !last.context_snapshot.key_facts.includes(f)
    );
    if (newFacts.length > 0) {
      changes.push(`新增 facts: ${newFacts.join(', ')}`);
    }
    
    // 对比 active_topics
    const newTopics = current.context_snapshot.active_topics.filter(
      t => !last.context_snapshot.active_topics.includes(t)
    );
    if (newTopics.length > 0) {
      changes.push(`新增 topics: ${newTopics.join(', ')}`);
    }
    
    // 对比 current_goal
    if (current.context_snapshot.current_goal !== last.context_snapshot.current_goal) {
      changes.push(`goal 变更: ${last.context_snapshot.current_goal} → ${current.context_snapshot.current_goal}`);
    }
    
    return changes.length > 0 ? changes.join('; ') : 'no significant change';
  }

  /** 持久化到磁盘 */
  private async persistCheckpoint(checkpoint: Checkpoint): Promise<void> {
    // TODO: 写入 ~/.openclaw/checkpoints/{session_id}/{checkpoint_id}.json
    console.log('[checkpoint]', checkpoint.checkpoint_id, checkpoint.summary);
  }

  /** 崩溃恢复：读取最后一个检查点重建状态 */
  async recover(): Promise<Checkpoint | null> {
    // TODO: 从磁盘读取最新的 checkpoint
    return this.chain.checkpoints[this.chain.checkpoints.length - 1] || null;
  }

  /** 获取完整检查点链 */
  getChain(): CheckpointChain {
    return { ...this.chain };
  }

  /** 等待所有待写入完成 */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingWrites);
  }
}
