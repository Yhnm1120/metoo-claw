#!/usr/bin/env node
/**
 * metoo-mcp-server.mjs — MCP (Model Context Protocol) Server for metoo.chat
 *
 * 用途：
 *   将 metoo.chat 后端的 HTTP API 包装为 MCP 工具，通过 Streamable HTTP 传输暴露。
 *   供 AI 客户端（如 Claude Desktop、OpenClaw 等）发现并调用 metoo 的收藏、聊天、运维功能。
 *
 * 启动方式：
 *   node metoo-mcp-server.mjs
 *   默认监听 127.0.0.1:3100，绑定本地，由反向代理/鉴权层对外暴露。
 *
 * 环境变量：
 *   METOO_API_BASE — 上游 metoo.chat HTTP API 基地址，默认 http://127.0.0.1:3009
 *   MCP_HOST       — 监听地址，默认 127.0.0.1
 *   MCP_PORT       — 监听端口，默认 3100
 *
 * 依赖：
 *   零外部依赖，仅使用 Node.js 内置模块（http, fetch）。
 *
 * 协议：
 *   实现 MCP Streamable HTTP 传输（JSON-RPC 2.0 over HTTP POST /mcp）。
 *   支持方法：initialize, tools/list, tools/call。
 *   响应格式：application/json（非流式，单次响应包含完整结果）。
 */

// ─── 配置 ────────────────────────────────────────────────────────────────────

const METOO_API_BASE = process.env.METOO_API_BASE || 'http://127.0.0.1:3009';
const MCP_HOST       = process.env.MCP_HOST       || '127.0.0.1';
const MCP_PORT       = parseInt(process.env.MCP_PORT || '3100', 10);
const HTTP_TIMEOUT   = 10_000; // 每个上游 HTTP 请求的超时时间（毫秒）

// MCP 协议版本
const MCP_PROTOCOL_VERSION = '2024-11-05';

// ─── 上游 HTTP 请求工具 ──────────────────────────────────────────────────────

/**
 * 向 metoo.chat HTTP API 发送 GET 请求
 * @param {string} path - API 路径，如 '/api/collections'
 * @param {Record<string,string>} [query] - URL 查询参数
 * @returns {Promise<{ok:boolean, status:number, data:any}>}
 */
async function apiGet(path, query) {
  const url = new URL(path, METOO_API_BASE);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    });
  }
  return apiFetch(url.toString(), { method: 'GET' });
}

/**
 * 向 metoo.chat HTTP API 发送 POST 请求
 * @param {string} path - API 路径
 * @param {any} body - JSON 请求体
 * @returns {Promise<{ok:boolean, status:number, data:any}>}
 */
async function apiPost(path, body) {
  const url = new URL(path, METOO_API_BASE);
  return apiFetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * 带超时的通用 HTTP fetch
 * @param {string} url
 * @param {RequestInit} options
 * @returns {Promise<{ok:boolean, status:number, data:any}>}
 */
async function apiFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    let data;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, status: 0, data: { error: `上游 API 请求超时（${HTTP_TIMEOUT}ms）: ${url}` } };
    }
    return { ok: false, status: 0, data: { error: `上游 API 请求失败: ${err.message}` } };
  } finally {
    clearTimeout(timer);
  }
}

// ─── MCP 工具定义 ────────────────────────────────────────────────────────────

/**
 * 所有 MCP 工具的注册表。
 * 每个工具包含：name, description, inputSchema, handler
 */
