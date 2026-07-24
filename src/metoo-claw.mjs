/**
 * metoo-claw entry point — 17 模块完整版
 */

import { createSelfAwarenessLayer } from './self-awareness/index.mjs';
import { createTemporalCore } from './temporal-core/index.mjs';

export function createMetooClaw(agentId, sessionId, storageDir = null) {
  const selfAwareness = createSelfAwarenessLayer(agentId, sessionId, storageDir);
  const temporalCore = createTemporalCore(sessionId, storageDir);

  return {
    selfAwareness,
    temporalCore,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const claw = createMetooClaw('xiaoyi', 'sess_test_001', '/tmp/metoo-claw-data');
  console.log('✅ metoo-claw initialized — 17 modules');
  console.log('Self-Awareness modules:', Object.keys(claw.selfAwareness).length);
  console.log('Temporal Core modules:', Object.keys(claw.temporalCore).length);
}
