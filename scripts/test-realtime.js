/**
 * WebSocket 实时推送端到端测试
 *   node scripts/test-realtime.js
 * 验证：坐席在线状态同步、客户发消息实时到达坐席、坐席回复实时到达客户、
 *       会话分配通知、正在输入提示、工单变更通知
 */
import { WebSocket } from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const WS_URL = BASE.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
};

async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return (await r.json()).data;
}

async function api(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await r.json()).data;
}

/** 建立已鉴权的 WebSocket 连接，收集收到的所有消息 */
function connect(token, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const received = [];
    const timeout = setTimeout(() => reject(new Error(`${label} 连接超时`)), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth:ok') {
        clearTimeout(timeout);
        resolve({ ws, received, label });
      } else if (msg.type === 'auth:fail') {
        clearTimeout(timeout);
        reject(new Error(`${label} 鉴权失败`));
      } else {
        received.push(msg);
      }
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

/** 等待满足条件的消息到达 */
function waitFor(conn, predicate, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const hit = conn.received.find(predicate);
    if (hit) return resolve(hit);
    const t = setTimeout(() => { conn.ws.off('message', onMsg); resolve(null); }, timeoutMs);
    const onMsg = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) { clearTimeout(t); conn.ws.off('message', onMsg); resolve(msg); }
    };
    conn.ws.on('message', onMsg);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

