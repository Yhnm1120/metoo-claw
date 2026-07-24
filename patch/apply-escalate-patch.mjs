#!/usr/bin/env node
/**
 * metoo-claw 梯度升级补丁（escalate）
 *
 * 作用：让 fallback 分类器识别 [ESCALATE] 标记。
 * 当 flash 模型回复以 [ESCALATE] 开头时，触发模型 fallback，
 * 自动用 fallback 模型（deepseek-v4-pro）重新回答。
 *
 * 实现：在 result-fallback-classifier 的 "finalAssistantVisibleText 非空则不 fallback"
 *       判断之前，插入 ESCALATE 检测分支。
 *
 * 特点：幂等 / 自动备份 / --uninstall 卸载 / 升级后可重打
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIST_FILE = path.join(
  os.homedir(),
  '.local/lib/node_modules/openclaw/dist/result-fallback-classifier-DNHhPT0Q.js'
);
const BACKUP_FILE = DIST_FILE + '.metoo-escalate-bak';
const MARKER = 'metoo-escalate-patch';

const ANCHOR = 'if (typeof params.result.meta.finalAssistantVisibleText === "string" && params.result.meta.finalAssistantVisibleText.trim().length > 0 && !isSilentReplyPayloadText(params.result.meta.finalAssistantVisibleText)) return null;';

// 在锚点之前插入 ESCALATE 检测：
// 若回复文本以 [ESCALATE] 开头，返回 fallback classification（reason: format）
const INJECT = `/* ${MARKER} */
	{
		const metooText = params.result.meta.finalAssistantVisibleText;
		if (typeof metooText === "string" && metooText.trim().startsWith("[ESCALATE]")) {
			return {
				message: "model requested escalation to a stronger model",
				reason: "format",
				code: "metoo_escalate",
				preserveResultOnExhaustion: false,
				preserveResultPriority: 0
			};
		}
	}
	${ANCHOR}`;

function main() {
  const uninstall = process.argv.includes('--uninstall');

  if (!fs.existsSync(DIST_FILE)) {
    console.error('❌ 找不到分类器 dist 文件:', DIST_FILE);
    process.exit(1);
  }
  const original = fs.readFileSync(DIST_FILE, 'utf-8');

  // ─── 卸载 ───
  if (uninstall) {
    if (!original.includes(MARKER)) { console.log('ℹ️ 未检测到补丁'); return; }
    if (fs.existsSync(BACKUP_FILE)) {
      fs.copyFileSync(BACKUP_FILE, DIST_FILE);
      console.log('✅ 已从备份恢复');
    } else {
      const restored = original.replace(INJECT, ANCHOR);
      if (restored === original) { console.error('❌ 无法还原'); process.exit(1); }
      fs.writeFileSync(DIST_FILE, restored, 'utf-8');
      console.log('✅ 已手动还原');
    }
    console.log('🔄 重启 Gateway: launchctl kickstart -k gui/501/ai.openclaw.gateway');
    return;
  }

  // ─── 打补丁 ───
  if (original.includes(MARKER)) { console.log('ℹ️ 补丁已存在（幂等）'); return; }
  if (!original.includes(ANCHOR)) {
    console.error('❌ 找不到锚点，分类器版本可能已变化');
    process.exit(1);
  }

  const patched = original.replace(ANCHOR, INJECT);
  if (patched === original) { console.error('❌ 替换失败'); process.exit(1); }

  fs.copyFileSync(DIST_FILE, BACKUP_FILE);
  fs.writeFileSync(DIST_FILE, patched, 'utf-8');

  console.log('✅ 梯度升级补丁已写入');
  console.log('📦 备份:', BACKUP_FILE);
  console.log('🔄 重启 Gateway: launchctl kickstart -k gui/501/ai.openclaw.gateway');
  console.log('🧪 验证: 问一个复杂问题，看是否触发 [ESCALATE] → pro 重答');
  console.log('↩️ 卸载: node apply-escalate-patch.mjs --uninstall');
}

main();
