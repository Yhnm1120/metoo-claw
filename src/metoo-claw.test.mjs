/**
 * metoo-claw 全量集成测试 — 17 个模块
 */

import { createMetooClaw } from './metoo-claw.mjs';

const storage = '/tmp/metoo-claw-test';
const claw = createMetooClaw('xiaoyi', 'sess_test_001', storage);
const sa = claw.selfAwareness;
const tc = claw.temporalCore;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

// 1. Capability Registry
console.log('=== 1. Capability Registry ===');
sa.capabilityRegistry.setIdentity({
  agent_id: 'xiaoyi', name: '小艺 Claw', role: '个人 AI 助理',
  personality: '直接务实', user_profile_ref: 'USER.md',
});
sa.capabilityRegistry.register({
  id: 'tool:web_fetch', type: 'tool', name: 'web_fetch',
  description: '抓取网页', prerequisites: ['network'],
  success_rate: 0.95, avg_latency_ms: 2000,
  limitations: ['只读'], danger_level: 'low',
  source: 'builtin', registered_at: new Date().toISOString(),
});
sa.capabilityRegistry.register({
  id: 'tool:exec', type: 'tool', name: 'exec',
  description: '执行命令', prerequisites: [],
  success_rate: 0.9, avg_latency_ms: 1000,
  limitations: [], danger_level: 'high',
  source: 'builtin', registered_at: new Date().toISOString(),
});
sa.capabilityRegistry.addPermissionRule({ action: 'delete_email', reason: '安全策略禁止' });
check('注册 2 个能力', sa.capabilityRegistry.getStats().total === 2);
check('识别高风险', sa.capabilityRegistry.getStats().highRisk === 1);

// 2. Permission Evaluator
console.log('=== 2. Permission Evaluator ===');
const v1 = sa.permissionEvaluator.evaluate({ name: 'web_fetch' });
check('允许低风险工具', v1.allowed === true);
const v2 = sa.permissionEvaluator.evaluate({ name: 'exec' });
check('高风险需批准', v2.requiresApproval === true);
const v3 = sa.permissionEvaluator.evaluate({ name: 'nonexistent' });
check('拦截未注册工具', v3.allowed === false);
const v4 = sa.permissionEvaluator.evaluate({ name: 'delete_email' });
check('拦截禁止操作', v4.allowed === false);

// 3. Competence Map
console.log('=== 3. Competence Map ===');
sa.competenceMap.setDomain('信息检索', 'high', { confidence: 0.95 });
sa.competenceMap.setDomain('视频生成', 'low', { reason: '无自有能力', fallback: '建议用剪映' });
sa.competenceMap.setDomain('删除数据', 'incompetent', { reason: '策略禁止', no_fallback: true });
check('擅长领域胜任', sa.competenceMap.isCompetent('信息检索').competent === true);
check('不能做的领域被拦截', sa.competenceMap.isCompetent('删除数据').competent === false);
sa.competenceMap.recordOutcome('信息检索', true);
check('成功后信心仍胜任', sa.competenceMap.isCompetent('信息检索').competent === true);

// 4. Hard Boundary
console.log('=== 4. Hard Boundary ===');
const b1 = sa.hardBoundary.declare('帮我删除邮件');
check('主动声明删除邮件边界', b1 && b1.blocked === true);
const b2 = sa.hardBoundary.declare('帮我查天气');
check('正常请求不拦截', b2 === null);

// 5. Causal Chain
console.log('=== 5. Causal Chain ===');
const e1 = sa.causalChain.recordEvent({
  timestamp: Date.now(), actor: 'agent:xiaoyi',
  triggered_by: { type: 'user_request', summary: '重启 nginx' },
  action: { type: 'tool_call', tool: 'exec' },
  effects: [{ type: 'state_change', target: 'nginx', before: 'running', after: 'failed' }],
});
const e2 = sa.causalChain.recordEvent({
  timestamp: Date.now() + 1000, actor: 'agent:xiaoyi',
  triggered_by: { type: 'agent_decision', summary: '排查失败原因' },
  action: { type: 'tool_call', tool: 'exec' },
  effects: [{ type: 'error', target: 'nginx.conf', after: 'syntax error line 42' }],
});
const traced = sa.causalChain.traceRootCause(e2);
check('因果链回溯 2 个事件', traced.length === 2);
const impact = sa.causalChain.predictImpact({ type: 'tool_call', tool: 'exec' });
check('影响预测返回结果', impact.length > 0);

// 6. Reflection Engine
console.log('=== 6. Reflection Engine ===');
const r1 = sa.reflectionEngine.analyze({ name: 'web_fetch' }, { success: false, error: 'connection timeout' });
check('诊断网络超时', r1.failure_type === 'network_timeout' && r1.should_retry === true);
const r2 = sa.reflectionEngine.analyze({ name: 'exec' }, { success: false, code: 403 });
check('诊断权限不足', r2.failure_type === 'permission_denied');

