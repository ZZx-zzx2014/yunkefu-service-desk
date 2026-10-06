/**
 * 在线会话接口：会话列表、创建、消息、转接、结束、评价、快捷话术、上传
 */
import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { run, get, all, getSetting, audit } from '../db.js';
import { ok, fail, asyncHandler, requireAuth } from '../middleware.js';
import { nextCode, pagination, pagedResult, nowStr, parseJSON } from '../utils.js';
import { UPLOAD_DIR } from '../config.js';
import { validateUpload, buildSafeFilename } from '../upload-security.js';
import {
  emitMessage, emitConversationUpdate, emitConversationNew, assignAgent, closeConversation,
  autoAssignAll, isUserOnline, onlineAgents, activeCount,
} from '../realtime.js';

const router = Router();

/* ------------------------------ 文件上传 ------------------------------ */

/**
 * 安全上传流程：
 *   1. 先收到内存（不落盘），限制单文件 10MB、单次 1 个文件
 *   2. 白名单 + 魔数校验（见 upload-security.js）
 *   3. 落盘文件名与扩展名完全由服务端生成，不采用用户提供的扩展名
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 },
});

router.post('/upload', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) return fail(res, '未接收到文件');

  const verdict = validateUpload({
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    buffer: req.file.buffer,
  });

  if (!verdict.ok) {
    audit(req.user, '上传被拒绝', verdict.displayName || req.file.originalname || '-', verdict.reason);
    return fail(res, verdict.reason, 400);
  }

  const filename = buildSafeFilename(verdict.ext);
  const target = path.join(UPLOAD_DIR, filename);
  await fs.promises.writeFile(target, req.file.buffer);

  audit(req.user, '上传文件', filename, `${verdict.mime} / ${req.file.size} 字节 / 原名 ${verdict.displayName}`);

  return ok(res, {
    url: `/uploads/${filename}`,
    name: verdict.displayName,
    size: req.file.size,
    mime: verdict.mime,
    type: verdict.inline ? 'image' : 'file',
  }, '上传成功');
}));

/* ------------------------------ 会话列表 ------------------------------ */

/**
 * GET /api/conversations
 * 客户：自己的会话；坐席：接待中 / 排队中 / 全部；管理员：全部
 */
