/**
 * 实时通信网关（WebSocket）
 *  - 坐席 / 客户 / 管理员共用一条连接，通过首帧 auth 消息鉴权
 *  - 支持：新消息、会话分配、状态变更、工单提醒、坐席状态同步
 *  - 内置自动分配引擎与超时自动关闭会话
 */
import { WebSocketServer } from 'ws';
import { verifyAccessToken } from './auth.js';
import { run, get, all, getSetting, audit } from './db.js';
import { nowStr } from './utils.js';
import { TEST_MODE } from './config.js';
import { isPrivateAddress } from './access-guard.js';

/** userId -> Set<ws> */
const clients = new Map();
let wss = null;

/** WebSocket 调试日志：设置环境变量 KEFU_WS_DEBUG=1 开启 */
const DEBUG_WS = process.env.KEFU_WS_DEBUG === '1';

export function initRealtime(server) {
  wss = new WebSocketServer({
    server,
    path: '/ws',
    // 测试模式：与 HTTP 一致，只接受本机与私有网段来源
    verifyClient: TEST_MODE
      ? (info) => {
        const addr = info.req.socket?.remoteAddress || '';
        if (isPrivateAddress(addr)) return true;
        console.warn(`[test-mode] 拒绝公网地址的 WebSocket 连接：${addr}`);
        return false;
      }
      : undefined,
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.user = null;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'auth') {
        // 仅接受访问令牌；2FA 待验证令牌不能建立实时连接
        const payload = verifyAccessToken(msg.token);
        if (!payload) {
          ws.send(JSON.stringify({ type: 'auth:fail' }));
          return ws.close();
        }
        const user = get('SELECT id, name, role, status, avatar FROM users WHERE id = ? AND active = 1', [payload.id]);
        if (!user) {
          ws.send(JSON.stringify({ type: 'auth:fail' }));
          return ws.close();
        }
        ws.user = user;
        if (!clients.has(user.id)) clients.set(user.id, new Set());
        clients.get(user.id).add(ws);
        if (DEBUG_WS) {
          console.log(`[ws] auth 成功 user=${user.name} id=${user.id} role=${user.role} 该用户当前连接数=${clients.get(user.id).size}`);
          let i = 0;
          for (const c of clients.get(user.id)) console.log(`[ws]   连接#${i++} readyState=${c.readyState} 是本次=${c === ws}`);
        }

        ws.send(JSON.stringify({ type: 'auth:ok', user }));
        if (user.role === 'agent' || user.role === 'admin') {
          setAgentOnline(user.id, true);
          broadcastAgentStatus(user.id, get('SELECT status FROM users WHERE id=?', [user.id]).status);
        }
        return;
      }

      if (!ws.user) return;

      switch (msg.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        case 'typing': {
          // 转发「正在输入」状态给对方
          const conv = get('SELECT customer_id, agent_id FROM conversations WHERE id = ?', [msg.conversationId]);
          if (!conv) break;
          const target = ws.user.role === 'customer' ? conv.agent_id : conv.customer_id;
          if (target) sendToUser(target, { type: 'typing', conversationId: msg.conversationId, from: ws.user.role });
          break;
        }
        case 'agent:status': {
          if (ws.user.role === 'customer') break;
          const allowed = ['online', 'busy', 'away'];
          if (!allowed.includes(msg.status)) break;
          run('UPDATE users SET status = ? WHERE id = ?', [msg.status, ws.user.id]);
          broadcastAgentStatus(ws.user.id, msg.status);
          break;
        }
        default:
          break;
      }
    });

    ws.on('close', () => {
      if (DEBUG_WS) console.log(`[ws] close 事件触发 user=${ws.user ? ws.user.name : 'null'} id=${ws.user?.id}`);
      if (!ws.user) return;
      const set = clients.get(ws.user.id);
      if (DEBUG_WS) {
        console.log(`[ws]   断开前该用户连接数=${set ? set.size : '无记录'}，本连接在集合中=${set ? set.has(ws) : false}`);
        if (set) {
          let i = 0;
          for (const c of set) {
            console.log(`[ws]     连接#${i++} readyState=${c.readyState} 是本次=${c === ws}`);
          }
        }
      }
      if (set) {
        set.delete(ws);
        if (DEBUG_WS) console.log(`[ws]   删除后剩余=${set.size}`);
        if (set.size === 0) {
          clients.delete(ws.user.id);
          if (ws.user.role === 'agent') {
            setAgentOnline(ws.user.id, false);
            broadcastAgentStatus(ws.user.id, 'offline');
            if (DEBUG_WS) console.log(`[ws]   已标记 ${ws.user.name} 为 offline`);
          }
        }
      }
    });
  });

  // 心跳保活
  const heartbeat = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch { /* ignore */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);

  // 自动分配 & 自动关闭
  const scheduler = setInterval(runScheduler, 8000);

  wss.on('close', () => { clearInterval(heartbeat); clearInterval(scheduler); });

  setTimeout(() => { autoAssignAll(); }, 1500);
  console.log('[ws] 实时通信网关已启动，路径 /ws');
  return wss;
}

