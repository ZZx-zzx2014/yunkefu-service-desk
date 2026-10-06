/**
 * 管理后台：坐席管理、部门、快捷话术、系统设置、操作日志、通知
 */
import { Router } from 'express';
import { run, get, all, tx, getSettings, setSetting, audit, DEFAULT_SETTINGS } from '../db.js';
import { hashPassword } from '../auth.js';
import { ok, fail, asyncHandler, requireAuth, requireRole } from '../middleware.js';
import { pagination, pagedResult, parseJSON, nowStr } from '../utils.js';
import { onlineAgents, notifyAgent } from '../realtime.js';

const router = Router();
const adminOnly = requireRole('admin');

/* ------------------------------ 通知 ------------------------------ */

router.get('/notifications', requireAuth, asyncHandler((req, res) => {
  const list = all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30', [req.user.id]);
  const unread = get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]).c;
  return ok(res, { list, unread });
}));

router.post('/notifications/read', requireAuth, asyncHandler((req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
  if (ids && ids.length) {
    run(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      [req.user.id, ...ids]);
  } else {
    run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
  }
  return ok(res, null, '已标记为已读');
}));

/* ------------------------------ 概览 ------------------------------ */

router.get('/overview', adminOnly, asyncHandler((_req, res) => {
  return ok(res, {
    users: {
      total: get('SELECT COUNT(*) AS c FROM users').c,
      admins: get("SELECT COUNT(*) AS c FROM users WHERE role='admin'").c,
      agents: get("SELECT COUNT(*) AS c FROM users WHERE role='agent'").c,
      customers: get("SELECT COUNT(*) AS c FROM users WHERE role='customer'").c,
      online: get("SELECT COUNT(*) AS c FROM users WHERE role='agent' AND status IN ('online','busy')").c,
      disabled: get('SELECT COUNT(*) AS c FROM users WHERE active = 0').c,
    },
    departments: get('SELECT COUNT(*) AS c FROM departments').c,
    conversations: get('SELECT COUNT(*) AS c FROM conversations').c,
    tickets: get('SELECT COUNT(*) AS c FROM tickets').c,
    articles: get('SELECT COUNT(*) AS c FROM kb_articles').c,
    quickReplies: get('SELECT COUNT(*) AS c FROM quick_replies').c,
    departmentStats: all(`
      SELECT d.id, d.name, d.description,
        (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.role='agent') AS agents,
        (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.status='online') AS online,
        (SELECT COUNT(*) FROM conversations c JOIN users u ON u.id = c.agent_id WHERE u.department_id = d.id) AS sessions,
        (SELECT COUNT(*) FROM tickets t WHERE t.department_id = d.id) AS tickets
      FROM departments d ORDER BY d.id`),
  });
}));

/* ------------------------------ 用户管理 ------------------------------ */

