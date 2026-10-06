/**
 * 双因素认证（TOTP）测试
 *   node scripts/test-2fa.js
 *
 * 覆盖：
 *  A. TOTP 算法正确性（与 RFC 6238 测试向量比对）
 *  B. 启用流程（密钥生成、错误验证码拒绝、正确验证码启用、备份码下发）
 *  C. 登录两步流程（口令 → 待验证令牌 → 动态验证码 → 访问令牌）
 *  D. 关键安全属性（待验证令牌不能访问业务接口、验证码防重放、备份码一次性）
 *  E. 关闭流程与异常路径
 *  F. 恢复（关闭后回到普通登录）
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

// 复用服务端实现计算验证码与时间步，保证测试与实现同源
const { currentStep, base32Decode } = await import('../server/totp.js');
const crypto = await import('node:crypto');

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label} ${extra}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

/** 独立实现 HOTP/TOTP（不复用服务端 verify，避免同源掩盖错误） */
function totpAt(secret, step) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  buf.writeUInt32BE(step % 0x100000000, 4);
  const digest = crypto.createHmac('sha1', key).update(buf).digest();
  const off = digest[digest.length - 1] & 0x0f;
  const bin = ((digest[off] & 0x7f) << 24) | ((digest[off + 1] & 0xff) << 16)
    | ((digest[off + 2] & 0xff) << 8) | (digest[off + 3] & 0xff);
  return String(bin % 1e6).padStart(6, '0');
}
const codeNow = (secret) => totpAt(secret, currentStep());

/**
 * 发起登录并取回「待验证令牌」。
 * 登录接口有速率限制（默认 15 次/分钟/IP+账号），而本测试会多次登录，
 * 因此对 429 等待满一个限流窗口后重试，并对异常返回给出清晰报错，
 * 而不是抛出一个与真实原因无关的 TypeError。
 */
async function freshTwoFactorToken(username = TEST_USER, password = TEST_PASS, attempt = 0) {
  const r = await req('POST', '/api/auth/login', { username, password });
  if (r.payload?.twoFactorToken) return r.payload.twoFactorToken;
  if (r.status === 429 && attempt < 3) {
    console.log(`  \x1b[33m·\x1b[0m 触发登录限流，等待 61 秒后重试（第 ${attempt + 1} 次）…`);
    await new Promise((s) => setTimeout(s, 61_000));
    return freshTwoFactorToken(username, password, attempt + 1);
  }
  throw new Error(`获取待验证令牌失败：status=${r.status} message=${r.message}`);
}

/**
 * 提交 2FA 验证码。
 * 该接口有独立的速率限制（默认 10 次/分钟，防暴力猜测验证码），
 * 本测试的用例密度会超过它，因此遇到 429 时等待一个窗口后重试。
 *
 * 重要：code 可以是字符串或「返回验证码的函数」。
 * 限流退避要等 61 秒，而 TOTP 验证码 30 秒就换一次，
 * 若传入固定字符串，重试时它已过期 —— 传函数才能拿到当前有效验证码。
 */
async function verify2fa(twoFactorToken, code, attempt = 0) {
  const value = typeof code === 'function' ? code() : code;
  const r = await req('POST', '/api/auth/2fa/verify', { twoFactorToken, code: value });
  if (r.status === 429 && attempt < 4) {
    console.log(`  \x1b[33m·\x1b[0m 触发 2FA 验证限流，等待 61 秒后重试（第 ${attempt + 1} 次）…`);
    await new Promise((s) => setTimeout(s, 61_000));
    return verify2fa(twoFactorToken, code, attempt + 1);
  }
  return r;
}

async function req(method, path, body, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, ok: res.ok, payload: json?.data, message: json?.message, json };
}

console.log(`\n=== 双因素认证测试 ===\n目标：${BASE}`);

/* ================= A. 算法正确性 ================= */
section('A. TOTP 算法正确性（RFC 6238 测试向量）');
{
  // RFC 6238 附录 B 的种子（ASCII "12345678901234567890" 的 Base32）
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  let allOk = true;
  for (const [unixTime, expected] of vectors) {
    const step = Math.floor(unixTime / 30);
    const got = totpAt(RFC_SECRET, step);
    if (got !== expected) { allOk = false; console.log(`      t=${unixTime} 期望 ${expected} 实际 ${got}`); }
  }
  check('生成的验证码与 RFC 6238 测试向量一致', allOk, allOk ? '' : '存在不匹配向量');
}

