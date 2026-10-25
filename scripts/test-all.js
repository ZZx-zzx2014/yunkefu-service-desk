/**
 * 统一测试入口：依次运行全部检查
 *   node scripts/test-all.js
 * 需要服务已在运行（npm start）。若服务未启动会给出提示。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

const suites = [
  ['前端 <-> 后端 一致性检查', 'check-consistency.js'],
  ['开源安全自检（后门/凭据/测试模式边界）', 'check-security.js'],
  ['布局滚动约束检查', 'check-layout.js'],
  ['接口返回结构契约测试', 'test-contract.js'],
  ['二维码生成与解码验证', 'test-qr.js'],
  ['双因素认证（TOTP）测试', 'test-2fa.js'],
  ['文件上传安全测试', 'test-upload-security.js'],
  ['接口功能端到端测试', 'test-api.js'],
  ['实时通信端到端测试', 'test-realtime.js'],
  ['消息通知场景测试（回归）', 'test-notify.js'],
  ['新增功能专项测试（常用话术 / 文件库）', 'test-features.js'],
  ['提权与免密码登录安全测试', 'test-privilege.js'],
  ['站点托管测试（静态 / PHP 沙箱 / 独立端口）', 'test-sites.js'],
  ['数据库自动迁移测试', 'test-migration.js'],
  ['看板指标合理性检查', 'check-metrics.js'],
  ['路径归一化单元测试', 'normalize-path.js'],
];

// 先探测服务是否可用
try {
  const res = await fetch(`${BASE}/api/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  console.log(`服务健康检查通过：${BASE}（uptime ${body.data.uptime}s）`);
} catch (err) {
  console.error(`\n无法连接服务 ${BASE}：${err.message}`);
  console.error('请先在另一个终端执行：npm run testmode   （测试需要演示账号与测试模式）\n');
  process.exitCode = 1;
  process.exit(1);
}

const results = [];
// 多个套件都会反复登录，会命中登录限流（15 次/分钟）。测试期间统一提高上限，
// 限流本身由 test-2fa.js 的最后一段专门验证。
// 同时强制测试模式：套件依赖演示账号与「一键体验」接口，且测试可能创建/修改数据，
// 不应对着正式库跑（测试自带 KEFU_DB_FILE 隔离时不受影响）。
const CHILD_ENV = { ...process.env, BASE, KEFU_LOGIN_RATE_LIMIT: '1000', KEFU_TEST_MODE: '1' };

for (const [title, file] of suites) {
  console.log(`\n${'█'.repeat(60)}`);
  console.log(`▶ ${title}  (scripts/${file})`);
  console.log('█'.repeat(60));
  const r = spawnSync(process.execPath, [path.join(DIR, file)], {
    stdio: 'inherit',
    env: CHILD_ENV,
  });
  results.push([title, r.status === 0]);
}

console.log(`\n${'═'.repeat(60)}`);
console.log('测试汇总');
console.log('═'.repeat(60));
for (const [title, ok] of results) {
  console.log(`${ok ? '\x1b[32m  通过\x1b[0m' : '\x1b[31m  失败\x1b[0m'}  ${title}`);
}
const failed = results.filter(([, ok]) => !ok).length;
console.log('═'.repeat(60));
console.log(failed === 0
  ? `\x1b[32m✓ 全部 ${results.length} 个测试套件通过\x1b[0m`
  : `\x1b[31m✗ ${failed}/${results.length} 个套件存在失败\x1b[0m`);
console.log('═'.repeat(60) + '\n');
process.exitCode = failed === 0 ? 0 : 1;