router.get('/', requireAuth, asyncHandler((req, res) => {
  const { page, size, offset } = pagination(req.query, 20);
  const { status, keyword, scope, agentId, channel, dateFrom, dateTo } = req.query;

  const where = [];
  const params = [];

  if (req.user.role === 'customer') {
    where.push('c.customer_id = ?');
    params.push(req.user.id);
  } else if (scope === 'mine') {
    where.push('c.agent_id = ?');
    params.push(req.user.id);
  } else if (scope === 'queue') {
    where.push("c.agent_id IS NULL AND c.status = 'queued'");
  } else if (scope === 'active') {
    where.push("c.status = 'active'");
  } else if (scope === 'closed') {
    where.push("c.status = 'closed'");
  }

  if (status && ['queued', 'active', 'closed'].includes(status)) { where.push('c.status = ?'); params.push(status); }
  if (channel) { where.push('c.channel = ?'); params.push(channel); }
  if (agentId) { where.push('c.agent_id = ?'); params.push(Number(agentId)); }
  if (keyword) {
    where.push('(c.code LIKE ? OR c.subject LIKE ? OR cu.name LIKE ? OR cu.username LIKE ?)');
    const like = `%${keyword}%`;
    params.push(like, like, like, like);
  }
  if (dateFrom) { where.push('date(c.created_at) >= date(?)'); params.push(dateFrom); }
  if (dateTo) { where.push('date(c.created_at) <= date(?)'); params.push(dateTo); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const baseSql = `
    FROM conversations c
    JOIN users cu ON cu.id = c.customer_id
    LEFT JOIN users ag ON ag.id = c.agent_id
    ${whereSql}`;

  const total = get(`SELECT COUNT(*) AS c ${baseSql}`, params).c;
  const list = all(`
    SELECT c.*, cu.name AS customer_name, cu.username AS customer_username, cu.avatar AS customer_avatar,
           cu.phone AS customer_phone, cu.email AS customer_email,
           ag.name AS agent_name, ag.avatar AS agent_avatar,
           (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
           (SELECT sender_role FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender_role,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    ${baseSql}
    ORDER BY CASE c.status WHEN 'queued' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
             c.last_message_at DESC
    LIMIT ? OFFSET ?`, [...params, size, offset]);

  return ok(res, pagedResult(list, total, page, size));
}));

/** GET /api/conversations/stats 工作台概览统计 */
router.get('/stats', requireAuth, asyncHandler((req, res) => {
  const mine = req.user.role === 'agent' || req.user.role === 'admin';
  const data = {
    queue: get("SELECT COUNT(*) AS c FROM conversations WHERE status='queued' AND agent_id IS NULL").c,
    active: get("SELECT COUNT(*) AS c FROM conversations WHERE status='active'").c,
    closedToday: get("SELECT COUNT(*) AS c FROM conversations WHERE status='closed' AND date(closed_at)=date('now','localtime')").c,
    onlineAgents: onlineAgents().length,
    totalAgents: get("SELECT COUNT(*) AS c FROM users WHERE role='agent' AND active=1").c,
    myActive: mine ? activeCount(req.user.id) : 0,
    myMax: req.user.max_concurrent || 5,
    todayTotal: get("SELECT COUNT(*) AS c FROM conversations WHERE date(created_at)=date('now','localtime')").c,
    avgRating: Number((get("SELECT ROUND(AVG(rating),2) AS c FROM conversations WHERE rating IS NOT NULL AND date(created_at) >= date('now','localtime','-30 day')")?.c || 0)),
  };
  if (req.user.role === 'customer') {
    data.myOpen = get("SELECT COUNT(*) AS c FROM conversations WHERE customer_id=? AND status != 'closed'", [req.user.id]).c;
  }
  return ok(res, data);
}));

/** GET /api/conversations/files 会话文件库：当前会话收发过的图片与附件 */
router.get('/:id/files', requireAuth, asyncHandler((req, res) => {
  const conv = get('SELECT * FROM conversations WHERE id = ?', [Number(req.params.id)]);
  if (!conv) return fail(res, '会话不存在', 404);
  if (req.user.role === 'customer' && conv.customer_id !== req.user.id) return fail(res, '无权访问该会话', 403);

  const rows = all(`
    SELECT id, sender_role, sender_name, type, content, meta, created_at
    FROM messages
    WHERE conversation_id = ? AND type IN ('image', 'file')
    ORDER BY id DESC`, [conv.id]);

  // 合并重复文件（同一 URL 只保留最新一次），并统计出现次数
  const seen = new Map();
  for (const r of rows) {
    const meta = parseJSON(r.meta, {}) || {};
    if (!seen.has(r.content)) {
      seen.set(r.content, {
        url: r.content,
        type: r.type,
        name: meta.name || r.content.split('/').pop(),
        size: meta.size || 0,
        mime: meta.mime || '',
        sender_role: r.sender_role,
        sender_name: r.sender_name,
        created_at: r.created_at,
        message_id: r.id,
        times: 1,
      });
    } else {
      seen.get(r.content).times += 1;
    }
  }
  const list = [...seen.values()];
  return ok(res, {
    list,
    total: list.length,
    fromCustomer: list.filter((f) => f.sender_role === 'customer').length,
    fromAgent: list.filter((f) => f.sender_role === 'agent').length,
    images: list.filter((f) => f.type === 'image').length,
    files: list.filter((f) => f.type === 'file').length,
  });
}));

/* ------------------------------ 快捷话术 ------------------------------ */

/**
 * GET /api/conversations/quick-replies/list
 *
 * 始终返回「数组」（保持与早期版本一致的契约，避免已缓存的前端代码
 * 对返回值调用 .slice() / .map() 时报错）。
 * 常用话术通过每项的 is_favorite 字段表达，并已排序置顶。
 */
router.get('/quick-replies/list', requireAuth, asyncHandler((req, res) => {
  const rows = all(`
    SELECT * FROM quick_replies
    WHERE scope = 'all' OR owner_id = ? OR department_id = ?
    ORDER BY is_favorite DESC, favorite_at DESC, use_count DESC, id ASC`,
    [req.user.id, req.user.department_id ?? -1]);
  return ok(res, rows);
}));

router.post('/quick-replies/:id/use', requireAuth, asyncHandler((req, res) => {
  run('UPDATE quick_replies SET use_count = use_count + 1 WHERE id = ?', [Number(req.params.id)]);
  return ok(res, null, 'ok');
}));

/** POST /api/conversations/quick-replies/:id/favorite 收藏 / 取消收藏（置顶） */
router.post('/quick-replies/:id/favorite', requireAuth, asyncHandler((req, res) => {
  const qr = get('SELECT * FROM quick_replies WHERE id = ?', [Number(req.params.id)]);
  if (!qr) return fail(res, '话术不存在', 404);
  if (qr.scope !== 'all' && qr.owner_id !== req.user.id && qr.department_id !== req.user.department_id) {
    return fail(res, '没有权限操作该话术', 403);
  }
  const next = req.body && 'favorite' in req.body
    ? (req.body.favorite ? 1 : 0)
    : (qr.is_favorite ? 0 : 1);
  run('UPDATE quick_replies SET is_favorite = ?, favorite_at = ? WHERE id = ?',
    [next, next ? nowStr() : null, qr.id]);
  return ok(res, get('SELECT * FROM quick_replies WHERE id = ?', [qr.id]),
    next ? '已加入常用，将置顶显示' : '已取消常用');
}));

/** GET /api/conversations/agents/online 可选坐席（转接用） */
router.get('/agents/online', requireAuth, asyncHandler((req, res) => {
  const rows = all(`
    SELECT u.id, u.name, u.status, u.level, u.skills, d.name AS department_name,
      (SELECT COUNT(*) FROM conversations c WHERE c.agent_id = u.id AND c.status='active') AS load,
      u.max_concurrent
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.role='agent' AND u.active = 1
    ORDER BY CASE u.status WHEN 'online' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END, load ASC`);
  return ok(res, rows.map((r) => ({ ...r, online: isUserOnline(r.id), skills: parseJSON(r.skills, []) })));
}));

/** GET /api/conversations/:id 会话详情 */
router.get('/:id', requireAuth, asyncHandler((req, res) => {
  const conv = get(`
    SELECT c.*, cu.name AS customer_name, cu.username AS customer_username,
           cu.phone AS customer_phone, cu.email AS customer_email, cu.avatar AS customer_avatar,
           ag.name AS agent_name, ag.avatar AS agent_avatar, ag.id AS agent_user_id,
           d.name AS department_name
    FROM conversations c
    JOIN users cu ON cu.id = c.customer_id
    LEFT JOIN users ag ON ag.id = c.agent_id
    LEFT JOIN departments d ON d.id = ag.department_id
    WHERE c.id = ?`, [Number(req.params.id)]);
  if (!conv) return fail(res, '会话不存在', 404);
  if (req.user.role === 'customer' && conv.customer_id !== req.user.id) return fail(res, '无权访问该会话', 403);

  // 客户查看时清除未读
  if (req.user.role === 'customer') {
    run('UPDATE conversations SET unread_customer = 0 WHERE id = ?', [conv.id]);
  } else {
    run('UPDATE conversations SET unread_agent = 0, unread_customer = unread_customer WHERE id = ?', [conv.id]);
  }

  const customerStats = {
    totalConversations: get('SELECT COUNT(*) AS c FROM conversations WHERE customer_id = ?', [conv.customer_id]).c,
    totalTickets: get('SELECT COUNT(*) AS c FROM tickets WHERE creator_id = ?', [conv.customer_id]).c,
    openTickets: get("SELECT COUNT(*) AS c FROM tickets WHERE creator_id = ? AND status NOT IN ('closed','resolved')", [conv.customer_id]).c,
    firstSeen: get('SELECT created_at FROM users WHERE id = ?', [conv.customer_id])?.created_at,
  };

  const history = all(`
    SELECT id, code, subject, status, rating, created_at FROM conversations
    WHERE customer_id = ? AND id != ? ORDER BY id DESC LIMIT 5`, [conv.customer_id, conv.id]);

  return ok(res, { conversation: conv, customerStats, history });
}));

/** GET /api/conversations/:id/messages 消息列表 */
router.get('/:id/messages', requireAuth, asyncHandler((req, res) => {
  const conv = get('SELECT * FROM conversations WHERE id = ?', [Number(req.params.id)]);
  if (!conv) return fail(res, '会话不存在', 404);
  if (req.user.role === 'customer' && conv.customer_id !== req.user.id) return fail(res, '无权访问该会话', 403);

  const after = Number(req.query.after) || 0;
  const list = after
    ? all('SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC', [conv.id, after])
    : all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC', [conv.id]);

  if (req.user.role === 'customer') run('UPDATE conversations SET unread_customer = 0 WHERE id = ?', [conv.id]);
  else run('UPDATE conversations SET unread_agent = 0 WHERE id = ?', [conv.id]);

  return ok(res, list);
}));

/** POST /api/conversations 创建会话（客户发起咨询） */
router.post('/', requireAuth, asyncHandler((req, res) => {
  const { subject = '', channel = 'web', tag = '', priority = 'normal', source_url = '' } = req.body || {};
  const customerId = req.user.role === 'customer' ? req.user.id : Number(req.body.customer_id);
  if (!customerId) return fail(res, '缺少客户信息');

  // 若已有未结束会话，直接复用
  const existing = get(
    "SELECT * FROM conversations WHERE customer_id = ? AND status != 'closed' ORDER BY id DESC LIMIT 1",
    [customerId]);
  if (existing) {
    const msgs = all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC', [existing.id]);
    return ok(res, { conversation: existing, messages: msgs, reused: true }, '已接入进行中的会话');
  }

  const code = nextCode('KH', 'conversations');
  const r = run(
    `INSERT INTO conversations (code, customer_id, channel, subject, tag, priority, source_url, status)
     VALUES (?,?,?,?,?,?,?, 'queued')`,
    [code, customerId, channel, subject, tag, priority, source_url],
  );
  const convId = Number(r.lastInsertRowid);

  const welcome = getSetting('welcome_message');
  run(`INSERT INTO messages (conversation_id, sender_id, sender_role, sender_name, type, content)
       VALUES (?, NULL, 'system', '系统', 'system', ?)`, [convId, welcome]);
  run(`INSERT INTO messages (conversation_id, sender_id, sender_role, sender_name, type, content)
       VALUES (?, NULL, 'system', '系统', 'system', ?)`, [convId, getSetting('queue_notice')]);

  const conv = get('SELECT * FROM conversations WHERE id = ?', [convId]);
  // 新会话：通知全体坐席立即刷新列表并弹窗提醒，无需手动刷新页面
  emitConversationNew(conv);
  emitConversationUpdate(conv, 'created');
  autoAssignAll();
  const latest = get('SELECT * FROM conversations WHERE id = ?', [convId]);
  const msgs = all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC', [convId]);
  audit(req.user, '发起会话', code, `渠道：${channel}`);
  return ok(res, { conversation: latest, messages: msgs }, '会话已创建');
}));

/** POST /api/conversations/:id/messages 发送消息 */
router.post('/:id/messages', requireAuth, asyncHandler((req, res) => {
  const conv = get('SELECT * FROM conversations WHERE id = ?', [Number(req.params.id)]);
  if (!conv) return fail(res, '会话不存在', 404);
  if (req.user.role === 'customer' && conv.customer_id !== req.user.id) return fail(res, '无权访问该会话', 403);
  if (conv.status === 'closed') return fail(res, '该会话已结束，请重新发起咨询');

  const { content = '', type = 'text', meta = {} } = req.body || {};
  if (!String(content).trim() && type === 'text') return fail(res, '消息内容不能为空');

  const senderRole = req.user.role === 'customer' ? 'customer' : 'agent';
  const createdAt = nowStr();
  const r = run(
    `INSERT INTO messages (conversation_id, sender_id, sender_role, sender_name, type, content, meta, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [conv.id, req.user.id, senderRole, req.user.name, type, content, JSON.stringify(meta || {}), createdAt],
  );
  const message = get('SELECT * FROM messages WHERE id = ?', [Number(r.lastInsertRowid)]);

  // 坐席首次回复自动接管未分配会话
  if (senderRole === 'agent' && !conv.agent_id) {
    const updated = assignAgent(conv.id, req.user.id, { silent: true, actor: req.user });
    if (updated) {
      run('UPDATE conversations SET last_message_at = ?, unread_customer = unread_customer + 1 WHERE id = ?', [createdAt, conv.id]);
    }
  } else {
    run(`UPDATE conversations SET last_message_at = ?,
           unread_customer = unread_customer + CASE WHEN ? = 'agent' THEN 1 ELSE 0 END,
           unread_agent = unread_agent + CASE WHEN ? = 'customer' THEN 1 ELSE 0 END
         WHERE id = ?`, [createdAt, senderRole, senderRole, conv.id]);
  }

  const fresh = get('SELECT * FROM conversations WHERE id = ?', [conv.id]);
  emitMessage(fresh, message);
  return ok(res, message, '已发送');
}));

/** POST /api/conversations/:id/assign 接入 / 转接 */
router.post('/:id/assign', requireAuth, asyncHandler((req, res) => {
  if (req.user.role === 'customer') return fail(res, '没有权限', 403);
  const conv = get('SELECT * FROM conversations WHERE id = ?', [Number(req.params.id)]);
  if (!conv) return fail(res, '会话不存在', 404);
  const targetId = req.body?.agentId ? Number(req.body.agentId) : req.user.id;
  const updated = assignAgent(conv.id, targetId, { actor: req.user });
  if (!updated) return fail(res, req.body?.agentId ? '目标坐席不存在或不可用' : '当前没有可接待的坐席，请稍后再试');
  audit(req.user, targetId === req.user.id ? '接入会话' : '转接会话', conv.code,
    targetId === req.user.id ? '坐席主动接入' : `转接给坐席 #${targetId}`);
  return ok(res, updated, targetId === req.user.id ? '已接入会话' : '转接成功');
}));

/** POST /api/conversations/:id/close 结束会话 */
router.post('/:id/close', requireAuth, asyncHandler((req, res) => {
  const conv = get('SELECT * FROM conversations WHERE id = ?', [Number(req.params.id)]);
  if (!conv) return fail(res, '会话不存在', 404);
  if (req.user.role === 'customer' && conv.customer_id !== req.user.id) return fail(res, '无权访问该会话', 403);
  const updated = closeConversation(conv.id, req.user.id, req.body?.reason || '', req.user.name);
  return ok(res, updated, '会话已结束');
}));

/** POST /api/conversations/:id/rating 服务评价 */
router.post('/:id/rating', requireAuth, asyncHandler((req, res) => {
  const conv = get('SELECT * FROM conversations WHERE id = ?', [Number(req.params.id)]);
  if (!conv) return fail(res, '会话不存在', 404);
  if (req.user.role === 'customer' && conv.customer_id !== req.user.id) return fail(res, '无权评价该会话');
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(res, '请给出 1-5 星评价');

  run('UPDATE conversations SET rating = ?, rating_comment = ? WHERE id = ?',
    [rating, String(req.body?.comment || '').slice(0, 500), conv.id]);

  const msg = get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conv.id]);
  void msg;
  run(`INSERT INTO messages (conversation_id, sender_id, sender_role, sender_name, type, content)
       VALUES (?, NULL, 'system', '系统', 'system', ?)`,
    [conv.id, `客户对本次服务评价 ${rating} 星${req.body?.comment ? `：${req.body.comment}` : ''}`]);
  const fresh = get('SELECT * FROM conversations WHERE id = ?', [conv.id]);
  emitConversationUpdate(fresh, 'rated');
  return ok(res, fresh, '感谢您的评价');
}));

/** POST /api/conversations/:id/tag 设置标签/优先级/主题 */
router.put('/:id', requireAuth, asyncHandler((req, res) => {
  if (req.user.role === 'customer') return fail(res, '没有权限', 403);
  const conv = get('SELECT * FROM conversations WHERE id = ?', [Number(req.params.id)]);
  if (!conv) return fail(res, '会话不存在', 404);
  const { tag, priority, subject } = req.body || {};
  run(`UPDATE conversations SET tag = COALESCE(?, tag), priority = COALESCE(?, priority),
        subject = COALESCE(?, subject) WHERE id = ?`,
    [tag ?? null, priority ?? null, subject ?? null, conv.id]);
  const fresh = get('SELECT * FROM conversations WHERE id = ?', [conv.id]);
  emitConversationUpdate(fresh, 'updated');
  return ok(res, fresh, '已更新');
}));

export default router;
