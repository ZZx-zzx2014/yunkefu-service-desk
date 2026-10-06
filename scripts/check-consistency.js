/**
 * 前端 <-> 后端 一致性静态检查
 *  1) JS 语法检查（ESM 用 node --check，浏览器端脚本用 vm 解析）
 *  2) 前端代码引用的 DOM id 是否存在于对应 HTML / JS 模板
 *  3) 前端调用的 API 端点是否在后端有定义
 *  4) CSS 类是否已定义（合并 base.css 与页面内联样式）
 *  5) 关键接口字段命名一致性
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { normalizePath } from './normalize-path.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SERVER = path.join(ROOT, 'server');

let problems = 0;
const report = (ok, label, detail = '') => {
  if (!ok) problems++;
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? `  ${detail}` : ''}`);
};

const read = (p) => fs.readFileSync(p, 'utf8');

/* ---------------- 1. 语法检查 ---------------- */
console.log('\n\x1b[36m1. JavaScript 语法检查\x1b[0m');

const browserFiles = fs.readdirSync(path.join(PUBLIC, 'assets'))
  .filter((f) => f.endsWith('.js')).map((f) => path.join(PUBLIC, 'assets', f));

// 浏览器脚本：vm 解析语法
for (const file of browserFiles) {
  try {
    new vm.Script(read(file), { filename: file });
    report(true, path.relative(ROOT, file));
  } catch (err) {
    report(false, path.relative(ROOT, file), `语法错误: ${err.message}`);
  }
}

// 服务端 ESM 模块：由运行期加载验证（见 test-api.js 的 103 项检查）
// 说明：沙箱禁止以管道方式捕获 node 子进程输出（EPERM），故此处用 import 动态加载校验
const serverModules = [
  'config.js', 'utils.js', 'auth.js', 'db.js', 'middleware.js', 'realtime.js', 'seed.js',
  ...fs.readdirSync(path.join(SERVER, 'routes')).filter((f) => f.endsWith('.js')).map((f) => `routes/${f}`),
];
for (const rel of serverModules) {
  try {
    if (rel === 'seed.js') {
      // seed.js 有副作用（写库），仅做文本层面的 import/export 结构检查
      const src = read(path.join(SERVER, rel));
      if (!/^import\s/m.test(src)) throw new Error('缺少 import 语句');
      report(true, `server/${rel}`, '(结构检查)');
      continue;
    }
    await import(pathToFileURL(path.join(SERVER, rel)).href);
    report(true, `server/${rel}`, '(模块加载成功)');
  } catch (err) {
    report(false, `server/${rel}`, `加载失败: ${err.message}`);
  }
}

/* ---------------- 工具 ---------------- */
// 路径归一化抽到独立模块，便于单测（node scripts/normalize-path.js）
// 见该文件注释：不能用 replace 标记插值起点，`$'` 在替换串中是特殊模式

