/**
 * 新增功能专项测试
 *   node scripts/test-features.js
 * 覆盖：快捷话术「常用」收藏与置顶、会话文件库（附件列表与重发）
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

async function req(method, path, body, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, ok: res.ok, data, payload: data?.data, message: data?.message };
}

const login = async (u, p) => (await req('POST', '/api/auth/login', { username: u, password: p })).payload;

(async () => {
  console.log(`\n=== 新增功能专项测试 ===\n目标：${BASE}`);

  const agent = await login('agent1', 'agent123');
  const admin = await login('admin', 'admin123');
  const customer = await login('user5', 'user123');

  /* ============ 1. 快捷话术「常用」 ============ */
  section('1. 快捷话术「常用」收藏与置顶');

  const listRes = await req('GET', '/api/conversations/quick-replies/list', undefined, agent.token);
  // 契约：始终返回数组（不是 {list, favorites} 包装对象）
  check('话术列表返回数组（保持向后兼容契约）',
    Array.isArray(listRes.payload),
    `实际 ${Array.isArray(listRes.payload) ? '数组' : typeof listRes.payload}`);
  check('存在常用话术（is_favorite 标记）',
    listRes.payload.filter((q) => Number(q.is_favorite) === 1).length > 0,
    `常用 ${listRes.payload?.filter?.((q) => Number(q.is_favorite) === 1).length ?? 0} 条`);

  // 收藏的话术必须排在最前面
  const list = listRes.payload;
  const firstNonFav = list.findIndex((q) => q.is_favorite !== 1);
  const lastFav = list.map((q) => q.is_favorite === 1).lastIndexOf(true);
  check('常用话术已置顶（排在所有非常用之前）',
    firstNonFav === -1 || lastFav < firstNonFav,
    `最后一条常用位于 #${lastFav}，第一条非常用位于 #${firstNonFav}`);

  // 收藏一条非常用话术
  const target = list.find((q) => q.is_favorite !== 1);
  if (target) {
    const fav = await req('POST', `/api/conversations/quick-replies/${target.id}/favorite`, {}, agent.token);
    check('可将话术设为常用', fav.payload?.is_favorite === 1, `is_favorite=${fav.payload?.is_favorite}`);

    const list2 = (await req('GET', '/api/conversations/quick-replies/list', undefined, agent.token)).payload;
    const idx = list2.findIndex((q) => q.id === target.id);
    check('新收藏的话术立即进入置顶区', idx > -1 && Number(list2[idx].is_favorite) === 1 && idx < firstNonFav,
      `位置 #${idx}`);

    // 取消收藏
    const unfav = await req('POST', `/api/conversations/quick-replies/${target.id}/favorite`, { favorite: false }, agent.token);
    check('可取消常用', unfav.payload?.is_favorite === 0);

    // 恢复原状
    await req('POST', `/api/conversations/quick-replies/${target.id}/favorite`, { favorite: false }, agent.token);
  } else {
    check('存在可用于收藏的非常用话术', false, '所有话术都已是常用');
  }

  // 管理端接口
  const adminList = await req('GET', '/api/admin/quick-replies', undefined, admin.token);
  check('管理端话术列表包含收藏字段',
    adminList.payload.list.every((q) => 'is_favorite' in q),
    `字段存在`);
  const adminFav = adminList.payload.list.find((q) => q.is_favorite === 1);
  if (adminFav) {
    const toggle = await req('POST', `/api/admin/quick-replies/${adminFav.id}/favorite`, { favorite: false }, admin.token);
    check('管理端可取消常用', toggle.payload?.is_favorite === 0);
    await req('POST', `/api/admin/quick-replies/${adminFav.id}/favorite`, { favorite: true }, admin.token);
    const back = await req('GET', '/api/admin/quick-replies', undefined, admin.token);
    check('管理端可恢复常用', back.payload.list.find((q) => q.id === adminFav.id)?.is_favorite === 1);
  }

  // 权限：坐席不能收藏别人的个人话术
  const personal = adminList.payload.list.find((q) => q.scope === 'personal' && q.owner_id !== agent.user.id);
  if (personal) {
    const denied = await req('POST', `/api/conversations/quick-replies/${personal.id}/favorite`, {}, agent.token);
    check('坐席无法收藏他人个人话术 (403)', denied.status === 403, `status=${denied.status}`);
  } else {
    console.log('  \x1b[33m·\x1b[0m 无他人个人话术，跳过越权用例');
  }

  /* ============ 2. 会话文件库 ============ */
  section('2. 会话文件库（附件列表与重发）');

  const conv = (await req('POST', '/api/conversations', { channel: 'web', subject: '文件库测试' }, customer.token)).payload.conversation;
  await req('POST', `/api/conversations/${conv.id}/assign`, { agentId: agent.user.id }, agent.token);

  const empty = await req('GET', `/api/conversations/${conv.id}/files`, undefined, agent.token);
  check('空会话的文件库返回空列表',
    empty.payload?.list?.length === 0 && empty.payload.total === 0,
    JSON.stringify(empty.payload).slice(0, 80));

  // 上传两个文件（一个图片一个文档）
  const pngBytes = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082', 'hex');

  const upload = async (name, type, buf) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type }), name);
    const r = await fetch(`${BASE}/api/conversations/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${agent.token}` }, body: fd,
    });
    return (await r.json()).data;
  };

  const img = await upload('screenshot.png', 'image/png', pngBytes);
  const doc = await upload('error-log.txt', 'text/plain', Buffer.from('错误日志内容第一行\n第二行'));
  check('图片上传成功并识别为 image', img?.type === 'image', `type=${img?.type}`);
  check('文档上传成功并识别为 file', doc?.type === 'file', `type=${doc?.type}`);

  // 作为消息发送
  await req('POST', `/api/conversations/${conv.id}/messages`,
    { content: img.url, type: 'image', meta: { name: img.name, size: img.size, mime: img.mime } }, agent.token);
  await req('POST', `/api/conversations/${conv.id}/messages`,
    { content: doc.url, type: 'file', meta: { name: doc.name, size: doc.size, mime: doc.mime } }, customer.token);

  const files = await req('GET', `/api/conversations/${conv.id}/files`, undefined, agent.token);
  check('文件库列出 2 个附件', files.payload?.list?.length === 2, `实际 ${files.payload?.list?.length}`);
  check('文件库统计正确',
    files.payload.images === 1 && files.payload.files === 1
    && files.payload.fromAgent === 1 && files.payload.fromCustomer === 1,
    `images=${files.payload?.images} files=${files.payload?.files} agent=${files.payload?.fromAgent} customer=${files.payload?.fromCustomer}`);
  check('附件包含文件名', files.payload.list.some((f) => f.name === 'screenshot.png')
    && files.payload.list.some((f) => f.name === 'error-log.txt'));
  check('附件包含大小信息', files.payload.list.every((f) => typeof f.size === 'number' && f.size > 0));
  check('附件包含发送者信息', files.payload.list.every((f) => f.sender_role && f.sender_name));

  // 重发：用已有 URL 直接再发一条消息
  const resend = await req('POST', `/api/conversations/${conv.id}/messages`,
    { content: img.url, type: 'image', meta: { name: img.name, size: img.size } }, agent.token);
  check('可直接重发已有附件（无需重新上传）', Boolean(resend.payload?.id), JSON.stringify(resend.payload).slice(0, 80));

  const files2 = await req('GET', `/api/conversations/${conv.id}/files`, undefined, agent.token);
  check('重发后文件库不重复计数（同一文件合并）', files2.payload.list.length === 2,
    `实际 ${files2.payload.list.length}`);
  const resentFile = files2.payload.list.find((f) => f.url === img.url);
  check('合并后记录发送次数', resentFile?.times === 2, `times=${resentFile?.times}`);

  // 客户也能看自己会话的文件库
  const custFiles = await req('GET', `/api/conversations/${conv.id}/files`, undefined, customer.token);
  check('客户可查看自己会话的文件库', custFiles.payload?.list?.length === 2);

  // 权限：其他客户不能看
  const other = await login('user6', 'user123');
  const denied = await req('GET', `/api/conversations/${conv.id}/files`, undefined, other.token);
  check('其他客户无法查看该会话文件库 (403)', denied.status === 403, `status=${denied.status}`);

  // 附件 URL 可访问
  const fetched = await fetch(BASE + img.url);
  check('附件可通过 URL 访问', fetched.status === 200, `status=${fetched.status}`);

  console.log(`\n${'═'.repeat(52)}`);
  if (fail === 0) console.log(`\x1b[32m✓ 新增功能全部通过：${pass} 项检查\x1b[0m`);
  else {
    console.log(`\x1b[32m通过 ${pass} 项\x1b[0m，\x1b[31m失败 ${fail} 项\x1b[0m`);
    console.log('失败项：\n  - ' + failures.join('\n  - '));
  }
  console.log(`${'═'.repeat(52)}\n`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((err) => {
  console.error('\n测试异常：', err);
  process.exitCode = 1;
});
