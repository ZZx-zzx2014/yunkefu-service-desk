/**
 * 认证接口：注册、登录、当前用户、修改密码、个人资料
 */
import { Router } from 'express';
import { run, get, all, audit, getSettings } from '../db.js';
import {
  hashPassword, verifyPassword, signAccessToken, signTwoFactorToken, verifyTwoFactorToken,
} from '../auth.js';
import {
  generateSecret, verifyTotp, buildOtpAuthUrl, currentStep,
  generateBackupCodes, hashBackupCode, safeCompareHex, secondsRemaining,
} from '../totp.js';
import { ok, fail, asyncHandler, requireAuth } from '../middleware.js';
import { rateLimit, parseJSON } from '../utils.js';
import { LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS, TWO_FACTOR_RATE_LIMIT, TWO_FACTOR_RATE_WINDOW_MS, TWO_FACTOR_ADMIN_RATE_LIMIT, TEST_MODE, TOKEN_TTL_MS } from '../config.js';

const router = Router();

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  role: u.role,
  email: u.email,
  phone: u.phone,
  avatar: u.avatar,
  level: u.level,
  status: u.status,
  department_id: u.department_id,
  department_name: u.department_name ?? null,
  skills: (() => { try { return JSON.parse(u.skills || '[]'); } catch { return []; } })(),
  max_concurrent: u.max_concurrent,
});

/** POST /api/auth/login 登录（第一步：口令校验）
 *  若账号已启用 2FA，则不直接下发访问令牌，而是返回一个短期的待验证令牌
 */
router.post('/login', asyncHandler((req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return fail(res, '请输入账号和密码');

  const ip = req.ip || '';
  if (!rateLimit(`login:${ip}:${username}`, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS)) {
    return fail(res, `登录尝试过于频繁，请 ${Math.round(LOGIN_RATE_WINDOW_MS / 1000)} 秒后再试`, 429);
  }

  const user = get('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
  if (!user || !user.active) return fail(res, '账号不存在或已被停用', 401);
  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    audit(user, '登录失败', user.username, '口令错误', ip);
    return fail(res, '账号或密码错误', 401);
  }

  // 已启用双因素认证：返回待验证令牌，第二步校验通过后才签发访问令牌
  if (user.totp_enabled === 1 && user.totp_secret) {
    audit(user, '登录待二次验证', user.username, '口令通过，等待 TOTP 验证码', ip);
    return ok(res, {
      twoFactorRequired: true,
      twoFactorToken: signTwoFactorToken(user),
      expiresIn: 300,
      hint: '请输入验证器应用中的 6 位动态验证码，或使用一个备份码',
    }, '需要二次验证');
  }

  run("UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?", [user.id]);
  audit(user, '登录系统', user.username, `${user.role} 登录成功`, ip);

  return ok(res, { token: signAccessToken(user), user: publicUser(user) }, '登录成功');
}));

