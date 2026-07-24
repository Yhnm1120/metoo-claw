# metoo-claw 模型库（Model Registry）

集中管理所有可用模型，按需调用，**不影响默认模型（flash）和兜底模型（pro）**。

## 模型清单

| 别名 | 模型 ID | 提供商 | 地址 | 用途 | 特点 |
|------|---------|--------|------|------|------|
| **代码** | `omlx/Qwen2.5-Coder-7B-4bit` | omlx | localhost:8000 | 代码生成/调试 | 本地、免费、快 |
| **润色** | `apfel/apple-foundationmodel` | apfel | localhost:11535 | 文本润色/改写 | 本地 Apple 模型、自然 |
| **推理** | `deepseek/deepseek-reasoner` | deepseek | 云端 | 数学/逻辑推理 | 思维链强 |
| **长文档** | `zhipu/glm-5.2` | zhipu | 云端 | 超长上下文 | 1M context |
| **日常**(默认) | `deepseek/deepseek-v4-flash` | deepseek | 云端 | 日常对话 | 快、便宜 |
| **兜底** | `deepseek/deepseek-v4-pro` | deepseek | 云端 | 复杂任务 | 质量最高 |
| **备用中文** | `moonshot/(待配)` | moonshot | 云端 | 中文优化 | 未配模型 ID |

## 调用方式

通过 `sessions_spawn` 工具 spawn 子代理，指定 `model` 参数：

```
sessions_spawn({
  task: "写一个 Python 爬虫，抓取豆瓣电影 Top250",
  model: "omlx/Qwen2.5-Coder-7B-4bit",   // 指定代码模型
  runtime: "subagent"
})
```

子代理用指定模型完成任务后返回结果，**主对话仍用默认模型**。

## 用户指定调用的说法

- "用代码模型..." → `omlx/Qwen2.5-Coder-7B-4bit`
- "用润色模型..." / "帮我润色" → `apfel/apple-foundationmodel`
- "用推理模型..." → `deepseek/deepseek-reasoner`
- "用长文档模型..." → `zhipu/glm-5.2`

## 触发时机（AI 自主判断）

遇到以下任务时，AI 可主动建议或调用对应模型：
- 代码生成/调试/重构 → 代码模型
- 文本润色/改写/更自然的表达 → 润色模型
- 数学证明/逻辑推理 → 推理模型
- 超长文档分析/大上下文 → 长文档模型
