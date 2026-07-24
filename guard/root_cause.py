#!/usr/bin/env python3
"""
凌霄运维大脑 — 智能根因诊断器
当组件异常时，抓取相关日志 → 调云端模型推理根因 → 输出诊断报告。

诊断报告包含：
  - 根因（为什么会出这个问题）
  - 修复建议（怎么修）
  - 预防建议（怎么避免再犯）

模型：deepseek-chat（便宜，诊断够用）。从 keychain/配置读 API key。
降级：模型不可用时返回基于规则的简单诊断。
"""

import json
import os
import re
import subprocess
import sys
import datetime
import glob

DIAG_DIR = os.path.expanduser("~/.openclaw/diagnosis")
OPENCLAW_JSON = os.path.expanduser("~/.openclaw/openclaw.json")


def sh(cmd, timeout=8):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return (r.stdout + r.stderr).strip()
    except Exception:
        return ""


def get_deepseek_key():
    """从 keychain 读 deepseek API key（参考 openclaw.json 的配置）"""
    # openclaw 把 key 存在 macOS keychain，id 为 openclaw-deepseek-api-key
    key = sh("security find-generic-password -s 'openclaw-deepseek-api-key' -w 2>/dev/null")
    if key and not key.startswith("security:"):
        return key
    # 兜底：环境变量
    return os.environ.get("DEEPSEEK_API_KEY", "")


def get_base_url():
    try:
        d = json.load(open(OPENCLAW_JSON, encoding="utf-8"))
        return d.get("models", {}).get("providers", {}).get("deepseek", {}).get("baseUrl",
               "https://api.deepseek.com/v1")
    except Exception:
        return "https://api.deepseek.com/v1"


def grab_logs(component, lines=80):
    """按组件抓取相关日志"""
    logs = []
    today = datetime.datetime.now().strftime("%Y-%m-%d")
    candidates = {
        "gateway": ["/tmp/openclaw/openclaw-%s.log" % today,
                    os.path.expanduser("~/.openclaw/logs/gateway.log")],
        "collector": [os.path.expanduser("~/.openclaw/data_collector/collector.log")],
        "guard": ["/tmp/openclaw-guard.log"],
    }
    for path in candidates.get(component, candidates["gateway"]):
        if os.path.isfile(path):
            try:
                content = sh("tail -%d '%s'" % (lines, path))
                if content:
                    logs.append("=== %s ===\n%s" % (path, content[-3000:]))
            except Exception:
                pass
    return "\n\n".join(logs)[:6000]


def get_local_models():
    """返回可用的本地 OpenAI 兼容端点列表（按优先级）"""
    return [
        ("http://localhost:8000/v1", "Qwen3.5-9B-MLX-4bit"),   # MLX 主推理
        ("http://localhost:11434/v1", "qwen2.5:7b"),           # Ollama 兼容端点
    ]


def diagnose_with_model(component, symptom, logs):
    """优先用本地模型推理根因（免费、快、不依赖 keychain/外网）"""
    prompt = (
        "你是资深运维专家。系统组件 [%s] 出现异常：%s。\n\n"
        "以下是相关日志（可能不完整）：\n```\n%s\n```\n\n"
        "请用简洁中文输出三段（每段一句话）：\n"
        "根因：<最可能的原因>\n"
        "修复：<具体可操作的修复步骤>\n"
        "预防：<如何避免再次发生>\n"
        "如果日志信息不足，根因写'日志不足，疑似X'。"
    ) % (component, symptom, logs or "（无可用日志）")

    body = json.dumps({
        "messages": [
            {"role": "system", "content": "你是资深运维专家，擅长从日志定位根因。回答简洁、可操作。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "max_tokens": 400,
    })
    for base, model in get_local_models():
        try:
            payload = json.loads(body)
            payload["model"] = model
            cmd = ("curl -s -m 30 '%s/chat/completions' -H 'Content-Type: application/json' -d @-" % base)
            r = subprocess.run(cmd, input=json.dumps(payload), shell=True,
                               capture_output=True, text=True, timeout=35)
            data = json.loads(r.stdout)
            text = data["choices"][0]["message"]["content"].strip()
            if text and len(text) > 20:
                return text
        except Exception:
            continue
    return None


def diagnose_rule_based(component, symptom):
    """规则兜底诊断（模型不可用时）"""
    rules = {
        "gateway": "根因：Gateway 进程崩溃或被系统回收\n修复：launchctl kickstart -k gui/501/ai.openclaw.gateway\n预防：检查内存是否不足，或日志中是否有反复崩溃的错误",
        "collector": "根因：采集服务进程退出（可能是网络或依赖问题）\n修复：cd ~/.openclaw/data_collector && ./venv/bin/python server.py\n预防：查看 collector.log 最后的报错",
        "disk": "根因：磁盘空间不足\n修复：清理大文件和缓存\n预防：定期清理 /tmp 和下载目录",
    }
    return rules.get(component, "根因：%s\n修复：人工检查\n预防：无" % symptom)


def diagnose(component, symptom):
    """主入口：先模型，失败降级规则"""
    logs = grab_logs(component)
    report = diagnose_with_model(component, symptom, logs)
    source = "model"
    if not report:
        report = diagnose_rule_based(component, symptom)
        source = "rule"

    # 存诊断记录
    os.makedirs(DIAG_DIR, exist_ok=True)
    rec = {"ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
           "component": component, "symptom": symptom, "source": source, "report": report}
    day = rec["ts"][:10]
    with open(os.path.join(DIAG_DIR, "diag-%s.jsonl" % day), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return {"report": report, "source": source}


if __name__ == "__main__":
    comp = sys.argv[1] if len(sys.argv) > 1 else "gateway"
    sym = sys.argv[2] if len(sys.argv) > 2 else "unknown error"
    r = diagnose(comp, sym)
    print(json.dumps(r, ensure_ascii=False))
