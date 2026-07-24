# 凌霄守护进程 v3.0 — 活的运维专家

## 设计理念转变

从"每分钟报告一切正常" → "平时安静如鸡，出事立即诊断、修复、然后才推一条给你"。

## 核心架构

```
每 5 分钟巡检一轮
  ↓
分层诊断（不是简单端口检查）
  现象 → 定位根因 → 匹配修复策略
  ↓
分级修复
  L1 预设方案（自动）→ L2 历史方案（自动）→ L3 需授权操作（报你确认）
  每步修复后验证是否真的好
  ↓
智能推送
  正常 → 沉默（只更新 AWARENESS.md）
  异常+自动修复成功 → 推一条"✅ X 出问题，已自动修复"
  异常+需授权 → 推一条"⚠️ X 出问题，需要你确认是否修复"
  异常+修不好 → 推一条"🚨 X 出问题，自动修复失败，需要人工介入"
```

## 自动修复边界

**可自动（不问）**：
- 重启 Gateway / MCP 服务 / 可视化服务
- 清理 /tmp 下 1 天前的日志、过期缓存
- 重建 SSH 反向隧道
- 重打 LaunchAgent

**必须先报你确认（L3）**：
- 删除大文件（>100MB）
- 修改任何配置文件（openclaw.json、plist 等）
- 动数据库（sqlite 写入/清理）
- 任何不可逆操作

## 分层诊断

**Gateway**（三级）：
- L0 进程活着（lsof :18789）
- L1 无错误日志（tail 最近日志，无 error/fatal）
- L2 HTTP API 端到端（curl /health 返回 ok，Python 实现超时）
- L3 WebSocket 连通（握手成功）

**磁盘**：读 `/System/Volumes/Data`（真实数据盘），不是 `/`（只读系统快照）

**网络**：
- HK 服务器：SSH 探活（Python subprocess 带超时）
- DNS：解析 github.com
- 外网：curl 一个国内可达地址

**采集系统**：8099 /health 端点（我们新做的服务）

## Bug 修复清单（v2.2 → v3.0）

1. ✅ timeout 命令不存在 → Python subprocess.run(timeout=N) 统一实现
2. ✅ 磁盘读错盘 → 改读 /System/Volumes/Data
3. ✅ 日志太啰嗦 → 状态变化/异常才记，正常沉默
4. ✅ 推送靠人读文件 → 主动推送（写 outbox 由 OpenClaw 发）
5. ✅ smart_heal 半成品 → 分级修复 + 验证

## 推送实现

真推送走 OpenClaw 消息渠道。guard 是独立 bash 进程，没法直接调 OpenClaw API。
方案：写 `~/.openclaw/guard-outbox.jsonl`，由 metoo-claw hook 在收到用户消息时检查并转发。
（更简单：guard 直接把告警写入 urgents.json，metoo-claw 已在读 prompt，但主动推送需要 outbox 机制）

最简单可靠：guard 检测到需推送的事件 → 追加到 outbox.jsonl → metoo-claw hook 每次 message:received 时检查 outbox，有新条目就通过 event.messages.push 注入提醒。
