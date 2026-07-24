/**
 * Temporal Core — 时序核心入口
 * 整合所有"记住、恢复、不丢"的模块。
 */

import { SessionCheckpointManager } from './checkpoint/manager';

export { SessionCheckpointManager };

export interface TemporalCore {
  checkpoint: SessionCheckpointManager;
}

export function createTemporalCore(sessionId: string): TemporalCore {
  const checkpoint = new SessionCheckpointManager(sessionId);
  
  return {
    checkpoint,
  };
}
