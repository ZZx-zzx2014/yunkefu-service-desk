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
/** 站点托管根目录：每个站点一个独立子目录（与 kefu 本体完全隔离） */
export const SITES_DIR = process.env.KEFU_SITES_DIR
  ? path.resolve(process.env.KEFU_SITES_DIR)
  : path.join(DATA_DIR, 'sites');
export const DB_FILE = process.env.KEFU_DB_FILE
  ? path.resolve(process.env.KEFU_DB_FILE)
  : path.join(DATA_DIR, 'kefu.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(SITES_DIR, { recursive: true });

export const PORT = Number(process.env.PORT || 3000);

/* ------------------------------------------------------------------ *
 * 站点托管（静态站点 / PHP 站点）的独立端口
 *
 * 为什么不用主端口的 /s/ 路径：托管内容来自外部（GitHub 仓库、管理员上传的
 * PHP 代码），与客服系统同源会带来两个真实风险：
 *   1. 托管页面里的 JS 可以读取同源 localStorage —— 而登录令牌就存在那里，
 *      等于任何站点都能偷走管理员令牌；
 *   2. 托管站点可调用同源 /api 接口，绕过了本系统的 CSRF/来源隔离假设。
 * 用不同端口 = 不同源，浏览器天然隔离 localStorage / cookie / 同源策略。
 * 端口可自定义：KEFU_SITES_PORT；设为 0 表示关闭站点托管。
 * ------------------------------------------------------------------ */
const rawSitesPort = String(process.env.KEFU_SITES_PORT ?? '').trim();
export const SITES_PORT = rawSitesPort === ''
  ? PORT + 1
  : (Number(rawSitesPort) || 0);

/* ------------------------------------------------------------------ *
 * 运行模式
 *
 * 默认「正常模式」（对外服务模式）。测试模式需要显式进入：
 *   npm run testmode     # 等价于 KEFU_TEST_MODE=1 npm start
 *
 * 正常模式（默认，KEFU_TEST_MODE 未设置或为 0）：
 *   - 监听 0.0.0.0（可用 HOST 覆盖），供局域网/公网访问
 *   - 必须自行提供 KEFU_SECRET，否则拒绝启动
 *   - 免密码的「一键体验」接口被禁用
 *
 * 测试模式（KEFU_TEST_MODE=1）：
 *   - 未提供 KEFU_SECRET 时用进程内随机密钥（重启后旧令牌失效）
 *   - 只监听本机（127.0.0.1，可用 HOST 覆盖），且拒绝公网来源
 *   - 允许一键体验账号（含管理员），仅限本地/可信局域网试用
 * ------------------------------------------------------------------ */

const rawTestMode = String(process.env.KEFU_TEST_MODE ?? '').trim().toLowerCase();
/** 默认为正常模式（false）；仅当显式设置为 1/true/on 时进入测试模式 */
export const TEST_MODE = ['1', 'true', 'on', 'yes'].includes(rawTestMode);

/** 监听地址：正常模式默认所有网卡；测试模式默认本机（均可用 HOST 覆盖） */
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
  // 正常模式（默认）使用可预测的密钥 = 任何人都能伪造管理员令牌，必须拒绝启动
  console.error(`
  ⛔ 拒绝启动：请先设置 KEFU_SECRET（令牌签名密钥）

     生成一个强密钥（任选其一）：

       npm run new-secret

       # 或在 .env 中配置（参考 .env.example）
       KEFU_SECRET=<粘贴上面生成的随机串>

     说明：默认的正常模式会监听所有网卡供局域网访问，
     所以必须保证密钥不可猜测。
     如果你只是想本地试用，可以用测试模式（仅本机可访问，一键体验可用）：

       npm run testmode
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
