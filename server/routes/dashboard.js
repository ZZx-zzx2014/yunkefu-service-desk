/**
 * 数据看板：会话趋势、满意度、坐席绩效、工单时效、渠道分布、高峰时段
 */
import { Router } from 'express';
import { get, all, getSetting } from '../db.js';
import { ok, asyncHandler, requireAuth } from '../middleware.js';
import { CONV_STATUSES, TICKET_STATUSES, TICKET_PRIORITIES, CHANNELS } from '../config.js';

const router = Router();

const rangeDays = (req) => {
  const range = String(req.query.range || '7d');
  const map = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 };
  return map[range] ?? 7;
};

/** GET /api/dashboard/overview 核心指标卡 */
router.get('/overview', requireAuth, asyncHandler((req, res) => {
  const days = rangeDays(req);
  const since = `-${days - 1} day`;

  const todaySessions = get("SELECT COUNT(*) AS c FROM conversations WHERE date(created_at) = date('now','localtime')").c;
  const yesterdaySessions = get("SELECT COUNT(*) AS c FROM conversations WHERE date(created_at) = date('now','localtime','-1 day')").c;

  const sessions = get(`SELECT COUNT(*) AS c FROM conversations WHERE date(created_at) >= date('now','localtime',?)`, [since]).c;
  const prevSessions = get(`SELECT COUNT(*) AS c FROM conversations
    WHERE date(created_at) >= date('now','localtime',?) AND date(created_at) < date('now','localtime',?)`,
    [`-${days * 2 - 1} day`, since]).c;

  const avgRating = Number(get(`SELECT ROUND(AVG(rating),2) AS c FROM conversations
    WHERE rating IS NOT NULL AND date(created_at) >= date('now','localtime',?)`, [since]).c || 0);
  const prevRating = Number(get(`SELECT ROUND(AVG(rating),2) AS c FROM conversations
    WHERE rating IS NOT NULL AND date(created_at) >= date('now','localtime',?)
      AND date(created_at) < date('now','localtime',?)`, [`-${days * 2 - 1} day`, since]).c || 0);

  const satisfaction = get(`SELECT
      SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) AS good,
      COUNT(*) AS total FROM conversations
    WHERE rating IS NOT NULL AND date(created_at) >= date('now','localtime',?)`, [since]);

  const tickets = get(`SELECT COUNT(*) AS c FROM tickets WHERE date(created_at) >= date('now','localtime',?)`, [since]).c;
  const resolvedTickets = get(`SELECT COUNT(*) AS c FROM tickets
    WHERE status IN ('resolved','closed') AND date(created_at) >= date('now','localtime',?)`, [since]).c;

  const avgResponseSec = get(`
    SELECT ROUND(AVG((julianday(m.created_at) - julianday(c.queued_at)) * 86400)) AS c
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id AND m.sender_role = 'agent'
    WHERE m.id = (SELECT MIN(id) FROM messages WHERE conversation_id = c.id AND sender_role = 'agent')
      AND date(c.created_at) >= date('now','localtime',?)`, [since]).c || 0;

  const avgHandleMin = get(`
    SELECT ROUND(AVG((julianday(closed_at) - julianday(COALESCE(started_at, queued_at))) * 1440)) AS c
    FROM conversations WHERE status='closed' AND closed_at IS NOT NULL
      AND date(created_at) >= date('now','localtime',?)`, [since]).c || 0;

  const pct = (cur, prev) => (prev > 0 ? Number((((cur - prev) / prev) * 100).toFixed(1)) : (cur > 0 ? 100 : 0));

  return ok(res, {
    range: `${days}d`,
    cards: {
      todaySessions: { value: todaySessions, delta: pct(todaySessions, yesterdaySessions), label: '今日会话量' },
      sessions: { value: sessions, delta: pct(sessions, prevSessions), label: '周期会话量' },
      avgRating: { value: avgRating, delta: pct(avgRating, prevRating), label: '平均满意度' },
      satisfactionRate: {
        value: satisfaction.total ? Number(((satisfaction.good / satisfaction.total) * 100).toFixed(1)) : 0,
        label: '好评率（4星以上）',
      },
      tickets: { value: tickets, label: '周期新增工单' },
      ticketResolveRate: { value: tickets ? Number(((resolvedTickets / tickets) * 100).toFixed(1)) : 0, label: '工单解决率' },
      avgResponseSec: { value: avgResponseSec, label: '平均首响（秒）' },
      avgHandleMin: { value: avgHandleMin, label: '平均处理时长（分）' },
      onlineAgents: { value: get("SELECT COUNT(*) AS c FROM users WHERE role='agent' AND status IN ('online','busy')").c, label: '在线坐席' },
      totalAgents: { value: get("SELECT COUNT(*) AS c FROM users WHERE role='agent' AND active=1").c, label: '坐席总数' },
      pendingTickets: { value: get("SELECT COUNT(*) AS c FROM tickets WHERE status='pending'").c, label: '待处理工单' },
      overdueTickets: { value: get("SELECT COUNT(*) AS c FROM tickets WHERE sla_due_at < datetime('now','localtime') AND status NOT IN ('closed','resolved')").c, label: '超时工单' },
      queue: { value: get("SELECT COUNT(*) AS c FROM conversations WHERE status='queued' AND agent_id IS NULL").c, label: '排队中' },
      activeNow: { value: get("SELECT COUNT(*) AS c FROM conversations WHERE status='active'").c, label: '进行中会话' },
      kbArticles: { value: get("SELECT COUNT(*) AS c FROM kb_articles WHERE status='published'").c, label: '已发布文章' },
      totalCustomers: { value: get("SELECT COUNT(*) AS c FROM users WHERE role='customer'").c, label: '客户总数' },
    },
  });
}));

