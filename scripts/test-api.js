/**
 * 端到端接口测试脚本（独立于 Windows 控制台编码，输出可靠）
 *   node scripts/test-api.js
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
}

async function req(method, path, body, token, raw = false) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return { status: res.status, text: await res.text() };
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data, ok: res.ok, payload: data?.data };
}

const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

(async () => {
  console.log(`\n=== 云客客服系统 端到端测试 ===\n目标：${BASE}`);

  /* ---------------- 健康检查 ---------------- */
  section('1. 服务健康检查');
  const health = await req('GET', '/api/health');
  check('GET /api/health 返回 200', health.status === 200 && health.payload?.status === 'ok');

  /* ---------------- 认证 ---------------- */
  section('2. 认证与权限');
  const badLogin = await req('POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
  check('错误密码被拒绝 (401)', badLogin.status === 401);

  const admin = (await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).payload;
  const agent = (await req('POST', '/api/auth/login', { username: 'agent1', password: 'agent123' })).payload;
  const agent2 = (await req('POST', '/api/auth/login', { username: 'agent2', password: 'agent123' })).payload;
  const cust = (await req('POST', '/api/auth/login', { username: 'user5', password: 'user123' })).payload;
  check('管理员可登录', Boolean(admin?.token) && admin.user.role === 'admin');
  check('坐席可登录', Boolean(agent?.token) && agent.user.role === 'agent');
  check('客户可登录', Boolean(cust?.token) && cust.user.role === 'customer');

  const me = await req('GET', '/api/auth/me', undefined, agent.token);
  check('GET /api/auth/me 返回当前用户', me.payload?.username === 'agent1');

  const forbidden = await req('GET', '/api/admin/users', undefined, cust.token);
  check('客户访问管理接口被拒绝 (403)', forbidden.status === 403);
  const noAuth = await req('GET', '/api/conversations');
  check('未登录访问受保护接口被拒绝 (401)', noAuth.status === 401);

  const settings = await req('GET', '/api/auth/settings');
  check('公开站点配置可读取', Boolean(settings.payload?.site_name));

  /* ---------------- 会话全流程 ---------------- */
  section('3. 在线会话全流程');
  const convRes = await req('POST', '/api/conversations',
    { channel: 'web', subject: '端到端测试会话', tag: '技术支持', priority: 'high' }, cust.token);
  const conv = convRes.payload.conversation;
  check('创建会话成功', Boolean(conv?.id), JSON.stringify(convRes.payload).slice(0, 120));
  check('会话编号格式正确 (KH...)', /^KH\d{8}-\d{4}$/.test(conv.code), conv.code);
  check('会话创建后带欢迎语消息', convRes.payload.messages.length >= 1);

  const beforeAssign = await req('GET', `/api/conversations/${conv.id}`, undefined, agent.token);
  check('自动分配引擎已派单或保持排队',
    beforeAssign.payload.conversation.status === 'queued' || beforeAssign.payload.conversation.agent_id !== null,
    `status=${beforeAssign.payload.conversation.status}`);

  const claim = await req('POST', `/api/conversations/${conv.id}/assign`, {}, agent.token);
  check('坐席接入会话成功', claim.payload?.agent_id === agent.user.id);
  check('接入后状态为 active', claim.payload?.status === 'active');

  const msg1 = await req('POST', `/api/conversations/${conv.id}/messages`, { content: '你好，接口调用返回 401' }, cust.token);
  check('客户发送消息成功', msg1.payload?.sender_role === 'customer');
  const msg2 = await req('POST', `/api/conversations/${conv.id}/messages`, { content: '您好，请检查 Authorization 头是否缺少 Bearer 前缀。' }, agent.token);
  check('坐席回复成功', msg2.payload?.sender_role === 'agent' && msg2.payload.sender_name === '林晓');

  const msgs = await req('GET', `/api/conversations/${conv.id}/messages`, undefined, agent.token);
  const hasSystem = msgs.payload.some((m) => m.sender_role === 'system');
  check('消息列表包含系统消息', hasSystem);
  check('消息按时间升序返回', msgs.payload.every((m, i, a) => i === 0 || a[i - 1].id < m.id));

  const unread = await req('GET', '/api/conversations?scope=mine&pageSize=50', undefined, agent.token);
  check('坐席「我的会话」列表包含该会话', unread.payload.list.some((c) => c.id === conv.id));

  const queueList = await req('GET', '/api/conversations?scope=queue', undefined, agent.token);
  check('排队列表接口可用', Array.isArray(queueList.payload.list));

  const kbSuggest = await req('GET', '/api/kb/suggest?q=密码', undefined, agent.token);
  check('知识库智能推荐可用', Array.isArray(kbSuggest.payload) && kbSuggest.payload.length > 0);

  const quick = await req('GET', '/api/conversations/quick-replies/list', undefined, agent.token);
  check('快捷话术列表可用（数组契约，含常用标记）',
    Array.isArray(quick.payload) && quick.payload.length > 0
    && quick.payload.every((q) => 'is_favorite' in q),
    `是数组=${Array.isArray(quick.payload)} 长度=${quick.payload?.length}`);

  const agentsOnline = await req('GET', '/api/conversations/agents/online', undefined, agent.token);
  check('可选坐席列表可用（转接用）', Array.isArray(agentsOnline.payload) && agentsOnline.payload.length > 0);

  const transfer = await req('POST', `/api/conversations/${conv.id}/assign`, { agentId: agent2.user.id }, agent.token);
  check('会话转接成功', transfer.payload?.agent_id === agent2.user.id);

  const meta = await req('PUT', `/api/conversations/${conv.id}`, { tag: '账务问题', priority: 'urgent' }, agent.token);
  check('会话标签与优先级更新成功', meta.payload?.tag === '账务问题' && meta.payload?.priority === 'urgent');

  const rating = await req('POST', `/api/conversations/${conv.id}/rating`, { rating: 5, comment: '非常专业，问题解决了' }, cust.token);
  check('客户评价成功', rating.payload?.rating === 5);

  const closed = await req('POST', `/api/conversations/${conv.id}/close`, {}, agent.token);
  check('结束会话成功', closed.payload?.status === 'closed');
  const closedAgain = await req('POST', `/api/conversations/${conv.id}/close`, {}, agent.token);
  check('重复结束会话幂等', closedAgain.payload?.status === 'closed');
  const sendClosed = await req('POST', `/api/conversations/${conv.id}/messages`, { content: 'test' }, cust.token);
  check('已结束会话拒绝发送消息', sendClosed.status >= 400);

  const stats = await req('GET', '/api/conversations/stats', undefined, agent.token);
  check('会话统计接口可用', typeof stats.payload?.queue === 'number' && typeof stats.payload?.active === 'number');

  /* ---------------- 工单全流程 ---------------- */
  section('4. 工单全流程');
  const tMeta = await req('GET', '/api/tickets/meta', undefined, agent.token);
  check('工单元数据（分类/优先级/坐席）可用',
    tMeta.payload?.categories?.length > 0 && Boolean(tMeta.payload.priorities));

  const tkRes = await req('POST', '/api/tickets',
    { title: '端到端测试工单：登录异常', description: '客户反馈无法登录，提示账号被锁定。', category: '技术支持', priority: 'high' }, cust.token);
  const ticket = tkRes.payload;
  check('创建工单成功', Boolean(ticket?.id), JSON.stringify(tkRes.payload).slice(0, 120));
  check('工单编号格式正确 (GD...)', /^GD\d{8}-\d{4}$/.test(ticket.code), ticket.code);
  check('工单按分类自动指派', ticket.assignee_id !== null, `assignee_id=${ticket.assignee_id}`);
  check('工单带 SLA 截止时间', Boolean(ticket.sla_due_at));

  const tkDetail = await req('GET', `/api/tickets/${ticket.id}`, undefined, agent.token);
  check('工单详情可读取', tkDetail.payload?.ticket?.id === ticket.id);
  check('工单创建生成处理记录', tkDetail.payload.comments.length >= 1);

  const tkComment = await req('POST', `/api/tickets/${ticket.id}/comments`, { content: '已重置账号状态，请客户重试。' }, agent.token);
  check('坐席回复工单成功', Boolean(tkComment.payload?.id));
  const internal = await req('POST', `/api/tickets/${ticket.id}/comments`, { content: '内部备注：该客户为VIP', internal: 1 }, agent.token);
  check('内部备注创建成功', internal.payload?.internal === 1);

  const custView = await req('GET', `/api/tickets/${ticket.id}`, undefined, cust.token);
  check('客户看不到内部备注', custView.payload.comments.every((c) => c.internal !== 1));

  const claimTk = await req('PUT', `/api/tickets/${ticket.id}`, { assignee_id: agent.user.id, status: 'processing' }, agent.token);
  check('工单指派与状态流转成功', claimTk.payload?.assignee_id === agent.user.id && claimTk.payload?.status === 'processing');

  const resolved = await req('PUT', `/api/tickets/${ticket.id}`, { status: 'resolved' }, agent.token);
  check('工单可标记为已解决', resolved.payload?.status === 'resolved' && Boolean(resolved.payload.resolved_at));

  const reopen = await req('POST', `/api/tickets/${ticket.id}/comments`, { content: '还是不行，麻烦再看下' }, cust.token);
  check('客户回复已解决工单自动重开', Boolean(reopen.payload));
  const afterReopen = await req('GET', `/api/tickets/${ticket.id}`, undefined, agent.token);
  check('重开后状态为 reopened', afterReopen.payload.ticket.status === 'reopened');

  const tkRate = await req('POST', `/api/tickets/${ticket.id}/rating`, { rating: 4, comment: '处理及时' }, cust.token);
  check('工单评价成功并自动关闭', tkRate.payload?.rating === 4 && tkRate.payload?.status === 'closed');

  const tkStats = await req('GET', '/api/tickets/stats', undefined, agent.token);
  check('工单统计接口可用', typeof tkStats.payload?.total === 'number' && Array.isArray(tkStats.payload.byCategory));

  const tkList = await req('GET', '/api/tickets?pageSize=5&scope=mine', undefined, agent.token);
  check('工单列表分页正常', tkList.payload?.pagination?.pageSize === 5 && Array.isArray(tkList.payload.list));

  /* ---------------- 知识库 ---------------- */
  section('5. 知识库 / 帮助中心');
  const cats = await req('GET', '/api/kb/categories');
  check('知识库分类列表可用', cats.payload.length > 0);

  const arts = await req('GET', '/api/kb/articles?pageSize=5');
  check('文章列表可用', arts.payload?.list?.length > 0);
  check('游客只能看到已发布公开文章', arts.payload.list.every((a) => a.status === 'published' && a.visibility === 'public'));

  const popular = await req('GET', '/api/kb/popular');
  check('热门文章接口可用', popular.payload.length > 0);

  const newArt = await req('POST', '/api/kb/articles',
    { title: '端到端测试文章', summary: '自动化测试生成', content: '## 测试\n\n这是一篇测试文章。', category_id: cats.payload[0].id, status: 'published', visibility: 'public', tags: ['测试'] }, agent.token);
  check('坐席可创建知识库文章', Boolean(newArt.payload?.id), JSON.stringify(newArt.payload).slice(0, 120));

  const updArt = await req('PUT', `/api/kb/articles/${newArt.payload.id}`, { title: '端到端测试文章（已更新）', visibility: 'internal' }, agent.token);
  check('文章可更新', updArt.payload?.title === '端到端测试文章（已更新）');

  const artDetail = await req('GET', `/api/kb/articles/${newArt.payload.id}`, undefined, agent.token);
  check('文章详情含相关推荐字段', Boolean(artDetail.payload?.article) && Array.isArray(artDetail.payload.related));

  const hidden = await req('GET', `/api/kb/articles/${newArt.payload.id}`);
  check('内部文章对游客不可见', hidden.status === 404);

  const feedback = await req('POST', `/api/kb/articles/${newArt.payload.id}/feedback`, { helpful: true });
  check('文章有用性反馈可用', feedback.status === 200);

  const adminArticle = await req('GET', '/api/kb/articles?visibility=internal', undefined, admin.token);
  check('管理员可筛选内部文章', adminArticle.payload.list.some((a) => a.visibility === 'internal'));

  const delArt = await req('DELETE', `/api/kb/articles/${newArt.payload.id}`, undefined, admin.token);
  check('管理员可删除文章', delArt.status === 200);
  const delByAgent = await req('DELETE', `/api/kb/articles/1`, undefined, agent.token);
  check('坐席删除文章被拒绝 (403)', delByAgent.status === 403);

  const kbStats = await req('GET', '/api/kb/stats', undefined, agent.token);
  check('知识库统计接口可用', typeof kbStats.payload?.totalViews === 'number');

  /* ---------------- 数据看板 ---------------- */
  section('6. 数据看板');
  const ov = await req('GET', '/api/dashboard/overview?range=7d', undefined, admin.token);
  check('看板总览返回 15+ 指标卡', Object.keys(ov.payload?.cards || {}).length >= 15,
    `实际 ${Object.keys(ov.payload?.cards || {}).length}`);
  check('看板含满意度与首响指标',
    ov.payload.cards.avgRating !== undefined && ov.payload.cards.avgResponseSec !== undefined);

  const trend = await req('GET', '/api/dashboard/trend?range=7d', undefined, admin.token);
  check('趋势数据返回 7 天', trend.payload.length === 7, `实际 ${trend.payload.length}`);
  check('趋势数据含会话/工单/评分维度', trend.payload[0].conversations !== undefined && trend.payload[0].tickets !== undefined);

  const perf = await req('GET', '/api/dashboard/agent-performance?range=7d', undefined, admin.token);
  check('坐席绩效排行可用', perf.payload.length > 0 && perf.payload[0].sessions !== undefined);

  const dist = await req('GET', '/api/dashboard/distribution?range=7d', undefined, admin.token);
  check('渠道/标签/评分/状态分布可用',
    dist.payload.channels.length > 0 && dist.payload.ratings.length === 5 && dist.payload.statuses.length > 0);

  const hourly = await req('GET', '/api/dashboard/hourly?range=7d', undefined, admin.token);
  check('24 小时分布返回 24 条', hourly.payload.length === 24);

  const realtime = await req('GET', '/api/dashboard/realtime', undefined, admin.token);
  check('实时概览可用', typeof realtime.payload?.queue === 'number');

  const csv = await req('GET', '/api/dashboard/export?range=7d', undefined, admin.token, true);
  check('CSV 报表导出可用', csv.text.includes('会话编号') && csv.text.split('\n').length > 1);

  /* ---------------- 管理后台 ---------------- */
  section('7. 管理后台');
  const aov = await req('GET', '/api/admin/overview', undefined, admin.token);
  check('管理概览可用', aov.payload?.users?.total > 0 && Array.isArray(aov.payload.departmentStats));

  const users = await req('GET', '/api/admin/users?pageSize=5', undefined, admin.token);
  check('用户列表分页可用', users.payload?.list?.length > 0);

  const depts = await req('GET', '/api/admin/departments', undefined, admin.token);
  check('部门列表可用', depts.payload.length > 0);

  const newUser = await req('POST', '/api/admin/users',
    { username: `e2e_${Date.now()}`, password: 'test123456', name: '端到端测试坐席', role: 'agent', department_id: depts.payload[0].id, level: '中级', skills: ['技术支持'], max_concurrent: 6 }, admin.token);
  check('新增坐席成功', Boolean(newUser.payload?.id), JSON.stringify(newUser.payload));

  const updUser = await req('PUT', `/api/admin/users/${newUser.payload.id}`, { level: '高级', max_concurrent: 8 }, admin.token);
  check('更新坐席成功', updUser.payload?.name === '端到端测试坐席');

  const toggle = await req('POST', `/api/admin/users/${newUser.payload.id}/toggle`, {}, admin.token);
  check('停用坐席成功', toggle.payload?.active === 0);

  const loginDisabled = await req('POST', '/api/auth/login', { username: newUser.payload.username, password: 'test123456' });
  check('被停用账号无法登录', loginDisabled.status === 401);

  const selfDelete = await req('DELETE', `/api/admin/users/${admin.user.id}`, undefined, admin.token);
  check('不能删除当前登录账号', selfDelete.status >= 400);

  const delUser = await req('DELETE', `/api/admin/users/${newUser.payload.id}`, undefined, admin.token);
  check('删除坐席成功', delUser.status === 200);

  const oldSettings = (await req('GET', '/api/admin/settings', undefined, admin.token)).payload.settings;
  const setRes = await req('PUT', '/api/admin/settings', { ticket_sla_hours: '12', site_slogan: '测试标语' }, admin.token);
  check('更新系统设置成功', setRes.payload?.ticket_sla_hours === '12');
  await req('PUT', '/api/admin/settings',
    { ticket_sla_hours: oldSettings.ticket_sla_hours, site_slogan: oldSettings.site_slogan }, admin.token);
  const restored = (await req('GET', '/api/admin/settings', undefined, admin.token)).payload.settings;
  check('系统设置可还原', restored.ticket_sla_hours === oldSettings.ticket_sla_hours);

  const qrList = await req('GET', '/api/admin/quick-replies', undefined, admin.token);
  check('快捷话术管理列表可用', qrList.payload.list.length > 0);

  const newQr = await req('POST', '/api/admin/quick-replies', { title: '端到端测试话术', content: '这是一条测试话术 {code}', category: '通用', scope: 'all' }, admin.token);
  check('新增快捷话术成功', Boolean(newQr.payload?.id));
  const delQr = await req('DELETE', `/api/admin/quick-replies/${newQr.payload.id}`, undefined, admin.token);
  check('删除快捷话术成功', delQr.status === 200);

  const logs = await req('GET', '/api/admin/audit-logs?pageSize=10', undefined, admin.token);
  check('操作日志已记录', logs.payload.list.length > 0 && logs.payload.list.some((l) => l.action));

  const notif = await req('GET', '/api/admin/notifications', undefined, agent.token);
  check('通知列表可用', Array.isArray(notif.payload?.list));
  await req('POST', '/api/admin/notifications/read', {}, agent.token);
  const notif2 = await req('GET', '/api/admin/notifications', undefined, agent.token);
  check('通知可标记已读', notif2.payload.unread === 0);

  const broadcast = await req('POST', '/api/admin/broadcast', { title: '端到端测试广播', body: '测试内容', type: 'info', target: 'all' }, admin.token);
  check('广播通知发送成功', broadcast.payload?.count > 0);

  /* ---------------- 上传 ---------------- */
  section('8. 文件上传');
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('test file content')], { type: 'text/plain' }), 'test.txt');
  const upRes = await fetch(`${BASE}/api/conversations/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${agent.token}` }, body: form,
  });
  const upJson = await upRes.json();
  check('文件上传成功', upJson.success && upJson.data?.url?.startsWith('/uploads/'), JSON.stringify(upJson).slice(0, 140));
  if (upJson.data?.url) {
    const fetched = await fetch(BASE + upJson.data.url);
    check('上传文件可通过 URL 访问', fetched.status === 200);
  }
  const unauth = await req('POST', '/api/conversations/upload');
  check('未登录上传被拒绝', unauth.status === 401 || unauth.status === 400);

  /* ---------------- 实时通信 ---------------- */
  section('9. WebSocket 实时通信');
  const wsUrl = BASE.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';
  const { WebSocket } = await import('ws');
  const wsResult = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => { ws.close(); resolve({ ok: false, reason: '超时' }); }, 8000);
    let authed = false;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: agent.token })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth:ok') { authed = true; ws.send(JSON.stringify({ type: 'ping' })); }
      else if (msg.type === 'pong' && authed) { clearTimeout(timeout); ws.close(); resolve({ ok: true }); }
    });
    ws.on('error', (e) => { clearTimeout(timeout); resolve({ ok: false, reason: e.message }); });
  });
  check('WebSocket 鉴权与心跳正常', wsResult.ok, wsResult.reason || '');

  const wsBad = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => { ws.close(); resolve({ rejected: false }); }, 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'invalid.token' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth:fail') { clearTimeout(timeout); resolve({ rejected: true }); }
    });
    ws.on('close', () => { clearTimeout(timeout); resolve({ rejected: true }); });
    ws.on('error', () => { clearTimeout(timeout); resolve({ rejected: true }); });
  });
  check('无效 Token 的 WebSocket 被拒绝', wsBad.rejected);

  /* ---------------- 静态页面 ---------------- */
  section('10. 前端页面与静态资源');
  for (const [path, marker] of [
    ['/', '<title>'], ['/agent', 'agent.js'], ['/admin', 'admin.js'], ['/help', '帮助'],
    ['/assets/base.css', '--brand'], ['/assets/common.js', 'Kefu'],
    ['/assets/customer.js', 'chat-panel'], ['/assets/agent.js', 'ws__list'], ['/assets/admin.js', 'dashboard'],
  ]) {
    const r = await fetch(BASE + path);
    const text = await r.text();
    check(`GET ${path} 可访问且内容正确`, r.status === 200 && text.includes(marker));
  }
  const nf = await fetch(BASE + '/definitely-not-exists');
  check('未知路径返回 404 页面', nf.status === 404);

  /* ---------------- 收尾 ---------------- */
  console.log(`\n${'═'.repeat(52)}`);
  if (fail === 0) {
    console.log(`\x1b[32m✓ 全部通过：${pass} 项检查\x1b[0m`);
  } else {
    console.log(`\x1b[32m通过 ${pass} 项\x1b[0m，\x1b[31m失败 ${fail} 项\x1b[0m`);
    console.log('失败项：\n  - ' + failures.join('\n  - '));
  }
  console.log(`${'═'.repeat(52)}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n测试脚本异常：', err);
  process.exit(1);
});
