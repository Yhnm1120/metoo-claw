#!/usr/bin/env python3
"""
凌霄运维大脑 — 趋势预测器
读取时序指标，做线性趋势外推，提前预警：
  - 磁盘：按当前消耗速率，预测几天后 < 阈值
  - 内存泄漏：gateway 进程 RSS 持续上涨 → 预测 OOM 风险
  - 负载：持续高负载 → 预警性能劣化

输出：预警信号列表（供 guard 推送）。无风险时输出空。
"""

import json
import os
import glob
import datetime
import statistics

METRICS_DIR = os.path.expanduser("~/.openclaw/metrics")
DATA_VOL_THRESHOLD_GB = 10      # 磁盘低于此值视为危险
LEAK_WINDOW_HOURS = 6           # 内存泄漏观察窗口
LEAK_MIN_GROWTH_MB = 200        # 窗口内增长超过此值疑似泄漏
DISK_MIN_SAMPLES = 12           # 至少需要 1 小时数据(12*5min)才做磁盘预测


def load_metrics(hours=24):
    """加载最近 N 小时的指标"""
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


def linear_slope(xs, ys):
    """最小二乘法拟合斜率（y 随 x 的变化率）"""
    n = len(xs)
    if n < 2:
        return 0.0
    mx, my = statistics.mean(xs), statistics.mean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs)
    return num / den if den else 0.0


def predict_disk(rows):
    """磁盘趋势：预测多久后 < 阈值"""
    pts = [(r["epoch"], r["disk_avail_gb"]) for r in rows if "disk_avail_gb" in r]
    if len(pts) < DISK_MIN_SAMPLES:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    slope = linear_slope(xs, ys)  # GB/秒
    current = ys[-1]
    if current < DATA_VOL_THRESHOLD_GB:
        return {"level": "alert", "component": "disk",
                "message": "磁盘已低于阈值（剩 %.1fGB），请立即清理。" % current}
    if slope >= 0:  # 在增长，不会满
        return None
    # 每秒消耗的 GB（slope 为负）
    secs_to_full = (current - DATA_VOL_THRESHOLD_GB) / (-slope)
    days = secs_to_full / 86400
    if days <= 3:
        return {"level": "warn", "component": "disk",
                "message": "按当前消耗速率（%.2fGB/天），磁盘约 %.1f 天后将低于 %dGB，建议提前清理。"
                % ((-slope) * 86400, days, DATA_VOL_THRESHOLD_GB)}
    return None


def predict_memory_leak(rows):
    """内存泄漏：gateway RSS 持续上涨"""
    cutoff = datetime.datetime.now().timestamp() - LEAK_WINDOW_HOURS * 3600
    pts = [(r["epoch"], r["gateway_rss_mb"]) for r in rows
           if "gateway_rss_mb" in r and r.get("epoch", 0) >= cutoff and r["gateway_rss_mb"] > 0]
    if len(pts) < 6:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    slope = linear_slope(xs, ys)  # MB/秒
    growth = slope * (xs[-1] - xs[0])
    # 持续上涨且增长量超阈值
    if slope > 0 and growth >= LEAK_MIN_GROWTH_MB:
        rate_mb_h = slope * 3600
        return {"level": "warn", "component": "memory",
                "message": "Gateway 内存疑似泄漏：%d 小时内增长 %.0fMB（%.0fMB/小时），当前 %.0fMB。建议关注，必要时重启。"
                % (LEAK_WINDOW_HOURS, growth, rate_mb_h, ys[-1])}
    return None


def predict_load(rows):
    """负载趋势：持续高负载"""
    pts = [r["load_1m"] for r in rows if "load_1m" in r]
    if len(pts) < 6:
        return None
    recent = pts[-6:]
    if statistics.mean(recent) > 8.0:  # M4 Pro 高负载阈值
        return {"level": "warn", "component": "load",
                "message": "系统持续高负载（1分钟均值 %.1f），可能有进程失控，建议检查。" % statistics.mean(recent)}
    return None


def predict_all():
    rows = load_metrics(hours=24)
    alerts = []
    for fn in (predict_disk, predict_memory_leak, predict_load):
        try:
            r = fn(rows)
            if r:
                alerts.append(r)
        except Exception:
            pass
    return alerts


if __name__ == "__main__":
    alerts = predict_all()
    if alerts:
        for a in alerts:
            print(json.dumps(a, ensure_ascii=False))
    else:
        print("NO_PREDICTION")
