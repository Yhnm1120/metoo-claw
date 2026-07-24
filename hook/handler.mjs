/**
 * metoo-claw OpenClaw Hook Handler
 * 把 17 个模块挂载到 OpenClaw 的内部 hook 体系。
 * 
 * 用法：把 hook/ 目录复制到 OpenClaw 的 src/hooks/bundled/metoo-claw/
 * 或在 extensions 目录中作为扩展加载。
 */

import { createMetooClaw } from '../dist/metoo-claw.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 每个会话一个 metoo-claw 实例
const instances = new Map();

function getInstance(agentId, sessionKey, storageDir) {
  const key = `${agentId}:${sessionKey}`;
  if (!instances.has(key)) {
    instances.set(key, createMetooClaw(agentId, sessionKey, storageDir));
  }
  return instances.get(key);
}

/**
 * 把当前自我认知写成 system prompt 附加文件。
 * Gateway 补丁会读取此文件并追加到 system prompt 尾部。
 * 每次 hook 事件后刷新，保证能力/成功率变化实时反映到 prompt。
 */
function refreshSystemPromptFile(claw, storageDir) {
  try {
    const parts = [];
    const cap = claw.selfAwareness.capabilityRegistry.toPromptDescription();
    const comp = claw.selfAwareness.competenceMap.toPromptDescription();
    const bound = claw.selfAwareness.hardBoundary.toPromptDescription();
    if (cap && cap.length > 10) parts.push(cap);
    if (comp && comp.length > 10) parts.push(comp);
    if (bound && bound.length > 10) parts.push(bound);
    if (parts.length === 0) return;
    const content = '## metoo-claw 自我认知（实时生成）\n\n' + parts.join('\n\n') + '\n';
    const dir = storageDir.replace(/^~/, os.homedir());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'system-prompt-extra.md'), content, 'utf-8');
  } catch (e) {
    // 写失败不影响主流程
  }
}

/**
 * 主 hook handler
 * @param {object} event - OpenClaw InternalHookEvent
 * @param {object} config - hook 配置
 */
export default async function metooClawHook(event, config = {}) {
  const storageDir = config.storageDir || `${process.env.HOME}/.openclaw/metoo-claw-data`;
  const agentId = event.context?.agentId || 'default';
  const sessionKey = event.sessionKey || 'unknown';

  const claw = getInstance(agentId, sessionKey, storageDir);

  switch (`${event.type}:${event.action}`) {

    // ═══ Gateway 启动：崩溃恢复检查 ═══
    case 'gateway:startup': {
      const recovery = await claw.temporalCore.recovery.recover(sessionKey);
      if (recovery.recovered) {
        event.messages.push(
          `🔄 会话已恢复（检查点 ${recovery.checkpoint.checkpoint_id}，重放 ${recovery.replayed_events} 个事件）`
        );
      }
      if (recovery.warnings.length > 0) {
        event.messages.push(`⚠️ ${recovery.warnings.join('；')}`);
      }
      break;
    }

    // ═══ Agent 启动：注入自我认知 + 意图恢复 ═══
    case 'agent:bootstrap': {
      // 首次启动：自动注册基础能力 + 安全边界
      autoRegisterBaseline(claw);
      // 意图恢复
      if (config.intentResume !== false) {
        const hint = claw.selfAwareness.intentTracker.getResumeHint();
        if (hint) {
          event.messages.push(`📋 ${hint.hint}（${hint.progress}）`);
        }
      }
      // 能力描述注入（通过 context 传给 system prompt 组装层）
      if (config.injectPrompt !== false && event.context) {
        event.context.metooSystemPromptExtra = [
          claw.selfAwareness.capabilityRegistry.toPromptDescription(),
          claw.selfAwareness.competenceMap.toPromptDescription(),
          claw.selfAwareness.hardBoundary.toPromptDescription(),
        ].filter(s => s && s.length > 10).join('\n\n');
      }
      break;
    }

    // ═══ 收到用户消息：硬边界检查 + 写检查点 ═══
    case 'message:received': {
      const text = event.context?.text || event.context?.message || '';
      
      // 硬边界检查
      const boundary = claw.selfAwareness.hardBoundary.declare(String(text));
      if (boundary?.blocked) {
        event.messages.push(
          boundary.declaration + (boundary.suggestion ? `\n${boundary.suggestion}` : '')
        );
        event.context.boundaryBlocked = true;
        return;
      }
      if (boundary && !boundary.blocked) {
        // 低信心提示（不拦截）
        event.messages.push(boundary.declaration);
      }

      // 写检查点
      await claw.temporalCore.checkpoint.writeCheckpoint({
        session_id: sessionKey,
        timestamp: Date.now(),
        type: 'user_message',
        summary: String(text).slice(0, 100),
        context_snapshot: {
          active_topics: [],
          key_facts: [],
          current_goal: '',
          active_intents: claw.selfAwareness.intentTracker.getActiveIntents().map(i => i.intent_id),
          recent_tools: [],
          capability_state_hash: '',
        },
        model_state: { system_prompt_hash: '' },
      });
      break;
    }

    // ═══ Agent 发出消息：因果链 + 学习反馈 ═══
    case 'message:sent': {
      const toolCalls = event.context?.toolCalls || [];
      for (const call of toolCalls) {
        // 因果链
        claw.selfAwareness.causalChain.recordEvent({
          timestamp: Date.now(),
          actor: `agent:${agentId}`,
          triggered_by: { type: 'user_request', summary: String(event.context?.userText || '').slice(0, 80) },
          action: { type: 'tool_call', tool: call.name, params: call.params },
          effects: call.success
            ? [{ type: 'state_change', target: call.name, after: 'success' }]
            : [{ type: 'error', target: call.name, after: call.error || 'failed' }],
        });

        // 学习反馈
        claw.selfAwareness.learningLoop.recordToolUse(
          call.name, !!call.success, call.latencyMs || 0, call.context || ''
        );

        // 失败诊断
        if (!call.success) {
          const report = claw.selfAwareness.reflectionEngine.analyze(
            { name: call.name }, { success: false, error: call.error, code: call.code }
          );
          if (report.should_escalate) {
            event.messages.push(claw.selfAwareness.reflectionEngine.formatReport(report));
          }
        }
      }

      // 增量日志
      claw.temporalCore.recovery.appendEvent(sessionKey, {
        type: 'message_sent',
        tool_calls: toolCalls.length,
      });
      break;
    }

    // ═══ 压缩前：用增量压缩接管 ═══
    case 'session:compact:before': {
      if (config.incrementalCompaction === false) return;
      // 标记：让核心知道我们用增量压缩处理
      event.context.metooIncrementalCompaction = true;
      break;
    }

    // ═══ /new /reset：归档意图 + 保存检查点链 ═══
    case 'command:new':
    case 'command:reset': {
      await claw.temporalCore.checkpoint.flush();
      // 意图保持活跃（不归档），下次会话自动恢复
      event.messages.push('💾 会话状态已保存，跨会话意图将在下次自动恢复');
      break;
    }
  }

  // 每个事件处理后刷新 system prompt 附加文件（供 Gateway 补丁读取）
  refreshSystemPromptFile(claw, storageDir);
}

