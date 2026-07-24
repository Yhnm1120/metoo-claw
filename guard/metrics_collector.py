#!/usr/bin/env python3
"""
凌霄运维大脑 — 时序指标采集器
每轮巡检调用一次，采集关键指标存为时序数据（JSONL，按天滚动）。
供趋势预测、根因诊断、对话式运维使用。

存储：~/.openclaw/metrics/metrics-YYYY-MM-DD.jsonl
保留：自动清理 7 天前的文件
"""

import json
import os
import re
import subprocess
import sys
import datetime
import glob

METRICS_DIR = os.path.expanduser("~/.openclaw/metrics")
DATA_VOL = "/System/Volumes/Data" if os.path.isdir("/System/Volumes/Data") else "/"


def sh(cmd, timeout=8):
    """执行命令返回 stdout，失败返回空串"""
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


def port_listen(port):
    try:
        r = subprocess.run(["lsof", "-iTCP:%d" % port, "-sTCP:LISTEN"],
                           capture_output=True, text=True, timeout=5)
        return "LISTEN" in r.stdout
    except Exception:
        # lsof 不存在时退回 socket 探测（跨平台）
        try:
            import socket
            s = socket.socket(); s.settimeout(2)
            s.connect(("127.0.0.1", port)); s.close()
            return True
        except Exception:
            return False


def collect():
    now = datetime.datetime.now().astimezone()
    m = {"ts": now.isoformat(timespec="seconds"), "epoch": int(now.timestamp())}

    # ── 磁盘（真实数据盘）──
    df = sh("df -k %s | tail -1" % DATA_VOL)
    parts = df.split()
    if len(parts) >= 5:
        try:
            m["disk_avail_gb"] = round(int(parts[3]) / 1024 / 1024, 1)
            m["disk_used_pct"] = int(parts[4].rstrip("%"))
        except Exception:
            pass

    # ── 内存 ──
    vm = sh("vm_stat")
    page_size = 16384
    free_pages = int(re.search(r"Pages free:\s+(\d+)", vm).group(1)) if re.search(r"Pages free:\s+(\d+)", vm) else 0
    inactive = int(re.search(r"Pages inactive:\s+(\d+)", vm).group(1)) if re.search(r"Pages inactive:\s+(\d+)", vm) else 0
    m["mem_free_gb"] = round((free_pages + inactive) * page_size / 1024**3, 1)

    # ── 负载 ──
    up = sh("uptime")
    la = re.search(r"load averages?:\s+([\d.]+)", up)
    if la:
        m["load_1m"] = float(la.group(1))

    # ── 进程数 ──
    m["proc_count"] = len(sh("ps -eo pid").splitlines()) - 1

    # ── 服务状态 ──
    m["gw_alive"] = port_listen(18789)
    m["collector_alive"] = port_listen(8099)
    m["mlx_alive"] = port_listen(8000)
    m["apfel_alive"] = port_listen(11535)

    # ── 关键进程内存占用 (RSS MB) ──
    for name, pattern in [("gateway", "openclaw"), ("ollama", "ollama")]:
        rss = sh("ps -eo rss,comm | grep -i %s | grep -v grep | awk '{s+=$1} END {print s}'" % pattern)
        try:
            m["%s_rss_mb" % name] = round(int(rss) / 1024) if rss else 0
        except Exception:
            m["%s_rss_mb"] = 0

    return m


def save(m):
    os.makedirs(METRICS_DIR, exist_ok=True)
    day = m["ts"][:10]
    path = os.path.join(METRICS_DIR, "metrics-%s.jsonl" % day)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(m, ensure_ascii=False) + "\n")


def cleanup(days=7):
    cutoff = datetime.datetime.now() - datetime.timedelta(days=days)
    for p in glob.glob(os.path.join(METRICS_DIR, "metrics-*.jsonl")):
        day = os.path.basename(p).replace("metrics-", "").replace(".jsonl", "")
        try:
            if datetime.datetime.strptime(day, "%Y-%m-%d") < cutoff:
                os.remove(p)
        except Exception:
            pass


if __name__ == "__main__":
    m = collect()
    save(m)
    cleanup()
    # 输出一行摘要（供 guard 日志/调试）
    print(json.dumps({k: m.get(k) for k in
          ["disk_avail_gb", "disk_used_pct", "mem_free_gb", "load_1m",
           "gw_alive", "collector_alive", "gateway_rss_mb"]}, ensure_ascii=False))
