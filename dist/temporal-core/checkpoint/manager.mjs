/**
 * Session Checkpoint — 会话检查点（JavaScript 版本）
 */

export class SessionCheckpointManager {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.chain = {
      session_id: sessionId,
      checkpoints: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    this.pendingWrites = new Set();
  }

  writeCheckpoint(checkpoint) {
    const checkpointId = `ckpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const delta = this.calculateDelta(checkpoint);
    
    const fullCheckpoint = {
      ...checkpoint,
      checkpoint_id: checkpointId,
      delta_from_previous: delta,
    };
    
    this.chain.checkpoints.push(fullCheckpoint);
    this.chain.last_checkpoint_id = checkpointId;
    this.chain.updated_at = Date.now();
    
    const writePromise = this.persistCheckpoint(fullCheckpoint);
    this.pendingWrites.add(writePromise);
    writePromise.finally(() => this.pendingWrites.delete(writePromise));
    
    return writePromise;
  }

  calculateDelta(current) {
    const last = this.chain.checkpoints[this.chain.checkpoints.length - 1];
    if (!last) return 'initial checkpoint';
    
    const changes = [];
    
    const newFacts = current.context_snapshot.key_facts.filter(
      f => !last.context_snapshot.key_facts.includes(f)
    );
    if (newFacts.length > 0) {
      changes.push(`新增 facts: ${newFacts.join(', ')}`);
    }
    
    const newTopics = current.context_snapshot.active_topics.filter(
      t => !last.context_snapshot.active_topics.includes(t)
    );
    if (newTopics.length > 0) {
      changes.push(`新增 topics: ${newTopics.join(', ')}`);
    }
    
    if (current.context_snapshot.current_goal !== last.context_snapshot.current_goal) {
      changes.push(`goal 变更: ${last.context_snapshot.current_goal} → ${current.context_snapshot.current_goal}`);
    }
    
    return changes.length > 0 ? changes.join('; ') : 'no significant change';
  }

  async persistCheckpoint(checkpoint) {
    console.log('[checkpoint]', checkpoint.checkpoint_id, checkpoint.summary);
  }

  async recover() {
    return this.chain.checkpoints[this.chain.checkpoints.length - 1] || null;
  }

  getChain() {
    return { ...this.chain };
  }

  async flush() {
    await Promise.allSettled(this.pendingWrites);
  }
}