/** POST /api/auth/2fa/verify 登录第二步：校验动态验证码或备份码 */
router.post('/2fa/verify', asyncHandler((req, res) => {
  const { twoFactorToken, code } = req.body || {};
  const payload = verifyTwoFactorToken(twoFactorToken);
  if (!payload) return fail(res, '验证会话已过期，请重新登录', 401);

  const ip = req.ip || '';
  if (!rateLimit(`2fa:${ip}:${payload.id}`, TWO_FACTOR_RATE_LIMIT, TWO_FACTOR_RATE_WINDOW_MS)) {
    return fail(res, '验证尝试过于频繁，请稍后再试', 429);
  }

  const user = get('SELECT * FROM users WHERE id = ? AND active = 1', [payload.id]);
  if (!user || user.totp_enabled !== 1 || !user.totp_secret) {
    return fail(res, '该账号未启用二次验证，请重新登录', 400);
  }

  const input = String(code || '').trim();

  // 1) 动态验证码（TOTP）
  if (/^\d{6}$/.test(input)) {
    const result = verifyTotp(user.totp_secret, input);
    if (!result.ok) {
      audit(user, '二次验证失败', user.username, '动态验证码错误', ip);
      return fail(res, '验证码不正确或已过期，请重新输入', 401);
    }
    // 防重放：只拒绝「更早时间步」的验证码。
    // 同一时间步内允许重复提交（真实验证器场景下用户打错字重输很常见），
    // 而攻击者事后重放旧验证码会因时间步更早而被拒绝。
    if (user.totp_last_step !== null && user.totp_last_step !== undefined
        && result.step < user.totp_last_step) {
      audit(user, '二次验证失败', user.username, '验证码已过期（疑似重放）', ip);
      return fail(res, '验证码已过期，请使用验证器中最新的验证码', 401);
    }
    if (user.totp_last_step === null || user.totp_last_step === undefined || result.step > user.totp_last_step) {
      run('UPDATE users SET totp_last_step = ? WHERE id = ?', [result.step, user.id]);
    }
  } else {
    // 2) 备份码（一次性）
    const codes = parseJSON(user.backup_codes, []) || [];
    const hashed = hashBackupCode(input);
    const hit = codes.find((c) => safeCompareHex(c, hashed));
    if (!hit) {
      audit(user, '二次验证失败', user.username, '备份码无效', ip);
      return fail(res, '验证码或备份码不正确', 401);
    }
    const remaining = codes.filter((c) => c !== hit);
    run('UPDATE users SET backup_codes = ? WHERE id = ?', [JSON.stringify(remaining), user.id]);
    run("UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?", [user.id]);
    const fresh = get('SELECT * FROM users WHERE id = ?', [user.id]);
    audit(fresh, '使用备份码登录', fresh.username, `剩余备份码 ${remaining.length} 个`, ip);
    return ok(res, {
      token: signAccessToken(fresh),
      user: publicUser(fresh),
      usedBackupCode: true,
      backupCodesLeft: remaining.length,
    }, '登录成功（已使用备份码，请尽快重新生成备份码）');
  }

  run("UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?", [user.id]);
  const fresh = get('SELECT * FROM users WHERE id = ?', [user.id]);
  audit(fresh, '登录系统', fresh.username, `${fresh.role} 登录成功（2FA）`, ip);
  return ok(res, { token: signAccessToken(fresh), user: publicUser(fresh) }, '登录成功');
}));

/* ------------------------------ 双因素认证管理 ------------------------------ */

/** GET /api/auth/2fa/status 当前账号的 2FA 状态 */
router.get('/2fa/status', requireAuth, asyncHandler((req, res) => {
  const user = get('SELECT totp_enabled, totp_confirmed_at, backup_codes FROM users WHERE id = ?', [req.user.id]);
  const codes = parseJSON(user?.backup_codes, []) || [];
  return ok(res, {
    enabled: user?.totp_enabled === 1,
    confirmedAt: user?.totp_confirmed_at || null,
    backupCodesLeft: codes.length,
    secondsRemaining: secondsRemaining(),
  });
}));

/** POST /api/auth/2fa/setup 生成密钥与配置 URI（尚未启用，需再校验一次验证码） */
router.post('/2fa/setup', requireAuth, asyncHandler((req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (user.totp_enabled === 1) {
    return fail(res, '双因素认证已启用，如需更换请先关闭', 400);
  }
  const secret = generateSecret();
  const issuer = getSettings().site_name || '云客客服中心';
  const account = user.email || user.username;
  const otpauthUrl = buildOtpAuthUrl({ secret, account, issuer });

  // 暂存密钥但保持未启用；若中途放弃，下次 setup 会覆盖，不会留下可用凭据
  run('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', [secret, user.id]);
  audit(user, '发起 2FA 绑定', user.username, '生成 TOTP 密钥');

  return ok(res, {
    secret,
    otpauthUrl,
    issuer,
    account,
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }, '请用验证器应用扫描二维码或手动输入密钥');
}));

/** POST /api/auth/2fa/enable 校验验证码后正式启用，并返回备份码 */
router.post('/2fa/enable', requireAuth, asyncHandler((req, res) => {
  const { code } = req.body || {};
  const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (user.totp_enabled === 1) return fail(res, '双因素认证已启用', 400);
  if (!user.totp_secret) return fail(res, '请先获取密钥再启用', 400);

  if (!rateLimit(`2fa-enable:${req.user.id}`, TWO_FACTOR_ADMIN_RATE_LIMIT, TWO_FACTOR_RATE_WINDOW_MS)) {
    return fail(res, '尝试过于频繁，请稍后再试', 429);
  }

  const result = verifyTotp(user.totp_secret, code);
  if (!result.ok) return fail(res, '验证码不正确，请确认验证器时间是否准确', 400);

  const backupCodes = generateBackupCodes(8);
  // 注意：这里不写入 totp_last_step。
  // 否则用户刚绑定完就登录时，会因「同一时间步已被启用流程占用」而被误判为重放。
  // 登录防重放只需在 /2fa/verify 中记录即可。
  run(`UPDATE users SET totp_enabled = 1, totp_confirmed_at = datetime('now','localtime'),
        totp_last_step = NULL, backup_codes = ? WHERE id = ?`,
  [JSON.stringify(backupCodes.map(hashBackupCode)), user.id]);

  audit(user, '启用 2FA', user.username, '双因素认证已启用');
  return ok(res, {
    backupCodes,
    warning: '备份码仅显示这一次，请立即妥善保存。忘记验证器时可用备份码登录。',
  }, '双因素认证已启用');
}));

