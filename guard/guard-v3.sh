#!/bin/bash
# ============================================================
# GUARD.sh — 凌霄守护进程 v3.0「活的运维专家」
# 独立于 Gateway 运行，由 LaunchAgent 管理。
#
# 设计理念：平时安静如鸡，出事立即诊断、修复、然后才推一条给你。
#
# v3.0 核心改动：
#   - 修复 timeout 命令不存在（macOS）：Python 统一实现带超时执行
#   - 修复磁盘读错盘：读 /System/Volumes/Data 真实数据盘
#   - 日志降噪：正常沉默，只在状态变化/真异常时记录
#   - 主动推送：异常+修复结果 → outbox → OpenClaw 推给你
#   - 分层诊断：现象→根因→策略；分级修复：预设→历史→需授权
#   - 巡检频率 5 分钟
# ============================================================
set -uo pipefail

INTERVAL=300          # 5 分钟
LOG="/tmp/openclaw-guard.log"
WORKSPACE="$HOME/.openclaw/workspace"
SMART_COLLECT="$WORKSPACE/smart_collect"
LOG_MAX=300
FIX_LOG="$HOME/.openclaw/heal_history.jsonl"
FIX_LOG_MAX=100
AWARENESS="$WORKSPACE/AWARENESS.md"
URGENTS="$WORKSPACE/urgents.json"
OUTBOX="$HOME/.openclaw/guard-outbox.jsonl"   # 主动推送队列（metoo-claw 读取转发）
STATE_DIR="/tmp/openclaw-guard-state"          # 上次状态（用于变化检测）
mkdir -p "$STATE_DIR" /tmp/openclaw-alert

PY3="/usr/bin/python3"

# ── 统一带超时执行（替代不存在的 timeout 命令）────────────
# 用法: run_timed <秒> <命令...>
run_timed() {
  local secs="$1"; shift
  "$PY3" - "$secs" "$@" <<'PYEOF'
import subprocess, sys
secs = float(sys.argv[1])
cmd = sys.argv[2:]
try:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=secs)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr)
    sys.exit(r.returncode)
except subprocess.TimeoutExpired:
    sys.stderr.write("TIMEOUT")
    sys.exit(124)
except FileNotFoundError as e:
    sys.stderr.write(f"CMD_NOT_FOUND:{e}")
    sys.exit(127)
PYEOF
}

# ── 日志（降噪：只在状态变化或异常时记）────────────────────
log() {
  echo "[$(date '+%m-%d %H:%M:%S')] $*" >> "$LOG"
  local lines
  lines=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  if [ "$lines" -gt "$LOG_MAX" ]; then
    tail -n "$LOG_MAX" "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

# 状态变化检测：state_changed <组件> <当前状态值>
# 状态与上次不同才返回 0（应记录/推送）
state_changed() {
  local comp="$1" val="$2"
  local f="$STATE_DIR/$comp"
  local prev=""
  [ -f "$f" ] && prev=$(cat "$f")
  if [ "$prev" != "$val" ]; then
    echo "$val" > "$f"
    return 0
  fi
  return 1
}

# 告警去重：alert_dedup <key> <窗口秒>，窗口内重复返回 1（不推送）
alert_dedup() {
  local key="$1" window="${2:-300}"
  local now stamp_file last=0
  now=$(date +%s)
  stamp_file="/tmp/openclaw-alert/${key//:/_}"
  [ -f "$stamp_file" ] && last=$(cat "$stamp_file" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$window" ]; then return 1; fi
  echo "$now" > "$stamp_file"
  return 0
}

# ── 主动推送：写入 outbox，metoo-claw 转发给用户 ──────────
# push_notify <级别:ok|warn|alert> <组件> <消息>
push_notify() {
  local level="$1" comp="$2" msg="$3"
  local icon
  case "$level" in
    ok)    icon="✅" ;;
    warn)  icon="⚠️" ;;
    alert) icon="🚨" ;;
    *)     icon="ℹ️" ;;
  esac
  "$PY3" - "$level" "$comp" "$msg" "$OUTBOX" <<'PYEOF'
import json, sys, datetime
level, comp, msg, outbox = sys.argv[1:5]
rec = {
  "ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
  "level": level, "component": comp, "message": msg,
}
with open(outbox, "a", encoding="utf-8") as f:
    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
PYEOF
  log "📤 推送[$level][$comp]: $msg"
}

