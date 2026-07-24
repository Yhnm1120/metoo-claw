/**
 * metoo Auto Polish 插件
 *
 * 在消息发送前（message_sending）自动调用 Apple 本地模型润色长文本回复。
 *
 * 规则：
 * - 只润色长文本（默认 >60 字）
 * - 跳过含代码块的消息（``` 或大量缩进代码），避免改坏代码
 * - 跳过纯标记/指令类消息（[ESCALATE] 等）
 * - 润色失败/超时静默降级，返回原文（不阻塞发送）
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const POLISH_SYSTEM_PROMPT =
  "你是文本润色助手。把用户给的文本改写得更自然流畅、简洁清晰，保持原意和技术准确性，" +
  "不要增删事实，不要改变格式结构（列表/标题保持原样）。只输出润色后的文本，不要任何解释、前缀或引号。";

function resolveConfig(cfg) {
  return {
    polishUrl: cfg?.polishUrl || "http://localhost:11535/v1/chat/completions",
    model: cfg?.model || "apple-foundationmodel",
    minLength: typeof cfg?.minLength === "number" ? cfg.minLength : 60,
    enabled: cfg?.enabled !== false,
    timeoutMs: typeof cfg?.timeoutMs === "number" ? cfg.timeoutMs : 15000,
  };
}

/** 判断是否跳过润色 */
function shouldSkip(text) {
  if (!text) return true;
  const t = text.trim();
  // 含代码块
  if (t.includes("```")) return true;
  // 含升级/指令标记
  if (t.startsWith("[ESCALATE]") || t.startsWith("HEARTBEAT_OK") || t === "NO_REPLY") return true;
  // 含大量 URL（润色可能破坏链接）
  const urlCount = (t.match(/https?:\/\//g) || []).length;
  if (urlCount >= 3) return true;
  return false;
}

async function polishText(cfg, text, logger) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const resp = await fetch(cfg.polishUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: POLISH_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        max_tokens: Math.max(256, Math.ceil(text.length * 1.5)),
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger?.warn?.(`metoo-polish: 润色服务返回 ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const polished = data?.choices?.[0]?.message?.content?.trim();
    if (!polished || polished.length < 10) return null;
    return polished;
  } catch (e) {
    logger?.warn?.(`metoo-polish: 润色失败 ${String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default definePluginEntry({
  id: "metoo-polish",
  name: "metoo Auto Polish",
  description: "发送前自动用 Apple 本地模型润色长文本回复",
  version: "1.0.0",
  kind: "hook",

  register(api) {
    if (api.registrationMode !== "full") return;
    const cfg = resolveConfig(api.pluginConfig);
    if (!cfg.enabled) {
      api.logger.info?.("metoo-polish: disabled");
      return;
    }

    api.on("message_sending", async (event, ctx) => {
      try {
        const text = event?.content;
        if (typeof text !== "string") return undefined;
        const trimmed = text.trim();
        if (trimmed.length < cfg.minLength) return undefined;
        if (shouldSkip(trimmed)) return undefined;

        const polished = await polishText(cfg, trimmed, api.logger);
        if (!polished || polished === trimmed) return undefined;

        api.logger.info?.(`metoo-polish: 已润色 (${trimmed.length} -> ${polished.length} 字)`);
        return { content: polished };
      } catch (e) {
        api.logger.warn?.(`metoo-polish: hook 异常 ${String(e)}`);
        return undefined; // 任何异常都不阻塞发送
      }
    });

    api.logger.info?.(`metoo-polish: 已启用 (>${cfg.minLength}字自动润色, 模型=${cfg.model})`);
  },
});
