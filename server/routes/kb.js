/**
 * 知识库 / 帮助中心：分类、文章、搜索、统计、有用性投票
 */
import { Router } from 'express';
import { run, get, all, getSetting, audit } from '../db.js';
import { ok, fail, asyncHandler, requireAuth, requireRole } from '../middleware.js';
import { pagination, pagedResult, nowStr, parseJSON } from '../utils.js';
import { emitKbUpdate } from '../realtime.js';

const router = Router();

/* ------------------------------ 分类 ------------------------------ */

router.get('/categories', asyncHandler((_req, res) => {
  const rows = all(`
    SELECT c.*, (SELECT COUNT(*) FROM kb_articles a WHERE a.category_id = c.id AND a.status = 'published' AND a.visibility = 'public') AS article_count
    FROM kb_categories c ORDER BY c.sort_order ASC, c.id ASC`);
  return ok(res, rows);
}));

router.post('/categories', requireRole('admin'), asyncHandler((req, res) => {
  const { name, icon = '📄', description = '', sort_order = 0 } = req.body || {};
  if (!name) return fail(res, '请填写分类名称');
  if (get('SELECT id FROM kb_categories WHERE name = ?', [name])) return fail(res, '该分类已存在');
  const r = run('INSERT INTO kb_categories (name, icon, description, sort_order) VALUES (?,?,?,?)',
    [name, icon, description, Number(sort_order) || 0]);
  const created = get('SELECT * FROM kb_categories WHERE id = ?', [Number(r.lastInsertRowid)]);
  emitKbUpdate('category:created', { id: created.id, name: created.name });
  return ok(res, created, '分类已创建');
}));

router.put('/categories/:id', requireRole('admin'), asyncHandler((req, res) => {
  const { name, icon, description, sort_order } = req.body || {};
  const cat = get('SELECT * FROM kb_categories WHERE id = ?', [Number(req.params.id)]);
  if (!cat) return fail(res, '分类不存在', 404);
  run('UPDATE kb_categories SET name = COALESCE(?, name), icon = COALESCE(?, icon), description = COALESCE(?, description), sort_order = COALESCE(?, sort_order) WHERE id = ?',
    [name ?? null, icon ?? null, description ?? null, sort_order ?? null, cat.id]);
  emitKbUpdate('category:updated', { id: cat.id, name: name || cat.name });
  return ok(res, get('SELECT * FROM kb_categories WHERE id = ?', [cat.id]), '分类已更新');
}));

router.delete('/categories/:id', requireRole('admin'), asyncHandler((req, res) => {
  const cat = get('SELECT * FROM kb_categories WHERE id = ?', [Number(req.params.id)]);
  if (!cat) return fail(res, '分类不存在', 404);
  if (get('SELECT COUNT(*) AS c FROM kb_articles WHERE category_id = ?', [cat.id]).c > 0) {
    return fail(res, '该分类下仍有文章，请先移动或删除文章');
  }
  run('DELETE FROM kb_categories WHERE id = ?', [cat.id]);
  audit(req.user, '删除知识库分类', cat.name);
  emitKbUpdate('category:deleted', { id: cat.id, name: cat.name });
  return ok(res, null, '分类已删除');
}));

/* ------------------------------ 文章列表 ------------------------------ */