/* ------------------------------------------------------------------ *
 * 发送 / 广播
 * ------------------------------------------------------------------ */

function sendToUser(userId, payload) {
  const set = clients.get(userId);
  if (!set || set.size === 0) return false;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) { try { ws.send(data); } catch { /* ignore */ } }
  }
  return true;
}

function broadcast(payload, filter) {
  const data = JSON.stringify(payload);
  for (const [, set] of clients) {
    for (const ws of set) {
      if (ws.readyState !== 1) continue;
      if (filter && !filter(ws.user)) continue;
      try { ws.send(data); } catch { /* ignore */ }
    }
  }
}

export function isUserOnline(userId) {
  return clients.has(Number(userId));
}

export function onlineAgents() {
  const ids = [];
  for (const [id, set] of clients) {
    for (const ws of set) {
      if (ws.user?.role === 'agent') { ids.push(id); break; }
    }
  }
  return ids;
}

/** 推送给全体坐席与管理员 */
function toStaff(payload) {
  broadcast(payload, (u) => u.role === 'agent' || u.role === 'admin');
}

/**
 * 推送新消息给会话双方。
 *
 * 关键：客户消息必须通知到「全体坐席」，而不只是负责该会话的坐席。
 * 原因：会话由自动分配或历史轮次决定负责人，其他坐席在「全部 / 排队」视图下
 * 同样需要实时看到这条消息（列表预览、未读角标、提醒），否则只能手动刷新页面。
 */
export function emitMessage(conversation, message) {
  const isCustomerMsg = message?.sender_role === 'customer';
  const payload = { type: 'message', conversationId: conversation.id, message };

  sendToUser(conversation.customer_id, payload);
  if (conversation.agent_id) sendToUser(conversation.agent_id, payload);

  if (isCustomerMsg) {
    // 全体坐席：携带会话摘要与消息，供列表实时刷新 + 未读标记 + 弹窗提醒
    toStaff({
      type: 'queue:update',
      conversationId: conversation.id,
      message,
      conversation: conversationSummary(conversation.id),
      unassigned: !conversation.agent_id,
    });
  } else if (!conversation.agent_id) {
    // 非客户消息（如系统消息）且无人负责：仅刷新列表
    toStaff({ type: 'queue:update', conversationId: conversation.id, conversation: conversationSummary(conversation.id) });
  }
}

/** 会话分配/流转通知 */
export function emitConversationUpdate(conversation, reason = '') {
  const payload = { type: 'conversation:update', conversation, reason };
  sendToUser(conversation.customer_id, payload);
  if (conversation.agent_id) sendToUser(conversation.agent_id, payload);
  toStaff({ type: 'queue:refresh', reason });
}

/**
 * 新会话创建通知：提醒全体坐席有新客户接入
 * 客服端据此实时显示「新会话」并刷新列表，无需手动刷新页面
 */
export function emitConversationNew(conversation, message = null, action = 'created') {
  const summary = conversationSummary(conversation.id) || conversation;
  const payload = {
    type: 'conversation:new',
    action,
    conversationId: conversation.id,
    conversation: summary,
    message,
  };
  sendToUser(conversation.customer_id, payload);
  toStaff(payload);
}

/** 会话转交通知（明确告知新负责的坐席） */
export function emitConversationAssigned(conversation, previousAgentId, actorName = '') {
  const payload = {
    type: 'conversation:assigned',
    conversationId: conversation.id,
    conversation: conversationSummary(conversation.id) || conversation,
    previousAgentId,
    actorName,
  };
  sendToUser(conversation.customer_id, payload);
  if (conversation.agent_id) sendToUser(conversation.agent_id, payload);
  toStaff(payload);
}