/** GET /api/dashboard/trend 会话 / 工单趋势 */
router.get('/trend', requireAuth, asyncHandler((req, res) => {
  const days = rangeDays(req);
  const rows = all(`
    WITH RECURSIVE dates(d) AS (
      SELECT date('now','localtime',?)
      UNION ALL SELECT date(d, '+1 day') FROM dates WHERE d < date('now','localtime')
    )
    SELECT d AS date,
      (SELECT COUNT(*) FROM conversations c WHERE date(c.created_at) = d) AS conversations,
      (SELECT COUNT(*) FROM conversations c WHERE date(c.closed_at) = d) AS closed,
      (SELECT COUNT(*) FROM tickets t WHERE date(t.created_at) = d) AS tickets,
      (SELECT COUNT(*) FROM tickets t WHERE date(t.resolved_at) = d) AS resolved,
      (SELECT ROUND(AVG(rating),2) FROM conversations c WHERE date(c.created_at) = d AND c.rating IS NOT NULL) AS rating
    FROM dates`, [`-${days - 1} day`]);
  return ok(res, rows);
}));

/** GET /api/dashboard/agent-performance 坐席绩效排行 */
router.get('/agent-performance', requireAuth, asyncHandler((req, res) => {
  const days = rangeDays(req);
  // 每个子查询各占一个占位符，顺序与参数数组严格一致，避免数量错位
  const list = all(`
    SELECT u.id, u.name, u.level, u.status, d.name AS department_name,
      (SELECT COUNT(*) FROM conversations c
         WHERE c.agent_id = u.id AND date(c.created_at) >= date('now','localtime',?)) AS sessions,
      (SELECT COUNT(*) FROM conversations c
         WHERE c.agent_id = u.id AND c.status = 'closed' AND date(c.created_at) >= date('now','localtime',?)) AS closed_count,
      (SELECT ROUND(AVG(c.rating), 2) FROM conversations c
         WHERE c.agent_id = u.id AND c.rating IS NOT NULL AND date(c.created_at) >= date('now','localtime',?)) AS rating,
      (SELECT COUNT(*) FROM tickets t
         WHERE t.assignee_id = u.id AND date(t.created_at) >= date('now','localtime',?)) AS ticket_count,
      (SELECT COUNT(*) FROM tickets t
         WHERE t.assignee_id = u.id AND t.status IN ('resolved','closed') AND date(t.created_at) >= date('now','localtime',?)) AS ticket_resolved,
      (SELECT ROUND(AVG((julianday(m.created_at) - julianday(c.queued_at)) * 86400))
         FROM conversations c JOIN messages m ON m.conversation_id = c.id AND m.sender_role = 'agent'
         WHERE c.agent_id = u.id AND m.sender_role = 'agent'
           AND m.id = (SELECT MIN(id) FROM messages WHERE conversation_id = c.id AND sender_role = 'agent')
           AND date(c.created_at) >= date('now','localtime',?)) AS avg_response_sec,
      (SELECT ROUND(AVG((julianday(c.closed_at) - julianday(COALESCE(c.started_at, c.queued_at))) * 1440))
         FROM conversations c
         WHERE c.agent_id = u.id AND c.closed_at IS NOT NULL
           AND date(c.created_at) >= date('now','localtime',?)) AS avg_handle_min
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.role = 'agent' AND u.active = 1
    ORDER BY sessions DESC, rating DESC`,
    [`-${days - 1} day`, `-${days - 1} day`, `-${days - 1} day`, `-${days - 1} day`,
      `-${days - 1} day`, `-${days - 1} day`, `-${days - 1} day`]);

  // 统一输出字段名，前端与工作台页面依赖这些键名
  return ok(res, list.map((r) => ({
    id: r.id,
    name: r.name,
    level: r.level,
    status: r.status,
    department_name: r.department_name,
    sessions: r.sessions,
    closed: r.closed_count,
    rating: r.rating,
    tickets: r.ticket_count,
    ticketsResolved: r.ticket_resolved,
    avgResponseSec: r.avg_response_sec,
    avgHandleMin: r.avg_handle_min,
  })));
}));

