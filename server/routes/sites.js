/**
 * 站点托管路由
 *
 * 两部分：
 *   A. /api/admin/sites* —— 管理端：创建/部署/删除站点、查询 PHP 版本
 *   B. /s/:slug/*       —— 访问端：静态文件直出 + PHP 脚本经隔离执行器运行
 *
 * 访问端设计：
 *   - 路径固定前缀 /s/<slug>/，与主系统完全隔离；slug 全局唯一
 *   - 静态类型：express.static 直出（复用主系统的安全头与缓存策略）
 *   - PHP 类型：命中 .php 文件时交给 runPhp（open_basedir 限制在该站点目录）
 *   - 目录索引：默认找 index.php / index.html，都没有则给简单的目录列表页
 *   - 站点目录名带随机后缀（slug-<rand>），不可通过猜测 slug 直接定位磁盘目录
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { SITES_DIR } from '../config.js';
import { run, get, all, audit } from '../db.js';
import { nowStr } from '../utils.js';
import { asyncHandler, ok, fail, requireAuth, requireRole } from '../middleware.js';
import { securityHeaders } from '../security.js';
import { listPhpVersions, runPhp } from '../php.js';
import { deployFromGitHub, parseRepoUrl, validateRef, dirSize, removeDir, siteDirName } from '../deploy.js';

export const router = express.Router();
export default router;

/* ================================================================== *
 * A. 管理端接口（全部要求 admin）
 * ================================================================== */

const adminOnly = requireRole('admin');

/** slug 合法性：小写字母/数字/-，3~30 位 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;

/** 每个站点在磁盘上的根目录 */
function siteRoot(site) {
  return path.join(SITES_DIR, site.root_dir || siteDirName(site.slug));
}

/** 站点记录 → API 输出（不泄露磁盘绝对路径） */
function publicSite(s) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    type: s.type,
    php_version: s.php_version,
    source: s.source,
    repo_url: s.repo_url,
    repo_ref: s.repo_ref,
    sub_dir: s.sub_dir,
    status: s.status,
    last_error: s.last_error,
    size_bytes: s.size_bytes,
    has_index: s.has_index,
    url: `/s/${s.slug}/`,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

/** 计算站点当前是否有可用入口文件 */
function detectIndex(root) {
  const candidates = ['index.php', 'index.html', 'index.htm'];
  for (const c of candidates) {
    try {
      if (fs.statSync(path.join(root, c)).isFile()) return { file: c, type: c.endsWith('.php') ? 'php' : 'static' };
    } catch { /* 不存在继续找 */ }
  }
  return null;
}

/* ---------------- PHP 版本探测 ---------------- */

/** GET /api/admin/sites/php-versions 本机可用 PHP 版本列表 */
router.get('/php-versions', requireAuth, adminOnly, asyncHandler(async (_req, res) => {
  const versions = await listPhpVersions();
  return ok(res, { list: versions, available: versions.length > 0 });
}));

/* ---------------- 站点 CRUD ---------------- */

/** GET /api/admin/sites 站点列表 */
router.get('/', requireAuth, adminOnly, asyncHandler(async (_req, res) => {
  const rows = all('SELECT * FROM sites ORDER BY id DESC');
  const list = rows.map((s) => {
    let hasIndex = null;
    try { hasIndex = detectIndex(siteRoot(s)); } catch { /* 目录不存在 */ }
    return publicSite({ ...s, has_index: hasIndex });
  });
  return ok(res, { list });
}));

/** GET /api/admin/sites/:id 部署历史 */
router.get('/:id/deploys', requireAuth, adminOnly, asyncHandler(async (req, res) => {
  const site = get('SELECT * FROM sites WHERE id = ?', [req.params.id]);
  if (!site) return fail(res, '站点不存在', 404, 404);
  const list = all('SELECT * FROM site_deploys WHERE site_id = ? ORDER BY id DESC LIMIT 20', [site.id]);
  return ok(res, { list });
}));