/** 读一条会话摘要（含客户名、最后消息、未读数），供实时推送携带 */
function conversationSummary(conversationId) {
  return get(`
    SELECT c.id, c.code, c.status, c.priority, c.tag, c.channel, c.subject,
           c.agent_id, c.customer_id, c.last_message_at, c.unread_agent,
           cu.name AS customer_name, cu.avatar AS customer_avatar,
           ag.name AS agent_name,
           (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
           (SELECT sender_role FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender_role
    FROM conversations c
    JOIN users cu ON cu.id = c.customer_id
    LEFT JOIN users ag ON ag.id = c.agent_id
    WHERE c.id = ?`, [conversationId]) || null;
}

/** 知识库变更通知：让后台与工作台的知识库页面实时更新 */
export function emitKbUpdate(action, payload = {}) {
  toStaff({ type: 'kb:update', action, ...payload, at: nowStr() });
}

/** 工单统计变更通知：让工单列表的统计卡片自动刷新 */
export function emitTicketStats() {
  toStaff({ type: 'ticket:stats' });
}

/** 工单变更通知 */
export function emitTicketUpdate(ticket, extra = {}) {
  const payload = { type: 'ticket:update', ticket, ...extra };
  if (ticket?.assignee_id) sendToUser(ticket.assignee_id, payload);
  if (ticket?.creator_id) sendToUser(ticket.creator_id, payload);
  broadcast(payload, (u) => u.role === 'admin');
}

/** 站内通知 */
export function emitNotification(userId, notification) {
  sendToUser(userId, { type: 'notification', notification });
}

/** 向指定坐席推送提醒 */
export function notifyAgent(agentId, notification) {
  run('INSERT INTO notifications (user_id, title, body, type, link) VALUES (?,?,?,?,?)',
    [agentId, notification.title, notification.body ?? '', notification.type ?? 'info', notification.link ?? '']);
  const row = get('SELECT * FROM notifications WHERE id = last_insert_rowid()');
  sendToUser(agentId, { type: 'notification', notification: row });
  return row;
}

/* ------------------------------------------------------------------ *
 * 在线状态
 * ------------------------------------------------------------------ */

function setAgentOnline(agentId, online) {
  const user = get('SELECT status FROM users WHERE id = ?', [agentId]);
  if (!user) return;
  if (online) {
    if (user.status === 'offline') run("UPDATE users SET status='online', last_login_at=datetime('now','localtime') WHERE id=?", [agentId]);
  } else {
    const res = run("UPDATE users SET status='offline' WHERE id=?", [agentId]);
    if (DEBUG_WS) {
      const after = get('SELECT status FROM users WHERE id = ?', [agentId]);
      console.log(`[ws]   setAgentOnline(false) changes=${res.changes} 写后读回 status=${after?.status}`);
    }
  }
}

function broadcastAgentStatus(agentId, status) {
  broadcast({ type: 'agent:status', agentId, status }, (u) => u.role === 'agent' || u.role === 'admin');
}

/* ------------------------------------------------------------------ *
 * 自动分配引擎
 * ------------------------------------------------------------------ */

/** 坐席当前接待数 */
export function activeCount(agentId) {
  return get("SELECT COUNT(*) AS c FROM conversations WHERE agent_id = ? AND status = 'active'", [agentId]).c;
}

/** 按「技能匹配 + 负载最低 + 在线」挑选坐席 */
export function pickAgent(tag = '') {
  const agents = all(`
    SELECT u.*, d.name AS department_name,
      (SELECT COUNT(*) FROM conversations c WHERE c.agent_id = u.id AND c.status = 'active') AS load
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.role = 'agent' AND u.active = 1 AND u.status = 'online'
  `);
  const candidates = agents.filter((a) => a.load < a.max_concurrent);
  if (candidates.length === 0) return null;

  const score = (a) => {
    let skills = [];
    try { skills = JSON.parse(a.skills || '[]'); } catch { /* ignore */ }
    const matched = tag && skills.some((s) => tag.includes(s) || s.includes(tag)) ? 1 : 0;
    return matched * 100 - a.load * 10;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0];
}

/** 将排队会话自动分配出去 */
export function autoAssignAll() {
  if (getSetting('auto_assign', '1') !== '1') return 0;
  const queued = all("SELECT * FROM conversations WHERE status = 'queued' AND agent_id IS NULL ORDER BY priority DESC, queued_at ASC");
  let assigned = 0;
  for (const conv of queued) {
    if (assignAgent(conv.id, null, { silent: true })) assigned++;
  }
  return assigned;
}

/** 分配会话给坐席；agentId 为 null 时自动挑选
 *  silent 仅表示「不额外弹窗提示客户」，但分配结果必须广播，
 *  否则自动分配发生时新负责的坐席无法实时得知，只能靠手动刷新。
 */