# ── 修复历史记录 ──────────────────────────────────────────
record_fix() {  # record_fix <severity> <component> <symptom> <fix|status>
  "$PY3" - "$1" "$2" "$3" "$4" "$FIX_LOG" <<'PYEOF'
import json, sys, datetime
sev, comp, sym, fix, path = sys.argv[1:6]
rec = {"ts": datetime.datetime.utcnow().isoformat(timespec="seconds")+"Z",
       "severity": sev, "component": comp, "symptom": sym}
if fix.startswith("unresolved"):
    rec["status"] = "unresolved"
else:
    rec["fix"] = fix; rec["status"] = "resolved"
with open(path, "a", encoding="utf-8") as f:
    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
PYEOF
}

# ── 工具 ──────────────────────────────────────────────────
port_listen() { lsof -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; }

# ══════════════════════════════════════════════════════
#  Gateway 三级诊断
#  L0 进程活着 / L1 无错误日志 / L2 HTTP+WS 端到端
# ══════════════════════════════════════════════════════
GATEWAY_HEALTH_LEVEL=-1

_gw_http_check() {
  # Python 实现 HTTP 探活（带超时）
  "$PY3" -c "
import urllib.request, sys
try:
    r = urllib.request.urlopen('http://127.0.0.1:18789/health', timeout=5)
    sys.exit(0 if r.status in (200,302,401) else 1)
except Exception:
    sys.exit(1)
"
}

_gw_log_check() {
  local log_file="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
  [ ! -f "$log_file" ] && return 0
  local errors
  errors=$(tail -50 "$log_file" 2>/dev/null | grep -c -E "lane task error|AUTH_FAILED|INVALID_REQUEST|restart failed" 2>/dev/null || true)
  errors=$(echo "$errors" | tr -d ' \n')
  [ "${errors:-0}" -lt 3 ]
}

_gw_ws_check() {
  "$PY3" -c "
import socket, sys
try:
    s = socket.socket(); s.settimeout(5)
    s.connect(('127.0.0.1', 18789))
    s.send(b'GET / HTTP/1.1\r\nHost: 127.0.0.1:18789\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    resp = s.recv(256); s.close()
    sys.exit(0 if (b'101' in resp or b'400' in resp) else 1)
except Exception:
    sys.exit(1)
"
}

check_gateway() {
  local alive=false
  if port_listen 18789; then
    alive=true
    GATEWAY_HEALTH_LEVEL=0
    _gw_log_check && GATEWAY_HEALTH_LEVEL=1
    if _gw_http_check && _gw_ws_check; then GATEWAY_HEALTH_LEVEL=2; fi
  else
    GATEWAY_HEALTH_LEVEL=-1
  fi

  # 状态变化才记录
  if state_changed "gateway" "$GATEWAY_HEALTH_LEVEL"; then
    local icon="❌"
    case $GATEWAY_HEALTH_LEVEL in
      2) icon="💚" ;; 1) icon="🟡" ;; 0) icon="✅" ;;
    esac
    log "$icon Gateway L$GATEWAY_HEALTH_LEVEL"
  fi

  if $alive; then return 0; fi

  # ── Gateway 挂了：分级自愈（L1 自动）──
  log "⚠️ Gateway 无响应，启动自愈..."
  local fixed=false

  # 预设方案 1: kickstart
  if launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null; then
    sleep 4
    if port_listen 18789; then fixed=true; fi
  fi
  # 预设方案 2: bootstrap
  if ! $fixed; then
    local plist="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
    if [ -f "$plist" ]; then
      launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || true
      sleep 2
      launchctl kickstart "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null || true
      sleep 4
      if port_listen 18789; then fixed=true; fi
    fi
  fi

  if $fixed; then
    log "✅ Gateway 已自动恢复"
    record_fix "P1" "gateway" "gateway not responding" "kickstart/bootstrap"
    # 自主学习：沉淀有效方案
    [ -f "$SELF_HEAL" ] && "$PY3" "$SELF_HEAL" learn "gateway" "gateway not responding" "launchctl kickstart/bootstrap" true >/dev/null 2>&1 || true
    push_notify "ok" "gateway" "Gateway 刚才无响应，已自动重启恢复。"
    state_changed "gateway" "2"
    return 0
  fi

  # 修不好 → 智能根因诊断 + 记录失败（供学习调优）
  log "🚨 Gateway 自愈失败，启动根因诊断..."
  record_fix "P0" "gateway" "gateway restart failed" "unresolved"
  [ -f "$SELF_HEAL" ] && "$PY3" "$SELF_HEAL" learn "gateway" "gateway not responding" "launchctl kickstart/bootstrap" false >/dev/null 2>&1 || true
  local diag_report=""
  if [ -f "$ROOT_CAUSE" ]; then
    diag_report=$("$PY3" "$ROOT_CAUSE" "gateway" "gateway restart failed, kickstart/bootstrap 无效" 2>/dev/null | "$PY3" -c 'import sys,json;print(json.loads(sys.stdin.read()).get("report",""))' 2>/dev/null || echo "")
  fi
  if [ -n "$diag_report" ]; then
    # 附加变更关联+影响面
    local extra=""
    [ -f "$CHANGE_TOPO" ] && extra=$("$PY3" "$CHANGE_TOPO" correlate "gateway" "restart failed" 2>/dev/null || echo "")
    push_notify "alert" "gateway" "Gateway 无响应且自动重启失败。诊断：${diag_report}${extra:+。$extra}"
  else
    push_notify "alert" "gateway" "Gateway 无响应且自动重启失败，需要人工介入（可尝试手动 launchctl kickstart）。"
  fi
  return 1
}

