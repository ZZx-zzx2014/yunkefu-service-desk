/**
 * 提权与免密码登录安全测试
 *   node scripts/test-privilege.js
 *
 * 本套件源于一次真实的安全报告：
 *   测试者用 Burp 把登录请求的请求体从 {username, password}
 *   改成 {role: 'admin'} 发给 /api/auth/demo，即可免密码拿到管理员令牌。
 *
 * 因此这里用「动态请求」逐项验证安全边界，而不是只做静态代码检查：
 *   A. 正常模式下 /api/auth/demo 必须彻底不可用（404，路由不存在）
 *   B. 测试模式签发的演示令牌（demo:1 标记）在正常模式下必须失效
 *   C. 客户/坐席账号不能改任何人的角色（PUT /api/admin/users/:id 必须 403）
 *   D. 两种模式下正常密码登录都不受影响（修复不能误伤合法功能）
 *   E. 单元级：demo 令牌的标记与校验逻辑
 *
 * 本套件完全自包含：自己启动「正常模式」与「测试模式」两个实例
 * （独立数据库、独立端口），不依赖外部已运行的服务，也不污染正式库。
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'server', 'index.js');
const PROD_PORT = 3988;
const TEST_PORT = 3989;
const PROD_BASE = `http://127.0.0.1:${PROD_PORT}`;
const TEST_BASE = `http://127.0.0.1:${TEST_PORT}`;

let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    fail++; failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  ${detail}` : ''}`);
  }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

async function req(base, method, url, body, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(base + url, { method, headers, body: payload, signal: AbortSignal.timeout(20_000) });
  let json = null;
  try { json = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json };
}

/** 启动一个服务实例（独立临时库），返回 { child, base, cleanup } */
async function startInstance({ port, testMode, secret }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kefu-priv-${testMode ? 'test' : 'prod'}-`));
  const dbFile = path.join(dir, 'test.db');
  const env = {
    ...process.env,
    PORT: String(port),
    KEFU_DB_FILE: dbFile,
    KEFU_LOGIN_RATE_LIMIT: '1000',
    KEFU_TEST_MODE: testMode ? '1' : '0',
    KEFU_SECRET: secret,
    HOST: '127.0.0.1',
  };
  const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let booted = false;
  const logs = [];
  child.stdout.on('data', (d) => {
    const s = d.toString();
    logs.push(s);
    if (s.includes('服务已启动')) booted = true;
  });
  child.stderr.on('data', (d) => logs.push(d.toString()));

  const startAt = Date.now();
  while (!booted && Date.now() - startAt < 30_000) {
    await new Promise((s) => setTimeout(s, 250));
  }
  if (!booted) {
    console.error(`  实例启动失败（port=${port}）：\n${logs.slice(-20).join('')}`);
    process.exit(1);
  }

  // 写入演示数据（独立库）
  const seed = spawnSync(process.execPath, [path.join(ROOT, 'server', 'seed.js')], {
    env: { ...process.env, KEFU_DB_FILE: dbFile },
    encoding: 'utf8',
  });
  if (seed.status !== 0) {
    console.error(`  seed 失败：${(seed.stderr || '').split('\n').slice(0, 3).join('\n')}`);
    process.exit(1);
  }

  const cleanup = () => {
    try { child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { child, base: `http://127.0.0.1:${port}`, cleanup };
}

console.log('\n=== 提权与免密码登录安全测试 ===');
console.log('（自包含双实例：正常模式 3988 / 测试模式 3989，独立临时数据库）\n');

// 两个实例共用同一个 SECRET —— 这样测试模式签发的令牌能通过正常模式的验签，
// 从而真正验证「demo 标记在正常模式被拒绝」这一逻辑（而不是被签名不同拒掉）。
const SHARED_SECRET = crypto.randomBytes(32).toString('hex');

const prod = await startInstance({ port: PROD_PORT, testMode: false, secret: SHARED_SECRET });
const test = await startInstance({ port: TEST_PORT, testMode: true, secret: SHARED_SECRET });

