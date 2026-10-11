/**
 * 云客客服系统 - 服务端入口
 */
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
// 说明：.env 由 server/config.js 在其顶部载入（必须早于任何配置读取）
import { PORT, HOST, PUBLIC_DIR, ROOT, ACCESS, LISTEN_ALL } from './config.js';
import './db.js';
import { getSettings } from './db.js';
import { attachUser, errorHandler, ok, fail } from './middleware.js';
import { securityHeaders, serveUpload } from './security.js';
import { localOnlyGuard } from './access-guard.js';
import { compress } from './compress.js';
import { initRealtime } from './realtime.js';
import { listAccessAddresses, primaryAddress, kindLabel } from './netinfo.js';
import { toPNG, toSVG, toDataURI, toTerminal } from './qrcode.js';
import { renderLanPage } from './lanpage.js';
import { listPhpVersions } from './php.js';

import authRoutes from './routes/auth.js';
import conversationRoutes from './routes/conversations.js';
import ticketRoutes from './routes/tickets.js';
import kbRoutes from './routes/kb.js';
import dashboardRoutes from './routes/dashboard.js';
import adminRoutes from './routes/admin.js';
// 站点托管子系统暂缓挂载：sites.js 存在两处缺陷（audit 导入来源错误已修，
// serveSiteFile 内引用未定义的 next），且未经完整验证。
// 安排：单独修复并验证后，再取消注释接入。见 PUBLISHING.md 待办。
// import siteAdminRoutes, { siteHostApp } from './routes/sites.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// 压缩必须在最前（拦截 res.write/end，对 JSON 与静态资源都生效）
app.use(compress());

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(securityHeaders);
// 测试模式：只接受本机与私有网段来源（纵深防御，配合 127.0.0.1 监听）
app.use(localOnlyGuard(ACCESS));
app.use(attachUser);

/* ------------------------------ 访问日志 ------------------------------ */
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/ws') {
    const start = Date.now();
    res.on('finish', () => {
      if (res.statusCode >= 400) {
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
      }
    });
  }
  next();
});

/* ------------------------------ 健康检查 ------------------------------ */
app.get('/api/health', (_req, res) => ok(res, {
  status: 'ok',
  uptime: Math.round(process.uptime()),
  time: new Date().toISOString(),
  version: '1.0.0',
}));

/* ------------------------------ API 路由 ------------------------------ */
app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/kb', kbRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/admin', adminRoutes);
// 站点托管：管理端接口（暂缓挂载，见顶部说明）
// app.use('/api/admin/sites', siteAdminRoutes);

/* ------------------------------ 局域网接入 / 二维码 ------------------------------ */

/**
 * GET /api/lan 返回可访问地址与推荐地址（供前端或脚本使用）
 * 注意：本路由与 /api/qr 必须注册在 `app.use('/api', ...)` 兜底之前，
 * 否则会被 404 兜底拦截。
 */
app.get('/api/lan', (_req, res) => {
  const addresses = listAccessAddresses(PORT);
  const primary = addresses.find((a) => a.recommended) || addresses[0] || null;
  return ok(res, {
    hostname: os.hostname(),
    port: PORT,
    primary,
    addresses,
    localhost: `http://localhost:${PORT}/`,
    siteName: getSettings().site_name,
  });
});