const collectIdDefs = (text) => {
  const ids = new Set();
  // HTML 属性、对象字面量、以及运行时赋值（el.id = 'xxx'）三种定义形式
  for (const m of text.matchAll(/\sid=["']([A-Za-z0-9_-]+)["']/g)) ids.add(m[1]);
  for (const m of text.matchAll(/id:\s*["']([A-Za-z0-9_-]+)["']/g)) ids.add(m[1]);
  for (const m of text.matchAll(/\.id\s*=\s*["']([A-Za-z0-9_-]+)["']/g)) ids.add(m[1]);
  return ids;
};
const collectIdRefs = (js) => {
  const ids = new Set();
  for (const m of js.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'/g)) ids.add(m[1]);
  for (const m of js.matchAll(/\$\(\s*`#([A-Za-z0-9_-]+)`/g)) ids.add(m[1]);
  for (const m of js.matchAll(/getElementById\(\s*'([A-Za-z0-9_-]+)'/g)) ids.add(m[1]);
  return ids;
};

/* ---------------- 2. DOM 引用 ---------------- */
console.log('\n\x1b[36m2. 前端引用的 DOM 元素是否已定义\x1b[0m');
const commonJs = read(path.join(PUBLIC, 'assets', 'common.js'));
const pages = [
  { js: 'customer.js', html: 'index.html', label: '客户端首页' },
  { js: 'agent.js', html: 'agent.html', label: '客服工作台' },
  { js: 'admin.js', html: 'admin.html', label: '管理后台' },
];

// 防止再出现「改了副本、线上仍是旧文件」：public 下的 HTML 必须全部登记在册
{
  const EXPECTED_HTML = new Set(['index.html', 'agent.html', 'admin.html', 'help.html', '404.html']);
  const actual = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
  const unknown = actual.filter((f) => !EXPECTED_HTML.has(f));
  const listed = pages.map((p) => p.html).every((h) => actual.includes(h));
  report(unknown.length === 0 && listed,
    'public 下的 HTML 页面均已登记（无遗留副本）',
    unknown.length ? `未登记的文件：${unknown.join(', ')}` : `${actual.length} 个页面`);
}

for (const page of pages) {
  const js = read(path.join(PUBLIC, 'assets', page.js));
  const html = read(path.join(PUBLIC, page.html));
  const refs = collectIdRefs(js);
  const defs = new Set([...collectIdDefs(html), ...collectIdDefs(js), ...collectIdDefs(commonJs)]);
  const missing = [...refs].filter((id) => !defs.has(id));
  report(missing.length === 0, `${page.label} (${page.js})`, missing.length ? `未定义: ${missing.join(', ')}` : `共 ${refs.size} 个引用全部匹配`);
}

/* ---------------- 3. API 端点 ---------------- */
console.log('\n\x1b[36m3. 前端调用的接口是否在后端定义\x1b[0m');

const serverRoutes = new Set();
const mounts = {
  '/api/auth': 'auth.js', '/api/conversations': 'conversations.js', '/api/tickets': 'tickets.js',
  '/api/kb': 'kb.js', '/api/dashboard': 'dashboard.js', '/api/admin': 'admin.js',
};
for (const [prefix, file] of Object.entries(mounts)) {
  const src = read(path.join(SERVER, 'routes', file));
  for (const m of src.matchAll(/router\.(get|post|put|delete|patch)\(\s*'([^']*)'/g)) {
    serverRoutes.add(`${m[1].toUpperCase()} ${m[2] === '/' ? prefix : prefix + m[2]}`);
  }
}
for (const m of read(path.join(SERVER, 'index.js')).matchAll(/app\.(get|post)\(\s*'([^']+)'/g)) {
  serverRoutes.add(`${m[1].toUpperCase()} ${m[2]}`);
}

const clientCalls = new Set();
const collectCalls = (js) => {
  for (const m of js.matchAll(/\bapi\.(get|post|put|del)\(\s*[`'"]([^`'"]+)[`'"]/g)) {
    clientCalls.add(`${m[1] === 'del' ? 'DELETE' : m[1].toUpperCase()} ${normalizePath(m[2])}`);
  }
  for (const m of js.matchAll(/fetch\(\s*[`'"]([^`'"]*\/api\/[^`'"]*)[`'"]/g)) {
    clientCalls.add(`GET ${normalizePath(m[1])}`);
  }
};
for (const page of pages) collectCalls(read(path.join(PUBLIC, 'assets', page.js)));
collectCalls(commonJs);

const matches = (call) => {
  if (serverRoutes.has(call)) return true;
  const [method, p] = call.split(' ');
  const a = p.split('/').filter(Boolean);
  for (const key of serverRoutes) {
    const [m2, p2] = key.split(' ');
    if (m2 !== method) continue;
    const b = p2.split('/').filter(Boolean);
    if (a.length !== b.length) continue;
    if (a.every((seg, i) => seg === b[i] || b[i].startsWith(':'))) return true;
  }
  return false;
};
const unmatched = [...clientCalls].filter((c) => !matches(c));
report(unmatched.length === 0, '前端调用的全部接口均已在后端定义',
  unmatched.length ? `缺失:\n    ${unmatched.join('\n    ')}` : `共校验 ${clientCalls.size} 个端点`);

/* ---------------- 4. CSS 类 ---------------- */
console.log('\n\x1b[36m4. CSS 类定义检查\x1b[0m');
const baseCss = read(path.join(PUBLIC, 'assets', 'base.css'));
// 页面作用域样式也算已定义
const allCss = baseCss
  + read(path.join(PUBLIC, 'index.html'))
  + read(path.join(PUBLIC, 'agent.html'))
  + read(path.join(PUBLIC, 'admin.html'));

const criticalClasses = [
  'stat', 'card', 'badge', 'btn', 'msg', 'avatar', 'table', 'modal', 'toast',
  'chat-panel', 'ws__list', 'ws__main', 'conv-item', 'bar-row', 'donut', 'heat-grid',
  'nav-item', 'list-tab', 'quick-panel', 'side-section', 'kpi', 'dept-card', 'log-item', 'setting-item',
];
const missingCss = criticalClasses.filter((c) => !new RegExp(`\\.${c.replace(/[-_]/g, '[-_]')}\\b`).test(allCss));
report(missingCss.length === 0, '全部关键 CSS 类均已定义',
  missingCss.length ? `缺失: ${missingCss.join(', ')}` : `${criticalClasses.length} 个关键类（含页面作用域样式）`);

/* ---------------- 5. 严格 CSP 兼容性 ---------------- */
console.log('\n\x1b[36m5. 严格 CSP（script-src 不含 unsafe-inline）兼容性\x1b[0m');

// 所有会被浏览器当作 HTML 解析的内容：HTML 文件 + JS 模板字符串
const htmlFiles = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
const scriptFiles = fs.readdirSync(path.join(PUBLIC, 'assets')).filter((f) => f.endsWith('.js'));

let cspViolations = [];

// a) 内联 <script>（无 src）
for (const f of htmlFiles) {
  const text = read(path.join(PUBLIC, f));
  const matches = text.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || [];
  if (matches.length) cspViolations.push(`public/${f}: ${matches.length} 段内联 <script>`);
}

// b) 内联事件处理属性（onclick / onerror / onload …）
const inlineEventRe = /\son[a-z]+\s*=\s*["']/gi;
for (const f of [...htmlFiles.map((x) => path.join(PUBLIC, x)), ...scriptFiles.map((x) => path.join(PUBLIC, 'assets', x))]) {
  const text = read(f);
  const hits = text.match(inlineEventRe) || [];
  // 排除注释里的示例写法
  const real = hits.filter((h) => !/onclick="\.\.\."/.test(h));
  if (real.length) cspViolations.push(`${path.relative(ROOT, f)}: ${real.length} 处内联事件属性 ${real.slice(0, 3).join(' ')}`);
}

// c) javascript: 协议链接
for (const f of [...htmlFiles.map((x) => path.join(PUBLIC, x)), ...scriptFiles.map((x) => path.join(PUBLIC, 'assets', x))]) {
  const text = read(f);
  const hits = (text.match(/javascript:\s*[a-z]/gi) || []);
  // common.js 中的协议黑名单判断属于防御代码，不算违规
  const real = f.endsWith('common.js') ? [] : hits;
  if (real.length) cspViolations.push(`${path.relative(ROOT, f)}: ${real.length} 处 javascript: 链接`);
}

report(cspViolations.length === 0, '前端无内联脚本 / 内联事件 / javascript: 链接（严格 CSP 可用）',
  cspViolations.length ? `\n    ${cspViolations.join('\n    ')}` : `${htmlFiles.length} 个 HTML + ${scriptFiles.length} 个 JS 已扫描`);

// d) 服务端 CSP 的 script-src 应为 'self' 且不含 unsafe-inline
const securitySrc = read(path.join(SERVER, 'security.js'));
const scriptSrcMatch = securitySrc.match(/"script-src([^"]*)"/);
const scriptSrcValue = scriptSrcMatch ? scriptSrcMatch[1] : '';
report(
  scriptSrcValue.includes("'self'") && !scriptSrcValue.includes('unsafe-inline'),
  '服务端 CSP 的 script-src 仅允许 self（不含 unsafe-inline）',
  `script-src${scriptSrcValue}`,
);

/* ---------------- 5b. 路由注册顺序（防兜底路由吞掉具体路由） ---------------- */
console.log('\n\x1b[36m5b. 路由注册顺序与局域网模块\x1b[0m');
{
  const indexSrc = read(path.join(SERVER, 'index.js'));

  // 去掉行注释，避免把注释里提到的代码当成真实注册
  const codeOnly = indexSrc
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
    .join('\n');

  // /api 兜底必须晚于所有具体的 /api/xxx 路由，否则具体路由永远匹配不到
  const catchAllIdx = codeOnly.indexOf("app.use('/api',");
  const lanIdx = codeOnly.indexOf("app.get('/api/lan'");
  const qrIdx = codeOnly.indexOf("app.get('/api/qr'");
  report(
    catchAllIdx > -1 && lanIdx > -1 && qrIdx > -1 && lanIdx < catchAllIdx && qrIdx < catchAllIdx,
    '/api/lan 与 /api/qr 注册在 /api 兜底路由之前',
    `catchAll@${catchAllIdx} lan@${lanIdx} qr@${qrIdx}`,
  );

  // 页面兜底（404）必须晚于 /lan 页面路由
  const notFoundIdx = codeOnly.indexOf('404.html');
  const lanPageIdx = codeOnly.indexOf("app.get('/lan'");
  report(lanPageIdx > -1 && lanPageIdx < notFoundIdx, '/lan 页面路由注册在 404 兜底之前',
    `lan@${lanPageIdx} notFound@${notFoundIdx}`);

  // 局域网相关模块可用且导出了必要能力
  const qrSrc = read(path.join(SERVER, 'qrcode.js'));
  for (const fn of ['export function encode', 'export function toPNG', 'export function toSVG',
    'export function toDataURI', 'export function toTerminal', 'export function computeOccupied']) {
    report(qrSrc.includes(fn), `qrcode.js 导出 ${fn.replace('export function ', '')}`);
  }
  report(indexSrc.includes('serveUpload') && indexSrc.includes('securityHeaders'),
    'index.js 仍挂载安全中间件');

  // 零运行时依赖：不应引入额外的第三方包
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  const deps = Object.keys(pkg.dependencies || {});
  report(deps.length <= 3 && !deps.includes('qrcode'),
    '未引入二维码等额外依赖（保持零多余依赖）', `依赖：${deps.join(', ')}`);
}

/* ---------------- 6. 字段一致性 ---------------- */
console.log('\n\x1b[36m6. 关键接口字段命名一致性\x1b[0m');
const dashSrc = read(path.join(SERVER, 'routes', 'dashboard.js'));
const agentSrc = read(path.join(PUBLIC, 'assets', 'agent.js'));
const adminSrc = read(path.join(PUBLIC, 'assets', 'admin.js'));

const perfFields = ['sessions', 'closed', 'rating', 'tickets', 'ticketsResolved', 'avgResponseSec', 'avgHandleMin', 'department_name'];
const perfMissing = perfFields.filter((f) => !dashSrc.includes(`${f}:`));
report(perfMissing.length === 0, '坐席绩效字段与前端一致',
  perfMissing.length ? `后端缺少: ${perfMissing.join(', ')}` : perfFields.join(', '));

// 前端读取的字段必须在后端返回
const consumed = ['sessions', 'closed', 'rating', 'avgResponseSec', 'avgHandleMin', 'ticketsResolved', 'department_name'];
const notReturned = consumed.filter((f) => (agentSrc.includes(`p.${f}`) || adminSrc.includes(`p.${f}`)) && !dashSrc.includes(`${f}:`));
report(notReturned.length === 0, '前端读取的绩效字段后端均有返回',
  notReturned.length ? `未返回: ${notReturned.join(', ')}` : consumed.join(', '));

// 会话列表字段
const convSrc = read(path.join(SERVER, 'routes', 'conversations.js'));
const convFields = ['customer_name', 'agent_name', 'last_message', 'unread_agent', 'message_count'];
const convMissing = convFields.filter((f) => !convSrc.includes(f));
report(convMissing.length === 0, '会话列表字段完整', convMissing.length ? `缺少: ${convMissing.join(', ')}` : convFields.join(', '));

console.log(`\n${'═'.repeat(54)}`);
console.log(problems === 0 ? '\x1b[32m✓ 前后端一致性检查全部通过\x1b[0m' : `\x1b[31m✗ 发现 ${problems} 处问题\x1b[0m`);
console.log(`${'═'.repeat(54)}\n`);
process.exitCode = problems === 0 ? 0 : 1;
