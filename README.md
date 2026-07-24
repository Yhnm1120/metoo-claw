# metoo-claw

基于 OpenClaw 2026.7.2 的独立 fork，为 AI Agent 增加**时序核心 + 自我认知层**。

> 让 Agent 从"会忘事的工具"变成"有自我认知的智能体"——它知道自己是谁、记得什么、能做什么、不能做什么、擅长什么、不擅长什么，并且崩了能恢复。

## 为什么做这个项目

基于 OpenClaw GitHub 真实 issue 数据：

- **#92043 (P1)**: Compaction 180s 超时死循环——单墙钟跑整个 chunk pipeline，无部分进度复用，超时后从头重跑，唯一出路是 `/new`（丢历史）
- **#44925 (P1)**: Subagent 完成静默丢失——超时无重试、无通知
- **#87637**: 记忆状态不透明——doctor 说"禁用"但 dreaming 在跑
- **#112252**: 配置漂移——存了 thinkingLevel=max 实际 thinking=off
- **3,877 个** `impact:session-state` 标签的 issue——会话状态问题是最普遍痛点

## 架构

```
┌─────────────────────────────────────────────┐
│  Self-Awareness Layer（自我认知层）12 模块    │
│  知道自己是谁、能做什么、不能做什么           │
├─────────────────────────────────────────────┤
│  Temporal Core（时序核心）5 模块              │
│  记住、恢复、不丢                             │
└─────────────────────────────────────────────┘
```

## 17 个模块

### Self-Awareness Layer（12）

| 模块 | 路径 | 功能 |
|------|------|------|
| Capability Registry | `self-awareness/capability-registry/` | 能力注册表：Agent 的身份证 |
| Dynamic Watcher | `self-awareness/dynamic-watcher/` | 监听 skill 目录，新能力实时注册 |
| Permission Evaluator | `self-awareness/permission-evaluator/` | 工具调用前拦截：事前检查资格 |
| Competence Map | `self-awareness/competence-map/` | 擅长/不擅长地图，动态更新 |
| Hard Boundary | `self-awareness/hard-boundary/` | 主动声明不能做什么 |
| Causal Chain | `self-awareness/causal-chain/` | 行为因果链：根因追溯+影响预测 |
| Reflection Engine | `self-awareness/reflection-engine/` | 失败后自我诊断+建议 |
| Intent Tracker | `self-awareness/intent-tracker/` | 跨会话意图追踪，新会话自动恢复 |
| Learning Loop | `self-awareness/learning-loop/` | 工具使用效果学习，越用越聪明 |
| Status Oracle | `self-awareness/status-oracle/` | 系统状态报告 |
| Consistency Checker | `self-awareness/consistency-checker/` | 配置漂移检测+自动修复 |
| Multi-Agent Mesh | `self-awareness/multi-agent-mesh/` | 多 Agent 协同认知，避免重复工作 |

### Temporal Core（5）

| 模块 | 路径 | 功能 |
|------|------|------|
| Session Checkpoint | `temporal-core/checkpoint/` | 检查点链，每次关键操作落盘 |
| Temporal Priority | `temporal-core/priority/` | 时间衰减优先级，旧事自动降权 |
| Context Window Manager | `temporal-core/context-manager/` | 上下文分层管理，超限不丢关键信息 |
| Incremental Compaction | `temporal-core/compaction/` | 增量压缩+断点续跑（解 #92043） |
| Crash Recovery | `temporal-core/recovery/` | 三阶段崩溃恢复 |

## 快速开始

零依赖，Node.js 直接跑（v20+）：

```bash
# 运行完整测试（32 个断言）
node dist/metoo-claw.test.mjs

# 最小示例
node dist/metoo-claw.mjs
```

```javascript
import { createMetooClaw } from './dist/metoo-claw.mjs';

const claw = createMetooClaw('my-agent', 'session-001', './data');

// 注册能力
claw.selfAwareness.capabilityRegistry.register({
  id: 'tool:web_fetch', type: 'tool', name: 'web_fetch',
  description: '抓取网页', prerequisites: [],
  success_rate: 0.95, avg_latency_ms: 2000,
  limitations: ['只读'], danger_level: 'low',
  source: 'builtin', registered_at: new Date().toISOString(),
});

// 权限评估（工具调用前）
const verdict = claw.selfAwareness.permissionEvaluator.evaluate({ name: 'web_fetch' });
// → { allowed: true }

// 意图追踪（跨会话）
const intentId = claw.selfAwareness.intentTracker.createIntent('搭建个人网站');
claw.selfAwareness.intentTracker.updateProgress(intentId, { start_step: '选域名' });

// 新会话恢复
const hint = claw.selfAwareness.intentTracker.getResumeHint();
// → "上次我们在做「搭建个人网站」，进行到「选域名」，要继续吗？"

// 因果链
claw.selfAwareness.causalChain.recordEvent({
  timestamp: Date.now(), actor: 'agent:my-agent',
  triggered_by: { type: 'user_request', summary: '重启服务' },
  action: { type: 'tool_call', tool: 'exec' },
  effects: [{ type: 'state_change', target: 'nginx', before: 'running', after: 'failed' }],
});

// 检查点
await claw.temporalCore.checkpoint.writeCheckpoint({
  session_id: 'session-001', timestamp: Date.now(), type: 'user_message',
  summary: '用户请求...',
  context_snapshot: { active_topics: [], key_facts: [], current_goal: '',
    active_intents: [], recent_tools: [], capability_state_hash: '' },
  model_state: { system_prompt_hash: '' },
});
```

## 测试

```bash
node dist/metoo-claw.test.mjs
# ✅ 通过: 32  ❌ 失败: 0
# 🎉 17 个模块全部测试通过！
```

## 路线图

- [x] C 阶段：真实场景验证（意图追踪、因果链、学习循环已实测）
- [ ] B 阶段：模块文档和集成指南
- [ ] A 阶段：集成进 OpenClaw Gateway 生产环境

## License

基于 OpenClaw fork，遵循原项目协议。