# ══════════════════════════════════════════════════════
#  MCP / 可视化服务保活（L1 自动重启）
# ══════════════════════════════════════════════════════
start_python_script() {
  local script="$1" tag="$2"
  [ ! -f "$script" ] && return 1
  if pgrep -f "$script" >/dev/null 2>&1; then
    if state_changed "svc:$tag" "up"; then :; fi  # 正常，沉默
    return 0
  fi
  nohup "$PY3" "$script" >> "$LOG" 2>&1 &
  sleep 2
  if pgrep -f "$script" >/dev/null 2>&1; then
    log "✅ $tag 已自动重启 (pid=$!)"
    push_notify "ok" "$tag" "$tag 服务刚才停止，已自动拉起。"
    state_changed "svc:$tag" "up"
  else
    push_notify "warn" "$tag" "$tag 服务无法启动，可能需要人工检查。"
    state_changed "svc:$tag" "down"
  fi
}

check_mcp_servers() { start_python_script "$SMART_COLLECT/mcp_server.py" "MCP:smart-collect"; }
check_visualizer()  { start_python_script "$SMART_COLLECT/memory_visualizer.py" "可视化服务"; }

# ══════════════════════════════════════════════════════
#  采集系统（8099 服务）诊断
# ══════════════════════════════════════════════════════
check_collector() {
  local ok
  ok=$("$PY3" -c "
import urllib.request, sys
try:
    r = urllib.request.urlopen('http://127.0.0.1:8099/health', timeout=5)
    sys.exit(0 if r.status==200 else 1)
except Exception:
    sys.exit(1)
" && echo up || echo down)

  if [ "$ok" = "up" ]; then
    state_changed "collector" "up" && log "💚 采集服务(8099) 恢复"
    return 0
  fi
  # down：尝试自动重启
  if state_changed "collector" "down"; then
    log "⚠️ 采集服务(8099) 无响应，自动重启..."
  fi
  pkill -f "data_collector/server.py" 2>/dev/null || true
  sleep 1
  (cd "$HOME/.openclaw/data_collector" && nohup ./venv/bin/python server.py >> collector.log 2>&1 &)
  sleep 4
  if "$PY3" -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8099/health',timeout=5).status==200 else 1)" 2>/dev/null; then
    log "✅ 采集服务已自动恢复"
    push_notify "ok" "collector" "采集服务(8099) 刚才无响应，已自动重启恢复。"
    state_changed "collector" "up"
  else
    push_notify "warn" "collector" "采集服务(8099) 无法启动，联网搜索功能不可用，需要人工检查。"
    state_changed "collector" "down"
  fi
}

# ══════════════════════════════════════════════════════
#  磁盘监控（读真实数据盘 /System/Volumes/Data）
# ══════════════════════════════════════════════════════
check_disk() {
  local vol="/System/Volumes/Data"
  [ ! -d "$vol" ] && vol="/"
  local avail_gb used_pct
  avail_gb=$(df -k "$vol" 2>/dev/null | tail -1 | awk '{printf "%d", $4/1024/1024}')
  used_pct=$(df -k "$vol" 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
  [ -z "$avail_gb" ] && return 0

  local level="ok"
  [ "$avail_gb" -lt 10 ] && level="warn"
  [ "$avail_gb" -lt 2 ] && level="crit"

  if state_changed "disk" "$level"; then
    case "$level" in
      ok)   log "✅ 磁盘恢复正常: ${avail_gb}GB (已用${used_pct}%)" ;;
      warn) log "⚠️ 磁盘偏低: ${avail_gb}GB (已用${used_pct}%)" ;;
      crit) log "🚨 磁盘严重不足: ${avail_gb}GB (已用${used_pct}%)" ;;
    esac
  fi

  if [ "$level" = "crit" ]; then
    # 可自动：清 /tmp 旧日志
    find /tmp -name "*.log" -mtime +1 -delete 2>/dev/null
    local new_avail
    new_avail=$(df -k "$vol" 2>/dev/null | tail -1 | awk '{printf "%d", $4/1024/1024}')
    if [ "$new_avail" -gt "$avail_gb" ]; then
      push_notify "ok" "disk" "磁盘曾不足 2GB，已自动清理临时日志，释放到 ${new_avail}GB。"
      record_fix "P2" "disk" "disk low ${avail_gb}GB" "clean /tmp logs"
    else
      # 需要删大文件 → L3 报你确认
      push_notify "alert" "disk" "磁盘严重不足(${avail_gb}GB)，自动清理临时文件无效。需要你确认是否清理大文件/缓存。"
      record_fix "P1" "disk" "disk low ${avail_gb}GB" "unresolved"
    fi
  elif [ "$level" = "warn" ]; then
    push_notify "warn" "disk" "磁盘空间偏低：剩 ${avail_gb}GB（已用${used_pct}%），建议择机清理。"
  fi
}

