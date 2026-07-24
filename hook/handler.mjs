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
    const claw = createMetooClaw(agentId, sessionKey, storageDir);
    autoRegisterBaseline(claw); // 新实例立即初始化基础能力+边界，不依赖 bootstrap 事件
    instances.set(key, claw);
  }
  return instances.get(key);
}

/**
 * 把当前自我认知写成 system prompt 附加文件。
 * Gateway 补丁会读取此文件并追加到 system prompt 尾部。
 * 每次 hook 事件后刷新，保证能力/成功率变化实时反映到 prompt。
 * @param {string} contextIntel 可选：针对当前用户消息查到的上下文情报（先查后答）
 */
// prompt 文件 hash 缓存：内容没变不重写，避免每条消息都写盘
let lastPromptHash = '';

function refreshSystemPromptFile(claw, storageDir, contextIntel = '') {
  try {
    const parts = [];
    const cap = claw.selfAwareness.capabilityRegistry.toPromptDescription();
    const comp = claw.selfAwareness.competenceMap.toPromptDescription();
    const bound = claw.selfAwareness.hardBoundary.toPromptDescription();
    if (cap && cap.length > 10) parts.push(cap);
    if (comp && comp.length > 10) parts.push(comp);
    if (bound && bound.length > 10) parts.push(bound);
    if (contextIntel) parts.push(contextIntel);
    parts.push(PRE_SEARCH_DIRECTIVE);
    parts.push(ESCALATE_DIRECTIVE);
    parts.push(MODEL_REGISTRY_DIRECTIVE);
    if (parts.length === 0) return;
    const content = '## metoo-claw 自我认知（实时生成）\n\n' + parts.join('\n\n') + '\n';
    // hash 对比：内容没变则跳过写盘
    const hash = String(content.length) + ':' + content.slice(0, 64);
    if (hash === lastPromptHash) return;
    lastPromptHash = hash;
    const dir = storageDir.replace(/^~/, os.homedir());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'system-prompt-extra.md'), content, 'utf-8');
  } catch (e) {
    // 写失败不影响主流程
  }
}

// 情报查询 TTL 缓存：相同查询 30 秒内复用，避免重复全量检索
const intelCache = new Map(); // key -> { intel, expireAt }
const INTEL_TTL = 30 * 1000;

async function gatherContextIntel(claw, userText) {
  const text = String(userText || '').trim();
  if (!text) return '';
  // 用文本前 40 字符做缓存 key（同一会话内相似查询复用）
  const cacheKey = text.slice(0, 40);
  const cached = intelCache.get(cacheKey);
  if (cached && cached.expireAt > Date.now()) return cached.intel;
  const intel = await _gatherContextIntelImpl(claw, text);
  intelCache.set(cacheKey, { intel, expireAt: Date.now() + INTEL_TTL });
  // 缓存清理：防止无限增长
  if (intelCache.size > 50) {
    const now = Date.now();
    for (const [k, v] of intelCache) if (v.expireAt <= now) intelCache.delete(k);
  }
  return intel;
}

/** RAG 知识库检索：调用本地 memory-rag.py，检索领域知识 */
const RAG_SCRIPT = '~/.openclaw/workspace/memory-rag.py';
const RAG_CACHE = new Map();
const RAG_TTL = 60 * 1000; // 相同查询 60s 缓存

async function ragSearch(query) {
  const key = String(query || '').trim().slice(0, 60);
  if (!key) return '';
  const cached = RAG_CACHE.get(key);
  if (cached && cached.expireAt > Date.now()) return cached.result;
  let result = '';
  try {
    const { execFile } = await import('node:child_process');
    const scriptPath = RAG_SCRIPT.replace(/^~/, os.homedir());
    const cwd = path.dirname(scriptPath);
    result = await new Promise((resolve) => {
      // 8s 超时，避免拖慢响应
      execFile('python3', [scriptPath, 'search', key], { cwd, timeout: 8000, maxBuffer: 1024 * 64 }, (err, stdout) => {
        if (err) return resolve('');
        resolve(String(stdout || ''));
      });
    });
  } catch { result = ''; }
  RAG_CACHE.set(key, { result, expireAt: Date.now() + RAG_TTL });
  if (RAG_CACHE.size > 50) {
    const now = Date.now();
    for (const [k, v] of RAG_CACHE) if (v.expireAt <= now) RAG_CACHE.delete(k);
  }
  return result;
}

