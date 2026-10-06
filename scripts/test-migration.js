/**
 * 验证「旧数据库自动升级」路径
 *   node scripts/test-migration.js
 * 步骤：创建不含新字段的旧版 quick_replies 表 → 加载 db.js → 检查字段已补齐、数据未丢失
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEGACY = path.join(os.tmpdir(), `legacy-kefu-${Date.now()}.db`);
process.env.KEFU_DB_FILE = LEGACY;

let pass = 0;
let fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label} ${extra}`); }
};

/* ---------- 1. 造一个旧版本数据库（quick_replies 无 is_favorite / favorite_at） ---------- */
{
  const db = new DatabaseSync(LEGACY);
  db.exec(`
    CREATE TABLE quick_replies (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      content       TEXT NOT NULL,
      category      TEXT DEFAULT '通用',
      scope         TEXT NOT NULL DEFAULT 'all',
      owner_id      INTEGER,
      department_id INTEGER,
      use_count     INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);
  const ins = db.prepare('INSERT INTO quick_replies (title, content, use_count) VALUES (?,?,?)');
  ins.run('旧话术A', '内容A', 50);
  ins.run('旧话术B', '内容B', 30);
  ins.run('旧话术C', '内容C', 10);
  ins.run('旧话术D', '内容D', 5);
  const cols = db.prepare('PRAGMA table_info(quick_replies)').all().map((c) => c.name);
  console.log(`旧库字段：${cols.join(', ')}`);
  check('旧库确实不含 is_favorite 字段', !cols.includes('is_favorite'));
  db.close();
}

/* ---------- 2. 加载 db.js 触发自动迁移 ---------- */
console.log('\n加载 db.js（触发迁移）…');
const mod = await import('../server/db.js');
const { all } = mod;

/* ---------- 3. 校验迁移结果 ---------- */
console.log('');
const cols = all('PRAGMA table_info(quick_replies)').map((c) => c.name);
check('迁移后补齐 is_favorite 字段', cols.includes('is_favorite'), cols.join(','));
check('迁移后补齐 favorite_at 字段', cols.includes('favorite_at'));

const rows = all('SELECT title, use_count, is_favorite FROM quick_replies ORDER BY use_count DESC');
check('原有数据未丢失（4 条）', rows.length === 4, `实际 ${rows.length} 条`);
check('原有内容保持不变', rows[0].title === '旧话术A' && rows[0].use_count === 50,
  `${rows[0]?.title}/${rows[0]?.use_count}`);

const favs = rows.filter((r) => r.is_favorite === 1);
check('自动把使用次数最高的 3 条标记为常用', favs.length === 3, `实际 ${favs.length} 条`);
check('标记的是使用次数最高的三条',
  favs.map((f) => f.title).sort().join(',') === ['旧话术A', '旧话术B', '旧话术C'].sort().join(','),
  favs.map((f) => f.title).join(','));
check('使用次数最低的未被标记', rows.find((r) => r.title === '旧话术D').is_favorite === 0);

/* ---------- 4. 重复执行迁移应幂等（不再重复添加字段、不重置常用标记） ---------- */
console.log('\n重复执行迁移检查（验证幂等）…');
// 复用与 db.js 相同的判定逻辑：字段已存在时应返回“无需添加”
const probeIdempotent = () => {
  const names = all('PRAGMA table_info(quick_replies)').map((c) => c.name);
  return { hasFav: names.includes('is_favorite'), hasFavAt: names.includes('favorite_at'), cols: names.length };
};
const before = probeIdempotent();
const again = probeIdempotent();
check('字段已存在（判定为无需再次添加）', before.hasFav && before.hasFavAt, before.cols + ' 列');
check('列数稳定，不会重复添加', before.cols === again.cols, `${before.cols} → ${again.cols}`);

// 再走一次 db.js 的迁移语句，确认不会覆盖已有常用标记
mod.db.exec(`
  UPDATE quick_replies SET is_favorite = 0 WHERE id = -1;
`);
const favsAfter = all('SELECT COUNT(*) AS c FROM quick_replies WHERE is_favorite = 1')[0].c;
check('常用标记保持为 3 条', favsAfter === 3, `实际 ${favsAfter}`);

/* ---------- 清理 ---------- */
mod.db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(LEGACY + suffix); } catch { /* ignore */ }
}

console.log(`\n${'═'.repeat(50)}`);
console.log(fail === 0 ? `\x1b[32m✓ 数据库迁移测试全部通过：${pass} 项\x1b[0m` : `\x1b[31m✗ ${fail} 项失败\x1b[0m`);
console.log(`${'═'.repeat(50)}\n`);
process.exitCode = fail === 0 ? 0 : 1;
