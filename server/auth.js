/**
 * 认证与加密工具：使用 Node 内置 crypto 实现 PBKDF2 口令散列与 HMAC 签名令牌，
 * 避免引入 bcrypt / jsonwebtoken 等额外依赖。
 */
import crypto from 'node:crypto';
import { SECRET, TOKEN_TTL_MS, TEST_MODE } from './config.js';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(String(expectedHash || ''), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(payload, ttl = TOKEN_TTL_MS) {
  const body = { ...payload, exp: Date.now() + ttl };
  const data = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * 签发访问令牌（可用于访问业务接口）
 * purpose 固定为 'access'，与 2FA 待验证令牌严格区分。
 * 可选 demo:1 标记 —— 一键体验签发的令牌带上它，
 * verifyToken 校验时若发现该标记但当前已非测试模式，直接作废。
 * 这意味着：测试模式下拿到的演示令牌，切换到正常模式后立即失效，
 * 攻击者无法「先在测试模式拿令牌、再带去正常模式复用」。
 */
export function signAccessToken(user, ttl = TOKEN_TTL_MS, opts = {}) {
  const body = { id: user.id, role: user.role, purpose: 'access' };
  if (opts.demo) body.demo = 1;
  return signToken(body, ttl);
}

/**
 * 签发 2FA 待验证令牌（短期，仅能用于提交验证码，不能访问任何业务接口）
 */
export function signTwoFactorToken(user, ttl = 5 * 60 * 1000) {
  return signToken({ id: user.id, role: user.role, purpose: '2fa' }, ttl);
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.indexOf('.');
  const data = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

  // 常数时间比较：长度不等时也不能提前返回（否则可通过响应时间推断签名长度）。
  // 长度不同必然不等，用一个等长的占位串做 timingSafeEqual 后再判否。
  const sigBuf = Buffer.from(sig);
  const expectBuf = Buffer.from(expect);
  const sameLength = sigBuf.length === expectBuf.length;
  const comparable = sameLength ? sigBuf : Buffer.alloc(expectBuf.length);
  const equal = crypto.timingSafeEqual(comparable, expectBuf);
  if (!sameLength || !equal) return null;

  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!body.exp || body.exp < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * 校验访问令牌：除签名与有效期外，还必须显式声明 purpose === 'access'。
 *
 * 服务端签发的访问令牌一定带 purpose；不带 purpose 的令牌只可能来自
 * 密钥泄露后的人为构造，因此这里一律拒绝，不做「历史兼容」放行。
 *
 * 演示令牌的额外约束：demo:1 标记的令牌只在测试模式下有效。
 * 正常模式下出现 demo 标记 → 直接拒绝（防止测试期令牌被带到生产复用）。
 */
export function verifyAccessToken(token) {
  const body = verifyToken(token);
  if (!body) return null;
  if (body.purpose !== 'access') return null;
  if (body.demo === 1 && !TEST_MODE) return null;
  return body;
}

/** 校验 2FA 待验证令牌 */
export function verifyTwoFactorToken(token) {
  const body = verifyToken(token);
  if (!body) return null;
  return body.purpose === '2fa' ? body : null;
}

export const uid = (prefix = '') =>
  prefix + crypto.randomBytes(8).toString('hex') + Date.now().toString(36);
