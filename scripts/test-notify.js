/**
 * 场景化复现：模拟真人的操作顺序
 *   A. 客户已在会话中，客服尚未打开该会话
 *   B. 会话是「排队中」状态时客户发消息
 *   C. 客服在「全部」标签下能看到但没打开
 *   D. 消息发送后客服才登录
 */
import { WebSocket } from 'ws';

const BASE = 'http://127.0.0.1:3000';
const login = async (u, p) => (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: u, password: p }),
})).json()).data;
const api = async (m, p, b, t) => (await (await fetch(BASE + p, {
  method: m, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b),
})).json()).data;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openPage(token, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:3000/ws');
    const frames = [];
    const t = setTimeout(() => reject(new Error(`${label} 超时`)), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth:ok') { clearTimeout(t); resolve({ ws, frames, label }); }
      else if (msg.type === 'auth:fail') { clearTimeout(t); reject(new Error(`${label} 鉴权失败`)); }
      else frames.push(msg);
    });
    ws.on('error', reject);
  });
}

const results = [];
const scenario = async (name, fn) => {
  try {
    const r = await fn();
    results.push([name, r.ok, r.note]);
    console.log(`\n${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}`);
    console.log(`   ${r.note}`);
  } catch (err) {
    results.push([name, false, err.message]);
    console.log(`\n\x1b[31m✗\x1b[0m ${name}\n   异常：${err.message}`);
  }
};

/* ============ 场景 A：客服未打开该会话时客户发消息 ============ */
await scenario('A. 客服在线但未打开该会话 → 客户发消息', async () => {
  const agent = await login('agent3', 'agent123');
  const customer = await login('user8', 'user123');
  const agentPage = await openPage(agent.token, '坐席');

  // 客户发起新会话（user8 可能已有未结束会话，会被复用）
  const conv = await api('POST', '/api/conversations', { channel: 'web', subject: 'A测试' }, customer.token);
  const convId = conv.conversation.id;
  await sleep(600);
  agentPage.frames.length = 0;

  await api('POST', `/api/conversations/${convId}/messages`, { content: `A-${Date.now()}` }, customer.token);
  await sleep(1000);

  // 该会话可能被自动分配给别的坐席；无论归属如何，当前坐席都必须收到通知
  const detail = await api('GET', `/api/conversations/${convId}`, undefined, agent.token);
  const isMine = detail.conversation.agent_id === agent.user.id;
  const msgFrames = agentPage.frames.filter((f) => f.type === 'message' && f.conversationId === convId);
  const queueFrames = agentPage.frames.filter((f) =>
    (f.type === 'queue:update' || f.type === 'queue:refresh') && f.conversationId === convId);
  const notified = msgFrames.length > 0 || queueFrames.some((f) => f.message);

  agentPage.ws.close();
  return {
    ok: notified,
    note: `会话负责人${isMine ? '是本坐席' : '是其他坐席'}；` +
      `收到直达 message 帧 ${msgFrames.length} 个、带消息的队列帧 ${queueFrames.filter((f) => f.message).length} 个` +
      (notified ? '' : ' ← 坐席端无法实时感知这条消息'),
  };
});