router.get('/articles', asyncHandler((req, res) => {
  const { page, size, offset } = pagination(req.query, 20);
  const { category_id, keyword, status, visibility, category, tag, sort } = req.query;

  const where = [];
  const params = [];

  const isStaff = req.user && req.user.role !== 'customer';
  if (!isStaff) {
    where.push("a.status = 'published' AND a.visibility = 'public'");
  } else {
    if (status) { where.push('a.status = ?'); params.push(status); }
    if (visibility) { where.push('a.visibility = ?'); params.push(visibility); }
  }
  if (category_id) { where.push('a.category_id = ?'); params.push(Number(category_id)); }
  if (category) { where.push('c.name = ?'); params.push(category); }
  if (keyword) {
    where.push('(a.title LIKE ? OR a.summary LIKE ? OR a.content LIKE ? OR a.tags LIKE ?)');
    const like = `%${keyword}%`;
    params.push(like, like, like, like);
  }
  if (tag) { where.push('a.tags LIKE ?'); params.push(`%${tag}%`); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const baseSql = `FROM kb_articles a LEFT JOIN kb_categories c ON c.id = a.category_id LEFT JOIN users u ON u.id = a.author_id ${whereSql}`;

  const total = get(`SELECT COUNT(*) AS c ${baseSql}`, params).c;
  const orderBy = sort === 'hot' ? 'a.views DESC' : sort === 'helpful' ? 'a.helpful DESC' : 'a.updated_at DESC';
  const list = all(`
    SELECT a.id, a.category_id, a.title, a.summary, a.tags, a.status, a.visibility, a.views, a.helpful, a.not_helpful,
           a.created_at, a.updated_at, c.name AS category_name, c.icon AS category_icon, u.name AS author_name,
           substr(a.content, 1, 160) AS excerpt
    ${baseSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, size, offset]);

  return ok(res, pagedResult(list.map((a) => ({ ...a, tags: parseJSON(a.tags, []) })), total, page, size));
}));

/* ------------------------------ 热门 / 推荐 ------------------------------ */

router.get('/popular', asyncHandler((_req, res) => {
  const list = all(`
    SELECT a.id, a.title, a.views, a.helpful, c.name AS category_name, c.icon AS category_icon
    FROM kb_articles a LEFT JOIN kb_categories c ON c.id = a.category_id
    WHERE a.status = 'published' AND a.visibility = 'public'
    ORDER BY a.views DESC LIMIT 6`);
  return ok(res, list);
}));

/* ------------------------------ 文章详情 ------------------------------ */

router.get('/articles/:id', asyncHandler((req, res) => {
  const article = get(`
    SELECT a.*, c.name AS category_name, c.icon AS category_icon, u.name AS author_name
    FROM kb_articles a
    LEFT JOIN kb_categories c ON c.id = a.category_id
    LEFT JOIN users u ON u.id = a.author_id
    WHERE a.id = ?`, [Number(req.params.id)]);
  if (!article) return fail(res, '文章不存在', 404);

  const isStaff = req.user && req.user.role !== 'customer';
  if (!isStaff && (article.status !== 'published' || article.visibility !== 'public')) {
    return fail(res, '文章不存在或未公开', 404);
  }

  run('UPDATE kb_articles SET views = views + 1 WHERE id = ?', [article.id]);
  article.views += 1;
  article.tags = parseJSON(article.tags, []);

  const related = all(`
    SELECT id, title, views FROM kb_articles
    WHERE category_id = ? AND id != ? AND status = 'published' AND visibility = 'public'
    ORDER BY views DESC LIMIT 5`, [article.category_id ?? -1, article.id]);

  const prev = get('SELECT id, title FROM kb_articles WHERE id < ? AND status=\'published\' AND visibility=\'public\' ORDER BY id DESC LIMIT 1', [article.id]);
  const next = get('SELECT id, title FROM kb_articles WHERE id > ? AND status=\'published\' AND visibility=\'public\' ORDER BY id ASC LIMIT 1', [article.id]);

  return ok(res, { article, related, prev, next });
}));

/* ------------------------------ 写操作 ------------------------------ */

router.post('/articles', requireRole('admin', 'agent'), asyncHandler((req, res) => {
  const { category_id, title, summary = '', content = '', tags = [], status = 'published', visibility = 'public' } = req.body || {};
  if (!title || !String(title).trim()) return fail(res, '请填写文章标题');
  if (!content || !String(content).trim()) return fail(res, '请填写文章内容');
  if (!['draft', 'published', 'archived'].includes(status)) return fail(res, '文章状态不正确');
  if (!['public', 'internal'].includes(visibility)) return fail(res, '可见范围不正确');

  const r = run(
    `INSERT INTO kb_articles (category_id, title, summary, content, tags, status, visibility, author_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [category_id ? Number(category_id) : null, String(title).trim(),
      summary || String(content).replace(/[#>*`\-\n]/g, ' ').trim().slice(0, 80),
      content, JSON.stringify(tags || []), status, visibility, req.user.id]);
  audit(req.user, '新增知识库文章', title, `分类 #${category_id ?? '-'}`);
  emitKbUpdate('article:created', { id: Number(r.lastInsertRowid), title: String(title).trim() });
  return ok(res, get('SELECT * FROM kb_articles WHERE id = ?', [Number(r.lastInsertRowid)]), '文章已发布');
}));

router.put('/articles/:id', requireRole('admin', 'agent'), asyncHandler((req, res) => {
  const article = get('SELECT * FROM kb_articles WHERE id = ?', [Number(req.params.id)]);
  if (!article) return fail(res, '文章不存在', 404);
  const { category_id, title, summary, content, tags, status, visibility } = req.body || {};
  run(`
    UPDATE kb_articles SET
      category_id = ?, title = COALESCE(?, title), summary = COALESCE(?, summary),
      content = COALESCE(?, content), tags = COALESCE(?, tags), status = COALESCE(?, status),
      visibility = COALESCE(?, visibility), updated_at = datetime('now','localtime')
    WHERE id = ?`,
    [category_id === undefined ? article.category_id : (category_id ? Number(category_id) : null),
      title ?? null, summary ?? null, content ?? null,
      tags === undefined ? null : JSON.stringify(tags), status ?? null, visibility ?? null, article.id]);
  audit(req.user, '更新知识库文章', title || article.title);
  emitKbUpdate('article:updated', { id: article.id, title: title || article.title });
  return ok(res, get('SELECT * FROM kb_articles WHERE id = ?', [article.id]), '文章已更新');
}));

router.delete('/articles/:id', requireRole('admin'), asyncHandler((req, res) => {
  const article = get('SELECT * FROM kb_articles WHERE id = ?', [Number(req.params.id)]);
  if (!article) return fail(res, '文章不存在', 404);
  run('DELETE FROM kb_articles WHERE id = ?', [article.id]);
  audit(req.user, '删除知识库文章', article.title);
  emitKbUpdate('article:deleted', { id: article.id, title: article.title });
  return ok(res, null, '文章已删除');
}));

/** POST /api/kb/articles/:id/feedback 有用 / 没用 */
router.post('/articles/:id/feedback', asyncHandler((req, res) => {
  const article = get('SELECT * FROM kb_articles WHERE id = ?', [Number(req.params.id)]);
  if (!article) return fail(res, '文章不存在', 404);
  const helpful = req.body?.helpful === true || req.body?.helpful === 1 || req.body?.helpful === '1';
  run(`UPDATE kb_articles SET ${helpful ? 'helpful = helpful + 1' : 'not_helpful = not_helpful + 1'} WHERE id = ?`, [article.id]);
  return ok(res, null, helpful ? '感谢您的反馈' : '我们会继续完善这篇文章');
}));

/** GET /api/kb/stats 知识库统计（后台） */
router.get('/stats', requireRole('admin', 'agent'), asyncHandler((_req, res) => {
  return ok(res, {
    total: get('SELECT COUNT(*) AS c FROM kb_articles').c,
    published: get("SELECT COUNT(*) AS c FROM kb_articles WHERE status='published'").c,
    draft: get("SELECT COUNT(*) AS c FROM kb_articles WHERE status='draft'").c,
    internal: get("SELECT COUNT(*) AS c FROM kb_articles WHERE visibility='internal'").c,
    totalViews: get('SELECT COALESCE(SUM(views),0) AS c FROM kb_articles').c,
    totalHelpful: get('SELECT COALESCE(SUM(helpful),0) AS c FROM kb_articles').c,
    categories: get('SELECT COUNT(*) AS c FROM kb_categories').c,
    topArticles: all(`SELECT id, title, views, helpful, not_helpful FROM kb_articles ORDER BY views DESC LIMIT 8`),
    categoriesStat: all(`
      SELECT c.name, c.icon, COUNT(a.id) AS count, COALESCE(SUM(a.views),0) AS views
      FROM kb_categories c LEFT JOIN kb_articles a ON a.category_id = c.id
      GROUP BY c.id ORDER BY c.sort_order`),
  });
}));

/** GET /api/kb/suggest 智能推荐（会话中坐席侧边推荐） */
router.get('/suggest', requireAuth, asyncHandler((req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return ok(res, []);
  const like = `%${q}%`;
  const list = all(`
    SELECT id, title, summary, substr(content,1,120) AS excerpt, views
    FROM kb_articles
    WHERE status='published' AND (title LIKE ? OR summary LIKE ? OR content LIKE ? OR tags LIKE ?)
    ORDER BY (CASE WHEN title LIKE ? THEN 0 ELSE 1 END), helpful DESC, views DESC
    LIMIT 5`, [like, like, like, like, like]);
  return ok(res, list);
}));

export default router;