# ══════════════════════════════════════════════════════
#  网络诊断（HK 服务器 / DNS / 外网）
# ══════════════════════════════════════════════════════
check_network() {
  # HK 服务器
  local hk
  hk=$(run_timed 8 ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no hk-proxy "echo up" 2>/dev/null | grep -c up || echo 0)
  if [ "$hk" -gt 0 ]; then
    state_changed "net:hk" "up" && log "✅ HK 服务器恢复"
  else
    if state_changed "net:hk" "down"; then
      log "⚠️ HK 服务器不可达"
      push_notify "warn" "network" "HK 服务器(47.79.21.43)暂时不可达，隧道相关功能受影响。"
    fi
  fi

  # DNS
  local dns
  dns=$(run_timed 5 nslookup github.com 2>/dev/null | grep -c Address || echo 0)
  if [ "$dns" -gt 0 ]; then
    state_changed "net:dns" "up"
  else
    if state_changed "net:dns" "down"; then
      log "⚠️ DNS 解析异常"
      push_notify "warn" "network" "DNS 解析异常，可能影响联网功能。"
    fi
  fi
}

# ══════════════════════════════════════════════════════
#  更新 AWARENESS.md + urgents.json（静默仪表盘）
# ══════════════════════════════════════════════════════
update_awareness() {
  local now_ts gw_status disk_status hk_status
  now_ts=$(date '+%Y-%m-%d %H:%M %Z')

  case $GATEWAY_HEALTH_LEVEL in
    2) gw_status="💚" ;; 1) gw_status="🟡" ;; 0) gw_status="✅" ;; *) gw_status="❌" ;;
  esac

  local vol="/System/Volumes/Data"; [ ! -d "$vol" ] && vol="/"
  local disk_avail disk_total disk_pct
  disk_avail=$(df -k "$vol" 2>/dev/null | tail -1 | awk '{printf "%d", $4/1024/1024}')
  disk_total=$(df -k "$vol" 2>/dev/null | tail -1 | awk '{printf "%d", $2/1024/1024}')
  disk_pct=$(df -k "$vol" 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
  if [ "${disk_avail:-99}" -lt 2 ]; then disk_status="🚨"; elif [ "${disk_avail:-99}" -lt 10 ]; then disk_status="⚠️"; else disk_status="✅"; fi

  if run_timed 6 ssh -o ConnectTimeout=4 -o StrictHostKeyChecking=no hk-proxy "echo up" 2>/dev/null | grep -q up; then hk_status="✅"; else hk_status="❌"; fi

  cat > "$AWARENESS" << AWEOF
# 🛰 System Awareness (v3.0)
> Guard 每 5 分钟巡检 | 平时安静，出事主动推送

| 组件 | 状态 | 详情 |
|------|:----:|------|
| Gateway | ${gw_status} | :18789 (L${GATEWAY_HEALTH_LEVEL}) |
| 采集服务 | $(state_changed "collector" "$(cat $STATE_DIR/collector 2>/dev/null || echo up)" >/dev/null 2>&1; cat $STATE_DIR/collector 2>/dev/null || echo up) | :8099 |
| 磁盘 | ${disk_status} | ${disk_avail:-?}Gi/${disk_total:-?}Gi (${disk_pct:-?}%) |
| HK 服务器 | ${hk_status} | 47.79.21.43 |

*最后更新: ${now_ts}*
AWEOF

  # urgents.json：当前未解决的 P0/P1
  "$PY3" - "$FIX_LOG" "$URGENTS" <<'PYEOF'
import json, sys
fix_log, urgents = sys.argv[1:3]
items = []
try:
    for line in open(fix_log, encoding="utf-8"):
        try:
            d = json.loads(line)
            if d.get("status") == "unresolved" and d.get("severity") in ("P0", "P1"):
                items.append({"severity": d["severity"], "component": d.get("component"),
                              "symptom": str(d.get("symptom",""))[:80], "ts": d.get("ts","")})
        except Exception: pass
except FileNotFoundError: pass
json.dump(items[-10:], open(urgents, "w", encoding="utf-8"), ensure_ascii=False)
PYEOF
}