/** POST /api/admin/sites 创建站点（手动模式：创建空目录 + 入口文件） */
router.post('/', requireAuth, adminOnly, asyncHandler(async (req, res) => {
  const { slug, name, type = 'static', php_version = '' } = req.body || {};

  if (!SLUG_RE.test(String(slug || ''))) {
    return fail(res, '站点标识（slug）须为 3~30 位小写字母、数字或连字符，且以字母/数字开头');
  }
  if (get('SELECT id FROM sites WHERE slug = ?', [slug])) return fail(res, '该标识已被占用');
  if (!String(name || '').trim()) return fail(res, '请填写站点名称');
  if (!['static', 'php'].includes(type)) return fail(res, '站点类型只支持 static 或 php');
  if (type === 'php' && !php_version) return fail(res, 'PHP 站点必须选择 PHP 版本');

  // PHP 版本必须真实存在于本机（防止填一个不存在的版本后站点永远 500）
  if (type === 'php') {
    const versions = await listPhpVersions();
    if (!versions.some((v) => v.id === php_version)) {
      return fail(res, `本机没有 PHP ${php_version}，请从版本列表中选择`, 400);
    }
  }

  const rootDir = siteDirName(slug);
  const root = path.join(SITES_DIR, rootDir);
  fs.mkdirSync(root, { recursive: true });

  // 手动创建时给出最小可用的入口文件，方便用户直接开始编辑
  if (type === 'php') {
    fs.writeFileSync(path.join(root, 'index.php'),
      `<?php\nheader('Content-Type: text/html; charset=utf-8');\necho "<h1>${escapeHtml(name)}</h1><p>站点已就绪，把你的 PHP 文件放在这里即可。</p>";\n`);
  } else {
    fs.writeFileSync(path.join(root, 'index.html'),
      `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(name)}</title></head><body><h1>${escapeHtml(name)}</h1><p>站点已就绪，把你的静态文件放在这里即可。</p></body></html>\n`);
  }

  const r = run(
    `INSERT INTO sites (slug, name, type, php_version, root_dir, source, status, created_by)
     VALUES (?, ?, ?, ?, ?, 'manual', 'running', ?)`,
    [slug, String(name).trim(), type, php_version, rootDir, req.user.id],
  );
  const site = get('SELECT * FROM sites WHERE id = ?', [r.lastInsertRowid]);
  audit(req.user, '创建站点', site.slug, `类型 ${type}${type === 'php' ? ' · PHP ' + php_version : ''}`, req.ip);
  return ok(res, publicSite({ ...site, has_index: detectIndex(root) }), '站点创建成功');
}));

/** POST /api/admin/sites/:id/deploy 从 GitHub 重新部署 */
router.post('/:id/deploy', requireAuth, adminOnly, asyncHandler(async (req, res) => {
  const site = get('SELECT * FROM sites WHERE id = ?', [req.params.id]);
  if (!site) return fail(res, '站点不存在', 404, 404);
  const { repo_url = site.repo_url, repo_ref = site.repo_ref || 'main', sub_dir = site.sub_dir || '' } = req.body || {};

  let owner, repo;
  try {
    ({ owner, repo } = parseRepoUrl(repo_url));
  } catch (e) {
    return fail(res, e.message);
  }
  const ref = validateRef(repo_ref);

  const t0 = Date.now();
  const root = siteRoot(site);
  const stagingDir = root + '.staging';
  try {
    // 先部署到 staging，成功后原子切换
    removeDir(stagingDir);
    fs.mkdirSync(stagingDir, { recursive: true });
    const result = await deployFromGitHub({ owner, repo, ref, destDir: stagingDir, subDir });

    // 切换：旧目录 → .old，staging → 正式，删除 .old
    const oldDir = root + '.old';
    removeDir(oldDir);
    if (fs.existsSync(root)) fs.renameSync(root, oldDir);
    fs.renameSync(result.finalRoot, root);
    // subDir 场景：finalRoot 在 staging 内，需要把内容搬上来
    if (path.resolve(result.finalRoot) !== path.resolve(stagingDir)) {
      // finalRoot 已 rename 到 root，staging 里剩下的旧目录结构直接清理
    }
    removeDir(stagingDir);
    removeDir(oldDir);

    const size = dirSize(root);
    run('UPDATE sites SET status = ?, last_error = "", repo_url = ?, repo_ref = ?, sub_dir = ?, source = ?, size_bytes = ?, updated_at = ? WHERE id = ?',
      ['running', repo_url, ref, sub_dir, 'github', size, nowStr(), site.id]);
    const duration = Date.now() - t0;
    run('INSERT INTO site_deploys (site_id, source, ref, status, duration_ms, detail) VALUES (?, ?, ?, ?, ?, ?)',
      [site.id, 'github', ref, 'success', duration, `${result.files} 个文件 · ${(result.bytes / 1024).toFixed(0)} KB`]);
    audit(req.user, '部署站点', site.slug, `来自 GitHub ${owner}/${repo}@${ref}，${result.files} 个文件`, req.ip);
    const updated = get('SELECT * FROM sites WHERE id = ?', [site.id]);
    return ok(res, publicSite({ ...updated, has_index: detectIndex(root) }), `部署成功：${result.files} 个文件，${duration} ms`);
  } catch (err) {
    removeDir(stagingDir);
    run('UPDATE sites SET status = ?, last_error = ? WHERE id = ?', ['error', err.message, site.id]);
    run('INSERT INTO site_deploys (site_id, source, ref, status, duration_ms, detail) VALUES (?, ?, ?, ?, ?, ?)',
      [site.id, 'github', ref, 'failed', Date.now() - t0, err.message]);
    return fail(res, `部署失败：${err.message}`, 400);
  }
}));