/** GET /api/qr?data=&scale=&format= 生成二维码图片（默认 PNG，format=svg 可返回 SVG） */
app.get('/api/qr', (req, res) => {
  const format = String(req.query.format || 'png').toLowerCase();
  const scale = Math.max(2, Math.min(20, Number(req.query.scale) || 8));
  // 未指定 data 时，默认生成「推荐局域网地址」的二维码，方便直接使用
  let data = String(req.query.data || '').trim();
  if (!data) {
    const primary = primaryAddress(PORT);
    data = primary ? primary.url : `http://localhost:${PORT}/`;
  }
  if (data.length > 900) return fail(res, '内容过长，无法生成二维码', 400);

  try {
    if (format === 'svg') {
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(toSVG(data, { scale, margin: 4 }));
    }
    const png = toPNG(data, { scale, margin: 4 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(png);
  } catch (err) {
    return fail(res, err.message || '二维码生成失败', 400);
  }
});

app.use('/api', (_req, res) => fail(res, '接口不存在', 404));

/* ------------------------------ 站点托管（/s/<slug>/） ------------------------------ */
// 访问端暂缓挂载（见顶部说明）：
// app.use('/s', siteHostApp());

/* ------------------------------ 静态资源 ------------------------------ */
// 上传文件走专用中间件：强制 nosniff、非图片强制下载、禁止任何主动内容执行
app.use('/uploads', serveUpload);
/**
 * 静态资源缓存策略：
 *  - HTML 页面：no-cache —— 每次协商校验，保证用户总是拿到新版入口
 *  - JS/CSS：no-cache —— 同上；因未做文件指纹，改版本仍靠协商缓存兜底
 *  - 其它（favicon 等）：允许短缓存
 * 上传的图片等用户内容走 /uploads，不在此列。
 */
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], setHeaders: (res, filePath) => {
  const p = filePath.toLowerCase();
  const isPage = p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css');
  res.setHeader('Cache-Control', isPage ? 'no-cache, must-revalidate' : 'public, max-age=86400');
} }));
// express.static 自带 ETag/Last-Modified 协商，命中 304 时无响应体，二次访问几乎零开销

// 前端三个端口的入口
const sendPage = (file) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
app.get('/agent', sendPage('agent.html'));
app.get('/agent/*', sendPage('agent.html'));
app.get('/admin', sendPage('admin.html'));
app.get('/admin/*', sendPage('admin.html'));
app.get('/help', sendPage('help.html'));
app.get('/help/*', sendPage('help.html'));

/** GET /lan 局域网接入页：展示二维码与可访问地址，手机扫码即用 */
app.get('/lan', (_req, res) => {
  const addresses = listAccessAddresses(PORT);
  const primary = addresses.find((a) => a.recommended) || addresses[0] || null;
  const settings = getSettings();
  const target = primary ? primary.url : `http://localhost:${PORT}/`;
  const html = renderLanPage({
    siteName: settings.site_name || '云客客服中心',
    slogan: settings.site_slogan || '',
    addresses,
    port: PORT,
    localhost: `http://localhost:${PORT}/`,
    qrDataUri: toDataURI(target, { scale: 8, margin: 2 }),
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
});

app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((_req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'), (err) => {
    if (err) res.status(404).send('404 Not Found');
  });
});

app.use(errorHandler);

/* ------------------------------ 启动 ------------------------------ */
const server = http.createServer(app);
initRealtime(server);

/**
 * 按「显示宽度」截断/补齐（中日韩字符占 2 列），用于把启动横幅的边框对齐。
 * 直接用 String.padEnd 会按码点计数，中文描述会把右边框推歪。
 */
function displayWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f)        // 韩文字母
      || (code >= 0x2e80 && code <= 0xa4cf)                 // CJK 部首 ~ 彝文
      || (code >= 0xac00 && code <= 0xd7a3)                 // 韩文音节
      || (code >= 0xf900 && code <= 0xfaff)                 // CJK 兼容
      || (code >= 0xfe30 && code <= 0xfe6f)                 // CJK 兼容形式
      || (code >= 0xff00 && code <= 0xff60)                 // 全角
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x20000 && code <= 0x3fffd);              // CJK 扩展
    w += wide ? 2 : 1;
  }
  return w;
}

/** 按显示宽度居中（用于横幅标题行） */
function centerByWidth(str, width) {
  const diff = width - displayWidth(str);
  if (diff <= 0) return str;
  const left = Math.floor(diff / 2);
  return ' '.repeat(left) + str + ' '.repeat(diff - left);
}

