/**
 * 接口返回结构契约测试
 *   node scripts/test-contract.js
 *
 * 目的：前端代码大量依赖接口返回的「形状」（数组 / 对象 / 字段名）。
 * 一旦把返回从数组改成对象，已缓存的旧前端就会在运行时抛出
 * 「xxx.slice 不是函数」这类难以定位的错误。
 * 本测试把每个接口的形状固化为断言，防止再次发生破坏性变更。
 */
import http from 'node:http';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const BASE_URL = new URL(BASE);
const BASE_HOST = BASE_URL.hostname;
const BASE_PORT = BASE_URL.port || '80';

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label} ${extra}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

const login = async (u, p) => (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: u, password: p }),
})).json()).data;

const get = async (path, token) => {
  const r = await fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isArr = (v) => Array.isArray(v);

const A = (await login('agent1', 'agent123')).token;
const AD = (await login('admin', 'admin123')).token;

console.log(`\n=== 接口返回结构契约测试 ===\n目标：${BASE}`);

/* ---------------- 数组型返回值 ---------------- */
section('返回数组的接口（前端会直接 .slice()/.map()）');

const arrayEndpoints = [
  ['/api/kb/categories', null, '知识库分类'],
  ['/api/kb/popular', null, '热门文章'],
  ['/api/dashboard/trend?range=7d', AD, '趋势数据'],
  ['/api/dashboard/hourly?range=7d', AD, '24 小时分布'],
  ['/api/dashboard/agent-performance?range=7d', AD, '坐席绩效'],
  ['/api/conversations/quick-replies/list', A, '快捷话术'],
  ['/api/conversations/agents/online', A, '可选坐席'],
  ['/api/admin/departments', AD, '部门列表'],
];

for (const [path, token, label] of arrayEndpoints) {
  const r = await get(path, token);
  const v = r.json?.data;
  const ok = r.status === 200 && isArr(v);
  let methodsOk = false;
  if (ok) {
    try {
      const a = v.slice(0, 2);
      const b = v.map((x) => x);
      const c = v.filter(() => true);
      const d = [...v];
      methodsOk = isArr(a) && isArr(b) && isArr(c) && isArr(d);
    } catch { methodsOk = false; }
  }
  check(`${label}：返回数组且 slice/map/filter/展开 可用`,
    ok && methodsOk,
    ok ? '数组方法异常' : `实际返回 ${isArr(v) ? '数组' : typeof v}（status=${r.status}）`);
}

{
  const r = await get('/api/tickets/meta', A);
  check('工单元数据：categories / agents 为数组',
    isArr(r.json?.data?.categories) && isArr(r.json?.data?.agents));
}

/* ---------------- 对象含 list 的接口 ---------------- */
section('返回 { list, pagination } 的分页接口');

const pagedEndpoints = [
  ['/api/conversations?pageSize=2', A, '会话列表'],
  ['/api/conversations?scope=mine&pageSize=2', A, '我的会话'],
  ['/api/tickets?pageSize=2', A, '工单列表'],
  ['/api/kb/articles?pageSize=2', null, '知识库文章'],
  ['/api/admin/users?pageSize=2', AD, '用户列表'],
  ['/api/admin/audit-logs?pageSize=2', AD, '操作日志'],
];

for (const [path, token, label] of pagedEndpoints) {
  const r = await get(path, token);
  const v = r.json?.data;
  check(`${label}：{ list: 数组, pagination: 对象 }`,
    r.status === 200 && isArr(v?.list) && isObj(v?.pagination),
    `list=${isArr(v?.list) ? 'array' : typeof v?.list} pagination=${isObj(v?.pagination) ? 'object' : typeof v?.pagination}`);
  check(`${label}：pagination 含 page/pageSize/total/totalPages`,
    typeof v?.pagination?.page === 'number' && typeof v?.pagination?.pageSize === 'number'
    && typeof v?.pagination?.total === 'number' && typeof v?.pagination?.totalPages === 'number');
}

/* ---------------- 快捷话术字段契约（本次 bug 的直接来源） ---------------- */
section('快捷话术：数组契约 + 常用字段');
{
  const r = await get('/api/conversations/quick-replies/list', A);
  const v = r.json?.data;
  check('快捷话术返回纯数组（不是包装对象）', isArr(v), `实际 ${isArr(v) ? '数组' : typeof v}`);
  check('每项含 is_favorite 字段', isArr(v) && v.every((q) => 'is_favorite' in q),
    isArr(v) ? `缺少字段的项：${v.filter((q) => !('is_favorite' in q)).length}` : '');
  check('每项含 use_count / title / content / category',
    isArr(v) && v.every((q) => 'use_count' in q && 'title' in q && 'content' in q && 'category' in q));

  if (isArr(v) && v.length) {
    const firstNonFav = v.findIndex((q) => Number(q.is_favorite) !== 1);
    const lastFav = v.map((q) => Number(q.is_favorite) === 1).lastIndexOf(true);
    check('常用话术置顶（排在非常用之前）', firstNonFav === -1 || lastFav < firstNonFav,
      `lastFav=${lastFav} firstNonFav=${firstNonFav}`);
  }

  // 模拟旧前端写法：res.slice(0, 6) 不应抛错（这正是报错场景）
  let legacyOk = true;
  let legacyErr = '';
  try {
    const s = v.slice(0, 6);
    const m = s.map((q) => q.title);
    void m;
  } catch (err) { legacyOk = false; legacyErr = err.message; }
  check('旧前端写法 res.slice(0,6).map(...) 不报错', legacyOk, legacyErr);
}

/* ---------------- 其它关键形状 ---------------- */
section('其它关键返回形状');
{
  const me = await get('/api/auth/me', A);
  check('/api/auth/me 返回用户对象', isObj(me.json?.data) && typeof me.json.data.id === 'number');

  const settings = await get('/api/auth/settings');
  check('/api/auth/settings 返回对象', isObj(settings.json?.data));

  const stats = await get('/api/conversations/stats', A);
  check('/api/conversations/stats 返回对象且含数值字段',
    isObj(stats.json?.data) && typeof stats.json.data.queue === 'number'
    && typeof stats.json.data.active === 'number');

  const ov = await get('/api/dashboard/overview?range=7d', AD);
  check('/api/dashboard/overview 返回 { cards: 对象 }',
    isObj(ov.json?.data) && isObj(ov.json?.data?.cards));

  const detail = await get('/api/conversations/1', A);
  check('/api/conversations/:id 返回 { conversation, customerStats, history }',
    isObj(detail.json?.data) && isObj(detail.json.data.conversation)
    && isObj(detail.json.data.customerStats) && isArr(detail.json.data.history));

  const files = await get('/api/conversations/1/files', A);
  check('/api/conversations/:id/files 返回 { list: 数组, total: 数值 }',
    isObj(files.json?.data) && isArr(files.json.data.list) && typeof files.json.data.total === 'number');

  const notif = await get('/api/admin/notifications', A);
  check('/api/admin/notifications 返回 { list: 数组, unread: 数值 }',
    isObj(notif.json?.data) && isArr(notif.json.data.list) && typeof notif.json.data.unread === 'number');

  const qrAdmin = await get('/api/admin/quick-replies', AD);
  check('/api/admin/quick-replies 返回 { list: 数组, categories: 数组 }',
    isObj(qrAdmin.json?.data) && isArr(qrAdmin.json.data.list) && isArr(qrAdmin.json.data.categories));

  const kbStats = await get('/api/kb/stats', A);
  check('/api/kb/stats 含 categoriesStat / topArticles 数组',
    isObj(kbStats.json?.data) && isArr(kbStats.json.data.categoriesStat) && isArr(kbStats.json.data.topArticles));

  const kbDetail = await get('/api/kb/articles/1');
  check('/api/kb/articles/:id 返回 { article, related, prev, next }',
    isObj(kbDetail.json?.data) && isObj(kbDetail.json.data.article) && isArr(kbDetail.json.data.related));

  const realtime = await get('/api/dashboard/realtime', A);
  check('/api/dashboard/realtime 返回对象且含队列数值',
    isObj(realtime.json?.data) && typeof realtime.json.data.queue === 'number');
}

/* ---------------- 错误响应形状 ---------------- */
section('错误响应形状');
{
  const r = await fetch(`${BASE}/api/conversations/99999`, { headers: { Authorization: `Bearer ${A}` } });
  const j = await r.json();
  check('错误响应统一为 { success: false, code, message, data }',
    j.success === false && typeof j.code === 'number' && typeof j.message === 'string' && 'data' in j);

  const unauth = await fetch(`${BASE}/api/conversations`);
  const uj = await unauth.json();
  check('未登录返回 401 且结构一致', unauth.status === 401 && uj.success === false);
}

/* ---------------- 静态资源缓存策略 ---------------- */
section('静态资源缓存策略（防止浏览器执行旧版前端）');
{
  for (const [p, label] of [['/', '页面'], ['/agent', '工作台页面'], ['/assets/agent.js', '前端脚本'], ['/assets/base.css', '样式表']]) {
    const r = await fetch(BASE + p);
    const cc = r.headers.get('cache-control') || '';
    check(`${label} 使用协商缓存（no-cache/must-revalidate）`,
      /no-cache|must-revalidate/.test(cc), `Cache-Control: ${cc}`);
  }
}

/* ---------------- 安全响应头（扫描器告警回归） ---------------- */
section('安全响应头');
{
  const r = await fetch(BASE + '/');
  // Burp 曾报「X-XSS-Protection: 0 禁用了浏览器 XSS 过滤器」（信息级，CWE-16）。
  // 修复取值 1; mode=block；用断言锁定，防止回退到 0。
  const xss = r.headers.get('x-xss-protection') || '';
  check('X-XSS-Protection 为 block 模式（非禁用）',
    /^1;\s*mode=block/i.test(xss), `实际值：${xss || '缺失'}`);
  check('X-Content-Type-Options: nosniff',
    (r.headers.get('x-content-type-options') || '').toLowerCase() === 'nosniff');
  const csp = r.headers.get('content-security-policy') || '';
  check('CSP 存在且 script-src 不含 unsafe-inline',
    /script-src[^;]*'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp),
    csp ? 'script-src 段含 unsafe-inline' : 'CSP 缺失');
  check('X-Frame-Options 限制同源',
    /sameorigin/i.test(r.headers.get('x-frame-options') || ''));
}

/* ---------------- 响应压缩（gzip 加速） ---------------- */
section('响应压缩（零依赖 gzip，加速访问）');
{
  /**
   * 注意：Node 的 fetch(undici) 会自动解压带 Content-Encoding 的响应体，
   * 用它比较“压缩前后大小”永远相等（这正是本测试曾误报的原因）。
   * 因此这里用原始 http 模块拿真实字节，以 gzip 魔数(1f 8b)与
   * content-length 与原文之比作为判定依据。
   */
  const rawBytes = (path, acceptEncoding) => new Promise((resolve, reject) => {
    http.request({ host: BASE_HOST, port: BASE_PORT, path, headers: acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        encoding: res.headers['content-encoding'] || '',
        length: res.headers['content-length'],
        bytes: Buffer.concat(chunks),
      }));
    }).on('error', reject).end();
  });

  // 场景1：CSS —— 应返回真 gzip
  const gz = await rawBytes('/assets/base.css', 'gzip');
  const isRealGzip = gz.bytes[0] === 0x1f && gz.bytes[1] === 0x8b;
  check('CSS 返回真 gzip（魔数 1f8b）', isRealGzip,
    `Content-Encoding: ${gz.encoding || '无'} · 前2字节 ${gz.bytes.subarray(0, 2).toString('hex')}`);

  // 场景2：压缩率 —— 用 content-length（线上传输大小）对比 identity 的实际字节
  const plain = await rawBytes('/assets/base.css', 'identity');
  const saved = plain.bytes.byteLength ? (1 - gz.bytes.byteLength / plain.bytes.byteLength) : 0;
  check('压缩率有效（体积减少 ≥ 40%）', isRealGzip && saved >= 0.4,
    `原始 ${plain.bytes.byteLength}B → 线上传输 ${gz.bytes.byteLength}B（省 ${(saved * 100).toFixed(0)}%）`);

  const varyOk = await new Promise((resolve) => {
    http.request({ host: BASE_HOST, port: BASE_PORT, path: '/assets/base.css', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      resolve(/accept-encoding/i.test(res.headers.vary || ''));
      res.resume();
    }).end();
  });
  check('压缩响应带 Vary: Accept-Encoding（缓存正确性）', varyOk);

  // 场景3：无压缩能力客户端拿原文
  check('无压缩能力时返回原始内容（兼容性）',
    plain.encoding === '' && plain.bytes.byteLength > 1024 && plain.bytes.subarray(0, 2).toString('hex') !== '1f8b',
    `Content-Encoding: ${plain.encoding || '无'}`);

  // 场景4：大 JSON 同样压缩
  const jsonGz = await rawBytes('/api/kb/articles?pageSize=50', 'gzip');
  check('JSON 接口同样压缩（响应体 > 1KB）',
    jsonGz.bytes[0] === 0x1f && jsonGz.bytes[1] === 0x8b,
    `Content-Encoding: ${jsonGz.encoding || '无'}`);

  // 场景5：小响应按设计跳过
  const small = await rawBytes('/api/health', 'gzip');
  check('小响应（< 1KB）按设计跳过压缩',
    small.encoding === '', `Content-Encoding: ${small.encoding || '无'}`);
}

console.log(`\n${'═'.repeat(56)}`);
if (fail === 0) console.log(`\x1b[32m✓ 接口契约测试全部通过：${pass} 项检查\x1b[0m`);
else {
  console.log(`\x1b[32m通过 ${pass} 项\x1b[0m，\x1b[31m失败 ${fail} 项\x1b[0m`);
  console.log('失败项：\n  - ' + failures.join('\n  - '));
}
console.log(`${'═'.repeat(56)}\n`);
process.exitCode = fail === 0 ? 0 : 1;