/** 解析 RAG 输出为精简的情报文本（只取前 2 条，截断） */
function formatRagIntel(raw) {
  if (!raw || !raw.includes('搜索结果')) return '';
  const blocks = raw.split(/\n\d+\. \[/).slice(1, 3); // 最多 2 条
  if (blocks.length === 0) return '';
  const items = blocks.map(b => {
    const scoreMatch = b.match(/^([\d.]+)\]/);
    const srcMatch = b.match(/📄\s*(\S+)/);
    // 取文本主体（去掉 score/source 行），限制长度
    const text = b.replace(/^[\d.]+\]\s*[^\n]*\n/, '').replace(/📄[^\n]*\n/, '').trim().slice(0, 400);
    const src = srcMatch ? srcMatch[1] : '知识库';
    return `- [${src}] ${text}`;
  });
  return '### 相关知识库内容（回答时参考，标注来源）\n' + items.join('\n\n');
}

/** 实际的情报检索逻辑（被带缓存的 gatherContextIntel 包装） */
async function _gatherContextIntelImpl(claw, userText) {
  const sections = [];
  const text = String(userText || '').trim();
  if (!text) return '';

  // 1. 进行中的意图（跨会话延续的任务）
  try {
    const intents = claw.selfAwareness.intentTracker.getActiveIntents();
    if (intents.length > 0) {
      const lines = intents.slice(0, 3).map(i =>
        `- 「${i.goal}」进行中，进度 ${i.progress || 0}步` +
        (i.current_step ? `，当前：${i.current_step}` : '')
      );
      sections.push('### 进行中的任务\n' + lines.join('\n'));
    }
  } catch {}

  // 1.5 知识库检索（本地 RAG，领域知识）
  try {
    const ragRaw = await ragSearch(text);
    const ragIntel = formatRagIntel(ragRaw);
    if (ragIntel) sections.push(ragIntel);
  } catch {}

  // 2. 相关工具的成功率画像（从历史学习）
  try {
    const stats = claw.selfAwareness.learningLoop.getStats();
    const tools = stats?.tools || {};
    const entries = Object.entries(tools)
      .filter(([, s]) => (s.total_uses || 0) >= 1)
      .map(([name, s]) => ({ name, rate: parseFloat(s.success_rate) || 0, total: s.total_uses }));
    if (entries.length > 0) {
      entries.sort((a, b) => b.rate - a.rate);
      const lines = entries.slice(0, 5).map(e => {
        const pct = (e.rate * 100).toFixed(0);
        const warn = e.rate < 0.6 ? ' ⚠️ 不稳定' : '';
        return `- ${e.name}: 成功率 ${pct}%（${e.total}次）${warn}`;
      });
      sections.push('### 工具使用经验（回答时优先用高成功率工具）\n' + lines.join('\n'));
    }
  } catch {}

  // 3. 相关因果链（以前类似操作的结果）
  try {
    const chain = claw.selfAwareness.causalChain.getChain();
    if (chain && chain.length > 0) {
      // 简单关键词匹配最近相关事件
      const keywords = text.match(/[\u4e00-\u9fa5]{2,}|[a-zA-Z]{4,}/g) || [];
      const relevant = chain.filter(e => {
        const hay = JSON.stringify(e).toLowerCase();
        return keywords.some(kw => hay.includes(kw.toLowerCase()));
      });
      if (relevant.length > 0) {
        const lines = relevant.slice(-3).map(e => {
          const eff = e.effects?.[0];
          return `- ${e.action?.tool || e.action?.type}: ${eff?.after ?? ''}`;
        });
        sections.push('### 历史相关操作\n' + lines.join('\n'));
      }
    }
  } catch {}

  if (sections.length === 0) return '';
  return '## 上下文情报（先查后答，回答时必须参考）\n\n' + sections.join('\n\n');
}

// 调试导出（测试用）
export { gatherContextIntel };