export function assignAgent(conversationId, agentId = null, { silent = false, actor = null } = {}) {
  const conv = get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
  if (!conv || conv.status === 'closed') return null;

  let target = null;
  if (agentId) {
    target = get("SELECT * FROM users WHERE id = ? AND role IN ('agent','admin') AND active = 1", [agentId]);
    if (!target) return null;
  } else {
    target = pickAgent(conv.tag || '');
    if (!target) return null;
  }

  const previousAgentId = conv.agent_id;
  const isTransfer = Boolean(previousAgentId) && previousAgentId !== target.id;
  const assignTime = nowStr();
  run(
    `UPDATE conversations SET agent_id = ?, status = 'active',
       started_at = COALESCE(started_at, ?), last_message_at = ?
     WHERE id = ?`,
    [target.id, assignTime, assignTime, conversationId],
  );

  const sysMsg = addSystemMessage(conversationId,
    isTransfer
      ? `${actor?.name || '系统'} 将会话转接给客服「${target.name}」`
      : `客服「${target.name}」已接入会话，很高兴为您服务`);

  const updated = get('SELECT * FROM conversations WHERE id = ?', [conversationId]);

  // 无论是否 silent，都必须广播分配结果，保证坐席端实时感知
  emitConversationAssigned(updated, previousAgentId, actor?.name || '系统');
  emitConversationUpdate(updated, isTransfer ? 'transferred' : 'assigned');
  if (!silent) emitMessage(updated, sysMsg);

  // 新会话/分配结果通知：让其他坐席的列表同步更新
  emitConversationNew(updated, sysMsg, 'assigned');

  autoAssignAll();
  return updated;
}

/** 写入系统消息 */
export function addSystemMessage(conversationId, content) {
  const createdAt = nowStr();
  const r = run(
    `INSERT INTO messages (conversation_id, sender_id, sender_role, sender_name, type, content, is_read, created_at)
     VALUES (?, NULL, 'system', '系统', 'system', ?, 1, ?)`,
    [conversationId, content, createdAt],
  );
  run('UPDATE conversations SET last_message_at = ? WHERE id = ?', [createdAt, conversationId]);
  return get('SELECT * FROM messages WHERE id = ?', [Number(r.lastInsertRowid)]);
}

/* ------------------------------------------------------------------ *
 * 定时任务：超时未分配提醒 / 空闲会话自动关闭
 * ------------------------------------------------------------------ */

function runScheduler() {
  try {
    autoAssignAll();

    // 排队超时提醒
    const waiting = all(`
      SELECT * FROM conversations
      WHERE status = 'queued' AND agent_id IS NULL
        AND (julianday('now','localtime') - julianday(queued_at)) * 24 * 60 > 3
    `);
    for (const conv of waiting) {
      const notified = get(
        "SELECT COUNT(*) AS c FROM notifications WHERE title = '会话排队超时' AND body LIKE ?",
        [`%${conv.code}%`],
      ).c;
      if (notified > 0) continue;
      const agents = onlineAgents();
      for (const a of agents) {
        notifyAgent(a, {
          title: '会话排队超时',
          body: `会话 ${conv.code} 已等待超过 3 分钟，请尽快接入`,
          type: 'warning',
          link: `#/workspace?conv=${conv.id}`,
        });
      }
    }

    // 自动关闭长时间无消息的进行中会话
    const minutes = Number(getSetting('auto_close_minutes', '30'));
    if (minutes > 0) {
      const idle = all(`
        SELECT * FROM conversations
        WHERE status = 'active'
          AND (julianday('now','localtime') - julianday(last_message_at)) * 24 * 60 > ?
      `, [minutes]);
      for (const conv of idle) {
        closeConversation(conv.id, null, '系统自动关闭（长时间无新消息）');
      }
    }
  } catch (err) {
    console.error('[scheduler]', err.message);
  }
}

export function closeConversation(conversationId, userId = null, reason = '', actorName = '') {
  const conv = get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
  if (!conv || conv.status === 'closed') return conv;
  const closedAt = nowStr();
  run("UPDATE conversations SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?",
    [closedAt, userId, conversationId]);
  const msg = addSystemMessage(conversationId,
    reason || `${actorName ? `客服「${actorName}」` : '系统'}已结束本次会话${getSetting('rating_enabled', '1') === '1' ? '，感谢您的来访，欢迎对本次服务作出评价' : ''}`);
  const updated = get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
  emitConversationUpdate(updated, 'closed');
  emitMessage(updated, msg);
  if (userId) audit({ id: userId, name: actorName || 'agent' }, '结束会话', updated.code, reason);
  return updated;
}