/* ============ 场景 B：会话处于「排队中」时客户连发多条 ============ */
await scenario('B. 会话排队中（无坐席可分配）客户连发消息', async () => {
  const customer = await login('user4', 'user123');
  const agent = await login('agent4', 'agent123');
  const customerPage = await openPage(customer.token, '客户');
  const agentPage = await openPage(agent.token, '坐席');

  const conv = await api('POST', '/api/conversations', { channel: 'web', subject: 'B测试' }, customer.token);
  const convId = conv.conversation.id;
  await sleep(800);
  agentPage.frames.length = 0;

  await api('POST', `/api/conversations/${convId}/messages`, { content: 'B第一条' }, customer.token);
  await sleep(400);
  await api('POST', `/api/conversations/${convId}/messages`, { content: 'B第二条' }, customer.token);
  await sleep(1000);

  const detail = await api('GET', `/api/conversations/${convId}`, undefined, agent.token);
  const isMine = detail.conversation.agent_id === agent.user.id;
  const direct = agentPage.frames.filter((f) => f.type === 'message' && f.conversationId === convId);
  const relayed = agentPage.frames.filter((f) =>
    (f.type === 'queue:update') && f.conversationId === convId && f.message?.sender_role === 'customer');
  const total = new Set([...direct, ...relayed].map((f) => f.message?.id)).size;

  customerPage.ws.close();
  agentPage.ws.close();
  return {
    ok: total >= 2,
    note: `会话负责人${isMine ? '是本坐席' : '是其他坐席'}；客服端共收到 ${total}/2 条客户消息 ` +
      `(直达 ${direct.length}，转发 ${relayed.length})`,
  };
});

/* ============ 场景 C：客服后登录，之前发的消息能否看到 ============ */
await scenario('C. 客户先发消息，客服后登录（历史消息）', async () => {
  const customer = await login('user2', 'user123');
  const agent = await login('agent1', 'agent123');

  const conv = await api('POST', '/api/conversations', { channel: 'web', subject: 'C测试', tag: '技术支持' }, customer.token);
  const convId = conv.conversation.id;
  await api('POST', `/api/conversations/${convId}/messages`, { content: 'C-客户先发的消息' }, customer.token);
  await sleep(500);

  // 客服此刻才登录并拉列表
  const list = await api('GET', '/api/conversations?scope=all&pageSize=50', undefined, agent.token);
  const detail = await api('GET', `/api/conversations/${convId}`, undefined, agent.token);
  const msgs = await api('GET', `/api/conversations/${convId}/messages`, undefined, agent.token);

  const inList = list.list.some((c) => c.id === convId);
  const hasMsg = msgs.some((m) => m.content === 'C-客户先发的消息');
  return {
    ok: inList && hasMsg,
    note: `会话在列表中=${inList}，消息可读取=${hasMsg}，会话 assigned_agent=${detail.conversation.agent_name || '未分配'}`,
  };
});

/* ============ 场景 D：客服已打开的会话，客户发消息 ============ */
await scenario('D. 客服已打开该会话 → 客户发消息', async () => {
  const customer = await login('user3', 'user123');
  const agent = await login('agent5', 'agent123');
  const agentPage = await openPage(agent.token, '坐席');

  const conv = await api('POST', '/api/conversations', { channel: 'web', subject: 'D测试' }, customer.token);
  const convId = conv.conversation.id;
  await api('POST', `/api/conversations/${convId}/assign`, { agentId: agent.user.id }, agent.token);
  await api('GET', `/api/conversations/${convId}/messages`, undefined, agent.token);
  await sleep(600);
  agentPage.frames.length = 0;

  await api('POST', `/api/conversations/${convId}/messages`, { content: `D-${Date.now()}` }, customer.token);
  await sleep(1000);

  const frames = agentPage.frames.filter((f) => f.type === 'message' && f.conversationId === convId);
  agentPage.ws.close();
  return { ok: frames.length > 0, note: `客服端收到 ${frames.length} 条实时消息` };
});

console.log(`\n${'═'.repeat(60)}`);
console.log('复现结论');
console.log('═'.repeat(60));
for (const [name, ok, note] of results) {
  console.log(`${ok ? '\x1b[32m通过\x1b[0m' : '\x1b[31m失败\x1b[0m'}  ${name}`);
  console.log(`      ${note}`);
}
const failed = results.filter(([, ok]) => !ok).length;
console.log('═'.repeat(60));
console.log(failed === 0 ? '\x1b[32m全部场景通过\x1b[0m' : `\x1b[31m${failed} 个场景失败\x1b[0m`);
console.log('═'.repeat(60) + '\n');
process.exitCode = failed === 0 ? 0 : 1;
