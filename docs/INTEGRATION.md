# 集成指南：把 metoo-claw 集成进 OpenClaw Gateway

> A 阶段执行手册。目标：让 17 个模块在 OpenClaw Gateway 生产环境中真正跑起来。

## 集成策略

**原则：不动 OpenClaw 核心文件，用"旁路注入"方式集成。**

OpenClaw 的 session-memory hook 机制（`/new` `/reset` 时触发）证明了它有 hook 体系。我们利用同样的模式注入。

## 集成点

### 1. 会话启动时（Session Init）

**注入内容：**
- Capability Registry 的 prompt 描述 → 追加到 system prompt
- Competence Map 的能力地图 → 追加到 system prompt
- Hard Boundary 的边界声明 → 追加到 system prompt
- Intent Tracker 的恢复提示 → 作为第一条 agent 消息

**实现位置：** `src/sessions/session-lifecycle-admission.ts`（会话准入）或 session-memory hook 同款机制

**伪代码：**
```javascript
// 在会话初始化时
const claw = createMetooClaw(agentId, sessionId, '~/.openclaw/metoo-claw-data');

// 恢复意图
const resumeHint = claw.selfAwareness.intentTracker.getResumeHint();
if (resumeHint) {
  systemMessages.push({ role: 'system', content: resumeHint.hint });
}

// 注入自我认知
systemPrompt += '\n\n' + claw.selfAwareness.capabilityRegistry.toPromptDescription();
systemPrompt += '\n' + claw.selfAwareness.competenceMap.toPromptDescription();
systemPrompt += '\n' + claw.selfAwareness.hardBoundary.toPromptDescription();
```

### 2. 工具调用前（Pre-Tool-Call）

**注入内容：**
- Permission Evaluator 评估 → 不通过则拦截
- Hard Boundary 声明 → 触碰边界则替换为声明文本

**实现位置：** `attempt.tool-run-context` 流程中（源码中已存在此 hook 点）

**伪代码：**
```javascript
// 在工具调度前
const boundary = claw.selfAwareness.hardBoundary.declare(userRequest);
if (boundary?.blocked) {
  return reply(boundary.declaration + (boundary.suggestion || ''));
}

const verdict = claw.selfAwareness.permissionEvaluator.evaluate(toolCall, agentState);
if (!verdict.allowed) {
  if (verdict.requiresApproval) {
    return askUserApproval(verdict.reason);
  }
  return reply(`无法执行：${verdict.reason}`);
}
```

### 3. 工具调用后（Post-Tool-Call）

**注入内容：**
- Causal Chain 记录事件
- Learning Loop 记录成败
- Reflection Engine 失败时诊断
- Crash Recovery 追加增量日志

**伪代码：**
```javascript
// 工具调用完成后
claw.selfAwareness.causalChain.recordEvent({...});
claw.selfAwareness.learningLoop.recordToolUse(tool, success, latency, context);

if (!success) {
  const report = claw.selfAwareness.reflectionEngine.analyze(toolCall, result);
  if (report.should_escalate) {
    return reply(claw.selfAwareness.reflectionEngine.formatReport(report));
  }
}

claw.temporalCore.recovery.appendEvent(sessionId, event);
```

### 4. 每次用户消息（User Turn）

**注入内容：**
- Session Checkpoint 写检查点
- Context Window Manager 检查用量

**伪代码：**
```javascript
await claw.temporalCore.checkpoint.writeCheckpoint({...});

const mgr = claw.temporalCore.contextManager.manage(currentContext);
if (mgr.action === 'compress') {
  // 触发增量压缩而非官方的全量压缩
  await claw.temporalCore.compactor.compact(sessionId, chunks, summarizeFn);
}
```

### 5. 崩溃恢复（Gateway Startup）

**实现位置：** Gateway 启动流程 + launchd 守护

**launchd 配置（Mac）：**
```xml
<!-- ~/Library/LaunchAgents/chat.metoo.claw.plist -->
<dict>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
```

## 部署清单（Mac mini）

```bash
# 1. 代码部署
cd ~
git clone https://github.com/Yhnm1120/metoo-claw.git
cd metoo-claw && node dist/metoo-claw.test.mjs  # 验证 32/32

# 2. 数据目录
mkdir -p ~/.openclaw/metoo-claw-data

# 3. 集成注入（A 阶段核心工作）
# 修改 OpenClaw Gateway 加载逻辑，挂载 metoo-claw

# 4. launchd 守护
# 安装 plist，崩溃自动拉起
```

## 回滚方案

如果集成后出问题：
1. 移除注入代码 → Gateway 恢复原版行为
2. metoo-claw 数据目录独立，不影响 OpenClaw 原有数据
3. 全部模块零侵入，可整体摘除