try {
  /* ================================================================ *
   * A. 正常模式下 /api/auth/demo 必须彻底不存在
   * ================================================================ */
  section('A. 正常模式下，一键体验接口必须不可用');

  {
    const r = await req(prod.base, 'POST', '/api/auth/demo', { role: 'admin' });
    check('POST /api/auth/demo 不签发令牌',
      [404, 403].includes(r.status) && !(r.json?.data?.token),
      `实际 status=${r.status}${r.json?.data?.token ? '（⚠️ 签发了令牌！）' : ''}`);

    check('（关键）伪造 {role:"admin"} 无法获得管理员令牌',
      !r.json?.data?.token, r.json?.data?.token ? '泄露了令牌' : `status=${r.status}`);

    const r2 = await req(prod.base, 'POST', '/api/auth/demo', {});
    check('空请求体同样被拒绝', [404, 403].includes(r2.status) && !r2.json?.data?.token, `status=${r2.status}`);

    const r3 = await req(prod.base, 'POST', '/api/auth/demo', { role: 'customer' });
    check('customer 角色映射同样不可用', [404, 403].includes(r3.status) && !r3.json?.data?.token, `status=${r3.status}`);
  }

  /* ================================================================ *
   * B. 演示令牌跨模式失效（关键回归：防止令牌携带到正常模式复用）
   * ================================================================ */
  section('B. 演示令牌（demo:1 标记）在正常模式下必须失效');

  {
    const demoLogin = await req(test.base, 'POST', '/api/auth/demo', { role: 'admin' });
    const demoToken = demoLogin.json?.data?.token;
    check('测试模式下 demo 接口可用（设计功能）', !!demoToken, `status=${demoLogin.status}`);

    if (demoToken) {
      const me1 = await req(test.base, 'GET', '/api/auth/me', undefined, demoToken);
      check('演示令牌在测试模式实例上有效', me1.status === 200, `status=${me1.status}`);

      // 关键：同一令牌（同 SECRET、同签名）拿到正常模式实例上必须被拒
      const me2 = await req(prod.base, 'GET', '/api/auth/me', undefined, demoToken);
      check('（关键）演示令牌在正常模式实例上被拒绝（401）',
        me2.status === 401, `status=${me2.status}${me2.status === 200 ? '（⚠️ 演示令牌在正常模式存活！）' : ''}`);
    }
  }

  /* ================================================================ *
   * C. 角色变更越权测试（正常模式实例）
   * ================================================================ */
  section('C. 角色变更越权测试');

  {
    const custLogin = await req(prod.base, 'POST', '/api/auth/login', { username: 'user1', password: 'user123' });
    const custToken = custLogin.json?.data?.token;
    check('客户账号可正常登录', !!custToken);
    if (custToken) {
      const adminLogin = await req(prod.base, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
      const adminToken = adminLogin.json?.data?.token;
      const users = await req(prod.base, 'GET', '/api/admin/users?pageSize=100', undefined, adminToken);
      const adminUser = (users.json?.data?.list || []).find((u) => u.username === 'admin');
      const me = await req(prod.base, 'GET', '/api/auth/me', undefined, custToken);
      const myId = me.json?.data?.id;

      const selfEsc = await req(prod.base, 'PUT', `/api/admin/users/${myId}`, { role: 'admin' }, custToken);
      check('客户无法修改自己的角色（403）', selfEsc.status === 403, `status=${selfEsc.status}`);

      const otherEsc = await req(prod.base, 'PUT', `/api/admin/users/${adminUser?.id ?? 1}`, { role: 'customer' }, custToken);
      check('客户无法修改他人角色（403）', otherEsc.status === 403, `status=${otherEsc.status}`);

      const anonEsc = await req(prod.base, 'PUT', `/api/admin/users/${myId}`, { role: 'admin' });
      check('未登录无法调用用户更新接口（401）', anonEsc.status === 401, `status=${anonEsc.status}`);

      const agentLogin = await req(prod.base, 'POST', '/api/auth/login', { username: 'agent1', password: 'agent123' });
      const agentToken = agentLogin.json?.data?.token;
      const agentEsc = await req(prod.base, 'PUT', `/api/admin/users/${myId}`, { role: 'agent' }, agentToken);
      check('坐席无法修改用户角色（403）', agentEsc.status === 403, `status=${agentEsc.status}`);
    }
  }

  /* ================================================================ *
   * D. 正常登录不受影响
   * ================================================================ */
  section('D. 合法功能不受影响');

  {
    const l1 = await req(prod.base, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    check('正常模式：密码登录可用', l1.status === 200 && !!l1.json?.data?.token, `status=${l1.status}`);

    const l2 = await req(test.base, 'POST', '/api/auth/login', { username: 'user1', password: 'user123' });
    check('测试模式：密码登录同样可用', l2.status === 200 && !!l2.json?.data?.token, `status=${l2.status}`);

    // 密码错误必须失败（demo 不能掩盖正常登录的口令校验）
    const l3 = await req(prod.base, 'POST', '/api/auth/login', { username: 'admin', password: 'wrong-password' });
    check('密码错误仍然被拒绝（401）', l3.status === 401, `status=${l3.status}`);
  }

  /* ================================================================ *
   * E. 单元级：demo 令牌标记与校验逻辑
   * ================================================================ */
  section('E. 单元级验证');

  {
    const { signAccessToken, verifyToken, verifyAccessToken } = await import('../server/auth.js');
    const { TOKEN_TTL_MS, TEST_MODE } = await import('../server/config.js');

    const fakeUser = { id: 1, role: 'admin' };
    const normalToken = signAccessToken(fakeUser);
    const demoToken = signAccessToken(fakeUser, TOKEN_TTL_MS, { demo: true });

    check('普通令牌可正常校验', verifyAccessToken(normalToken)?.purpose === 'access');

    // verifyToken 是不带模式门控的底层校验：只验签名/有效期，用它确认标记写进去了
    const rawDemo = verifyToken(demoToken);
    check('demo 令牌带 demo:1 标记（写入层）', rawDemo?.demo === 1, JSON.stringify(rawDemo));

    // verifyAccessToken 是带模式门控的业务层：
    //   非测试模式 → demo 令牌必须被拒（这正是修复的核心）
    //   测试模式   → demo 令牌可用（设计功能）
    const gated = verifyAccessToken(demoToken);
    if (TEST_MODE) {
      check('测试模式下 demo 令牌可正常校验（设计功能）', gated?.demo === 1, JSON.stringify(gated));
    } else {
      check('（关键）正式模式下 demo 令牌被 verifyAccessToken 拒绝', gated === null,
        JSON.stringify(gated));
    }

    const src = fs.readFileSync(path.join(ROOT, 'server', 'auth.js'), 'utf8');
    check('verifyAccessToken 含 demo 标记 + TEST_MODE 检查',
      /body\.demo === 1 && !TEST_MODE/.test(src));

    const authSrc = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'auth.js'), 'utf8');
    check('demo 路由仅在测试模式注册（编译期守卫）',
      /if\s*\(TEST_MODE\)\s*\{[\s\S]{0,500}?router\.post\('\/demo'/.test(authSrc));
  }
} finally {
  prod.cleanup();
  test.cleanup();
}

/* ================================================================ *
 * 汇总
 * ================================================================ */
console.log(`\n${'═'.repeat(56)}`);
if (fail === 0) console.log(`\x1b[32m✓ 提权安全测试全部通过：${pass} 项\x1b[0m`);
else {
  console.log(`\x1b[32m通过 ${pass} 项\x1b[0m，\x1b[31m失败 ${fail} 项\x1b[0m`);
  console.log('失败项：\n  - ' + failures.join('\n  - '));
}
console.log(`${'═'.repeat(56)}\n`);
process.exitCode = fail === 0 ? 0 : 1;