/* ================= 准备 ================= */
// 使用 agent2 作为 2FA 测试账号，测试结束会关闭 2FA 恢复原状
const TEST_USER = 'agent2';
const TEST_PASS = 'agent123';

// 幂等准备：若上一次运行残留了启用状态，先用管理员接口重置，保证可重复执行
{
  const adminLogin = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const adminToken = adminLogin.payload?.token;
  if (!adminToken) {
    console.error('\n无法以管理员身份登录，测试中止：', adminLogin.message);
    process.exitCode = 1;
    process.exit(1);
  }
  const users = await req('GET', '/api/admin/users?keyword=' + TEST_USER, undefined, adminToken);
  const target = (users.payload?.list || []).find((u) => u.username === TEST_USER);
  if (!target) {
    console.error(`\n未找到测试账号 ${TEST_USER}，测试中止`);
    process.exitCode = 1;
    process.exit(1);
  }
  if (target.role === 'admin' || target.id === 1) {
    console.error('\n拒绝在管理员账号上运行 2FA 测试');
    process.exitCode = 1;
    process.exit(1);
  }
  await req('POST', `/api/admin/users/${target.id}/2fa/reset`, {}, adminToken);
  console.log(`  \x1b[33m·\x1b[0m 已重置 ${TEST_USER} 的 2FA 状态（保证测试幂等）`);
}

const pre = await req('POST', '/api/auth/login', { username: TEST_USER, password: TEST_PASS });
const preToken = pre.payload?.token;
check('测试账号初始可普通登录（未启用 2FA）', Boolean(preToken), pre.message);

// 确保初始为未启用状态
{
  const st = await req('GET', '/api/auth/2fa/status', undefined, preToken);
  check('初始状态为未启用 2FA', st.payload?.enabled === false, `enabled=${st.payload?.enabled}`);
}

/* ================= B. 启用流程 ================= */
section('B. 启用流程');
let secret = '';
{
  const setup = await req('POST', '/api/auth/2fa/setup', {}, preToken);
  secret = setup.payload?.secret || '';
  check('可生成 TOTP 密钥', /^[A-Z2-7]{16,}$/.test(secret), `secret=${secret?.slice(0, 8)}...`);
  check('返回 otpauth 配置链接', String(setup.payload?.otpauthUrl || '').startsWith('otpauth://totp/'));
  check('配置链接包含发行方与算法参数',
    /issuer=/.test(setup.payload?.otpauthUrl || '') && /algorithm=SHA1/.test(setup.payload?.otpauthUrl || '')
    && /digits=6/.test(setup.payload?.otpauthUrl || ''));

  // 未启用时，登录仍应是普通流程（密钥已暂存但未生效）
  const stillPlain = await req('POST', '/api/auth/login', { username: TEST_USER, password: TEST_PASS });
  check('仅生成密钥（未启用）时登录不需要二次验证', Boolean(stillPlain.payload?.token));

  const wrong = await req('POST', '/api/auth/2fa/enable', { code: '000000' }, preToken);
  check('错误的验证码无法启用 2FA', wrong.status >= 400, `status=${wrong.status}`);

  const short = await req('POST', '/api/auth/2fa/enable', { code: '123' }, preToken);
  check('位数不足的验证码被拒绝', short.status >= 400);

  const enable = await req('POST', '/api/auth/2fa/enable', { code: codeNow(secret) }, preToken);
  check('正确的验证码可启用 2FA', enable.payload?.backupCodes?.length === 8,
    `backupCodes=${enable.payload?.backupCodes?.length}`);
  check('启用时下发 8 个备份码',
    Array.isArray(enable.payload?.backupCodes) && enable.payload.backupCodes.every((c) => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)),
    JSON.stringify(enable.payload?.backupCodes?.slice(0, 2)));

  const status = await req('GET', '/api/auth/2fa/status', undefined, preToken);
  check('状态变为已启用', status.payload?.enabled === true);
  check('备份码数量为 8', status.payload?.backupCodesLeft === 8, `left=${status.payload?.backupCodesLeft}`);

  const me = await req('GET', '/api/auth/me', undefined, preToken);
  check('/api/auth/me 暴露 twoFactorEnabled', me.payload?.twoFactorEnabled === true);

  const again = await req('POST', '/api/auth/2fa/setup', {}, preToken);
  check('已启用时不允许重复 setup', again.status >= 400, `status=${again.status}`);
}