/** POST /api/auth/2fa/disable 关闭 2FA（需口令 + 当前验证码或备份码） */
router.post('/2fa/disable', requireAuth, asyncHandler((req, res) => {
  const { password, code } = req.body || {};
  if (!password) return fail(res, '请输入登录密码以确认操作');

  const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (user.totp_enabled !== 1) return fail(res, '该账号未启用双因素认证', 400);
  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    audit(user, '关闭 2FA 失败', user.username, '密码错误');
    return fail(res, '密码不正确', 401);
  }
  if (!rateLimit(`2fa-disable:${req.user.id}`, TWO_FACTOR_ADMIN_RATE_LIMIT, TWO_FACTOR_RATE_WINDOW_MS)) {
    return fail(res, '尝试过于频繁，请稍后再试', 429);
  }

  const input = String(code || '').trim();
  let confirmed = false;
  if (/^\d{6}$/.test(input)) {
    confirmed = verifyTotp(user.totp_secret, input).ok;
  } else if (input) {
    const codes = parseJSON(user.backup_codes, []) || [];
    confirmed = codes.some((c) => safeCompareHex(c, hashBackupCode(input)));
  }
  if (!confirmed) return fail(res, '请输入验证器中的 6 位验证码（或一个未使用的备份码）', 400);

  run(`UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_confirmed_at = NULL,
        totp_last_step = NULL, backup_codes = '[]' WHERE id = ?`, [user.id]);
  audit(user, '关闭 2FA', user.username, '双因素认证已关闭');
  return ok(res, { enabled: false }, '双因素认证已关闭');
}));

/** POST /api/auth/2fa/backup-codes/regenerate 重新生成备份码（需当前验证码） */
router.post('/2fa/backup-codes/regenerate', requireAuth, asyncHandler((req, res) => {
  const { code } = req.body || {};
  const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (user.totp_enabled !== 1) return fail(res, '该账号未启用双因素认证', 400);
  if (!rateLimit(`2fa-backup:${req.user.id}`, TWO_FACTOR_ADMIN_RATE_LIMIT, TWO_FACTOR_RATE_WINDOW_MS)) {
    return fail(res, '尝试过于频繁，请稍后再试', 429);
  }
  if (!verifyTotp(user.totp_secret, code).ok) return fail(res, '验证码不正确', 400);

  const backupCodes = generateBackupCodes(8);
  run('UPDATE users SET backup_codes = ? WHERE id = ?',
    [JSON.stringify(backupCodes.map(hashBackupCode)), user.id]);
  audit(user, '重新生成备份码', user.username, '旧备份码已失效');
  return ok(res, { backupCodes, warning: '旧备份码已全部失效，请保存新的备份码。' }, '备份码已重新生成');
}));

/** POST /api/auth/register 客户注册 */
router.post('/register', asyncHandler((req, res) => {
  const { username, password, name, email = '', phone = '' } = req.body || {};
  if (!username || !password) return fail(res, '请填写账号和密码');
  if (String(username).length < 3) return fail(res, '账号至少 3 个字符');
  if (String(password).length < 6) return fail(res, '密码至少 6 位');
  if (get('SELECT id FROM users WHERE username = ?', [username])) return fail(res, '该账号已被注册');

  const { hash, salt } = hashPassword(password);
  const r = run(
    `INSERT INTO users (username, password_hash, password_salt, name, role, email, phone, status)
     VALUES (?,?,?,?,'customer',?,?, 'offline')`,
    [username, hash, salt, name || username, email, phone],
  );
  const user = get('SELECT * FROM users WHERE id = ?', [Number(r.lastInsertRowid)]);
  audit(user, '注册账号', username, '客户自助注册');
  return ok(res, { token: signAccessToken(user), user: publicUser(user) }, '注册成功');
}));