# ══════════════════════════════════════════════════════
#  指标采集 + 趋势预测（运维大脑）
# ══════════════════════════════════════════════════════
GUARD_DIR="$HOME/.openclaw/workspace"
METRICS_COLLECTOR="$GUARD_DIR/guard/metrics_collector.py"
TREND_PREDICTOR="$GUARD_DIR/guard/trend_predictor.py"
ROOT_CAUSE="$GUARD_DIR/guard/root_cause.py"
SELF_HEAL="$GUARD_DIR/guard/self_heal_brain.py"
CHANGE_TOPO="$GUARD_DIR/guard/change_topology.py"

collect_metrics() {
  [ -f "$METRICS_COLLECTOR" ] && "$PY3" "$METRICS_COLLECTOR" >/dev/null 2>&1 || true
}

run_trend_prediction() {
  [ ! -f "$TREND_PREDICTOR" ] && return 0
  local alerts
  alerts=$("$PY3" "$TREND_PREDICTOR" 2>/dev/null | grep -v NO_PREDICTION || true)
  [ -z "$alerts" ] && return 0
  # 每条预警去重后推送（同类 6 小时内不重复）
  echo "$alerts" | while IFS= read -r line; do
    [ -z "$line" ] && continue
    local comp level msg
    comp=$(echo "$line" | "$PY3" -c 'import sys,json;print(json.loads(sys.stdin.read()).get("component","?"))' 2>/dev/null || echo "?")
    level=$(echo "$line" | "$PY3" -c 'import sys,json;print(json.loads(sys.stdin.read()).get("level","warn"))' 2>/dev/null || echo "warn")
    msg=$(echo "$line" | "$PY3" -c 'import sys,json;print(json.loads(sys.stdin.read()).get("message",""))' 2>/dev/null || echo "")
    [ -z "$msg" ] && continue
    # 趋势预警 6 小时去重
    if alert_dedup "trend:$comp" 21600; then
      push_notify "$level" "$comp" "$msg"
      log "📈 趋势预警[$comp]: $msg"
    fi
  done
}

# ══════════════════════════════════════════════════════
#  主循环
# ══════════════════════════════════════════════════════
main() {
  log "🛡️ 守护进程 v3.0 启动 (间隔=${INTERVAL}s, 降噪模式)"
  while true; do
    check_gateway
    check_mcp_servers
    check_visualizer
    check_collector
    check_disk
    check_network
    collect_metrics        # 采集时序指标
    run_trend_prediction   # 趋势预测预警
    update_awareness
    sleep "$INTERVAL"
  done
}

case "${1:-}" in
  check)
    check_gateway; check_mcp_servers; check_visualizer; check_collector; check_disk; check_network; update_awareness
    echo "✅ 单次巡检完成，日志: $LOG"
    ;;
  *) main ;;
esac