/* ================= C. 登录两步流程 ================= */
section('C. 登录两步流程');
let twoFactorToken = '';
let backupCodes = [];
{
  const step1 = await req('POST', '/api/auth/login', { username: TEST_USER, password: TEST_PASS });
  check('第一步返回 twoFactorRequired', step1.payload?.twoFactorRequired === true);
  check('第一步不返回访问令牌', !step1.payload?.token, `token=${step1.payload?.token ? '存在（严重问题）' : '无'}`);
  twoFactorToken = step1.payload?.twoFactorToken || '';
  check('返回待验证令牌', Boolean(twoFactorToken));

  // 取得备份码用于后续测试（重新生成一次以拿到明文）
  const regen = await req('POST', '/api/auth/2fa/backup-codes/regenerate', { code: codeNow(secret) }, preToken);
  backupCodes = regen.payload?.backupCodes || [];
  check('可重新生成备份码', backupCodes.length === 8);

  const badCode = await verify2fa(twoFactorToken, '000000');
  check('错误验证码被拒绝', badCode.status === 401, `status=${badCode.status}`);

  const noToken = await req('POST', '/api/auth/2fa/verify', { code: codeNow(secret) });
  check('缺少待验证令牌被拒绝', noToken.status === 401);

  const good = await verify2fa(twoFactorToken, () => codeNow(secret));
  check('正确验证码换发访问令牌', Boolean(good.payload?.token), good.message);
  check('换发的令牌可访问业务接口',
    (await req('GET', '/api/auth/me', undefined, good.payload?.token)).status === 200);

  // 同一时间步内允许重复提交（用户打错字重输的正常场景）
  const retrySameStep = await verify2fa(twoFactorToken, () => codeNow(secret));
  check('同一时间步内可重复提交（符合真实验证器体验）', Boolean(retrySameStep.payload?.token),
    retrySameStep.message);

  // 防重放：更早时间步的验证码必须被拒绝
  const olderStep = await verify2fa(twoFactorToken, () => totpAt(secret, currentStep() - 2));
  check('更早时间步的验证码被拒绝（防重放）', olderStep.status === 401,
    `status=${olderStep.status} ${olderStep.message}`);

  // 超出允许窗口的验证码同样被拒绝
  const farFuture = await verify2fa(twoFactorToken, () => totpAt(secret, currentStep() + 5));
  check('超出时间窗口的验证码被拒绝', farFuture.status === 401, `status=${farFuture.status}`);
}

/* ================= D. 关键安全属性 ================= */
section('D. 关键安全属性');
{
  // 待验证令牌绝不能访问业务接口
  const probe = await req('GET', '/api/auth/me', undefined, twoFactorToken);
  check('待验证令牌不能访问 /api/auth/me', probe.status === 401, `status=${probe.status}`);

  const probeConv = await req('GET', '/api/conversations', undefined, twoFactorToken);
  check('待验证令牌不能访问 /api/conversations', probeConv.status === 401, `status=${probeConv.status}`);

  const probeAdmin = await req('GET', '/api/admin/users', undefined, twoFactorToken);
  check('待验证令牌不能访问管理接口', probeAdmin.status === 401, `status=${probeAdmin.status}`);

  const probeKb = await req('POST', '/api/kb/articles', { title: 'x', content: 'y' }, twoFactorToken);
  check('待验证令牌不能执行写操作', probeKb.status === 401, `status=${probeKb.status}`);

  // WebSocket 也不接受待验证令牌
  const { WebSocket } = await import('ws');
  const wsRejected = await new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:3000/ws');
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolve(false); }, 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: twoFactorToken })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'auth:fail') { clearTimeout(timer); ws.close(); resolve(true); }
      if (m.type === 'auth:ok') { clearTimeout(timer); ws.close(); resolve(false); }
    });
    ws.on('error', () => { clearTimeout(timer); resolve(true); });
  });
  check('WebSocket 拒绝待验证令牌', wsRejected);

  // 伪造的待验证令牌
  const forged = await verify2fa('aaa.bbb', '123456');
  check('伪造的待验证令牌被拒绝', forged.status === 401);

  // 备份码：一次性
  section('D2. 备份码一次性');
  const first = await verify2fa(await freshTwoFactorToken(), backupCodes[0]);
  check('可用备份码登录', Boolean(first.payload?.token) && first.payload?.usedBackupCode === true, first.message);
  check('备份码登录后剩余数量减少', first.payload?.backupCodesLeft === 7, `left=${first.payload?.backupCodesLeft}`);

  const second = await verify2fa(await freshTwoFactorToken(), backupCodes[0]);
  check('同一个备份码不能再次使用', second.status === 401, `status=${second.status}`);

  const wrongBackup = await verify2fa(await freshTwoFactorToken(), 'ZZZZ-ZZZZ');
  check('无效备份码被拒绝', wrongBackup.status === 401);
}