/** 模型库指引：告诉模型有哪些专用模型可按需调用 */
const MODEL_REGISTRY_DIRECTIVE = `## 可调用的专用模型库（按需调用，不影响默认模型）

除了你自己（默认模型），还可以随时调用以下专用模型处理特定任务。调用方式：用 sessions_spawn 工具 spawn 子代理，并指定 model 参数。

可用模型：
- **代码模型** \`omlx/Qwen2.5-Coder-7B-4bit\`：代码生成、调试、重构（本地，快）
- **润色模型** \`apfel/apple-foundationmodel\`：文本润色、改写、更自然的表达（本地）
- **推理模型** \`deepseek/deepseek-reasoner\`：数学证明、复杂逻辑推理
- **长文档模型** \`zhipu/glm-5.2\`：超长文档分析、大上下文（1M）

**何时主动调用**：遇到明显属于某类专长且能显著提升质量的任务时，可以用 sessions_spawn 调对应模型。例如：
- 用户要求写较复杂的代码 → spawn 代码模型
- 用户要求润色文章 → spawn 润色模型
- 数学/逻辑证明题 → spawn 推理模型

**用户指定调用**：如果用户明确说"用代码模型""用润色模型"等，直接按要求 spawn 对应模型。

**注意**：简单任务不要滥用子代理（有额外开销）。只有确实能用专长模型明显提升质量时才调用。调用后把子代理的结果整合进你的回答。`;

/** 梯度升级指令：flash 判断搞不定时主动喊 pro 救场 */
const ESCALATE_DIRECTIVE = `## 能力升级机制（梯度升级）

你是日常对话模型（快但能力有限）。如果遇到超出你能力的任务，不要勉强给出质量差的回答。

**何时应该请求升级**（任一命中）：
- 需要深度推理、多步骤架构设计、复杂系统设计
- 长代码生成（>50 行）或复杂调试
- 你对答案不确定、在猜测
- 需要多个工具协同完成的复杂任务
- 用户明确要求“仔细分析”、“深入设计”、“详细规划”

**如何请求升级**：
如果判断需要升级，回复必须以特殊标记开头：
[ESCALATE] 这个问题需要更强的模型处理，因为（简述原因）。

系统检测到此标记后，会自动调用更强的模型重新回答。用户会先看到你的升级提示，然后看到强模型的流式回答。

**不要升级的场景**：日常闲聊、简单问答、状态查询、翻译、总结、短代码——这些你能胜任，直接答，避免浪费。`;

/** 先搜后答强制指令：让模型养成涉及时效性信息必须先查的习惯 */
const PRE_SEARCH_DIRECTIVE = `## 回答前必须执行（先搜后答）

涉及时效性信息时，必须先调用搜索工具获取实时资料，再基于查到的内容回答，禁止仅凭训练数据作答。

触发条件（任一命中即必须搜索）：
- 新闻、时事、行情、价格、汇率、股价
- 软件/库/模型的最新版本、更新日志、发布动态
- 用户提到"最新"、"现在"、"最近"、"今天"、"目前"、"实时"
- 技术文档、API 用法、开源项目现状（这些会随时间变化）
- 你不确定是否仍然准确的事实

执行方式（按优先级）：
1. **本地采集服务**（http://127.0.0.1:8099，智能搜索+抓取一体）：
   - 用 web_fetch 调用 http://127.0.0.1:8099/collect/smart?q=关键词&fetch_top=2
   - 返回结构化搜索结果+正文，中文自动走百度，英文走 Bing
2. xiaoyi-web-search（中文优化）或 web_search
3. web_fetch 直接抓取已知 URL 验证细节
回答时标注信息来源和获取时间。

不需要搜索的场景（直接答）：纯编程、逻辑推理、数学计算、翻译润色、闲聊、执行类任务（用户明确说不用查）。`;

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
      // 意图恢复（能力注册已在 getInstance 中完成）
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

    // ═══ 收到用户消息：先查后答 + 硬边界检查 + 写检查点 ═══
    case 'message:received': {
      const text = event.context?.text || event.context?.message || '';

      // ── 先查：检索上下文情报并立即写入 prompt 文件，让模型本轮就看到 ──
      if (config.preAnswerLookup !== false) {
        const intel = await gatherContextIntel(claw, text);
        if (process.env.METOO_DEBUG) process.stderr.write(`[metoo-debug] intel len=${intel.length} tools=${JSON.stringify(Object.keys(claw.selfAwareness.learningLoop.getStats().tools||{}))}\n`);
        refreshSystemPromptFile(claw, storageDir, intel);
      }

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

      // 写检查点（惰性：不 await，后台写，不阻塞响应链路）
      claw.temporalCore.checkpoint.writeCheckpoint({
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
      }).catch(() => {}); // 后台静默写盘，失败不影响响应
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
  // 注意：message:received 已在先查阶段带情报刷新过，此处跳过避免覆盖情报
  if (`${event.type}:${event.action}` !== 'message:received') {
    refreshSystemPromptFile(claw, storageDir);
  }
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
