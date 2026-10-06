/**
 * TOTP 双因素认证（RFC 6238）
 *
 * 仅使用 Node 内置 crypto 实现，兼容 Google Authenticator / Microsoft Authenticator /
 * Authy / 1Password 等标准验证器应用。
 *
 * 安全要点：
 *  - 密钥使用 Base32（验证器要求的编码），长度 20 字节（160 位，RFC 推荐）
 *  - 校验窗口允许前后各 1 个时间步（共 90 秒），容忍客户端时钟偏差
 *  - 比对使用 timingSafeEqual，避免时序侧信道
 *  - 同一时间步的验证码会被记录，防止重放（replay）
 *  - 备份码一次性使用，比对同样为常数时间
 */
import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;          // 时间步长（秒）
const DIGITS = 6;           // 验证码位数
const WINDOW = 1;           // 允许前后偏移的时间步数

/* ------------------------------------------------------------------ *
 * Base32
 * ------------------------------------------------------------------ */

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ------------------------------------------------------------------ *
 * 密钥与验证码
 * ------------------------------------------------------------------ */

/** 生成新的 TOTP 密钥（Base32 字符串） */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** 计算指定时间步的验证码 */
function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);

  const digest = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** DIGITS)).padStart(DIGITS, '0');
}

/** 当前时间步 */
export function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / PERIOD);
}

/**
 * 校验验证码
 * @returns {{ ok: boolean, step?: number, offset?: number }} 校验通过时返回匹配的时间步
 */
export function verifyTotp(secret, code, { window = WINDOW, now = Date.now() } = {}) {
  const input = String(code || '').replace(/\D/g, '');
  if (input.length !== DIGITS) return { ok: false };

  const secretBuf = base32Decode(secret);
  if (secretBuf.length < 10) return { ok: false };

  const step = currentStep(now);
  const candidates = [];
  for (let offset = -window; offset <= window; offset++) candidates.push(step + offset);

  for (const s of candidates) {
    const expected = hotp(secretBuf, s);
    const a = Buffer.from(expected);
    const b = Buffer.from(input);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { ok: true, step: s, offset: s - step };
    }
  }
  return { ok: false };
}

/** 生成 otpauth:// 配置 URI（验证器应用扫描/导入用） */
export function buildOtpAuthUrl({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** 生成剩余可用秒数（用于前端倒计时提示） */
export function secondsRemaining(now = Date.now()) {
  return PERIOD - (Math.floor(now / 1000) % PERIOD);
}

/* ------------------------------------------------------------------ *
 * 备份码
 * ------------------------------------------------------------------ */

/** 生成 N 个一次性备份码（格式 XXXX-XXXX，仅含大写字母与数字） */
export function generateBackupCodes(count = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符 I/O/0/1
  const codes = [];
  for (let i = 0; i < count; i++) {
    let raw = '';
    const bytes = crypto.randomBytes(8);
    for (let j = 0; j < 8; j++) raw += alphabet[bytes[j] % alphabet.length];
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

/** 备份码散列（不存明文） */
export function hashBackupCode(code) {
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** 常数时间比较散列值 */
export function safeCompareHex(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}