/** 供外部（status 命令等）查询状态 */
export function getMetooStatus(agentId, sessionKey, storageDir) {
  const claw = getInstance(agentId, sessionKey, storageDir);
  return claw.selfAwareness.statusOracle.formatReport();
}

/** 首次启动时注册基础能力清单和安全边界（只注册一次） */
function autoRegisterBaseline(claw) {
  const reg = claw.selfAwareness.capabilityRegistry;
  if (reg.getStats().total > 0) return; // 已注册过
  const now = new Date().toISOString();
  const coreTools = [
    ['read', 'Read files', 5, 'none'], ['write', 'Create/overwrite files', 50, 'medium'],
    ['edit', 'Exact file edits', 30, 'low'], ['exec', 'Run shell commands', 5000, 'medium'],
    ['web_fetch', 'Fetch/extract URL', 8000, 'low'], ['web_search', 'Web search', 10000, 'low'],
    ['browser', 'Control web browser', 15000, 'medium'], ['cron', 'Manage scheduled jobs', 50, 'low'],
    ['message', 'Send channel messages', 3000, 'low'], ['sessions_spawn', 'Spawn sub-agents', 100, 'low'],
    ['gateway', 'Gateway config/restart', 200, 'high'], ['memory_store', 'Store durable memory', 200, 'low'],
    ['memory_record_search', 'Search memories', 2000, 'low'],
  ];
  for (const [name, desc, latency, danger] of coreTools) {
    reg.register({
      id: `tool:${name}`, type: 'tool', name, description: desc,
      prerequisites: [], success_rate: 0.95, avg_latency_ms: latency,
      limitations: [], danger_level: danger, source: 'builtin', registered_at: now,
    });
  }
  // 安全边界（来自 AGENTS.md 红线）— 用 registry 的 permission rule
  reg.addPermissionRule({
    action: 'delete_email',
    reason: '安全策略禁止删除邮件，任何情况下不可覆盖',
  });
  reg.addPermissionRule({
    action: 'modify openclaw.json',
    reason: 'Gateway 配置文件受保护，直接修改会导致崩溃，请用 gateway 工具 config.patch',
  });
  reg.addPermissionRule({
    action: 'disable execution-validator',
    reason: 'execution-validator 是核心安全组件，不可禁用',
  });
  // 初始擅长领域
  claw.selfAwareness.competenceMap.setDomain('信息检索', 'high', {
    best_tools: ['web_search', 'web_fetch'],
  });
  claw.selfAwareness.competenceMap.setDomain('代码开发', 'high', {
    best_tools: ['write', 'edit', 'exec'],
  });
  claw.selfAwareness.competenceMap.setDomain('系统运维', 'medium', {
    best_tools: ['exec', 'cron'],
  });
  claw.selfAwareness.competenceMap.setDomain('图像生成', 'incompetent', {
    reason: '本地无图像生成模型',
    fallback: '可调用 xiaoyi-image-creator skill',
  });
}
