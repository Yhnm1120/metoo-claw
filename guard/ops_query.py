#!/usr/bin/env python3
"""
凌霄运维大脑 — 对话式运维查询
你问"系统怎么样/昨天为什么卡/哪个最占资源"，它汇总全部数据给出答案素材。

输出：结构化运维摘要（供 metoo-claw 注入 prompt，由主模型组织自然语言回答）。
命令：
  overview           系统总览（当前状态+趋势+最近异常+最近变更）
  resource           资源占用分析（哪个服务最占内存/磁盘趋势）
  history [hours]    最近 N 小时的异常与修复历史
"""

import json
import os
import sys
import glob
import datetime
import statistics

METRICS_DIR = os.path.expanduser("~/.openclaw/metrics")
AWARENESS = os.path.expanduser("~/.openclaw/workspace/AWARENESS.md")
FIX_LOG = os.path.expanduser("~/.openclaw/heal_history.jsonl")
DIAG_DIR = os.path.expanduser("~/.openclaw/diagnosis")
CHANGES = os.path.expanduser("~/.openclaw/changes/changes.jsonl")


def load_metrics(hours=24):
    cutoff = datetime.datetime.now() - datetime.timedelta(hours=hours)
    rows = []
    for p in sorted(glob.glob(os.path.join(METRICS_DIR, "metrics-*.jsonl"))):
        try:
            for line in open(p, encoding="utf-8"):
                line = line.strip()
                if not line:
                    continue
                d = json.loads(line)
                ts = datetime.datetime.fromisoformat(d["ts"])
                if ts.replace(tzinfo=None) >= cutoff:
                    rows.append(d)
        except Exception:
            pass
    rows.sort(key=lambda x: x.get("epoch", 0))
    return rows


def recent_jsonl(path, hours=24, filter_key=None):
    if not os.path.isfile(path):
        return []
    cutoff = datetime.datetime.now().astimezone() - datetime.timedelta(hours=hours)
    out = []
    try:
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            ts_str = d.get("ts", "")
            try:
                ts = datetime.datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                if ts >= cutoff:
                    out.append(d)
            except Exception:
                out.append(d)  # 无时间戳也带上
    except Exception:
        pass
    return out


def overview():
    m = load_metrics(24)
    out = {"当前状态": {}, "趋势": {}, "最近异常": [], "最近变更": []}

    if m:
        last = m[-1]
        out["当前状态"] = {
            "磁盘可用GB": last.get("disk_avail_gb"), "磁盘占用%": last.get("disk_used_pct"),
            "内存可用GB": last.get("mem_free_gb"), "负载": last.get("load_1m"),
            "Gateway": "正常" if last.get("gw_alive") else "异常",
            "采集服务": "正常" if last.get("collector_alive") else "异常",
        }
        # 磁盘趋势
        disks = [r["disk_avail_gb"] for r in m if "disk_avail_gb" in r]
        if len(disks) >= 2:
            out["趋势"]["磁盘24h变化GB"] = round(disks[-1] - disks[0], 1)
        # 负载均值/峰值
        loads = [r["load_1m"] for r in m if "load_1m" in r]
        if loads:
            out["趋势"]["负载均值"] = round(statistics.mean(loads), 2)
            out["趋势"]["负载峰值"] = round(max(loads), 2)
        # Gateway RSS
        rss = [r["gateway_rss_mb"] for r in m if r.get("gateway_rss_mb")]
        if rss:
            out["趋势"]["Gateway内存MB"] = {"当前": rss[-1], "峰值": max(rss)}

    out["最近异常"] = [f"{d.get('component')}:{d.get('symptom')}({d.get('status','?')})"
                      for d in recent_jsonl(FIX_LOG, 24)][-5:]
    out["最近变更"] = [f"{c.get('kind')}:{c.get('target')}"
                      for c in recent_jsonl(CHANGES, 24)][-5:]
    return out


def resource():
    m = load_metrics(24)
    if not m:
        return {"说明": "暂无足够指标数据"}
    last = m[-1]
    rss_data = {}
    for k in ("gateway_rss_mb", "ollama_rss_mb"):
        vals = [r[k] for r in m if r.get(k)]
        if vals:
            rss_data[k.replace("_rss_mb", "")] = {"当前MB": vals[-1], "峰值MB": max(vals),
                                                    "均值MB": round(statistics.mean(vals))}
    return {
        "磁盘": {"可用GB": last.get("disk_avail_gb"), "占用%": last.get("disk_used_pct")},
        "内存": {"可用GB": last.get("mem_free_gb")},
        "各服务内存占用": rss_data,
        "负载": {"当前": last.get("load_1m")},
    }


def history(hours=24):
    fixes = recent_jsonl(FIX_LOG, hours)
    diags = []
    for p in glob.glob(os.path.join(DIAG_DIR, "diag-*.jsonl")):
        diags.extend(recent_jsonl(p, hours))
    return {
        "修复历史": [{"组件": d.get("component"), "症状": d.get("symptom"),
                     "状态": d.get("status", "?"), "方案": d.get("fix", "")} for d in fixes][-10:],
        "诊断记录": [{"组件": d.get("component"), "来源": d.get("source"),
                     "报告": d.get("report", "")[:150]} for d in diags][-5:],
    }


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "overview"
    if cmd == "overview":
        print(json.dumps(overview(), ensure_ascii=False, indent=2))
    elif cmd == "resource":
        print(json.dumps(resource(), ensure_ascii=False, indent=2))
    elif cmd == "history":
        print(json.dumps(history(int(sys.argv[2]) if len(sys.argv) > 2 else 24),
                         ensure_ascii=False, indent=2))