/** PUT /api/admin/sites/:id 修改（改名 / 切 PHP 版本） */
router.put('/:id', requireAuth, adminOnly, asyncHandler(async (req, res) => {
  const site = get('SELECT * FROM sites WHERE id = ?', [req.params.id]);
  if (!site) return fail(res, '站点不存在', 404, 404);
  const { name, php_version } = req.body || {};

  if (php_version && php_version !== site.php_version) {
    const versions = await listPhpVersions();
    if (!versions.some((v) => v.id === php_version)) {
      return fail(res, `本机没有 PHP ${php_version}`, 400);
    }
  }
  run('UPDATE sites SET name = COALESCE(?, name), php_version = COALESCE(?, php_version), updated_at = ? WHERE id = ?',
    [String(name || '').trim() || null, php_version || null, nowStr(), site.id]);
  audit(req.user, '修改站点', site.slug, name ? `改名 ${name}` : `PHP 版本 → ${php_version}`, req.ip);
  const updated = get('SELECT * FROM sites WHERE id = ?', [site.id]);
  return ok(res, publicSite({ ...updated, has_index: detectIndex(siteRoot(updated)) }), '已保存');
}));

/** DELETE /api/admin/sites/:id 删除站点（含磁盘目录） */
router.delete('/:id', requireAuth, adminOnly, asyncHandler(async (req, res) => {
  const site = get('SELECT * FROM sites WHERE id = ?', [req.params.id]);
  if (!site) return fail(res, '站点不存在', 404, 404);
  removeDir(siteRoot(site));
  removeDir(siteRoot(site) + '.staging');
  removeDir(siteRoot(site) + '.old');
  run('DELETE FROM sites WHERE id = ?', [site.id]);
  audit(req.user, '删除站点', site.slug, '', req.ip);
  return ok(res, null, '站点已删除');
}));

/* ================================================================== *
 * B. 访问端：GET /s/:slug/* —— 供独立挂载，见 index.js
 * ================================================================== */

