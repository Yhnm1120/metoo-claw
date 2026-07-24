import { CapabilityRegistry } from './capability-registry/registry.mjs';
import { DynamicCapabilityWatcher } from './dynamic-watcher/watcher.mjs';
import { CausalChainTracker } from './causal-chain/tracker.mjs';
import { PermissionEvaluator } from './permission-evaluator/evaluator.mjs';
import { CompetenceMap } from './competence-map/map.mjs';
import { HardBoundaryDeclarer } from './hard-boundary/declarer.mjs';
import { ReflectionEngine } from './reflection-engine/engine.mjs';
import { IntentTracker } from './intent-tracker/tracker.mjs';
import { LearningLoop } from './learning-loop/loop.mjs';
import { StatusOracle } from './status-oracle/oracle.mjs';
import { StateConsistencyChecker } from './consistency-checker/checker.mjs';
import { MultiAgentMesh } from './multi-agent-mesh/mesh.mjs';

export {
  CapabilityRegistry,
  DynamicCapabilityWatcher,
  CausalChainTracker,
  PermissionEvaluator,
  CompetenceMap,
  HardBoundaryDeclarer,
  ReflectionEngine,
  IntentTracker,
  LearningLoop,
  StatusOracle,
  StateConsistencyChecker,
  MultiAgentMesh,
};

export function createSelfAwarenessLayer(agentId, sessionId, storageDir = null) {
  const capabilityRegistry = new CapabilityRegistry(agentId);
  const watcher = new DynamicCapabilityWatcher(capabilityRegistry);
  const causalChain = new CausalChainTracker(sessionId);
  const permissionEvaluator = new PermissionEvaluator(capabilityRegistry);
  const competenceMap = new CompetenceMap();
  const hardBoundary = new HardBoundaryDeclarer(capabilityRegistry, competenceMap);
  const reflectionEngine = new ReflectionEngine();
  const intentTracker = new IntentTracker(storageDir ? `${storageDir}/intents` : null);
  const learningLoop = new LearningLoop(storageDir ? `${storageDir}/learning` : null);
  const consistencyChecker = new StateConsistencyChecker();
  const multiAgentMesh = new MultiAgentMesh(agentId, storageDir ? `${storageDir}/mesh` : null);
  const statusOracle = new StatusOracle({
    registry: capabilityRegistry,
    competenceMap,
    intentTracker,
    learningLoop,
  });

  return {
    capabilityRegistry,
    watcher,
    causalChain,
    permissionEvaluator,
    competenceMap,
    hardBoundary,
    reflectionEngine,
    intentTracker,
    learningLoop,
    statusOracle,
    consistencyChecker,
    multiAgentMesh,
  };
}
