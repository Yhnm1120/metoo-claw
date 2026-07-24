/**
 * metoo-claw OpenClaw Hook Handler
 * 把 17 个模块挂载到 OpenClaw 的内部 hook 体系。
 * 
 * 用法：把 hook/ 目录复制到 OpenClaw 的 src/hooks/bundled/metoo-claw/
 * 或在 extensions 目录中作为扩展加载。
 */

import { createMetooClaw } from '../dist/metoo-claw.mjs';

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
}

/** 供外部（status 命令等）查询状态 */
export function getMetooStatus(agentId, sessionKey, storageDir) {
  const claw = getInstance(agentId, sessionKey, storageDir);
  return claw.selfAwareness.statusOracle.formatReport();
}