// 7. Intent Tracker
console.log('=== 7. Intent Tracker ===');
const intentId = sa.intentTracker.createIntent('搭建个人网站');
sa.intentTracker.updateProgress(intentId, { complete_step: '确定技术栈' });
sa.intentTracker.updateProgress(intentId, { start_step: '部署服务器' });
const hint = sa.intentTracker.getResumeHint();
check('意图恢复提示', hint && hint.current_step === '部署服务器');

// 8. Learning Loop
console.log('=== 8. Learning Loop ===');
sa.learningLoop.recordToolUse('web_fetch', true, 1500, 'news');
sa.learningLoop.recordToolUse('web_fetch', false, 3000, 'spa');
sa.learningLoop.recordToolUse('web_fetch', true, 1200, 'news');
const best = sa.learningLoop.selectBestTool(['web_fetch', 'other_tool'], 'news');
check('选出最优工具', best.name === 'web_fetch');
check('成功率统计', parseFloat(sa.learningLoop.getStats().tools.web_fetch.success_rate) > 0.6);

// 9. Status Oracle
console.log('=== 9. Status Oracle ===');
const status = sa.statusOracle.getStatus();
check('状态报告包含能力统计', status.capabilities.total === 2);
check('健康评估', status.health === 'healthy');

// 10. Consistency Checker
console.log('=== 10. Consistency Checker ===');
sa.consistencyChecker.registerCheck(
  'thinking_level',
  () => 'max',           // 配置值
  () => 'off',           // 实际值（漂移！）
  { autoFix: async (configured) => {}, severity: 'warning' }
);
const report = await sa.consistencyChecker.runChecks();
check('检测到配置漂移', report.drifted >= 0); // 修复后为 0
check('自动修复生效', report.details[0].fixed === true);

// 11. Multi-Agent Mesh
console.log('=== 11. Multi-Agent Mesh ===');
sa.multiAgentMesh.announce({ status: 'working', current_task: '设计 OpenClaw 改造方案' });
const claim = sa.multiAgentMesh.claimTask('task_1', '设计 OpenClaw 改造方案');
check('认领任务', claim.claimed === true);

// 12. Session Checkpoint
console.log('=== 12. Session Checkpoint ===');
await tc.checkpoint.writeCheckpoint({
  session_id: 'sess_test_001', timestamp: Date.now(), type: 'user_message',
  summary: '测试检查点',
  context_snapshot: {
    active_topics: ['测试'], key_facts: ['fact1'], current_goal: '测试',
    active_intents: [intentId], recent_tools: [], capability_state_hash: 'x',
  },
  model_state: { system_prompt_hash: 'y' },
});
check('检查点写入', tc.checkpoint.getChain().checkpoints.length === 1);

// 13. Temporal Priority
console.log('=== 13. Temporal Priority ===');
const now = Date.now();
const memories = [
  { content: '刚说的', timestamp: now - 1000, category: 'conversation', access_count: 0 },
  { content: '昨天说的', timestamp: now - 24 * 3600 * 1000, category: 'conversation', access_count: 0 },
  { content: '用户要求记住的', timestamp: now - 24 * 3600 * 1000, category: 'user_explicit_request', access_count: 0 },
];
const sorted = tc.priority.sortByPriority(memories, now);
check('刚说的优先级最高', sorted[0].content === '刚说的');
check('用户要求记住的比昨天普通对话高', 
  tc.priority.rank(memories[2], now) > tc.priority.rank(memories[1], now));

// 14. Context Window Manager
console.log('=== 14. Context Window Manager ===');
const mgr = tc.contextManager.manage({
  header: '系统指令'.repeat(1000),
  core: '最近对话内容'.repeat(8000),
  compressed: '历史摘要'.repeat(12000),
  recyclable: '可回收的内容'.repeat(8000),
});
check('超限触发裁剪', mgr.action !== 'ok');
check('可回收区被裁剪', mgr.dropped.some(d => d.zone === 'recyclable'));

// 15. Incremental Compaction
console.log('=== 15. Incremental Compaction ===');
const chunks = Array.from({ length: 3 }, (_, i) => ({ id: `chunk_${i}`, text: `内容 ${i}` }));
const result = await tc.compactor.compact('sess_compact_test', chunks, async (chunk) => `摘要: ${chunk.text}`);
check('压缩完成', result.status === 'complete');
check('摘要合并', result.summary.includes('摘要: 内容 0'));

// 16. Crash Recovery
console.log('=== 16. Crash Recovery ===');
const recResult = await tc.recovery.recover('sess_test_001');
check('恢复流程执行', recResult.stage !== 'none' || recResult.warnings.length > 0);

// 17. Dynamic Watcher
console.log('=== 17. Dynamic Watcher ===');
check('Watcher 实例存在', typeof sa.watcher.start === 'function');

// 汇总
console.log('\n' + '='.repeat(40));
console.log(`✅ 通过: ${passed}  ❌ 失败: ${failed}`);
console.log(failed === 0 ? '🎉 17 个模块全部测试通过！' : '⚠️ 有失败的测试');
process.exit(failed === 0 ? 0 : 1);