server.listen(PORT, HOST, () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const addresses = listAccessAddresses(PORT);
  const primary = addresses.find((a) => a.recommended) || addresses[0] || null;

  // 横幅宽度按描述的实际显示宽度自适应，避免中文把右边框推歪
  const bannerWidth = Math.max(58, displayWidth(pkg.description) + 2);
  console.log(`
  ╭${'─'.repeat(bannerWidth)}╮
  │${centerByWidth(pkg.description, bannerWidth)}│
  ╰${'─'.repeat(bannerWidth)}╯

  ✅ 服务已启动`);

  // 测试模式提示（默认状态，必须在最显眼的位置说明）
  if (ACCESS.testMode) {
    console.log(`
  ── 测试模式 ────────────────────────────────────────────────

     · 仅监听 ${HOST}，且只接受本机与局域网（私有网段）访问
     · 「一键体验」可用：可免密码以演示账号进入，包含管理员
     · 请勿用于对外提供服务；不要将本机端口映射到公网

     切换到正常模式（对外服务）：直接 npm start（需在 .env 配置 KEFU_SECRET）`);
  } else {
    console.log(`
  ── 正常模式（对外服务）─────────────────────────────────────

     · 监听 ${HOST}，局域网内设备可直接访问
     · 「一键体验」接口已禁用；如需本地演示请用 npm run testmode`);
    if (ACCESS.secretIsWeak) {
      console.log('     · ⚠️  检测到 KEFU_SECRET 过弱或为示例值，请尽快更换为随机强密钥');
    }
  }

  if (ACCESS.secretIsEphemeral && ACCESS.testMode) {
    console.log(`
  ⚠️  未设置 KEFU_SECRET，本次使用「进程内随机密钥」
     服务重启后所有已登录会话将失效。`);
  }

  console.log(`
  ── 访问地址 ────────────────────────────────────────────────

     客户咨询中心   http://localhost:${PORT}/
     客服工作台     http://localhost:${PORT}/agent
     管理后台       http://localhost:${PORT}/admin
     帮助中心       http://localhost:${PORT}/help`);

  // 站点托管子系统暂缓上线：/s/ 路由未挂载，提示一并隐藏（见 PUBLISHING.md 待办）

  if (ACCESS.testMode) {
    console.log(`
     演示账号（测试模式免密码一键进入，也可用密码登录）：
       admin/admin123 · agent1/agent123 · user1/user123`);
  }

  // 局域网地址只在真正监听所有网卡时展示（否则会给出误导性地址）
  if (LISTEN_ALL) {
    if (primary && primary.kind === 'lan') {
      console.log(`
  ── 局域网访问 ──────────────────────────────────────────────

     ${primary.url}   （${primary.interface}）
     扫码接入页：http://${primary.address}:${PORT}/lan`);
    } else if (primary) {
      console.log(`
  ── 网络访问 ────────────────────────────────────────────────

     ${primary.url}   （${kindLabel(primary.kind)} · ${primary.interface}）`);
    }
  } else {
    console.log(`
  ── 手机扫码接入 ────────────────────────────────────────────
     当前仅监听 ${HOST}，手机无法访问。如需手机接入：

       npm start                 （正常模式，监听所有网卡，需 KEFU_SECRET）
       npm run start:lan         （同上，附局域网地址提示）`);

    if (ACCESS.testMode) {
      console.log(`
     或保持测试模式并放开监听（只接受私有网段来源）：
       HOST=0.0.0.0 npm run testmode`);
    }
  }
  console.log('');
});

/**
 * 打印终端二维码（供手机扫码接入）。
 * 说明：终端二维码用半块字符绘制，需要浅色背景；
 * 若终端为深色主题，可使用 `npm run lan` 生成 PNG 打开后用手机扫。
 */
function printTerminalQR(url) {
  console.log('\n  ── 手机扫码接入 ──────────────────────────────────────────\n');
  console.log(toTerminal(url, { margin: 2, scale: 8 }).split('\n').map((l) => `  ${l}`).join('\n'));
  console.log(`\n  扫码后打开：${url}`);
  console.log('  （若终端显示错位，请改用 npm run lan 生成二维码图片）\n');
}

// 仅当显式要求时才打印终端二维码，避免刷屏影响日常只看日志的场景
if (process.env.KEFU_SHOW_QR === '1') {
  const primary = primaryAddress(PORT);
  if (primary) printTerminalQR(primary.url);
}

const shutdown = (signal) => {
  console.log(`\n[server] 收到 ${signal}，正在关闭…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
