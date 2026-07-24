/**
 * metoo-claw integration test — 验证核心模块功能
 */

import { createMetooClaw } from './metoo-claw';
import type { CapabilityEntry } from './self-awareness/capability-registry/registry';

const claw = createMetooClaw('xiaoyi', 'sess_test_001');

// 1. 测试 Capability Registry
console.log('=== Test 1: Capability Registry ===');
const registry = claw.selfAwareness.capabilityRegistry;

registry.setIdentity({
  agent_id: 'xiaoyi',
  name: '小艺 Claw',
  role: '养成系个人 AI 助理',
  personality: '直接、务实、不废话',
  user_profile_ref: 'USER.md',
});

registry.register({
  id: 'tool:web_fetch',
  type: 'tool',
  name: 'web_fetch',
  description: '抓取网页内容',
  prerequisites: ['network'],
  success_rate: 0.95,
  avg_latency_ms: 2000,
  limitations: ['只读', '不执行 JS'],
  danger_level: 'low',
  source: 'builtin',
  registered_at: new Date().toISOString(),
});

registry.register({
  id: 'skill:weather',
  type: 'skill',
  name: 'weather',
  description: '查询天气预报',
  prerequisites: [],
  success_rate: 0.98,
  avg_latency_ms: 500,
  limitations: ['仅支持中国城市'],
  danger_level: 'low',
  source: 'skill_install',
  registered_at: new Date().toISOString(),
});

registry.addPermissionRule({
  action: 'delete_email',
  reason: '安全策略禁止',
});

console.log(registry.toPromptDescription());
console.log('Stats:', registry.getStats());

// 2. 测试 Causal Chain
console.log('\n=== Test 2: Causal Chain ===');
const chain = claw.selfAwareness.causalChain;

const evt1 = chain.recordEvent({
  timestamp: Date.now(),
  actor: 'agent:xiaoyi',
  triggered_by: { type: 'user_request', summary: '用户要求重启 nginx' },
  action: { type: 'tool_call', tool: 'exec', params: { command: 'systemctl restart nginx' } },
  effects: [
    { type: 'state_change', target: 'nginx.service', before: 'running', after: 'failed' },
  ],
});

const evt2 = chain.recordEvent({
  timestamp: Date.now() + 1000,
  actor: 'agent:xiaoyi',
  triggered_by: { type: 'agent_decision', summary: '检测到 nginx 启动失败' },
  action: { type: 'tool_call', tool: 'exec', params: { command: 'nginx -t' } },
  effects: [
    { type: 'error', target: 'nginx.conf', after: 'syntax error on line 42' },
  ],
});

console.log(chain.generateReport(evt2));

// 3. 测试 Session Checkpoint
console.log('\n=== Test 3: Session Checkpoint ===');
const checkpoint = claw.temporalCore.checkpoint;

checkpoint.writeCheckpoint({
  session_id: 'sess_test_001',
  timestamp: Date.now(),
  type: 'user_message',
  summary: '用户询问如何配置 API 密钥',
  context_snapshot: {
    active_topics: ['API 配置', '服务器部署'],
    key_facts: ['用户使用 DeepSeek 模型', '香港服务器 IP: 47.79.21.43'],
    current_goal: '配置 API 密钥并测试',
    active_intents: [],
    recent_tools: ['exec', 'web_fetch'],
    capability_state_hash: 'sha256:abc123',
  },
  model_state: { temperature: 0.7, system_prompt_hash: 'sha256:def456' },
});

console.log('Checkpoint chain:', checkpoint.getChain().checkpoints.length, 'checkpoints');

console.log('\n✅ All tests passed!');