/** 构造访问端中间件（挂到独立端口，路径 /s/） */
export function siteHostApp() {
  const app = express();
  app.disable('x-powered-by');

  /* PHP 需要「原始请求体」自己解析 $_POST / php://input。
   * 不可以用 express.urlencoded —— 那会把 body 变成对象，PHP 就看不到原始字节了。
   * 2MB 上限与 php.ini 的 post_max_size=3M 相互配合（网关先兜一层）。
   */
  app.use(express.raw({ type: () => true, limit: '2mb' }));
  app.use(securityHeaders);

  /* 站点解析与文件投递：单入口，自己从 originalUrl 里解析路径。
   *
   * 为什么不用 app.use('/:slug/*')：Express 的 use 挂载会把匹配到的
   * 路径段从 req.url 里剥掉，`/:slug/*` 连通配部分一起剥，req.path 就只剩 '/'，
   * 结果任何文件的请求都会退化成「根目录 → 找 index」——表现为所有 URL 都返回
   * 首页（.php 不执行、.runtime 可访问、穿越探测也 200）。改成自己解析最可控。
   */
  app.use((req, res, next) => {
    const raw = String(req.originalUrl || req.url || '');
    const qIdx = raw.indexOf('?');
    const rawPath = qIdx === -1 ? raw : raw.slice(0, qIdx);
    const rawQuery = qIdx === -1 ? '' : raw.slice(qIdx);

    let pathname;
    try {
      // 只解码一次：解码后才会暴露 %2e%2e / %00，随后由 safeResolve 统一拒绝
      pathname = decodeURIComponent(rawPath);
    } catch {
      return res.status(400).type('text/plain; charset=utf-8').send('非法 URL 编码');
    }

    // 去掉挂载前缀 /s（直接挂在 / 时不存在这一段，正则兼容两种情况）
    const rest = pathname.replace(/^\/s(?=\/|$)/, '');
    const m = rest.match(/^\/([A-Za-z0-9-]+)(\/[\s\S]*)?$/);
    if (!m) {
      return res.status(404).type('html').send(notFoundPage('404', '地址应以 /s/<站点标识>/ 开头。'));
    }

    const slug = m[1];
    const subPath = m[2] || '';          // '' 或 '/xxx/yyy'
    const site = get('SELECT * FROM sites WHERE slug = ? AND status = ?', [slug, 'running']);
    if (!site) {
      return res.status(404).type('html').send(notFoundPage('站点不存在或已停止', '请检查地址，或联系管理员。'));
    }

    req.site = site;
    req.siteRoot = siteRoot(site);

    // /s/<slug> → /s/<slug>/（保留查询串）
    if (subPath === '') {
      return res.redirect(301, `/s/${slug}/${rawQuery}`);
    }

    const target = safeResolve(req.siteRoot, subPath.replace(/^\/+/, ''));
    if (!target) return res.status(403).type('text/plain; charset=utf-8').send('Forbidden');

    const finish = (err) => {
      if (!err) return;
      console.error(`[site:${slug}] 处理失败:`, err.message);
      if (!res.headersSent) res.status(500).type('text/plain; charset=utf-8').send('处理请求失败');
    };

    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return res.status(404).type('html').send(notFoundPage('404', '文件不存在。'));
    }

    if (stat.isDirectory()) {
      // 目录且没有尾斜杠：先补斜杠，保证页面里的相对链接正确
      if (!pathname.endsWith('/')) return res.redirect(301, `/s/${slug}${subPath}/${rawQuery}`);
      for (const idx of ['index.php', 'index.html', 'index.htm']) {
        const idxPath = path.join(target, idx);
        try {
          if (fs.statSync(idxPath).isFile()) return serveSiteFile(req, res, idxPath).catch(finish);
        } catch { /* 继续找下一个候选 */ }
      }
      return sendDirListing(req, res, target);
    }
    return serveSiteFile(req, res, target).catch(finish);
  });

  /** 对一个具体文件：.php 走执行器，其它直接读 */
  async function serveSiteFile(req, res, filePath) {
    const site = req.site;
    const root = req.siteRoot;

    if (filePath.toLowerCase().endsWith('.php')) {
      if (site.type !== 'php') {
        return res.status(403).send('该站点未启用 PHP，无法执行 .php 文件');
      }
      // 找到该站点的 php-cgi
      const versions = await listPhpVersions();
      const v = versions.find((x) => x.id === site.php_version);
      if (!v) {
        return res.status(500).send(`服务器配置错误：找不到 PHP ${site.php_version}`);
      }
      try {
        /* 用原始 URL 里的查询串，不要用 req.query 重新序列化：
         * 重新序列化会丢掉「?keyword」这种无等号形式、丢失重复键与顺序，
         * 而 runPhp 内部正是靠查询串原样传递来避免 php-cgi 的「查询串当命令行」分支。
         */
        const rawQuery = String(req.originalUrl || '').split('?')[1] || '';
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const out = await runPhp({
          bin: v.bin,
          script: filePath,
          docRoot: root,
          cgi: {
            REQUEST_METHOD: req.method,
            QUERY_STRING: rawQuery,
            CONTENT_TYPE: req.headers['content-type'] || '',
            SCRIPT_NAME: '/' + path.basename(filePath),
            REQUEST_URI: req.originalUrl,
            HTTP_HOST: req.headers.host || '',
            HTTPS: req.secure ? 'on' : '',
            REMOTE_ADDR: req.ip || '',
            HTTP_USER_AGENT: req.headers['user-agent'] || '',
            HTTP_ACCEPT: req.headers.accept || '',
            HTTP_ACCEPT_LANGUAGE: req.headers['accept-language'] || '',
            HTTP_COOKIE: req.headers.cookie || '',
            HTTP_REFERER: req.headers.referer || '',
          },
          body: ['GET', 'HEAD'].includes(req.method) ? '' : rawBody,
        });

        // 把 PHP 输出的响应头尽量忠实转发（多值头用数组形式）
        for (const [k, val] of Object.entries(out.headers || {})) {
          const lower = k.toLowerCase();
          if (['status', 'content-length', 'transfer-encoding', 'connection'].includes(lower)) continue;
          if (lower === 'x-powered-by') continue;   // 不暴露 PHP 版本
          try { res.setHeader(k, val); } catch { /* 非法头忽略 */ }
        }
        res.status(out.status);
        // HEAD 只要头，不要体
        return req.method === 'HEAD' ? res.end() : res.send(out.body);
      } catch (err) {
        console.error(`[site:${site.slug}] PHP 执行失败:`, err.message);
        return res.status(500).send(`PHP 执行失败：${escapeHtml(err.message)}`);
      }
    }

    // 静态文件：交给 res.sendFile 流式投递（支持 Range/ETag/Last-Modified，
    // 大文件不会整体读进内存，比 readFileSync 更稳）
    const rel = path.relative(root, filePath).split(path.sep).join('/');
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', /\.(html?|js|css|json)$/i.test(rel)
      ? 'no-cache, must-revalidate'
      : 'public, max-age=3600');
    // 危险类型强制下载（与主系统 /uploads 同策略），避免站点里放的 exe 被浏览器直接执行
    if (DANGEROUS_EXT.includes(ext)) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`);
    }
    return res.sendFile(filePath, { dotfiles: 'deny' }, (err) => {
      if (!err || res.headersSent) return;
      const code = err.code === 'ENOENT' ? 404 : (err.status || 500);
      res.status(code).send(code === 404 ? '文件不存在' : '读取文件失败');
    });
  }

  /** 简单目录列表（无 index 时） */
  function sendDirListing(req, res, dir) {
    const site = req.site;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { /* ignore */ }
    const items = entries
      .map((e) => {
        const href = (req.path.endsWith('/') ? req.path : req.path + '/') + encodeURIComponent(e.name) + (e.isDirectory() ? '/' : '');
        const icon = e.isDirectory() ? '📁' : '📄';
        return `<tr><td><a href="${href}">${icon} ${escapeHtml(e.name)}</a></td></tr>`;
      })
      .join('');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(site.name)}</title><style>body{font-family:system-ui;padding:40px;color:#334155}table{border-collapse:collapse}td{padding:6px 14px;border-bottom:1px solid #e2e8f0}a{color:#2563eb;text-decoration:none}</style></head><body><h2>${escapeHtml(site.name)}</h2><table>${items || '<tr><td>（空目录）</td></tr>'}</table></body></html>`);
  }

  return app;
}