/** GET /api/dashboard/distribution 渠道 / 标签 / 状态分布 */
router.get('/distribution', requireAuth, asyncHandler((req, res) => {
  const days = rangeDays(req);
  const since = `-${days - 1} day`;
  const channelRows = all(`SELECT channel, COUNT(*) AS c FROM conversations WHERE date(created_at) >= date('now','localtime',?) GROUP BY channel`, [since]);
  const tagRows = all(`SELECT COALESCE(NULLIF(tag,''),'未分类') AS tag, COUNT(*) AS c FROM conversations
    WHERE date(created_at) >= date('now','localtime',?) GROUP BY tag ORDER BY c DESC LIMIT 8`, [since]);
  const ratingRows = all(`SELECT rating, COUNT(*) AS c FROM conversations
    WHERE rating IS NOT NULL AND date(created_at) >= date('now','localtime',?) GROUP BY rating ORDER BY rating`, [since]);
  const statusRows = all(`SELECT status, COUNT(*) AS c FROM conversations WHERE date(created_at) >= date('now','localtime',?) GROUP BY status`, [since]);
  const categoryRows = all(`SELECT category, COUNT(*) AS c FROM tickets WHERE date(created_at) >= date('now','localtime',?) GROUP BY category ORDER BY c DESC`, [since]);

  return ok(res, {
    channels: channelRows.map((r) => ({ key: r.channel, label: CHANNELS[r.channel] || r.channel, count: r.c })),
    tags: tagRows.map((r) => ({ label: r.tag, count: r.c })),
    ratings: [1, 2, 3, 4, 5].map((s) => ({ star: s, count: ratingRows.find((r) => r.rating === s)?.c || 0 })),
    statuses: statusRows.map((r) => ({ key: r.status, label: CONV_STATUSES[r.status] || r.status, count: r.c })),
    ticketCategories: categoryRows.map((r) => ({ label: r.category, count: r.c })),
  });
}));

/** GET /api/dashboard/hourly 24 小时时段分布（高峰分析） */
router.get('/hourly', requireAuth, asyncHandler((req, res) => {
  const days = rangeDays(req);
  const rows = all(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS c
    FROM conversations
    WHERE date(created_at) >= date('now','localtime',?)
    GROUP BY hour ORDER BY hour`, [`-${days - 1} day`]);
  const list = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: rows.find((r) => r.hour === h)?.c || 0 }));
  return ok(res, list);
}));

/** GET /api/dashboard/realtime 实时概览（工作台顶部） */
router.get('/realtime', requireAuth, asyncHandler((_req, res) => {
  return ok(res, {
    queue: get("SELECT COUNT(*) AS c FROM conversations WHERE status='queued' AND agent_id IS NULL").c,
    active: get("SELECT COUNT(*) AS c FROM conversations WHERE status='active'").c,
    onlineAgents: get("SELECT COUNT(*) AS c FROM users WHERE role='agent' AND status='online'").c,
    todaySessions: get("SELECT COUNT(*) AS c FROM conversations WHERE date(created_at)=date('now','localtime')").c,
    todayTickets: get("SELECT COUNT(*) AS c FROM tickets WHERE date(created_at)=date('now','localtime')").c,
    todayRating: Number(get("SELECT ROUND(AVG(rating),2) AS c FROM conversations WHERE rating IS NOT NULL AND date(created_at)=date('now','localtime')").c || 0),
    slaHours: getSetting('ticket_sla_hours', '24'),
  });
}));

/** GET /api/dashboard/export 导出统计报表（CSV） */
router.get('/export', requireAuth, asyncHandler((req, res) => {
  const days = rangeDays(req);
  const rows = all(`
    SELECT c.code, cu.name AS customer, ag.name AS agent, c.channel, c.status, c.tag, c.priority,
           c.rating, c.created_at, c.closed_at
    FROM conversations c
    JOIN users cu ON cu.id = c.customer_id
    LEFT JOIN users ag ON ag.id = c.agent_id
    WHERE date(c.created_at) >= date('now','localtime',?)
    ORDER BY c.id DESC`, [`-${days - 1} day`]);
  const header = ['会话编号', '客户', '坐席', '渠道', '状态', '标签', '优先级', '评分', '创建时间', '结束时间'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.code, r.customer, r.agent ?? '', CHANNELS[r.channel] || r.channel,
      CONV_STATUSES[r.status] || r.status, r.tag || '', TICKET_PRIORITIES[r.priority] || r.priority,
      r.rating ?? '', r.created_at, r.closed_at ?? '']
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="conversations-${days}d.csv"`);
  return res.send('\uFEFF' + lines.join('\r\n'));
}));

export { TICKET_STATUSES };
export default router;
