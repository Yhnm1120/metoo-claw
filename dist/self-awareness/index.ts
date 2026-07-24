/**
 * Self-Awareness Layer — 自我认知层入口
 * 整合所有"知道自己是谁、能做什么、不能做什么"的模块。
 */

import { CapabilityRegistry } from './capability-registry/registry';
import { DynamicCapabilityWatcher } from './dynamic-watcher/watcher';
import { CausalChainTracker } from './causal-chain/tracker';

export { CapabilityRegistry, DynamicCapabilityWatcher, CausalChainTracker };

export interface SelfAwarenessLayer {
  capabilityRegistry: CapabilityRegistry;
  watcher: DynamicCapabilityWatcher;
  causalChain: CausalChainTracker;
}

export function createSelfAwarenessLayer(
  agentId: string,
  sessionId: string
): SelfAwarenessLayer {
  const capabilityRegistry = new CapabilityRegistry(agentId);
  const watcher = new DynamicCapabilityWatcher(capabilityRegistry);
  const causalChain = new CausalChainTracker(sessionId);
  
  return {
    capabilityRegistry,
    watcher,
    causalChain,
  };
}