/* ================= E. 关闭流程 ================= */
section('E. 关闭流程与异常路径');
{
  const post = await freshTwoFactorToken();
  const good = await verify2fa(post, () => codeNow(secret));
  const accessToken = good.payload?.token;
  check('重新取得访问令牌用于关闭测试', Boolean(accessToken), good.message);

  const noPass = await req('POST', '/api/auth/2fa/disable', { code: codeNow(secret) }, accessToken);
  check('关闭 2FA 必须提供密码', noPass.status === 400, `status=${noPass.status}`);

  const wrongPass = await req('POST', '/api/auth/2fa/disable', { password: 'wrong-password', code: codeNow(secret) }, accessToken);
  check('密码错误无法关闭 2FA', wrongPass.status === 401, `status=${wrongPass.status}`);

  const wrongCode = await req('POST', '/api/auth/2fa/disable', { password: TEST_PASS, code: '000000' }, accessToken);
  check('验证码错误无法关闭 2FA', wrongCode.status === 400, `status=${wrongCode.status}`);

  const disabled = await req('POST', '/api/auth/2fa/disable', { password: TEST_PASS, code: codeNow(secret) }, accessToken);
  check('密码 + 验证码正确可关闭 2FA', disabled.payload?.enabled === false, disabled.message);

  const status = await req('GET', '/api/auth/2fa/status', undefined, accessToken);
  check('关闭后状态为未启用', status.payload?.enabled === false);
  check('关闭后备份码已清空', status.payload?.backupCodesLeft === 0, `left=${status.payload?.backupCodesLeft}`);

  const leftover = await req('GET', '/api/auth/me', undefined, accessToken);
  check('关闭后 /api/auth/me 显示未启用', leftover.payload?.twoFactorEnabled === false);
}

/* ================= F. 恢复普通登录 ================= */
section('F. 关闭后恢复普通登录');
{
  const plain = await req('POST', '/api/auth/login', { username: TEST_USER, password: TEST_PASS });
  check('关闭 2FA 后登录不再需要二次验证', Boolean(plain.payload?.token) && !plain.payload?.twoFactorRequired);
  check('普通登录令牌可用', (await req('GET', '/api/auth/me', undefined, plain.payload?.token)).status === 200);

  // 其它演示账号不受影响（登录接口有 15 次/分钟限流，此处只抽检两个）
  for (const [u, p] of [['admin', 'admin123'], ['user1', 'user123']]) {
    const r = await req('POST', '/api/auth/login', { username: u, password: p });
    check(`演示账号 ${u} 仍可普通登录`, Boolean(r.payload?.token) && !r.payload?.twoFactorRequired);
  }
}

