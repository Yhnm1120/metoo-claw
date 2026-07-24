#!/usr/bin/env python3
"""
凌霄运维大脑 — 日志语义扫描器（整合自老 healer logwatch）
扫描 Gateway 日志，用语义模式识别异常，聚合后分级上报。

与老 logwatch 的区别：
  - 作为 guard v3.0 的子模块，统一推送（不再独立发报告）
  - 正常时沉默（不再发"日志扫描正常"）
  - 接入 guard 的去重 + outbox 推送

模式分级：
  P0(critical): 磁盘满/Gateway崩溃/认证失败
  P1(warning):  lane任务错误/MCP失败/连接拒绝/配置错误
"""

import json
import os
import re
import sys
import glob
import datetime
from collections import defaultdict

STATE = os.path.expanduser("~/.openclaw/guard-logwatch-state.json")
LOG_DIR = "/tmp/openclaw"

# 语义模式表（severity, category, patterns）
PATTERNS = {
    # P0
    "disk_full": ("P0", "disk", [r"磁盘.*不足", r"no space", r"disk.*full"]),
    "gateway_crash": ("P0", "gateway", [r"gateway.*crash", r"gateway.*exit", r"bootstrap failed",
                                         r"startup_failed", r"restart failed"]),
    "auth_failed": ("P0", "auth", [r"AUTH_FAILED", r"INVALID_REQUEST", r"invalid request frame",
                                    r"authentication.*failed", r"Permission denied"]),
    # P1
    "lane_task_error": ("P1", "agent", [r"lane task error", r"embedded_run_failover",
                                         r"surface_error", r"failover_decision"]),
    "mcp_failure": ("P1", "mcp", [r"failed to start server.*mcp", r"McpError", r"bundle-mcp.*failed",
                                   r"MCP.*connection closed", r"MCP.*error"]),
    "connection_refused": ("P1", "network", [r"connection.*refused", r"connect.*timed out",
                                              r"operation timed out", r"closed before connect"]),
    "config_error": ("P1", "config", [r"InvalidConfigError", r"INVALID_CONFIG",
                                       r"Unrecognized key", r"config.*invalid"]),
}

# 编译正则
COMPILED = {name: (sev, cat, [re.compile(p, re.I) for p in pats])
            for name, (sev, cat, pats) in PATTERNS.items()}


def _load_state():
    try:
        return json.load(open(STATE, encoding="utf-8"))
    except Exception:
        return {"last_offset": {}, "alert_cooldown": {}}


def _save_state(s):
    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        json.dump(s, open(STATE, "w", encoding="utf-8"))
    except Exception:
        pass


def today_logs():
    """今天要扫描的日志文件"""
    day = datetime.datetime.now().strftime("%Y-%m-%d")
    main = os.path.join(LOG_DIR, "openclaw-%s.log" % day)
    files = []
    if os.path.isfile(main):
        files.append(main)
    # 兼容滚动日志
    files.extend(sorted(glob.glob(os.path.join(LOG_DIR, "openclaw-%s*.log" % day)))[:2])
    return list(dict.fromkeys(files))  # 去重保序


def scan():
    """扫描日志，返回 [(name, severity, category, count, sample)] 聚合结果"""
    state = _load_state()
    hits = defaultdict(lambda: {"count": 0, "sample": ""})

    for path in today_logs():
        try:
            size = os.path.getsize(path)
            offset = state["last_offset"].get(path, 0)
            # 文件被截断/轮转，从头读
            if offset > size:
                offset = 0
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                f.seek(offset)
                new_lines = f.readlines()
                state["last_offset"][path] = f.tell()

            for line in new_lines[-2000:]:  # 单次最多扫2000行防爆
                for name, (sev, cat, regs) in COMPILED.items():
                    if any(r.search(line) for r in regs):
                        hits[name]["sev"] = sev
                        hits[name]["cat"] = cat
                        hits[name]["count"] += 1
                        if not hits[name]["sample"]:
                            hits[name]["sample"] = line.strip()[:200]
                        break  # 一行只算一个模式
        except Exception:
            continue

    _save_state(state)

    # 转列表 + 冷却过滤（30min 同类只报一次）
    now = datetime.datetime.now().timestamp()
    results = []
    cooldown = state.get("alert_cooldown", {})
    for name, h in hits.items():
        if h["count"] == 0:
            continue
        last = cooldown.get(name, 0)
        if now - last < 1800:  # 30min 冷却
            continue
        results.append((name, h["sev"], h["cat"], h["count"], h["sample"]))
        cooldown[name] = now
    state["alert_cooldown"] = cooldown
    _save_state(state)

    # 按 severity 排序（P0 在前）
    results.sort(key=lambda x: 0 if x[1] == "P0" else 1)
    return results


if __name__ == "__main__":
    results = scan()
    if not results:
        print("NO_ANOMALY")
    else:
        for name, sev, cat, count, sample in results:
            print(json.dumps({"name": name, "severity": sev, "category": cat,
                              "count": count, "sample": sample}, ensure_ascii=False))
