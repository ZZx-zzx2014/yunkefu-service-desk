/**
 * 工单系统：创建、查询、指派、流转、评论、评价、统计
 */
import { Router } from 'express';
import { run, get, all, getSetting, audit } from '../db.js';
import { ok, fail, asyncHandler, requireAuth } from '../middleware.js';
import { nextCode, pagination, pagedResult, nowStr, addHours, parseJSON } from '../utils.js';
import { emitTicketUpdate, notifyAgent, emitTicketStats } from '../realtime.js';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from '../config.js';

const router = Router();

const SLA_HOURS = { urgent: 2, high: 8, normal: 24, low: 72 };

function slaDue(priority) {
  const base = Number(getSetting('ticket_sla_hours', '24'));
  const factor = { urgent: 0.1, high: 0.4, normal: 1, low: 3 }[priority] ?? 1;
  return addHours(nowStr(), Math.max(1, Math.round(base * factor)));
}

/* ------------------------------ 元数据 ------------------------------ */

router.get('/meta', requireAuth, asyncHandler((_req, res) => {
  return ok(res, {
    categories: TICKET_CATEGORIES,
    priorities: TICKET_PRIORITIES,
    statuses: TICKET_STATUSES,
    agents: all("SELECT id, name, level, department_id FROM users WHERE role='agent' AND active=1 ORDER BY id"),
    departments: all('SELECT id, name FROM departments ORDER BY id'),
  });
}));

/* ------------------------------ 统计 ------------------------------ */

router.get('/stats', requireAuth, asyncHandler((req, res) => {
  const isCustomer = req.user.role === 'customer';
  const scope = isCustomer ? 'WHERE t.creator_id = ?' : '';
  const params = isCustomer ? [req.user.id] : [];

  const byStatus = all(`SELECT status, COUNT(*) AS c FROM tickets t ${scope} GROUP BY status`, params);
  const byCategory = all(`SELECT category, COUNT(*) AS c FROM tickets t ${scope} GROUP BY category ORDER BY c DESC`, params);
  const byPriority = all(`SELECT priority, COUNT(*) AS c FROM tickets t ${scope} GROUP BY priority`, params);

  const statusMap = Object.fromEntries(byStatus.map((r) => [r.status, r.c]));
  return ok(res, {
    total: get(`SELECT COUNT(*) AS c FROM tickets t ${scope}`, params).c,
    pending: statusMap.pending || 0,
    processing: statusMap.processing || 0,
    resolved: statusMap.resolved || 0,
    closed: statusMap.closed || 0,
    reopened: statusMap.reopened || 0,
    overdue: get(`SELECT COUNT(*) AS c FROM tickets t ${scope ? scope + ' AND' : 'WHERE'} t.sla_due_at < datetime('now','localtime') AND t.status NOT IN ('closed','resolved')`, params).c,
    mine: isCustomer ? 0 : get("SELECT COUNT(*) AS c FROM tickets WHERE assignee_id = ? AND status NOT IN ('closed')", [req.user.id]).c,
    unassigned: get("SELECT COUNT(*) AS c FROM tickets WHERE assignee_id IS NULL AND status NOT IN ('closed')").c,
    avgRating: Number(get(`SELECT ROUND(AVG(rating),2) AS c FROM tickets t ${scope ? scope + ' AND' : 'WHERE'} t.rating IS NOT NULL`, params).c || 0),
    byCategory: byCategory.map((r) => ({ category: r.category, count: r.c })),
    byPriority: byPriority.map((r) => ({ priority: r.priority, label: TICKET_PRIORITIES[r.priority] || r.priority, count: r.c })),
  });
}));

/* ------------------------------ 列表 ------------------------------ */

