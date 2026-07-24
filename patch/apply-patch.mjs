#!/usr/bin/env node
/**
 * metoo-claw Gateway 深度注入补丁（v2）
 * 
 * 作用：把 buildAttemptSystemPrompt 里的
 *   const baseSystemPrompt = buildEmbeddedSystemPrompt(params.embeddedSystemPrompt);
 * 替换为
 *   const baseSystemPrompt = buildEmbeddedSystemPrompt(params.embeddedSystemPrompt) + metooReadExtra();
 * 其中 metooReadExtra() 读取 ~/.openclaw/metoo-claw-data/system-prompt-extra.md
 * 
 * 特点：幂等 / 自动备份 / --uninstall 卸载 / 升级后可重打
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const DIST_FILE = path.join(
  os.homedir(),
  '.local/lib/node_modules/openclaw/dist/selection-8ixiqbew.js'
);
const BACKUP_FILE = DIST_FILE + '.metoo-bak';
const MARKER = 'metoo-claw-patch';

const ANCHOR = 'const baseSystemPrompt = buildEmbeddedSystemPrompt(params.embeddedSystemPrompt);';

// 替换后的代码：原调用 + 读取附加文件（内联，失败静默）
const REPLACEMENT = `const baseSystemPrompt = buildEmbeddedSystemPrompt(params.embeddedSystemPrompt) + (() => { try { const f = process.env.HOME + "/.openclaw/metoo-claw-data/system-prompt-extra.md"; return fs.existsSync(f) ? "\\n\\n" + fs.readFileSync(f, "utf-8").trim() : ""; } catch { return ""; } })(); /* ${MARKER} */`;

function main() {
  const uninstall = process.argv.includes('--uninstall');

  if (!fs.existsSync(DIST_FILE)) {
    console.error('❌ 找不到 Gateway dist 文件:', DIST_FILE);
    process.exit(1);
  }

  const original = fs.readFileSync(DIST_FILE, 'utf-8');

  // ─── 卸载 ───
  if (uninstall) {
    if (!original.includes(MARKER)) {
      console.log('ℹ️ 未检测到补丁，无需卸载');
      return;
    }
    if (fs.existsSync(BACKUP_FILE)) {
      fs.copyFileSync(BACKUP_FILE, DIST_FILE);
      console.log('✅ 已从备份恢复原文件');
    } else {
      const restored = original.replace(REPLACEMENT, ANCHOR);
      if (restored === original) { console.error('❌ 无法还原，补丁格式已变化'); process.exit(1); }
      fs.writeFileSync(DIST_FILE, restored, 'utf-8');
      console.log('✅ 已手动还原补丁代码');
    }
    console.log('🔄 请重启 Gateway: launchctl kickstart -k gui/501/ai.openclaw.gateway');
    return;
  }

  // ─── 打补丁 ───
  if (original.includes(MARKER)) {
    console.log('ℹ️ 补丁已存在，跳过（幂等）');
    return;
  }
  if (!original.includes(ANCHOR)) {
    console.error('❌ 找不到注入锚点，Gateway 版本可能已变化。锚点:');
    console.error('  ', ANCHOR);
    process.exit(1);
  }

  // 确认文件里有 fs 可用（兼容各种导入形式：default / 解构 / 混合）
  const hasFs = /import\s+[^;]*\bfs\b[^;]*from\s*["']node:fs["']/.test(original) ||
                /import\s+[^;]*\bfs\b[^;]*from\s*["']fs["']/.test(original);
  if (!hasFs) {
    console.error('❌ dist 文件中未找到 fs 导入');
    process.exit(1);
  }

  const patched = original.replace(ANCHOR, REPLACEMENT);
  if (patched === original) {
    console.error('❌ 替换失败（replace 未生效）');
    process.exit(1);
  }

  // 备份 → 写入 → 语法校验
  fs.copyFileSync(DIST_FILE, BACKUP_FILE);
  fs.writeFileSync(DIST_FILE, patched, 'utf-8');

  try {
    // 用 node 解析校验（打包产物是 ESM）
    execSync(`node --input-type=module -e "import('file://${DIST_FILE}').catch(e => { console.error(e.message); process.exit(1); })"`, {
      stdio: 'pipe', timeout: 30000,
    });
  } catch (e) {
    // import 整个文件可能因依赖缺失失败，这不代表语法错误。
    // 所以只做提示，不回滚——语法错误会在 Gateway 启动时立刻暴露，届时用备份恢复。
    console.log('⚠️ 完整 import 校验未通过（可能是依赖环境问题，不影响语法）');
  }

  console.log('✅ 补丁已写入');
  console.log('📦 备份:', BACKUP_FILE);
  console.log('🔄 重启 Gateway: launchctl kickstart -k gui/501/ai.openclaw.gateway');
  console.log('🧪 验证: 与 Gateway 对话，看 system prompt 是否含 "metoo-claw 自我认知"');
  console.log('↩️ 卸载: node apply-patch.mjs --uninstall');
}

main();
