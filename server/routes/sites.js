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

/** 构造访问端中间件（挂到主 app，路径 /s/） */
export function siteHostApp() {
  const app = express();

  // 站点解析：/s/<slug> 与 /s/<slug>/* 都命中（前者随后被重定向到带斜杠形式）
  app.use('/:slug', (req, res, next) => {
    const slug = req.params.slug;
    const site = get('SELECT * FROM sites WHERE slug = ? AND status = ?', [slug, 'running']);
    if (!site) {
      return res.status(404).send(`<!DOCTYPE html><meta charset="UTF-8"><title>404</title><body style="font-family:system-ui;text-align:center;padding:60px;color:#64748b"><h2 style="color:#0f172a">站点不存在或已停止</h2><p>请检查地址，或联系管理员。</p></body>`);
    }
    req.site = site;
    req.siteRoot = siteRoot(site);
    next();
  });

  // 无尾斜杠的 /s/<slug> → 301 到 /s/<slug>/（统一入口，命中下方通配）
  app.use('/:slug', (req, res, next) => {
    if (req.method !== 'GET' || req.path.split('/').length > 2) return next();
    return res.redirect(301, `${req.baseUrl}/${req.params.slug}/`);
  });

  // 静态/PHP 统一入口
  app.use('/:slug/*', (req, res, next) => {
    const root = req.siteRoot;
    // 解码 URL 中的相对路径（Express 已解码 req.path）
    const rel = req.path.replace(/^\/[^/]+\//, '');   // 去掉 /<slug>/ 前缀
    const target = safeResolve(root, rel);

    if (!target) return res.status(403).send('Forbidden');

    // 目录访问：自动找 index
    let stat;
    try { stat = fs.statSync(target); } catch {
      return res.status(404).send(`<!DOCTYPE html><meta charset="UTF-8"><title>404</title><body style="font-family:system-ui;text-align:center;padding:60px;color:#64748b"><h2 style="color:#0f172a">404</h2><p>文件不存在。</p></body>`);
    }

    // serveSiteFile 是 async：捕获其异常，防止未处理 rejection
    const finish = (err) => {
      if (err && !res.headersSent) {
        console.error(`[site:${req.site?.slug}] 处理失败:`, err.message);
        return res.status(500).send('处理请求失败');
      }
      if (err) console.error(`[site:${req.site?.slug}] 处理失败:`, err.message);
    };

    if (stat.isDirectory()) {
      for (const idx of ['index.php', 'index.html', 'index.htm']) {
        const idxPath = path.join(target, idx);
        try {
          fs.accessSync(idxPath, fs.constants.R_OK);
          return serveSiteFile(req, res, idxPath).catch(finish);
        } catch { /* 继续找 */ }
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
        const out = await runPhp({
          bin: v.bin,
          script: filePath,
          docRoot: root,
          cgi: {
            REQUEST_METHOD: req.method,
            QUERY_STRING: req.query ? new URLSearchParams(req.query).toString() : '',
            CONTENT_TYPE: req.headers['content-type'] || '',
            REQUEST_URI: req.url,
            PATH_INFO: '',
            HTTP_HOST: req.headers.host || '',
            HTTPS: req.secure ? 'on' : '',
            REMOTE_ADDR: req.ip || '',
            HTTP_USER_AGENT: req.headers['user-agent'] || '',
            HTTP_ACCEPT: req.headers.accept || '',
          },
          body: ['GET', 'HEAD'].includes(req.method) ? '' : JSON.stringify(req.body || {}),
        });
        if (out.headers.location) res.setHeader('Location', out.headers.location);
        if (out.headers['content-type']) res.setHeader('Content-Type', out.headers['content-type']);
        if (out.headers['set-cookie']) res.setHeader('Set-Cookie', out.headers['set-cookie']);
        return res.status(out.status).send(out.body);
      } catch (err) {
        console.error(`[site:${site.slug}] PHP 执行失败:`, err.message);
        return res.status(500).send(`PHP 执行失败：${escapeHtml(err.message)}`);
      }
    }

    // 静态文件：用 fs.createReadStream 直接投递（简单、可靠，保留协商能力）
    // —— 不再复用 express.static（它对 req.url 的重写要求与挂载路径耦合，容易踩坑）
    let data;
    try {
      data = fs.readFileSync(filePath);
    } catch {
      return res.status(500).send('读取文件失败');
    }
    const rel = path.relative(root, filePath);
    const ext = path.extname(filePath).toLowerCase();
    const MIME = {
      '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
      '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2',
      '.mp4': 'video/mp4', '.webm': 'video/webm',
    };
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', /\.(html?|js|css)$/i.test(rel) ? 'no-cache, must-revalidate' : 'public, max-age=3600');
    // 危险类型强制下载（与主系统 /uploads 同策略）
    if (['.exe', '.dll', '.bat', '.cmd', '.sh', '.msi', '.jar'].includes(ext)) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`);
    }
    return res.send(data);
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

/** 路径解析：结果必须仍在 root 内，且拒绝隐藏文件与点开头文件 */
function safeResolve(root, rel) {
  const clean = String(rel || '').replace(/^\/+/, '');
  if (clean.includes('\0') || clean.includes('..')) return null;
  if (/(^|\/)\.git(\/|$)/i.test(clean)) return null; // 不暴露 .git
  const target = path.resolve(root, clean);
  const rootRes = path.resolve(root);
  if (!target.toLowerCase().startsWith(rootRes.toLowerCase() + path.sep)
    && target.toLowerCase() !== rootRes.toLowerCase()) return null;
  return target;
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