/* ---------------- 工具 ---------------- */

/** 路径解析：结果必须仍在 root 内，且拒绝隐藏文件与点开头路径 */
function safeResolve(root, rel) {
  const clean = String(rel || '').replace(/^\/+/, '');
  if (clean.includes('\0') || clean.includes('..')) return null;
  // 编码后的穿越尝试（%2e%2e / %00）也一并拒绝
  if (/%2e|%00|%5c/i.test(clean)) return null;
  // 任何以点开头的路径段都不对外暴露：.git / .env / .runtime（PHP 会话与日志都在这里）
  // 例外：.well-known 是 Let's Encrypt 等标准约定的公开目录
  const segs = clean.split('/').filter(Boolean);
  for (const s of segs) {
    if (s.startsWith('.') && s !== '.well-known') return null;
  }
  const target = path.resolve(root, clean);
  const rootRes = path.resolve(root);
  if (!target.toLowerCase().startsWith(rootRes.toLowerCase() + path.sep)
    && target.toLowerCase() !== rootRes.toLowerCase()) return null;
  return target;
}

/** 站点内允许访问但强制下载的扩展名 */
const DANGEROUS_EXT = ['.exe', '.dll', '.bat', '.cmd', '.ps1', '.sh', '.msi', '.jar', '.com', '.scr', '.vbs', '.reg'];

/** 站点侧的错误页（很轻，不依赖主系统的样式） */
function notFoundPage(title, message) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f8fafc;color:#64748b;
text-align:center;padding:72px 24px;margin:0}h2{color:#0f172a;font-size:20px;margin:0 0 10px}
p{font-size:14px;margin:0}</style></head>
<body><h2>${escapeHtml(title)}</h2><p>${message}</p></body></html>`;
}

const HTML_ESCAPES = {
  '&': '\u0026amp;',
  '<': '\u0026lt;',
  '>': '\u0026gt;',
  '"': '\u0026quot;',
  "'": '\u0026#39;',
};
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