router.get('/users', adminOnly, asyncHandler((req, res) => {
  const { page, size, offset } = pagination(req.query, 20);
  const { role, keyword, status, department_id, active } = req.query;
  const where = [];
  const params = [];

  if (role) { where.push('u.role = ?'); params.push(role); }
  if (status) { where.push('u.status = ?'); params.push(status); }
  if (department_id) { where.push('u.department_id = ?'); params.push(Number(department_id)); }
  if (active !== undefined && active !== '') { where.push('u.active = ?'); params.push(Number(active)); }
  if (keyword) {
    where.push('(u.name LIKE ? OR u.username LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)');
    const like = `%${keyword}%`;
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = get(`SELECT COUNT(*) AS c FROM users u ${whereSql}`, params).c;
  const list = all(`
    SELECT u.id, u.username, u.name, u.role, u.email, u.phone, u.avatar, u.department_id, u.level,
           u.skills, u.max_concurrent, u.status, u.active, u.last_login_at, u.created_at,
           d.name AS department_name,
           (SELECT COUNT(*) FROM conversations c WHERE c.agent_id = u.id AND c.status='active') AS load,
           (SELECT COUNT(*) FROM conversations c WHERE c.agent_id = u.id) AS total_sessions,
           (SELECT COUNT(*) FROM tickets t WHERE t.assignee_id = u.id AND t.status NOT IN ('closed')) AS open_tickets
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    ${whereSql}
    ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END, u.id ASC
    LIMIT ? OFFSET ?`, [...params, size, offset]);

  return ok(res, pagedResult(list.map((u) => ({ ...u, skills: parseJSON(u.skills, []) })), total, page, size));
}));

router.post('/users', adminOnly, asyncHandler((req, res) => {
  const { username, password, name, role = 'agent', email = '', phone = '', department_id = null,
    level = '初级', skills = [], max_concurrent = 5 } = req.body || {};
  if (!username || !password || !name) return fail(res, '请填写账号、密码和姓名');
  if (!['admin', 'agent', 'customer'].includes(role)) return fail(res, '角色不正确');
  if (String(password).length < 6) return fail(res, '密码至少 6 位');
  if (get('SELECT id FROM users WHERE username = ?', [username])) return fail(res, '该账号已存在');

  const { hash, salt } = hashPassword(password);
  const r = run(
    `INSERT INTO users (username, password_hash, password_salt, name, role, email, phone, department_id, level, skills, max_concurrent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [username, hash, salt, name, role, email, phone, department_id ? Number(department_id) : null,
      level, JSON.stringify(skills || []), Number(max_concurrent) || 5]);
  audit(req.user, '新增账号', username, `${name} / ${role}`);
  return ok(res, get('SELECT id, username, name, role, status FROM users WHERE id = ?', [Number(r.lastInsertRowid)]), '账号已创建');
}));

router.put('/users/:id', adminOnly, asyncHandler((req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', [Number(req.params.id)]);
  if (!user) return fail(res, '账号不存在', 404);
  const { name, email, phone, role, department_id, level, skills, max_concurrent, status, active, password } = req.body || {};

  if (role && !['admin', 'agent', 'customer'].includes(role)) return fail(res, '角色不正确');
  if (user.role === 'admin' && active === 0 && get("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1").c <= 1) {
    return fail(res, '至少需要保留一个启用状态的管理员');
  }

  run(`
    UPDATE users SET
      name = COALESCE(?, name), email = COALESCE(?, email), phone = COALESCE(?, phone),
      role = COALESCE(?, role), department_id = ?, level = COALESCE(?, level),
      skills = COALESCE(?, skills), max_concurrent = COALESCE(?, max_concurrent),
      status = COALESCE(?, status), active = COALESCE(?, active)
    WHERE id = ?`,
    [name ?? null, email ?? null, phone ?? null, role ?? null,
      department_id === undefined ? user.department_id : (department_id ? Number(department_id) : null),
      level ?? null, skills === undefined ? null : JSON.stringify(skills),
      max_concurrent === undefined ? null : Number(max_concurrent),
      status ?? null, active === undefined ? null : Number(active), user.id]);

  if (password) {
    if (String(password).length < 6) return fail(res, '密码至少 6 位');
    const { hash, salt } = hashPassword(password);
    run('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', [hash, salt, user.id]);
  }
  audit(req.user, '更新账号', user.username, `${name || user.name}`);
  return ok(res, get('SELECT id, username, name, role, status, active FROM users WHERE id = ?', [user.id]), '账号已更新');
}));

router.delete('/users/:id', adminOnly, asyncHandler((req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', [Number(req.params.id)]);
  if (!user) return fail(res, '账号不存在', 404);
  if (user.id === req.user.id) return fail(res, '不能删除当前登录的账号');
  if (user.role === 'admin' && get("SELECT COUNT(*) AS c FROM users WHERE role='admin'").c <= 1) {
    return fail(res, '至少需要保留一个管理员账号');
  }
  try {
    run('DELETE FROM users WHERE id = ?', [user.id]);
  } catch {
    return fail(res, '该账号存在关联数据，无法删除，请改为停用');
  }
  audit(req.user, '删除账号', user.username, user.name);
  return ok(res, null, '账号已删除');
}));

router.post('/users/:id/toggle', adminOnly, asyncHandler((req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', [Number(req.params.id)]);
  if (!user) return fail(res, '账号不存在', 404);
  if (user.id === req.user.id) return fail(res, '不能停用当前登录的账号');
  const next = user.active ? 0 : 1;
  run('UPDATE users SET active = ?, status = ? WHERE id = ?', [next, next ? 'offline' : 'offline', user.id]);
  audit(req.user, next ? '启用账号' : '停用账号', user.username);
  return ok(res, { active: next }, next ? '账号已启用' : '账号已停用');
}));

/** POST /api/admin/users/:id/2fa/reset 重置某账号的双因素认证
 *  用途：用户丢失验证器且备份码用尽时的找回途径（仅管理员可操作）
 */
router.post('/users/:id/2fa/reset', adminOnly, asyncHandler((req, res) => {
  const user = get('SELECT id, username, name, totp_enabled FROM users WHERE id = ?', [Number(req.params.id)]);
  if (!user) return fail(res, '账号不存在', 404);

  run(`UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_confirmed_at = NULL,
        totp_last_step = NULL, backup_codes = '[]' WHERE id = ?`, [user.id]);

  audit(req.user, '重置 2FA', user.username, `原状态：${user.totp_enabled === 1 ? '已启用' : '未启用'}`);
  return ok(res, { userId: user.id, enabled: false }, `已重置「${user.name}」的双因素认证`);
}));

/* ------------------------------ 部门管理 ------------------------------ */

router.get('/departments', requireAuth, asyncHandler((_req, res) => {
  const list = all(`
    SELECT d.*,
      (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.role='agent') AS agent_count,
      (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.status='online') AS online_count
    FROM departments d ORDER BY d.id`);
  return ok(res, list);
}));

router.post('/departments', adminOnly, asyncHandler((req, res) => {
  const { name, description = '' } = req.body || {};
  if (!name) return fail(res, '请填写部门名称');
  if (get('SELECT id FROM departments WHERE name = ?', [name])) return fail(res, '该部门已存在');
  const r = run('INSERT INTO departments (name, description) VALUES (?,?)', [name, description]);
  audit(req.user, '新增部门', name);
  return ok(res, get('SELECT * FROM departments WHERE id = ?', [Number(r.lastInsertRowid)]), '部门已创建');
}));

router.put('/departments/:id', adminOnly, asyncHandler((req, res) => {
  const dept = get('SELECT * FROM departments WHERE id = ?', [Number(req.params.id)]);
  if (!dept) return fail(res, '部门不存在', 404);
  const { name, description } = req.body || {};
  run('UPDATE departments SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?',
    [name ?? null, description ?? null, dept.id]);
  return ok(res, get('SELECT * FROM departments WHERE id = ?', [dept.id]), '部门已更新');
}));

router.delete('/departments/:id', adminOnly, asyncHandler((req, res) => {
  const dept = get('SELECT * FROM departments WHERE id = ?', [Number(req.params.id)]);
  if (!dept) return fail(res, '部门不存在', 404);
  if (get('SELECT COUNT(*) AS c FROM users WHERE department_id = ?', [dept.id]).c > 0) {
    return fail(res, '该部门下仍有成员，请先调整成员归属');
  }
  run('DELETE FROM departments WHERE id = ?', [dept.id]);
  audit(req.user, '删除部门', dept.name);
  return ok(res, null, '部门已删除');
}));

/* ------------------------------ 快捷话术管理 ------------------------------ */

router.get('/quick-replies', requireAuth, asyncHandler((req, res) => {
  const { keyword, category, scope } = req.query;
  const where = [];
  const params = [];
  if (req.user.role !== 'admin') {
    where.push("(qr.scope = 'all' OR qr.owner_id = ? OR qr.department_id = ?)");
    params.push(req.user.id, req.user.department_id ?? -1);
  }
  if (scope) { where.push('qr.scope = ?'); params.push(scope); }
  if (category) { where.push('qr.category = ?'); params.push(category); }
  if (keyword) { where.push('(qr.title LIKE ? OR qr.content LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const list = all(`
    SELECT qr.*, u.name AS owner_name, d.name AS department_name
    FROM quick_replies qr
    LEFT JOIN users u ON u.id = qr.owner_id
    LEFT JOIN departments d ON d.id = qr.department_id
    ${whereSql} ORDER BY qr.is_favorite DESC, qr.favorite_at DESC, qr.use_count DESC, qr.id DESC`, params);
  const categories = all('SELECT DISTINCT category FROM quick_replies ORDER BY category').map((r) => r.category);
  return ok(res, { list, categories });
}));

/** POST /api/admin/quick-replies/:id/favorite 设为 / 取消常用 */
router.post('/quick-replies/:id/favorite', requireAuth, asyncHandler((req, res) => {
  const qr = get('SELECT * FROM quick_replies WHERE id = ?', [Number(req.params.id)]);
  if (!qr) return fail(res, '话术不存在', 404);
  if (req.user.role !== 'admin' && qr.owner_id !== req.user.id) return fail(res, '没有权限操作该话术', 403);
  const next = req.body && 'favorite' in req.body
    ? (req.body.favorite ? 1 : 0)
    : (qr.is_favorite ? 0 : 1);
  run('UPDATE quick_replies SET is_favorite = ?, favorite_at = ? WHERE id = ?',
    [next, next ? nowStr() : null, qr.id]);
  return ok(res, get('SELECT * FROM quick_replies WHERE id = ?', [qr.id]),
    next ? '已设为常用（将置顶）' : '已取消常用');
}));

router.post('/quick-replies', requireAuth, asyncHandler((req, res) => {
  const { title, content, category = '通用', scope = 'all', department_id = null, is_favorite = 0 } = req.body || {};
  if (!title || !content) return fail(res, '请填写话术标题和内容');
  const finalScope = req.user.role === 'admin' ? scope : 'personal';
  const fav = is_favorite ? 1 : 0;
  const r = run('INSERT INTO quick_replies (title, content, category, scope, owner_id, department_id, is_favorite, favorite_at) VALUES (?,?,?,?,?,?,?,?)',
    [title, content, category, finalScope, req.user.id,
      finalScope === 'department' ? (department_id ? Number(department_id) : req.user.department_id) : null,
      fav, fav ? nowStr() : null]);
  audit(req.user, '新增快捷话术', title);
  return ok(res, get('SELECT * FROM quick_replies WHERE id = ?', [Number(r.lastInsertRowid)]), '话术已保存');
}));

router.put('/quick-replies/:id', requireAuth, asyncHandler((req, res) => {
  const qr = get('SELECT * FROM quick_replies WHERE id = ?', [Number(req.params.id)]);
  if (!qr) return fail(res, '话术不存在', 404);
  if (req.user.role !== 'admin' && qr.owner_id !== req.user.id && qr.scope !== 'all') return fail(res, '没有权限修改该话术', 403);
  if (req.user.role !== 'admin' && qr.scope === 'all') return fail(res, '公共话术仅管理员可修改', 403);
  const { title, content, category, scope, department_id, is_favorite } = req.body || {};
  const fav = is_favorite === undefined ? qr.is_favorite : (is_favorite ? 1 : 0);
  run(`UPDATE quick_replies SET title = COALESCE(?, title), content = COALESCE(?, content),
        category = COALESCE(?, category), scope = COALESCE(?, scope), department_id = ?,
        is_favorite = ?, favorite_at = ? WHERE id = ?`,
    [title ?? null, content ?? null, category ?? null, scope ?? null,
      department_id === undefined ? qr.department_id : (department_id ? Number(department_id) : null),
      fav, fav ? (qr.favorite_at || nowStr()) : null, qr.id]);
  return ok(res, get('SELECT * FROM quick_replies WHERE id = ?', [qr.id]), '话术已更新');
}));

router.delete('/quick-replies/:id', requireAuth, asyncHandler((req, res) => {
  const qr = get('SELECT * FROM quick_replies WHERE id = ?', [Number(req.params.id)]);
  if (!qr) return fail(res, '话术不存在', 404);
  if (req.user.role !== 'admin' && qr.owner_id !== req.user.id) return fail(res, '没有权限删除该话术', 403);
  run('DELETE FROM quick_replies WHERE id = ?', [qr.id]);
  return ok(res, null, '话术已删除');
}));

/* ------------------------------ 系统设置 ------------------------------ */

router.get('/settings', adminOnly, asyncHandler((_req, res) => {
  return ok(res, { settings: getSettings(), defaults: DEFAULT_SETTINGS });
}));

router.put('/settings', adminOnly, asyncHandler((req, res) => {
  const body = req.body || {};
  const changed = [];
  tx(() => {
    for (const [key, value] of Object.entries(body)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      setSetting(key, value);
      changed.push(key);
    }
  });
  audit(req.user, '更新系统设置', changed.join(','), '');
  return ok(res, getSettings(), `已保存 ${changed.length} 项设置`);
}));

/* ------------------------------ 操作日志 ------------------------------ */

router.get('/audit-logs', adminOnly, asyncHandler((req, res) => {
  const { page, size, offset } = pagination(req.query, 30);
  const { keyword, action, userId } = req.query;
  const where = [];
  const params = [];
  if (action) { where.push('action = ?'); params.push(action); }
  if (userId) { where.push('user_id = ?'); params.push(Number(userId)); }
  if (keyword) {
    where.push('(user_name LIKE ? OR action LIKE ? OR target LIKE ? OR detail LIKE ?)');
    const like = `%${keyword}%`;
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`, params).c;
  const list = all(`SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, size, offset]);
  return ok(res, pagedResult(list, total, page, size));
}));

/* ------------------------------ 通知坐席（管理员广播） ------------------------------ */

router.post('/broadcast', adminOnly, asyncHandler((req, res) => {
  const { title, body = '', type = 'info', target = 'all' } = req.body || {};
  if (!title) return fail(res, '请填写通知标题');
  const agents = all("SELECT id FROM users WHERE role IN ('agent','admin') AND active = 1");
  const online = onlineAgents();
  let count = 0;
  for (const a of agents) {
    if (target === 'online' && !online.includes(a.id)) continue;
    notifyAgent(a.id, { title, body, type });
    count++;
  }
  audit(req.user, '发送全员通知', title, `覆盖 ${count} 人`);
  return ok(res, { count }, `通知已发送给 ${count} 人`);
}));

export default router;
