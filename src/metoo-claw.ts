/**
 * metoo-claw entry point — 独立入口，验证模块可编译运行
 * 不依赖 OpenClaw 官方构建系统，直接用 tsx/ts-node 跑。
 */

import { createSelfAwarenessLayer } from './self-awareness';
import { createTemporalCore } from './temporal-core';

export function createMetooClaw(agentId: string, sessionId: string) {
  const selfAwareness = createSelfAwarenessLayer(agentId, sessionId);
  const temporalCore = createTemporalCore(sessionId);
  
  return {
    selfAwareness,
    temporalCore,
  };
}

// 测试运行
if (import.meta.url === `file://${process.argv[1]}`) {
  const claw = createMetooClaw('xiaoyi', 'sess_test_001');
  console.log('✅ metoo-claw initialized');
  console.log('Capabilities:', claw.selfAwareness.capabilityRegistry.getStats());
  console.log('Temporal Core ready:', !!claw.temporalCore.checkpoint);
}
