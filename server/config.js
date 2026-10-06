import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.js';

/**
 * 载入 .env —— 必须出现在本文件最前面。
 *
 * 注意 ESM 的陷阱：import 会被提升，模块顶层代码按依赖顺序执行。
 * 因此 .env 的读取必须放在 config.js 自身内部（而不是入口文件里先 import
 * 一个加载器再 import config），否则下面的 process.env 读取发生在载入之前，
 * .env 就等于没生效。
 */
export const ENV_FILE = loadEnvFile();

const __filename = fileURLToPath(import.meta.url);
export const SERVER_DIR = path.dirname(__filename);

/** 项目根目录 */
export const ROOT = path.resolve(SERVER_DIR, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const DB_FILE = process.env.KEFU_DB_FILE
  ? path.resolve(process.env.KEFU_DB_FILE)
  : path.join(DATA_DIR, 'kefu.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const PORT = Number(process.env.PORT || 3000);

/* ------------------------------------------------------------------ *
 * 测试模式
 *
 * 默认「开启」。测试模式下：
 *   - 只监听本机（127.0.0.1），不对外暴露
 *   - 拒绝来自公网地址的请求（纵深防御）
 *   - 允许免密码的一键体验账号（/api/auth/demo）
 *
 * 关闭测试模式（KEFU_TEST_MODE=0）即为「对外服务模式」：
 *   - 必须自行提供 KEFU_SECRET，否则拒绝启动
 *   - 一键体验接口会被禁用
 *   - 监听 0.0.0.0（可用 HOST 覆盖）
 * ------------------------------------------------------------------ */

const rawTestMode = String(process.env.KEFU_TEST_MODE ?? '').trim().toLowerCase();
/** 未设置时默认开启测试模式（安全默认值） */
export const TEST_MODE = rawTestMode === ''
  ? true
  : !['0', 'false', 'no', 'off'].includes(rawTestMode);

/** 监听地址：测试模式默认本机（可用 HOST 显式放开，仍受来源守卫保护） */
export const HOST = TEST_MODE
  ? (process.env.HOST || '127.0.0.1')
  : (process.env.HOST || '0.0.0.0');

/** 是否监听在所有网卡上（决定是否展示局域网地址） */
export const LISTEN_ALL = HOST === '0.0.0.0' || HOST === '::';

/* ------------------------------------------------------------------ *
 * 令牌签名密钥
 *
 * 安全要求：绝不能在仓库里硬编码一个可用的固定密钥。
 *   - 生产模式：必须由 KEFU_SECRET 提供，否则启动时报错退出
 *   - 测试模式：未提供时生成进程内随机密钥（重启后旧令牌失效）
 * ------------------------------------------------------------------ */

const DEFAULT_INSECURE_SECRETS = new Set([
  'kefu-dev-secret-change-me-in-production',
  'secret', 'change-me', 'kefu', 'password',
]);

const providedSecret = String(process.env.KEFU_SECRET || '').trim();

if (!TEST_MODE && (!providedSecret || DEFAULT_INSECURE_SECRETS.has(providedSecret))) {
  // 对外服务时使用可预测的密钥 = 任何人都能伪造管理员令牌，必须拒绝启动
  console.error(`
  ⛔ 拒绝启动：生产模式必须提供你自己的 KEFU_SECRET

     生成一个强密钥（任选其一）：

       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

       # 或在 .env 中配置（参考 .env.example）
       KEFU_SECRET=<粘贴上面生成的随机串>

     如果你只是想在本地/局域网试用，请不要设置 KEFU_TEST_MODE，
     直接用默认的测试模式启动即可（仅本机可访问）。
`);
  process.exit(1);
}

let secret;
let secretIsEphemeral = false;
let secretIsWeak = false;

if (providedSecret && !DEFAULT_INSECURE_SECRETS.has(providedSecret) && providedSecret.length >= 16) {
  secret = providedSecret;
} else if (providedSecret && (DEFAULT_INSECURE_SECRETS.has(providedSecret) || providedSecret.length < 16)) {
  // 测试模式下允许但不推荐；生产模式已在上面拦下
  secret = providedSecret;
  secretIsWeak = true;
} else {
  secret = crypto.randomBytes(32).toString('hex');
  secretIsEphemeral = true;
}

export const SECRET = secret;
export const SECRET_IS_EPHEMERAL = secretIsEphemeral;
export const SECRET_IS_WEAK = secretIsWeak;
export const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 天

/** 测试模式相关配置聚合，供中间件与启动横幅使用 */
export const ACCESS = {
  testMode: TEST_MODE,
  host: HOST,
  port: PORT,
  secretIsEphemeral,
  secretIsWeak,
};

/** 登录接口速率限制：窗口内允许的尝试次数（自动化测试可调高） */
export const LOGIN_RATE_LIMIT = Number(process.env.KEFU_LOGIN_RATE_LIMIT || 15);
export const LOGIN_RATE_WINDOW_MS = 60_000;

/** 2FA 验证接口速率限制：防止暴力猜测 6 位验证码（自动化测试可调高） */
export const TWO_FACTOR_RATE_LIMIT = Number(process.env.KEFU_2FA_RATE_LIMIT || 10);
export const TWO_FACTOR_RATE_WINDOW_MS = 60_000;

/** 已启用 2FA 的账号，其敏感操作（关闭 / 重置备份码）的尝试上限 */
export const TWO_FACTOR_ADMIN_RATE_LIMIT = Number(process.env.KEFU_2FA_ADMIN_RATE_LIMIT || 10);

export const CHANNELS = {
  web: '网页',
  app: 'APP',
  wechat: '微信公众号',
  phone: '电话',
  email: '邮件',
};

export const TICKET_CATEGORIES = ['产品咨询', '技术支持', '账务问题', '投诉建议', '功能申请', '其他'];
export const TICKET_PRIORITIES = { low: '低', normal: '中', high: '高', urgent: '紧急' };
export const TICKET_STATUSES = {
  pending: '待处理',
  processing: '处理中',
  resolved: '已解决',
  closed: '已关闭',
  reopened: '重新打开',
};
export const CONV_STATUSES = { queued: '排队中', active: '进行中', closed: '已结束' };
