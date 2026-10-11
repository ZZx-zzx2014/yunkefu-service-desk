/**
 * 安全响应头与上传目录的静态文件服务
 *
 * 关键点：上传目录里的任何文件都不允许被浏览器当作「主动内容」执行，
 * 否则一个伪装成图片的 HTML/SVG 就能窃取会话令牌（存储型 XSS）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './config.js';
import { ALLOWED_MIME, INLINE_MIME } from './upload-security.js';

/** 落盘扩展名 -> MIME（服务端自己生成扩展名，因此可精确映射） */
const EXT_MIME = (() => {
  const map = new Map();
  for (const [mime, ext] of Object.entries(ALLOWED_MIME)) {
    if (ext && !map.has(ext)) map.set(ext, mime);
  }
  // 图片类型以更精确的值覆盖
  map.set('.png', 'image/png');
  map.set('.jpg', 'image/jpeg');
  map.set('.gif', 'image/gif');
  map.set('.webp', 'image/webp');
  map.set('.bmp', 'image/bmp');
  return map;
})();

/**
 * 全局安全响应头
 *
 * 说明：script-src 不含 'unsafe-inline' —— 前端已无内联脚本、
 * 无内联事件属性（onclick 等改为 data-action 事件委托），也无内联 javascript: 链接，
 * 因此可以启用严格脚本策略，使 XSS 注入的 <script> 与事件属性无法执行。
 * style-src 仍需 'unsafe-inline'：页面模板使用了大量内联 style 属性（风险远低于脚本）。
 */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // XSS 过滤器：按 CWE-16 建议「1; mode=block」而非「0」。
  // 说明：该头仅作用于老浏览器（IE/旧版 Safari），现代浏览器已废弃该机制
  // 并完全依赖下方 CSP；但保留 block 模式能让老浏览器在检测到反射型 XSS 时
  // 渲染空白页而不是尝试过滤，同时让安全扫描不再报「过滤器被禁用」。
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "font-src 'self' data:",
      // WebSocket 实时通道
      "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  );
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
}

/**
 * 上传文件的静态服务
 *  - 只服务 uploads 根目录下的常规文件，拒绝子目录与路径穿越
 *  - 图片：inline + nosniff + 严格 CSP（禁止脚本、禁止外连）
 *  - 其他：强制下载（attachment），并加 sandbox 兜底
 *  - 未知扩展名：一律按附件下载，绝不内联
 */
export function serveUpload(req, res, next) {
  let name;
  try {
    name = decodeURIComponent(req.path.replace(/^\/+/, ''));
  } catch {
    return res.status(400).send('非法路径');
  }

  // 拒绝路径穿越、隐藏点文件与子目录
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')
      || name.startsWith('.') || name.includes('..')) {
    return res.status(404).send('404 Not Found');
  }

  const filePath = path.join(UPLOAD_DIR, name);
  // 二次确认最终路径仍位于上传目录内
  const rel = path.relative(UPLOAD_DIR, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(404).send('404 Not Found');
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return res.status(404).send('404 Not Found');
  }
  if (!stat.isFile()) return res.status(404).send('404 Not Found');

  const ext = path.extname(name).toLowerCase();
  const mime = EXT_MIME.get(ext) || 'application/octet-stream';
  const inline = INLINE_MIME.has(mime);

  // 文本类带上 charset，二进制与图片不带；未知类型一律按二进制流处理
  const isText = /^text\//.test(mime) || mime === 'application/json';
  res.setHeader('Content-Type', isText ? `${mime}; charset=utf-8` : mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Accept-Ranges', 'none');

  if (inline) {
    // 图片内联展示：禁止脚本与外连，杜绝伪装成图片的主动内容
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
  } else {
    // 其余文件强制下载，并加 sandbox 兜底，避免被直接打开执行
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Download-Options', 'noopen');
  }

  return fs.createReadStream(filePath).pipe(res).on('error', () => {
    if (!res.headersSent) next();
    else res.end();
  });
}