const toolsRegistry = [
  {
    name: 'collections_list',
    description: '获取 metoo.chat 的收藏列表。可选 category 参数按分类过滤（如 "article"、"link" 等）。返回收藏数组。',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: '分类过滤值（可选），如 "article"、"link"、"note" 等',
        },
      },
    },
    handler: async (args) => {
      const res = await apiGet('/api/collections', { category: args.category });
      return formatResult(res);
    },
  },
  {
    name: 'collections_search',
    description: '在 metoo.chat 收藏中搜索，匹配 title / description / tag / tags 字段。返回匹配的收藏数组。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词（必填），用于匹配收藏的标题、描述和标签',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      if (!args.query || !args.query.trim()) {
        return { content: [{ type: 'text', text: '参数 "query" 不能为空' }], isError: true };
      }
      const res = await apiGet('/api/collections/search', { q: args.query.trim() });
      return formatResult(res);
    },
  },
  {
    name: 'chat',
    description: '向 metoo.chat AI 发送一条聊天消息并获取回复。message 参数为消息文本内容。',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '用户消息文本（必填）',
        },
      },
      required: ['message'],
    },
    handler: async (args) => {
      if (!args.message || !args.message.trim()) {
        return { content: [{ type: 'text', text: '参数 "message" 不能为空' }], isError: true };
      }
      const res = await apiPost('/api/chat', { message: args.message.trim() });
      return formatResult(res);
    },
  },
  {
    name: 'ops_diagnostics',
    description: '运行 metoo.chat 运维诊断，检查系统健康状况、磁盘使用、构建状态、内容统计和服务状态。无需参数。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const res = await apiGet('/api/ops/diagnostics');
      return formatResult(res);
    },
  },
  {
    name: 'ops_action',
    description: '在 metoo.chat 上执行运维操作。action 指定操作类型（如 "rebuild"、"restart"、"clean" 等），params 为可选附加参数。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '运维操作类型（必填），如 "rebuild"、"restart"、"clean"、 "sync" 等',
        },
        params: {
          type: 'object',
          description: '附加参数（可选），根据 action 类型传递不同的配置对象',
        },
      },
      required: ['action'],
    },
    handler: async (args) => {
      if (!args.action || !args.action.trim()) {
        return { content: [{ type: 'text', text: '参数 "action" 不能为空' }], isError: true };
      }
      const res = await apiPost('/api/ops/action', {
        action: args.action.trim(),
        params: args.params || {},
      });
      return formatResult(res);
    },
  },
  {
    name: 'ops_context',
    description: '获取 metoo.chat 运维上下文信息，包括系统配置、环境变量、运行状态等。无需参数。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const res = await apiGet('/api/ops/context');
      return formatResult(res);
    },
  },
  {
    name: 'ops_health',
    description: '检查 metoo.chat 运维健康状态，返回各服务的健康检查结果。无需参数。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const res = await apiGet('/api/ops/health');
      return formatResult(res);
    },
  },
  {
    name: 'health',
    description: '检查 metoo.chat 基础健康状态，确认服务是否正常运行。无需参数。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const res = await apiGet('/health');
      return formatResult(res);
    },
  },
];

/**
 * 将上游 HTTP 响应格式化为 MCP 工具调用结果
 * @param {{ok:boolean, status:number, data:any}} apiResult
 * @returns {{content:Array<{type:string,text:string}>, isError:boolean}}
 */