/** GET /api/auth/me 当前用户 */
router.get('/me', requireAuth, asyncHandler((req, res) => {
  const user = get(`
    SELECT u.*, d.name AS department_name FROM users u
    LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?`, [req.user.id]);
  const out = publicUser(user);
  out.twoFactorEnabled = user.totp_enabled === 1;
  out.twoFactorConfirmedAt = user.totp_confirmed_at || null;
  return ok(res, out);
}));

/** PUT /api/auth/profile 更新资料 */
router.put('/profile', requireAuth, asyncHandler((req, res) => {
  const { name, email, phone, avatar } = req.body || {};
  run(
    `UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email),
       phone = COALESCE(?, phone), avatar = COALESCE(?, avatar) WHERE id = ?`,
    [name ?? null, email ?? null, phone ?? null, avatar ?? null, req.user.id],
  );
  const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  return ok(res, publicUser(user), '资料已更新');
}));

/** PUT /api/auth/password 修改密码 */
router.put('/password', requireAuth, asyncHandler((req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return fail(res, '请填写原密码和新密码');
  if (String(newPassword).length < 6) return fail(res, '新密码至少 6 位');
  const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!verifyPassword(oldPassword, user.password_salt, user.password_hash)) return fail(res, '原密码不正确');
  const { hash, salt } = hashPassword(newPassword);
  run('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', [hash, salt, user.id]);
  audit(user, '修改密码', user.username, '用户自行修改密码');
  return ok(res, null, '密码修改成功');
}));

/** GET /api/auth/settings 客户端读取站点配置（无需登录） */
router.get('/settings', asyncHandler((_req, res) => {
  const s = getSettings();
  return ok(res, {
    site_name: s.site_name,
    site_slogan: s.site_slogan,
    welcome_message: s.welcome_message,
    offline_message: s.offline_message,
    queue_notice: s.queue_notice,
    work_time: s.work_time,
    rating_enabled: s.rating_enabled,
    // 测试模式开关：前端据此隐藏「一键体验」并显示测试模式提示
    test_mode: TEST_MODE,
  });
}));

/**
 * POST /api/auth/demo 一键体验（仅测试模式可用）
 *
 * ⚠️ 安全边界（多层独立防线，任何一层都不依赖其它层）：
 *
 *  1. 编译期：模块加载时检查 TEST_MODE，非测试模式下根本不注册该路由，
 *     请求会落到 /api 404 兜底 —— 即使运行时开关被误改，路由也不存在。
 *  2. 请求期：路由内部再次校验 TEST_MODE（双保险）。
 *  3. 签发范围：只允许映射到 seed 的演示账号白名单，
 *     且这些账号在测试模式下才允许免密码签发令牌。
 *
 * 为什么这么严格：该接口会「免密码」签发含管理员在内的演示账号令牌。
 * 曾有安全报告（用户用 Burp 把登录请求体改成 {role:'admin'} 即可拿管理员身份），
 * 因此正常模式下它必须彻底不存在，而不仅是“返回 403”。
 */
const DEMO_ACCOUNTS = { customer: 'user1', agent: 'agent1', admin: 'admin' };

if (TEST_MODE) {
  router.post('/demo', asyncHandler((req, res) => {
    // 请求期二次校验（防运行时配置被篡改）
    if (!TEST_MODE) {
      return fail(res, '一键体验仅在测试模式下可用', 403);
    }
    const role = String(req.body?.role || 'customer');
    const username = DEMO_ACCOUNTS[role] || DEMO_ACCOUNTS.customer;
    const user = get('SELECT * FROM users WHERE username = ? AND role = ?', [username, role]);
    if (!user) return fail(res, '演示账号不存在，请先运行 npm run seed');
    const ip = req.ip || '';
    run("UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?", [user.id]);
    audit(user, '测试模式一键登录', user.username, `以 ${user.role} 身份进入（仅测试模式）`, ip);
    // 演示令牌：带 demo 标记 —— 切换到正常模式后立即失效（见 verifyAccessToken）
    const token = signAccessToken(user, TOKEN_TTL_MS, { demo: true });
    return ok(res, { token, user: publicUser(user) }, '已进入测试模式');
  }));
}
// 非测试模式：路由根本不注册，POST /api/auth/demo 直接 404（接口不存在）

export default router;
export { publicUser };
