---
name: metoo-claw
description: "metoo-claw: Temporal Core + Self-Awareness Layer — 17 modules for agent self-awareness and session persistence"
events:
  - "gateway:startup"
  - "agent:bootstrap"
  - "message:received"
  - "message:sent"
  - "session:compact:before"
  - "command:new"
  - "command:reset"
---

# metoo-claw Hook

挂载 metoo-claw 的 17 个模块到 OpenClaw Gateway。

## 注入点

- **gateway:startup**: 初始化 metoo-claw 实例，崩溃恢复检查
- **agent:bootstrap**: 注入能力注册表/能力地图/硬边界到 system prompt；意图恢复提示
- **message:received**: 写会话检查点；硬边界检查
- **message:sent**: 因果链记录；学习反馈
- **session:compact:before**: 用增量压缩替代官方全量压缩
- **command:new / command:reset**: 归档当前意图，保存检查点链

## 配置

```json
{
  "hooks": {
    "metoo-claw": {
      "enabled": true,
      "storageDir": "~/.openclaw/metoo-claw-data",
      "injectPrompt": true,
      "intentResume": true,
      "incrementalCompaction": true
    }
  }
}
```