function formatResult(apiResult) {
  if (!apiResult.ok) {
    const text = typeof apiResult.data === 'string'
      ? apiResult.data
      : JSON.stringify(apiResult.data, null, 2);
    return {
      content: [{ type: 'text', text: `HTTP ${apiResult.status || 'ERR'}: ${text}` }],
      isError: true,
    };
  }

  const text = typeof apiResult.data === 'string'
    ? apiResult.data
    : JSON.stringify(apiResult.data, null, 2);
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

// ─── 工具查找 ────────────────────────────────────────────────────────────────

/**
 * 按名称查找 MCP 工具定义
 * @param {string} name
 * @returns {object|undefined}
 */
function findTool(name) {
  return toolsRegistry.find(t => t.name === name);
}

// ─── JSON-RPC / MCP 请求处理 ────────────────────────────────────────────────

/**
 * 处理 MCP Request（JSON-RPC 请求）
 * @param {object} body - 解析后的 JSON-RPC 请求体
 * @returns {Promise<object[]>} 返回数组，包含一个或多个 JSON-RPC 消息（streamable-http 协议允许返回多个）
 */
async function handleMCPRequest(body) {
  // 校验 JSON-RPC 基础字段
  if (!body || body.jsonrpc !== '2.0') {
    return [makeErrorResponse(null, -32600, 'Invalid Request: 缺少 jsonrpc 字段或版本不是 2.0')];
  }
  if (!body.method) {
    return [makeErrorResponse(body.id, -32600, 'Invalid Request: 缺少 method 字段')];
  }

  const { method, id, params } = body;

  try {
    // ─── initialize ──────────────────────────────────────────────────────
    if (method === 'initialize') {
      // 返回协议版本和 capabilities
      return [{
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},        // 服务端支持 tools 能力
          },
          serverInfo: {
            name: 'metoo-mcp-server',
            version: '0.1.0',
          },
        },
      }];
    }

    // ─── tools/list ──────────────────────────────────────────────────────
    if (method === 'tools/list') {
      const tools = toolsRegistry.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return [{
        jsonrpc: '2.0',
        id: id ?? null,
        result: { tools },
      }];
    }

    // ─── tools/call ──────────────────────────────────────────────────────
    if (method === 'tools/call') {
      if (!params || !params.name) {
        return [makeErrorResponse(id, -32602, 'Invalid params: 缺少工具名称 (name)')];
      }

      const tool = findTool(params.name);
      if (!tool) {
        return [{
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [{ type: 'text', text: `未知工具: "${params.name}"。可用工具: ${toolsRegistry.map(t => t.name).join(', ')}` }],
            isError: true,
          },
        }];
      }

      // 调用工具的 handler
      const toolResult = await tool.handler(params.arguments || {});
      return [{
        jsonrpc: '2.0',
        id: id ?? null,
        result: toolResult,
      }];
    }

    // ─── notifications (无响应) ───────────────────────────────────────────
    // 如果 id === undefined，是通知（notifications），忽略
    if (id === undefined || id === null) {
      return []; // 通知不需要响应
    }

    // ─── 未知方法 ─────────────────────────────────────────────────────────
    return [makeErrorResponse(id, -32601, `Method not found: ${method}`)];
  } catch (err) {
    return [makeErrorResponse(id, -32603, `Internal error: ${err.message}`)];
  }
}

/**
 * 构造一个 JSON-RPC 错误响应
 */
function makeErrorResponse(id, code, message) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  };
}

// ─── HTTP 服务器 ─────────────────────────────────────────────────────────────

import { createServer } from 'node:http';

const server = createServer(async (req, res) => {
  // 只接受 POST /mcp
  if (req.method !== 'POST' || req.url !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found. Use POST /mcp' }));
    return;
  }

  // 读取 request body
  let body = '';
  req.on('data', chunk => { body += chunk; });

  req.on('end', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: 请求体不是合法 JSON' },
      }));
      return;
    }

    // 处理请求
    const responses = await handleMCPRequest(parsed);

    // streamable-http: 如果客户端接受 text/event-stream，用 SSE 格式返回
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/event-stream')) {
      // SSE 响应：每个 JSON-RPC 消息作为一个 data 事件发送
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      if (responses.length === 0) {
        // 无响应（通知），发一个空事件
        res.write('event: end\ndata: \n\n');
      } else {
        for (const msg of responses) {
          res.write(`data: ${JSON.stringify(msg)}\n\n`);
        }
      }
      res.end();
    } else {
      // 标准 JSON 响应
      if (responses.length === 0) {
        // 通知类请求，无响应体
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      } else if (responses.length === 1) {
        // 单条响应
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responses[0]));
      } else {
        // 多条响应（极少情况），以 JSON 数组返回
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responses));
      }
    }
  });
});

// ─── 启动 ─────────────────────────────────────────────────────────────────────

server.listen(MCP_PORT, MCP_HOST, () => {
  console.log(`[metoo-mcp-server] 已启动`);
  console.log(`  监听地址:   http://${MCP_HOST}:${MCP_PORT}/mcp`);
  console.log(`  上游 API:   ${METOO_API_BASE}`);
  console.log(`  注册工具:   ${toolsRegistry.length} 个`);
  console.log(`  协议:       MCP Streamable HTTP (JSON-RPC 2.0)`);
  console.log(`  依赖:       零外部依赖（纯 Node.js 内置模块）`);
  console.log('');
  console.log(`  可用工具列表:`);
  toolsRegistry.forEach(t => console.log(`    - ${t.name}`));
});

// ─── 优雅关闭 ────────────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n[metoo-mcp-server] 正在关闭...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.log('\n[metoo-mcp-server] 收到 SIGTERM，正在关闭...');
  server.close(() => process.exit(0));
});