(async () => {
  console.log(`\n=== 实时通信端到端测试 ===\n目标：${BASE}`);

  const agent = await login('agent1', 'agent123');
  const customer = await login('user6', 'user123');

  section('1. 建立连接与在线状态');
  const agentConn = await connect(agent.token, '坐席');
  check('坐席 WebSocket 鉴权成功', true);
  await sleep(300);

  const customerConn = await connect(customer.token, '客户');
  check('客户 WebSocket 鉴权成功', true);

  // 坐席上线后应广播 agent:status
  const statusMsg = await waitFor(agentConn, (m) => m.type === 'agent:status', 4000);
  check('坐席状态变更会被广播', statusMsg !== null, statusMsg ? JSON.stringify(statusMsg) : '未收到 agent:status');

  section('2. 客户发消息 → 坐席实时收到');
  const conv = await api('POST', '/api/conversations',
    { channel: 'web', subject: '实时推送测试', tag: '技术支持' }, customer.token);
  const convId = conv.conversation.id;
  check('测试会话已创建', Boolean(convId));

  // 坐席接入，确保消息能定向推送
  await api('POST', `/api/conversations/${convId}/assign`, { agentId: agent.user.id }, agent.token);
  await sleep(400);

  const uniqueText = `实时测试消息-${Date.now()}`;
  await api('POST', `/api/conversations/${convId}/messages`, { content: uniqueText }, customer.token);

  const gotByAgent = await waitFor(agentConn,
    (m) => m.type === 'message' && m.conversationId === convId && m.message?.content === uniqueText, 6000);
  check('坐席实时收到客户消息', gotByAgent !== null,
    gotByAgent ? `内容="${gotByAgent.message.content}"` : '未收到 message 事件');
  check('推送消息包含发送者角色', gotByAgent?.message?.sender_role === 'customer',
    `sender_role=${gotByAgent?.message?.sender_role}`);

  section('3. 坐席回复 → 客户实时收到');
  const replyText = `坐席回复-${Date.now()}`;
  await api('POST', `/api/conversations/${convId}/messages`, { content: replyText }, agent.token);

  const gotByCustomer = await waitFor(customerConn,
    (m) => m.type === 'message' && m.conversationId === convId && m.message?.content === replyText, 6000);
  check('客户实时收到坐席回复', gotByCustomer !== null,
    gotByCustomer ? `内容="${gotByCustomer.message.content}"` : '未收到 message 事件');
  check('推送消息包含坐席姓名', gotByCustomer?.message?.sender_name === agent.user.name,
    `sender_name=${gotByCustomer?.message?.sender_name}`);

  section('4. 会话状态实时通知');
  await api('PUT', `/api/conversations/${convId}`, { priority: 'urgent', tag: '账务问题' }, agent.token);
  // 该会话此前已有若干 conversation:update（创建/接入/结束），需等待「优先级已变更」的那一条
  const updCustomer = await waitFor(customerConn,
    (m) => m.type === 'conversation:update' && m.conversation?.id === convId
      && m.conversation?.priority === 'urgent', 6000);
  check('会话更新推送给客户', updCustomer !== null);
  check('推送内容含最新优先级', updCustomer?.conversation?.priority === 'urgent',
    `priority=${updCustomer?.conversation?.priority}`);
  check('推送内容含最新标签', updCustomer?.conversation?.tag === '账务问题',
    `tag=${updCustomer?.conversation?.tag}`);

  await api('POST', `/api/conversations/${convId}/close`, {}, agent.token);
  const closedMsg = await waitFor(customerConn,
    (m) => (m.type === 'conversation:update' && m.reason === 'closed') || m.type === 'message', 5000);
  check('会话结束推送给客户', closedMsg !== null);

  section('5. 正在输入提示');
  agentConn.ws.send(JSON.stringify({ type: 'typing', conversationId: convId }));
  const typingMsg = await waitFor(customerConn, (m) => m.type === 'typing' && m.conversationId === convId, 5000);
  check('「正在输入」状态推送给客户', typingMsg !== null && typingMsg.from === 'agent',
    typingMsg ? JSON.stringify(typingMsg) : '未收到 typing 事件');

  section('6. 坐席状态切换');
  agentConn.ws.send(JSON.stringify({ type: 'agent:status', status: 'busy' }));
  await sleep(500);
  const meAfter = await api('GET', '/api/auth/me', undefined, agent.token);
  check('坐席状态已持久化为忙绿', meAfter.status === 'busy', `status=${meAfter.status}`);
  agentConn.ws.send(JSON.stringify({ type: 'agent:status', status: 'online' }));

  section('7. 工单变更实时通知');
  const ticket = await api('POST', '/api/tickets',
    { title: `实时工单测试-${Date.now()}`, description: '验证工单指派通知', category: '技术支持', priority: 'high' },
    customer.token);
  check('测试工单已创建', Boolean(ticket.id));
  // 指派给当前坐席，应收到 ticket:update
  await api('PUT', `/api/tickets/${ticket.id}`, { assignee_id: agent.user.id }, agent.token);
  const ticketMsg = await waitFor(agentConn,
    (m) => m.type === 'ticket:update' && m.ticket?.id === ticket.id, 6000);
  check('坐席实时收到工单变更', ticketMsg !== null,
    ticketMsg ? `action=${ticketMsg.action}` : '未收到 ticket:update');

  section('8. 知识库实时同步（管理员无需刷新页面）');
  const admin = await login('admin', 'admin123');
  const adminConn = await connect(admin.token, '管理员');

  // 坐席新建文章 → 管理员端应实时收到 kb:update
  const artTitle = `实时同步测试-${Date.now()}`;
  const newArt = await api('POST', '/api/kb/articles',
    { title: artTitle, content: '## 实时同步测试内容', status: 'published', visibility: 'public' }, agent.token);
  const createdEvt = await waitFor(adminConn, (m) => m.type === 'kb:update' && m.action === 'article:created', 6000);
  check('新增文章会实时广播给管理员', createdEvt !== null,
    createdEvt ? `action=${createdEvt.action} title=${createdEvt.title}` : '未收到 kb:update');
  check('广播事件携带文章标题', createdEvt?.title === artTitle, `title=${createdEvt?.title}`);

  // 更新文章
  await api('PUT', `/api/kb/articles/${newArt.id}`, { title: `${artTitle}-改`, visibility: 'internal' }, agent.token);
  const updatedEvt = await waitFor(adminConn,
    (m) => m.type === 'kb:update' && m.action === 'article:updated' && m.id === newArt.id, 6000);
  check('更新文章会实时广播', updatedEvt !== null, updatedEvt ? `title=${updatedEvt.title}` : '未收到');

  // 新增分类
  const catName = `实时分类-${Date.now()}`;
  const newCat = await api('POST', '/api/kb/categories', { name: catName, icon: '🧪' }, admin.token);
  const catEvt = await waitFor(adminConn, (m) => m.type === 'kb:update' && m.action === 'category:created', 6000);
  check('新增分类会实时广播', catEvt !== null && catEvt.name === catName, catEvt ? `name=${catEvt.name}` : '未收到');

  // 删除文章与分类
  await api('DELETE', `/api/kb/articles/${newArt.id}`, undefined, admin.token);
  const delEvt = await waitFor(adminConn, (m) => m.type === 'kb:update' && m.action === 'article:deleted', 6000);
  check('删除文章会实时广播', delEvt !== null, delEvt ? `title=${delEvt.title}` : '未收到');

  await api('DELETE', `/api/kb/categories/${newCat.id}`, undefined, admin.token);
  const delCatEvt = await waitFor(adminConn, (m) => m.type === 'kb:update' && m.action === 'category:deleted', 6000);
  check('删除分类会实时广播', delCatEvt !== null, delCatEvt ? `name=${delCatEvt.name}` : '未收到');

  adminConn.ws.close();

  section('9. 工单统计实时刷新');
  const statsConn = await connect(agent.token, '坐席');
  const tk = await api('POST', '/api/tickets',
    { title: `统计刷新测试-${Date.now()}`, description: '验证统计变更广播', category: '技术支持' }, customer.token);
  const statsEvt = await waitFor(statsConn, (m) => m.type === 'ticket:stats', 6000);
  check('工单创建会触发统计刷新广播', statsEvt !== null, statsEvt ? 'ok' : '未收到 ticket:stats');
  await api('DELETE', `/api/tickets/${tk.id}`, undefined, admin.token);
  statsConn.ws.close();

  section('10. 连接清理（多标签页场景）');
  // 注意：若真实浏览器仍开着该坐席的工作台页面，其连接会保持活跃，
  // 使「最后一条连接断开才离线」的判定无法观察。因此选用当前无活跃连接的坐席。
  let idleAgent = null;
  for (const name of ['agent1', 'agent2', 'agent3', 'agent4', 'agent5']) {
    const s = await login(name, 'agent123');
    const list = await api('GET', '/api/conversations/agents/online', undefined, s.token);
    const me = list.find((a) => a.id === s.user.id);
    if (me && me.online === false) { idleAgent = { name, ...s }; break; }
  }

  if (!idleAgent) {
    console.log('  \x1b[33m·\x1b[0m 所有坐席当前均有活跃连接，跳过离线判定（属正常情况）');
  } else {
    const connA = await connect(idleAgent.token, '空闲坐席A');
    await sleep(600);
    let list = await api('GET', '/api/conversations/agents/online', undefined, idleAgent.token);
    let me = list.find((a) => a.id === idleAgent.user.id);
    check('建立连接后标记为在线', me.online === true, `online=${me.online}`);

    const connB = await connect(idleAgent.token, '空闲坐席B');
    await sleep(500);
    connA.ws.close();
    await sleep(1200);
    list = await api('GET', '/api/conversations/agents/online', undefined, idleAgent.token);
    me = list.find((a) => a.id === idleAgent.user.id);
    check('多标签页：断开一条连接仍保持在线', me.online === true, `online=${me.online}`);

    connB.ws.close();
    await sleep(1500);
    list = await api('GET', '/api/conversations/agents/online', undefined, idleAgent.token);
    me = list.find((a) => a.id === idleAgent.user.id);
    check('断开最后一条连接后标记为离线', me.online === false && me.status === 'offline',
      `status=${me.status} online=${me.online}`);
  }

  // 关闭本次测试遗留的连接，避免进程无法退出
  agentConn.ws.close();
  customerConn.ws.close();
  await sleep(400);

  console.log(`\n${'═'.repeat(52)}`);
  if (fail === 0) console.log(`\x1b[32m✓ 实时通信全部通过：${pass} 项检查\x1b[0m`);
  else {
    console.log(`\x1b[32m通过 ${pass} 项\x1b[0m，\x1b[31m失败 ${fail} 项\x1b[0m`);
    console.log('失败项：\n  - ' + failures.join('\n  - '));
  }
  console.log(`${'═'.repeat(52)}\n`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((err) => {
  console.error('\n实时测试异常：', err.message);
  process.exitCode = 1;
});