/* ================= G. 登录限流 ================= */
section('G. 登录限流（暴力破解防护）');
{
  // 限流阈值可通过环境变量调高（默认 15 次/分钟）。
  // 若被调高，则本次不断言触发，避免测试自身把配额耗尽。
  const limit = Number(process.env.KEFU_LOGIN_RATE_LIMIT || 15);
  if (limit > 50) {
    console.log(`  \x1b[33m·\x1b[0m 登录限流阈值已调高至 ${limit}，跳过触发断言（生产默认为 15）`);
  } else {
    // 限流按「IP + 账号」计数，用与测试账号不同的用户名探测，
    // 否则会耗尽被测账号的配额，导致下次运行本测试时第一步就失败。
    const PROBE_USER = 'ratelimit-probe-nonexistent';
    let limited = false;
    let limitedAt = 0;
    for (let i = 0; i < limit + 5; i++) {
      const r = await req('POST', '/api/auth/login', { username: PROBE_USER, password: 'wrong-password' });
      if (r.status === 429) { limited = true; limitedAt = i + 1; break; }
    }
    check('连续错误登录会触发限流（429）', limited, limited ? `第 ${limitedAt} 次被限制` : '未触发限流');
  }
}

/* ================= H. 2FA 验证限流 =================
 * 必须放在最后，且使用独立账号：
 * 这段测试会耗尽该账号的「2FA 验证」配额（默认 10 次/分钟），
 * 若放在主流程中或复用 agent2，会导致随后的「关闭 2FA」拿不到访问令牌。
 */
section('H. 2FA 验证限流（防止暴力猜测验证码）');
{
  const limit = Number(process.env.KEFU_2FA_RATE_LIMIT || 10);
  if (limit > 50) {
    console.log(`  \x1b[33m·\x1b[0m 2FA 限流阈值已调高至 ${limit}，跳过触发断言（生产默认为 10）`);
  } else {
    const LIMIT_USER = 'agent3';
    const LIMIT_PASS = 'agent123';
    const adminLogin = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    const adminToken = adminLogin.payload?.token;
    const users = await req('GET', '/api/admin/users?keyword=' + LIMIT_USER, undefined, adminToken);
    const target = (users.payload?.list || []).find((u) => u.username === LIMIT_USER);

    if (!target) {
      console.log(`  \x1b[33m·\x1b[0m 未找到 ${LIMIT_USER}，跳过 2FA 限流断言`);
    } else {
      // 重置后用独立账号重新启用 2FA，避免影响 agent2 的主流程状态
      await req('POST', `/api/admin/users/${target.id}/2fa/reset`, {}, adminToken);
      const limitLogin = await req('POST', '/api/auth/login', { username: LIMIT_USER, password: LIMIT_PASS });
      const limitToken = limitLogin.payload?.token;
      const setup = await req('POST', '/api/auth/2fa/setup', {}, limitToken);
      const limitSecret = setup.payload?.secret;
      await req('POST', '/api/auth/2fa/enable', { code: codeNow(limitSecret) }, limitToken);

      const challenge = await freshTwoFactorToken(LIMIT_USER, LIMIT_PASS);
      let limited = false;
      let attempts = 0;
      for (let i = 0; i < limit + 5; i++) {
        // 这一段就是要触发限流，因此不能使用带退避的 verify2fa
        const r = await req('POST', '/api/auth/2fa/verify', { twoFactorToken: challenge, code: '000000' });
        attempts++;
        if (r.status === 429) { limited = true; break; }
      }
      check('连续错误验证码会触发限流（429）', limited,
        limited ? `第 ${attempts} 次被限制` : `尝试 ${attempts} 次仍未限流`);

      // 复位该账号，保持环境干净
      await req('POST', `/api/admin/users/${target.id}/2fa/reset`, {}, adminToken);
      const after = await req('GET', '/api/auth/2fa/status', undefined,
        (await req('POST', '/api/auth/login', { username: LIMIT_USER, password: LIMIT_PASS })).payload?.token);
      check(`${LIMIT_USER} 的 2FA 状态已复位`, after.payload?.enabled === false);
    }
  }
}

console.log(`\n${'═'.repeat(56)}`);
if (fail === 0) console.log(`\x1b[32m✓ 双因素认证测试全部通过：${pass} 项检查\x1b[0m`);
else {
  console.log(`\x1b[32m通过 ${pass} 项\x1b[0m，\x1b[31m失败 ${fail} 项\x1b[0m`);
  console.log('失败项：\n  - ' + failures.join('\n  - '));
}
console.log(`${'═'.repeat(56)}\n`);
process.exitCode = fail === 0 ? 0 : 1;
