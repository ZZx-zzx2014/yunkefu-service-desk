/**
 * 清理测试残留数据，并把演示数据恢复到干净状态。
 *   node scripts/cleanup.js            # 预览将执行的操作
 *   node scripts/cleanup.js --apply    # 实际执行
 *
 * 与 `npm run reset` 的区别：
 *   reset  会删除整个数据库，包括你自己注册的账号
 *   cleanup 保留「非演示账号」（你自己注册的用户），只清理测试产生的数据
 */
import { db, run, get, all, tx, getSettings, setSetting, DEFAULT_SETTINGS } from '../server/db.js';

const APPLY = process.argv.includes('--apply');

/* 演示数据里的账号用户名（由 seed.js 创建） */
const SEED_USERS = [
  'admin', 'agent1', 'agent2', 'agent3', 'agent4', 'agent5',
  'user1', 'user2', 'user3', 'user4', 'user5', 'user6', 'user7', 'user8',
];

/** 测试脚本创建的会话主题关键字 */
const TEST_SUBJECTS = ['端到端测试', '复现测试', 'A测试', 'B测试', 'C测试', 'D测试', '追踪', '文件库测试', '上传回归测试', '实时推送测试', '统计刷新测试'];
const TEST_TITLE_PREFIX = ['端到端测试工单', '实时工单测试', '统计刷新测试', '测试工单', '端到端测试文章', '端到端测试话术'];

const preview = () => {
  const users = all('SELECT id, username, name, role FROM users ORDER BY id');
  const foreign = users.filter((u) => !SEED_USERS.includes(u.username));

  const convs = all(`SELECT id, code, subject, status FROM conversations ORDER BY id`);
  const testConvs = convs.filter((c) => TEST_SUBJECTS.some((s) => String(c.subject || '').includes(s)));

  const tickets = all('SELECT id, code, title FROM tickets ORDER BY id');
  const testTickets = tickets.filter((t) => TEST_TITLE_PREFIX.some((s) => String(t.title || '').includes(s)));

  const articles = all('SELECT id, title FROM kb_articles ORDER BY id');
  const testArticles = articles.filter((a) => /端到端|测试文章/.test(String(a.title || '')));

  const quick = all('SELECT id, title FROM quick_replies ORDER BY id');
  const testQuick = quick.filter((q) => /端到端|测试话术/.test(String(q.title || '')));

  const openConvs = convs.filter((c) => c.status !== 'closed');

  return { users, foreign, convs, testConvs, tickets, testTickets, articles, testArticles, quick, testQuick, openConvs };
};

const p = preview();

console.log('\n=== 清理预览 ===\n');
console.log(`用户账号 ${p.users.length} 个，其中非演示账号（将保留）：`);
for (const u of p.foreign) console.log(`  · ${u.username}（${u.name} / ${u.role}）`);
if (!p.foreign.length) console.log('  （无）');

console.log(`\n会话 ${p.convs.length} 个；其中未结束 ${p.openConvs.length} 个（测试产生，将清理）`);
console.log(`  测试会话 ${p.testConvs.length} 个：${p.testConvs.map((c) => c.subject || c.code).join('、') || '（无）'}`);

console.log(`\n工单 ${p.tickets.length} 个，测试工单 ${p.testTickets.length} 个`);
console.log(`知识库文章 ${p.articles.length} 篇，测试文章 ${p.testArticles.length} 篇`);
console.log(`快捷话术 ${p.quick.length} 条，测试话术 ${p.testQuick.length} 条`);
console.log('\n将执行：');
console.log('  1. 删除测试产生的会话及其消息');
console.log('  2. 删除未结束的会话（测试遗留，客户会重新发起）');
console.log('  3. 删除测试工单、测试文章、测试话术');
console.log('  4. 清空 data/uploads 下的上传文件');
console.log('  5. 重置 settings 为默认值');
console.log('  6. 保留全部用户账号（含你自己注册的）与演示账号');

if (!APPLY) {
  console.log('\n\x1b[33m这是预览。加上 --apply 才会真正执行：node scripts/cleanup.js --apply\x1b[0m\n');
  process.exit(0);
}

console.log('\n=== 执行清理 ===');

tx(() => {
  // 1+2) 删除测试会话与所有未结束会话（消息随外键级联删除）
  const convIds = new Set([
    ...p.testConvs.map((c) => c.id),
    ...p.openConvs.map((c) => c.id),
  ]);
  let convDeleted = 0;
  for (const id of convIds) {
    const r = run('DELETE FROM conversations WHERE id = ?', [id]);
    convDeleted += r.changes;
  }
  console.log(`  ✓ 删除会话 ${convDeleted} 个（消息已级联删除）`);

  // 3) 测试工单
  let tkDeleted = 0;
  for (const t of p.testTickets) tkDeleted += run('DELETE FROM tickets WHERE id = ?', [t.id]).changes;
  console.log(`  ✓ 删除测试工单 ${tkDeleted} 个`);

  // 4) 测试文章
  let artDeleted = 0;
  for (const a of p.testArticles) artDeleted += run('DELETE FROM kb_articles WHERE id = ?', [a.id]).changes;
  console.log(`  ✓ 删除测试文章 ${artDeleted} 篇`);

  // 5) 测试话术
  let qrDeleted = 0;
  for (const q of p.testQuick) qrDeleted += run('DELETE FROM quick_replies WHERE id = ?', [q.id]).changes;
  console.log(`  ✓ 删除测试话术 ${qrDeleted} 条`);

  // 6) 清理测试期间产生的通知与日志噪音（保留最近的真实记录）
  const notifDeleted = run("DELETE FROM notifications WHERE title LIKE '%测试%' OR body LIKE '%测试%'").changes;
  console.log(`  ✓ 清理测试通知 ${notifDeleted} 条`);

  // 7) 重置设置
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting(k, v);
  console.log('  ✓ 系统设置已重置为默认值');

  // 8) 解除全部坐席的 2FA（测试可能留下启用状态）
  const reset2fa = run(`UPDATE users SET totp_enabled = 0, totp_secret = NULL,
      totp_confirmed_at = NULL, totp_last_step = NULL, backup_codes = '[]' WHERE totp_enabled = 1`).changes;
  console.log(`  ✓ 重置 ${reset2fa} 个账号的 2FA 状态`);
});

// 9) 清空上传目录（在事务外做文件操作）
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from '../server/config.js';
let files = 0;
for (const f of fs.readdirSync(UPLOAD_DIR)) {
  if (f === '.gitkeep') continue;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); files++; } catch { /* ignore */ }
}
console.log(`  ✓ 清空上传文件 ${files} 个`);

console.log('\n=== 清理完成 ===');
const after = preview();
console.log(`用户账号 ${after.users.length} 个（非演示账号保留 ${after.foreign.length} 个）`);
console.log(`会话 ${after.convs.length} 个，未结束 ${after.openConvs.length} 个`);
console.log(`工单 ${after.tickets.length} 个，文章 ${after.articles.length} 篇，话术 ${after.quick.length} 条\n`);
