import { SessionCheckpointManager } from './checkpoint/manager.mjs';
import { TemporalPriority } from './priority/temporal.mjs';
import { ContextWindowManager } from './context-manager/window.mjs';
import { IncrementalCompactor } from './compaction/incremental.mjs';
import { CrashRecovery } from './recovery/crash.mjs';

export {
  SessionCheckpointManager,
  TemporalPriority,
  ContextWindowManager,
  IncrementalCompactor,
  CrashRecovery,
};

export function createTemporalCore(sessionId, storageDir = null) {
  const checkpoint = new SessionCheckpointManager(sessionId);
  const priority = new TemporalPriority();
  const contextManager = new ContextWindowManager();
  const compactor = new IncrementalCompactor(
    storageDir ? `${storageDir}/compaction` : null
  );
  const recovery = new CrashRecovery(
    storageDir ? `${storageDir}/recovery` : null
  );

  return {
    checkpoint,
    priority,
    contextManager,
    compactor,
    recovery,
  };
}
