#!/usr/bin/env python3
"""
凌霄运维大脑 — 自主学习修复
两件事：
  1. lookup(symptom/component)：在 heal_knowledge 里查验证过的修复方案
  2. learn(component, symptom, fix, success)：修复后沉淀经验（成功才记为 verified）

知识库：~/.openclaw/workspace/memory/heal_knowledge.jsonl
guard 沉淀的条目带 source="guard-v3"、verified=True、success_count 累计。
"""

import json
import os
import sys
import datetime
import re

KNOWLEDGE = os.path.expanduser("~/.openclaw/workspace/memory/heal_knowledge.jsonl")


def _norm(s):
    return re.sub(r"\s+", " ", str(s or "").lower()).strip()


def lookup(component, symptom):
    """查历史验证过的修复方案。返回 (fix_text, success_count) 或 None"""
    if not os.path.isfile(KNOWLEDGE):
        return None
    comp_n = _norm(component)
    sym_n = _norm(symptom)
    best = None
    best_score = 0
    try:
        for line in open(KNOWLEDGE, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            # 只看有修复方案的
            fix = d.get("fix") or ""
            if not fix or fix in ("待 Specialist 深入分析", "诊断中"):
                continue
            # 匹配：组件名 或 症状关键词重叠
            text = _norm((d.get("title", "") + " " + d.get("symptom", "") + " " + d.get("category", "")))
            score = 0
            if comp_n and comp_n in text:
                score += 2
            # 症状词重叠（简单包含）
            for w in set(sym_n.split()):
                if len(w) > 2 and w in text:
                    score += 1
            # guard 验证过的加分
            if d.get("verified"):
                score += 3
            sc = d.get("success_count", 1)
            if score > best_score:
                best_score = score
                best = (fix, sc)
    except Exception:
        pass
    # 至少要组件匹配或有实质词重叠
    return best if best_score >= 3 else None


def learn(component, symptom, fix, success):
    """修复后沉淀经验。success=True 记为 verified，累计成功次数"""
    os.makedirs(os.path.dirname(KNOWLEDGE), exist_ok=True)
    now = datetime.datetime.now().astimezone().isoformat(timespec="seconds")

    # 读现有，看是否已有同类条目（有则更新 success_count，无则新增）
    lines = []
    updated = False
    comp_n = _norm(component)
    sym_n = _norm(symptom)
    if os.path.isfile(KNOWLEDGE):
        for line in open(KNOWLEDGE, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                lines.append(line)
                continue
            # 匹配同类（guard 沉淀的 + 组件相同 + 症状相似）
            if (d.get("source") == "guard-v3" and _norm(d.get("component")) == comp_n
                    and _norm(d.get("symptom")) == sym_n):
                if success:
                    d["success_count"] = d.get("success_count", 1) + 1
                    d["verified"] = True
                    d["fix"] = fix  # 用最新有效方案
                else:
                    d["fail_count"] = d.get("fail_count", 0) + 1
                    # 失败太多次就取消 verified
                    if d["fail_count"] >= 3:
                        d["verified"] = False
                d["last_seen"] = now
                updated = True
            lines.append(json.dumps(d, ensure_ascii=False))

    if not updated:
        rec = {
            "ts": now, "source": "guard-v3", "category": "auto_fix",
            "component": component, "symptom": symptom, "fix": fix,
            "severity": "P2", "verified": bool(success),
            "success_count": 1 if success else 0, "fail_count": 0 if success else 1,
            "last_seen": now, "note": "guard 自动沉淀",
        }
        lines.append(json.dumps(rec, ensure_ascii=False))

    # 原子写回
    tmp = KNOWLEDGE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, KNOWLEDGE)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "lookup"
    if cmd == "lookup":
        comp = sys.argv[2] if len(sys.argv) > 2 else ""
        sym = sys.argv[3] if len(sys.argv) > 3 else ""
        r = lookup(comp, sym)
        print(json.dumps({"found": bool(r), "fix": r[0] if r else None,
                          "success_count": r[1] if r else 0}, ensure_ascii=False))
    elif cmd == "learn":
        comp, sym, fix = sys.argv[2], sys.argv[3], sys.argv[4]
        success = sys.argv[5].lower() in ("1", "true", "yes") if len(sys.argv) > 5 else True
        learn(comp, sym, fix, success)
        print(json.dumps({"learned": True, "verified": success}, ensure_ascii=False))
