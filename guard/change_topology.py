#!/usr/bin/env python3
"""
凌霄运维大脑 — 变更关联 + 依赖拓扑分析

变更关联：记录系统变更事件（配置/部署/重启），出问题时回溯最近变更找因果。
依赖拓扑：某组件挂了，沿拓扑图找出所有受影响的下游，输出完整影响面。

变更日志：~/.openclaw/changes/changes.jsonl
拓扑图：  guard/topology.json
"""

import json
import os
import sys
import datetime
import glob

CHANGES_DIR = os.path.expanduser("~/.openclaw/changes")
CHANGES_LOG = os.path.join(CHANGES_DIR, "changes.jsonl")
TOPOLOGY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "topology.json")


def record_change(kind, target, detail=""):
    """记录一次变更事件。kind: config/deploy/restart/install"""
    os.makedirs(CHANGES_DIR, exist_ok=True)
    rec = {"ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
           "kind": kind, "target": target, "detail": detail}
    with open(CHANGES_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def recent_changes(hours=6):
    """最近 N 小时的变更"""
    if not os.path.isfile(CHANGES_LOG):
        return []
    cutoff = datetime.datetime.now().astimezone() - datetime.timedelta(hours=hours)
    out = []
    try:
        for line in open(CHANGES_LOG, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            try:
                ts = datetime.datetime.fromisoformat(d["ts"])
                if ts >= cutoff:
                    out.append(d)
            except Exception:
                pass
    except Exception:
        pass
    return out


def load_topology():
    try:
        return json.load(open(TOPOLOGY, encoding="utf-8"))
    except Exception:
        return {"nodes": {}, "edges": []}


def impact_analysis(failed_component):
    """某组件故障 → 沿拓扑找所有受影响下游，返回影响描述列表"""
    topo = load_topology()
    edges = topo.get("edges", [])
    nodes = topo.get("nodes", {})
    impacts = []
    visited = set()

    def walk(comp):
        for e in edges:
            if e.get("from") == comp and e.get("to") not in visited:
                visited.add(e["to"])
                impacts.append(e.get("impact", ""))
                walk(e["to"])  # 级联：下游的下游也受影响

    walk(failed_component)
    return impacts


def correlate(failed_component, symptom):
    """出问题时：变更关联 + 影响面，输出人类可读分析"""
    parts = []

    # 1. 影响面
    impacts = impact_analysis(failed_component)
    if impacts:
        parts.append("影响面：" + "；".join(impacts))

    # 2. 变更关联
    changes = recent_changes(hours=6)
    if changes:
        lines = []
        for c in changes[-3:]:
            t = str(c.get("ts", ""))[5:16].replace("T", " ")
            lines.append("%s %s %s" % (t, c.get("kind"), c.get("target")))
        parts.append("最近变更（可能相关）：" + "；".join(lines))
    else:
        parts.append("最近6小时无变更记录（排除变更导致）")

    return "\n".join(parts)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "correlate"
    if cmd == "record":
        record_change(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "")
        print(json.dumps({"recorded": True}, ensure_ascii=False))
    elif cmd == "impact":
        comp = sys.argv[2]
        print(json.dumps({"impacts": impact_analysis(comp)}, ensure_ascii=False))
    elif cmd == "correlate":
        comp = sys.argv[2] if len(sys.argv) > 2 else "gateway"
        sym = sys.argv[3] if len(sys.argv) > 3 else ""
        print(correlate(comp, sym))
    elif cmd == "changes":
        print(json.dumps(recent_changes(int(sys.argv[2]) if len(sys.argv) > 2 else 6), ensure_ascii=False))
