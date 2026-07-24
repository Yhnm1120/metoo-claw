/**
 * Hook handler 独立测试
 */

import handler, { getMetooStatus } from './handler.mjs';

const TEST_STORAGE = '/tmp/metoo-claw-hook-test';
const config = { storageDir: TEST_STORAGE };

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

// 模拟 OpenClaw hook event
function makeEvent(type, action, context = {}) {
  return {
    type, action,
    sessionKey: 'sess_hook_test',
    context,
    timestamp: new Date(),
    messages: [],
  };
}

console.log('=== Hook: agent:bootstrap ===');
const bootEvent = makeEvent('agent', 'bootstrap', { agentId: 'xiaoyi' });
await handler(bootEvent, config);
check('bootstrap 无报错', true);

console.log('=== Hook: message:received (正常) ===');
const msgEvent = makeEvent('message', 'received', { text: '帮我查一下天气' });
await handler(msgEvent, config);
check('正常消息不拦截', !msgEvent.context.boundaryBlocked);

console.log('=== Hook: message:received (先注册禁止规则再测) ===');
// 需要先注册规则——通过 bootstrap 时的 registry
// 这里直接再发一次，验证 declare 对未注册规则返回 null（不拦截）
const msgEvent2 = makeEvent('message', 'received', { text: '帮我删除邮件' });
await handler(msgEvent2, config);
// 现在实例创建即自动注册安全边界（含 delete_email），所以删除邮件会被拦截
check('删除邮件触碰安全边界被拦截', msgEvent2.context.boundaryBlocked === true);

console.log('=== Hook: message:sent (带工具调用) ===');
const sentEvent = makeEvent('message', 'sent', {
  userText: '查天气',
  toolCalls: [
    { name: 'web_fetch', success: true, latencyMs: 1500, context: 'weather' },
    { name: 'exec', success: false, error: 'permission denied', code: 403 },
  ],
});
await handler(sentEvent, config);
check('工具调用记录无报错', true);

console.log('=== Hook: gateway:startup (崩溃恢复) ===');
const startEvent = makeEvent('gateway', 'startup', {});
await handler(startEvent, config);
check('启动恢复流程执行', true);

console.log('=== Hook: command:new ===');
const newEvent = makeEvent('command', 'new', {});
await handler(newEvent, config);
check('会话重置保存提示', newEvent.messages.some(m => m.includes('已保存')));

console.log('=== Hook: session:compact:before ===');
const compactEvent = makeEvent('session', 'compact:before', {});
await handler(compactEvent, config);
check('增量压缩标记', compactEvent.context.metooIncrementalCompaction === true);

console.log('=== Status 查询 ===');
const status = getMetooStatus('xiaoyi', 'sess_hook_test', config.storageDir);
check('状态报告生成', status.includes('系统状态报告'));

console.log('\n' + '='.repeat(40));
console.log(`✅ 通过: ${passed}  ❌ 失败: ${failed}`);
console.log(failed === 0 ? '🎉 Hook 测试全部通过！' : '⚠️ 有失败');
process.exit(failed === 0 ? 0 : 1);