router.get('/', requireAuth, asyncHandler((req, res) => {
  const { page, size, offset } = pagination(req.query, 20);
  const { status, priority, category, keyword, assigneeId, scope, dateFrom, dateTo } = req.query;

  const where = [];
  const params = [];

  if (req.user.role === 'customer') {
    where.push('t.creator_id = ?');
    params.push(req.user.id);
  } else if (scope === 'mine') {
    where.push('t.assignee_id = ?');
    params.push(req.user.id);
  } else if (scope === 'unassigned') {
    where.push('t.assignee_id IS NULL');
  }

  if (status && TICKET_STATUSES[status]) {
    if (status === 'open') where.push("t.status NOT IN ('closed','resolved')");
    else { where.push('t.status = ?'); params.push(status); }
  }
  if (priority) { where.push('t.priority = ?'); params.push(priority); }
  if (category) { where.push('t.category = ?'); params.push(category); }
  if (assigneeId) { where.push('t.assignee_id = ?'); params.push(Number(assigneeId)); }
  if (keyword) {
    where.push('(t.code LIKE ? OR t.title LIKE ? OR t.description LIKE ? OR cu.name LIKE ?)');
    const like = `%${keyword}%`;
    params.push(like, like, like, like);
  }
  if (dateFrom) { where.push('date(t.created_at) >= date(?)'); params.push(dateFrom); }
  if (dateTo) { where.push('date(t.created_at) <= date(?)'); params.push(dateTo); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const baseSql = `
    FROM tickets t
    JOIN users cu ON cu.id = t.creator_id
    LEFT JOIN users ag ON ag.id = t.assignee_id
    LEFT JOIN departments d ON d.id = t.department_id
    ${whereSql}`;

  const total = get(`SELECT COUNT(*) AS c ${baseSql}`, params).c;
  const list = all(`
    SELECT t.*, cu.name AS creator_name, cu.phone AS creator_phone, cu.email AS creator_email,
           ag.name AS assignee_name, ag.avatar AS assignee_avatar, d.name AS department_name,
           (SELECT COUNT(*) FROM ticket_comments tc WHERE tc.ticket_id = t.id) AS comment_count,
           CASE WHEN t.sla_due_at IS NOT NULL AND t.sla_due_at < datetime('now','localtime')
                     AND t.status NOT IN ('closed','resolved') THEN 1 ELSE 0 END AS is_overdue
    ${baseSql}
    ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             CASE t.status WHEN 'pending' THEN 0 WHEN 'reopened' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END,
             t.updated_at DESC
    LIMIT ? OFFSET ?`, [...params, size, offset]);

  return ok(res, pagedResult(list, total, page, size));
}));

/* ------------------------------ 详情 ------------------------------ */

router.get('/:id', requireAuth, asyncHandler((req, res) => {
  const ticket = get(`
    SELECT t.*, cu.name AS creator_name, cu.username AS creator_username, cu.phone AS creator_phone,
           cu.email AS creator_email, ag.name AS assignee_name, ag.avatar AS assignee_avatar,
           d.name AS department_name
    FROM tickets t
    JOIN users cu ON cu.id = t.creator_id
    LEFT JOIN users ag ON ag.id = t.assignee_id
    LEFT JOIN departments d ON d.id = t.department_id
    WHERE t.id = ?`, [Number(req.params.id)]);
  if (!ticket) return fail(res, '工单不存在', 404);
  if (req.user.role === 'customer' && ticket.creator_id !== req.user.id) return fail(res, '无权访问该工单', 403);

  const comments = all(`
    SELECT tc.*, u.avatar FROM ticket_comments tc
    LEFT JOIN users u ON u.id = tc.user_id
    WHERE tc.ticket_id = ?
    ORDER BY tc.id ASC`, [ticket.id]);

  return ok(res, {
    ticket,
    comments: comments.filter((c) => !(c.internal === 1 && req.user.role === 'customer')),
  });
}));

/* ------------------------------ 创建 ------------------------------ */

router.post('/', requireAuth, asyncHandler((req, res) => {
  const { title, description = '', category = '其他', priority = 'normal', conversation_id = null } = req.body || {};
  if (!title || !String(title).trim()) return fail(res, '请填写工单标题');
  if (!TICKET_CATEGORIES.includes(category)) return fail(res, '工单分类不正确');
  if (!TICKET_PRIORITIES[priority]) return fail(res, '优先级不正确');

  const creatorId = req.user.role === 'customer' ? req.user.id
    : Number(req.body.creator_id || req.user.id);
  const code = nextCode('GD', 'tickets');
  const due = slaDue(priority);

  const r = run(
    `INSERT INTO tickets (code, title, description, category, priority, status, creator_id, conversation_id, sla_due_at)
     VALUES (?,?,?,?,?, 'pending', ?,?,?)`,
    [code, String(title).trim(), description, category, priority, creatorId, conversation_id, due],
  );
  const ticketId = Number(r.lastInsertRowid);
  run('INSERT INTO ticket_comments (ticket_id, user_id, user_name, action, content) VALUES (?,?,?,?,?)',
    [ticketId, req.user.id, req.user.name, 'create', description || '创建了工单']);

  // 按分类自动指派
  const deptMap = { 技术支持: '技术支持部', 账务问题: '售后服务部', 投诉建议: '售后服务部', 产品咨询: '售前咨询部' };
  const deptName = deptMap[category];
  let autoAgent = null;
  if (deptName) {
    const dept = get('SELECT id FROM departments WHERE name = ?', [deptName]);
    if (dept) {
      autoAgent = get(`SELECT id, name FROM users WHERE role='agent' AND active=1 AND department_id=?
                       ORDER BY (SELECT COUNT(*) FROM tickets t2 WHERE t2.assignee_id = users.id AND t2.status NOT IN ('closed')) ASC
                       LIMIT 1`, [dept.id]);
      if (autoAgent) {
        run("UPDATE tickets SET assignee_id = ?, department_id = ?, status = 'processing' WHERE id = ?",
          [autoAgent.id, dept.id, ticketId]);
        run('INSERT INTO ticket_comments (ticket_id, user_id, user_name, action, content, internal) VALUES (?,?,?,?,?,1)',
          [ticketId, null, '系统', 'assign', `根据分类「${category}」自动指派给 ${autoAgent.name}。`]);
        notifyAgent(autoAgent.id, {
          title: '您有新的工单',
          body: `${code} ${title}`,
          type: 'info',
          link: `#/tickets?id=${ticketId}`,
        });
      }
    }
  }

  const ticket = get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
  emitTicketUpdate(ticket, { action: 'created' });
  emitTicketStats();
  audit(req.user, '创建工单', code, title);
  return ok(res, ticket, autoAgent ? `工单已创建并指派给 ${autoAgent.name}` : '工单已创建，我们会尽快处理');
}));

/* ------------------------------ 更新（状态/指派/优先级） ------------------------------ */

router.put('/:id', requireAuth, asyncHandler((req, res) => {
  const ticket = get('SELECT * FROM tickets WHERE id = ?', [Number(req.params.id)]);
  if (!ticket) return fail(res, '工单不存在', 404);
  if (req.user.role === 'customer') return fail(res, '客户无权修改工单信息', 403);

  const { status, priority, assignee_id, category, title, description, department_id } = req.body || {};
  const logs = [];

  if (status && status !== ticket.status) {
    if (!TICKET_STATUSES[status]) return fail(res, '工单状态不正确');
    logs.push({ action: 'status', content: `状态由「${TICKET_STATUSES[ticket.status]}」变更为「${TICKET_STATUSES[status]}」` });
  }
  if (priority && priority !== ticket.priority) {
    if (!TICKET_PRIORITIES[priority]) return fail(res, '优先级不正确');
    logs.push({ action: 'priority', content: `优先级由「${TICKET_PRIORITIES[ticket.priority]}」调整为「${TICKET_PRIORITIES[priority]}」` });
  }
  if (assignee_id !== undefined && Number(assignee_id) !== ticket.assignee_id) {
    const agent = assignee_id ? get("SELECT id, name, department_id FROM users WHERE id = ? AND role IN ('agent','admin')", [Number(assignee_id)]) : null;
    logs.push({ action: 'assign', content: agent ? `工单指派给 ${agent.name}` : '取消指派', internal: 1 });
    if (agent) {
      run('UPDATE tickets SET department_id = ? WHERE id = ?', [agent.department_id, ticket.id]);
      notifyAgent(agent.id, { title: '工单指派通知', body: `${ticket.code} ${ticket.title}`, type: 'warning', link: `#/tickets?id=${ticket.id}` });
    }
  }

  const resolved = status === 'resolved';
  const closed = status === 'closed';

  run(`
    UPDATE tickets SET
      status = COALESCE(?, status),
      priority = COALESCE(?, priority),
      assignee_id = ?,
      category = COALESCE(?, category),
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      department_id = COALESCE(?, department_id),
      resolved_at = ${resolved ? "datetime('now','localtime')" : 'resolved_at'},
      closed_at = ${closed ? "datetime('now','localtime')" : 'closed_at'},
      updated_at = datetime('now','localtime')
    WHERE id = ?`,
    [status ?? null, priority ?? null,
      assignee_id === undefined ? ticket.assignee_id : (assignee_id === null || assignee_id === '' ? null : Number(assignee_id)),
      category ?? null, title ?? null, description ?? null, department_id ?? null, ticket.id]);

  for (const log of logs) {
    run('INSERT INTO ticket_comments (ticket_id, user_id, user_name, action, content, internal) VALUES (?,?,?,?,?,?)',
      [ticket.id, req.user.id, req.user.name, log.action, log.content, log.internal ?? 0]);
  }

  const fresh = get('SELECT * FROM tickets WHERE id = ?', [ticket.id]);
  emitTicketUpdate(fresh, { action: 'updated' });
  emitTicketStats();
  audit(req.user, '更新工单', fresh.code, logs.map((l) => l.content).join('；') || '更新工单信息');
  return ok(res, fresh, '工单已更新');
}));

/* ------------------------------ 评论 / 回复 ------------------------------ */

router.post('/:id/comments', requireAuth, asyncHandler((req, res) => {
  const ticket = get('SELECT * FROM tickets WHERE id = ?', [Number(req.params.id)]);
  if (!ticket) return fail(res, '工单不存在', 404);
  if (req.user.role === 'customer' && ticket.creator_id !== req.user.id) return fail(res, '无权回复该工单', 403);
  const { content, internal = 0 } = req.body || {};
  if (!String(content || '').trim()) return fail(res, '回复内容不能为空');

  const isInternal = req.user.role === 'customer' ? 0 : (internal ? 1 : 0);
  const r = run('INSERT INTO ticket_comments (ticket_id, user_id, user_name, action, content, internal) VALUES (?,?,?,?,?,?)',
    [ticket.id, req.user.id, req.user.name, 'comment', String(content).trim(), isInternal]);

  // 客户回复 → 重新打开已解决工单并通知处理人
  if (req.user.role === 'customer' && ['resolved', 'closed'].includes(ticket.status)) {
    run("UPDATE tickets SET status='reopened', updated_at=datetime('now','localtime') WHERE id=?", [ticket.id]);
    run('INSERT INTO ticket_comments (ticket_id, user_id, user_name, action, content, internal) VALUES (?,?,?,?,?,1)',
      [ticket.id, null, '系统', 'status', '客户回复，工单已重新打开']);
  } else {
    run("UPDATE tickets SET updated_at=datetime('now','localtime') WHERE id=?", [ticket.id]);
  }

  if (req.user.role !== 'customer' && ticket.creator_id) {
    notifyAgent(ticket.creator_id, { title: '工单有新回复', body: `${ticket.code}：${String(content).slice(0, 50)}`, type: 'info' });
  } else if (ticket.assignee_id) {
    notifyAgent(ticket.assignee_id, { title: '客户回复了工单', body: `${ticket.code}：${String(content).slice(0, 50)}`, type: 'warning' });
  }

  const fresh = get('SELECT * FROM tickets WHERE id = ?', [ticket.id]);
  emitTicketUpdate(fresh, { action: 'comment' });
  emitTicketStats();
  return ok(res, get('SELECT * FROM ticket_comments WHERE id = ?', [Number(r.lastInsertRowid)]), '回复成功');
}));

/* ------------------------------ 评价 & 关闭 ------------------------------ */

router.post('/:id/rating', requireAuth, asyncHandler((req, res) => {
  const ticket = get('SELECT * FROM tickets WHERE id = ?', [Number(req.params.id)]);
  if (!ticket) return fail(res, '工单不存在', 404);
  if (req.user.role === 'customer' && ticket.creator_id !== req.user.id) return fail(res, '无权评价');
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(res, '请给出 1-5 星评价');
  run("UPDATE tickets SET rating=?, rating_comment=?, status='closed', closed_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?",
    [rating, String(req.body?.comment || '').slice(0, 500), ticket.id]);
  const fresh = get('SELECT * FROM tickets WHERE id = ?', [ticket.id]);
  emitTicketUpdate(fresh, { action: 'rated' });
  emitTicketStats();
  return ok(res, fresh, '感谢您的评价');
}));

router.delete('/:id', requireAuth, asyncHandler((req, res) => {
  if (req.user.role !== 'admin') return fail(res, '仅管理员可删除工单', 403);
  const ticket = get('SELECT * FROM tickets WHERE id = ?', [Number(req.params.id)]);
  if (!ticket) return fail(res, '工单不存在', 404);
  run('DELETE FROM tickets WHERE id = ?', [ticket.id]);
  audit(req.user, '删除工单', ticket.code, ticket.title);
  emitTicketStats();
  return ok(res, null, '工单已删除');
}));

export default router;
