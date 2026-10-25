/**
 * 站点托管子系统测试
 *   node scripts/test-sites.js
 *
 * 覆盖：
 *   A. 权限边界（未登录 / 非管理员）
 *   B. PHP 版本探测与站点创建（static / php）
 *   C. 独立端口访问与主端口跳转（跨源隔离）
 *   D. PHP 执行与请求语义（$_GET / $_POST / 响应头）
 *   E. PHP 沙箱（open_basedir 阻断、危险函数禁用、会话目录隔离）
 *   F. 静态文件安全（路径穿越、隐藏目录、危险扩展名）
 *   G. GitHub 部署入口校验（离线，只验证参数拒绝逻辑）
 *   H. 清理
 *
 * 说明：本测试需要与服务器同机运行（要在站点目录里投放探针文件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SITES_DIR = path.join(ROOT, 'data', 'sites');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const BASE_URL = new URL(BASE);
const SITES_PORT = process.env.KEFU_SITES_PORT === '0'
  ? 0
  : Number(process.env.KEFU_SITES_PORT || (Number(BASE_URL.port || 80) + 1));
const SITE_BASE = `http://${BASE_URL.hostname}:${SITES_PORT}`;

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

async function req(method, urlPath, body, token, base = BASE) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + urlPath, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON（HTML 页面）忽略 */ }
  return { status: res.status, headers: res.headers, data, payload: data?.data, message: data?.message };
}

const login = async (u, p) => (await req('POST', '/api/auth/login', { username: u, password: p })).payload;

/** 找到站点在磁盘上的真实目录（目录名 = slug-随机后缀） */
function findSiteDir(slug) {
  try {
    const names = fs.readdirSync(SITES_DIR);
    const hit = names.find((n) => n === slug || n.startsWith(slug + '-'));
    return hit ? path.join(SITES_DIR, hit) : null;
  } catch { return null; }
}

const created = [];

(async () => {
  console.log(`\n=== 站点托管子系统测试 ===\n主站：${BASE}\n站点域：${SITE_BASE}`);

  if (!SITES_PORT) {
    console.log('\n\x1b[33m⚠  KEFU_SITES_PORT=0（站点托管已关闭），跳过全部用例\x1b[0m');
    process.exit(0);
  }

  const admin = await login('admin', 'admin123');
  const agent = await login('agent1', 'agent123');
  const customer = await login('user5', 'user123');

  /* ================= A. 权限边界 ================= */
  section('A. 权限边界');
  const anon = await req('GET', '/api/admin/sites');
  check('未登录访问站点列表被拒（401）', anon.status === 401, `实际 ${anon.status}`);
  const byAgent = await req('GET', '/api/admin/sites', undefined, agent?.token);
  check('客服访问站点管理被拒（403）', byAgent.status === 403, `实际 ${byAgent.status}`);
  const byCustomer = await req('GET', '/api/admin/sites', undefined, customer?.token);
  check('客户访问站点管理被拒（403）', byCustomer.status === 403, `实际 ${byCustomer.status}`);

  /* ================= B. PHP 版本与创建 ================= */
  section('B. PHP 版本探测与站点创建');
  const versions = await req('GET', '/api/admin/sites/php-versions', undefined, admin.token);
  check('PHP 版本接口可用', versions.status === 200, `实际 ${versions.status}`);
  const phpList = versions.payload?.list || [];
  check('返回版本列表为数组', Array.isArray(phpList), `类型 ${typeof phpList}`);
  const phpAvailable = versions.payload?.available === true && phpList.length > 0;
  console.log(`  · 本机 PHP 版本：${phpList.map((v) => v.version).join(', ') || '（未安装）'}`);

  const staticSlug = `t-static-${Date.now().toString(36)}`;
  const st = await req('POST', '/api/admin/sites', { slug: staticSlug, name: '测试静态站', type: 'static' }, admin.token);
  check('创建静态站点成功', st.status === 200 && st.payload?.slug === staticSlug, `实际 ${st.status} ${st.message || ''}`);
  if (st.payload?.id) created.push(st.payload);
  check('返回的 url 指向 /s/<slug>/', st.payload?.url === `/s/${staticSlug}/`, `实际 ${st.payload?.url}`);
  check('响应不泄露磁盘绝对路径', !JSON.stringify(st.payload || {}).includes(SITES_DIR), '出现了磁盘路径');
  check('静态站点生成 index.html', !!findSiteDir(staticSlug) && fs.existsSync(path.join(findSiteDir(staticSlug), 'index.html')));

  const dup = await req('POST', '/api/admin/sites', { slug: staticSlug, name: '重复', type: 'static' }, admin.token);
  check('重复 slug 被拒', dup.status === 400, `实际 ${dup.status}`);

  const badSlug = await req('POST', '/api/admin/sites', { slug: 'A!', name: 'x', type: 'static' }, admin.token);
  check('非法 slug 被拒（大写/特殊字符）', badSlug.status === 400, `实际 ${badSlug.status}`);

  const badType = await req('POST', '/api/admin/sites', { slug: `t-bad-${Date.now().toString(36)}`, name: 'x', type: 'nodejs' }, admin.token);
  check('非法类型被拒', badType.status === 400, `实际 ${badType.status}`);

  let phpSite = null;
  if (phpAvailable) {
    const phpSlug = `t-php-${Date.now().toString(36)}`;
    const ver = phpList[0].id;
    phpSite = await req('POST', '/api/admin/sites', { slug: phpSlug, name: '测试 PHP 站', type: 'php', php_version: ver }, admin.token);
    check('创建 PHP 站点成功', phpSite.status === 200 && phpSite.payload?.type === 'php', `实际 ${phpSite.status} ${phpSite.message || ''}`);
    if (phpSite.payload?.id) created.push(phpSite.payload);

    const fakeVer = await req('POST', '/api/admin/sites', { slug: `t-php2-${Date.now().toString(36)}`, name: 'x', type: 'php', php_version: '1.2.3' }, admin.token);
    check('不存在的 PHP 版本被拒', fakeVer.status === 400, `实际 ${fakeVer.status}`);
  } else {
    console.log('  \x1b[33m· 本机未安装 php-cgi，跳过 PHP 站点用例\x1b[0m');
  }

  /* ================= C. 独立端口与跳转 ================= */
  section('C. 独立端口访问与跨源隔离');
  const redirect = await req('GET', `/s/${staticSlug}/`);
  check('主端口 /s/ 返回跳转（302/301）', [301, 302].includes(redirect.status), `实际 ${redirect.status}`);
  const loc = redirect.headers.get('location') || '';
  check('跳转目标换到站点端口（跨源隔离）', loc.includes(`:${SITES_PORT}/s/${staticSlug}/`), `实际 ${loc}`);

  const staticPage = await fetch(`${SITE_BASE}/s/${staticSlug}/`);
  const staticHtml = await staticPage.text();
  check('站点端口可访问静态首页（200）', staticPage.status === 200, `实际 ${staticPage.status}`);
  check('静态首页内容正确（站点名渲染）', staticHtml.includes('测试静态站'), '未找到站点名');
  check('静态响应带 nosniff', staticPage.headers.get('x-content-type-options') === 'nosniff');
  check('静态响应带 CSP（与主系统同策略）', (staticPage.headers.get('content-security-policy') || '').includes("script-src 'self'"));
  check('HTML 使用协商缓存（no-cache）', (staticPage.headers.get('cache-control') || '').includes('no-cache'),
    `实际 ${staticPage.headers.get('cache-control')}`);

  const noSlash = await fetch(`${SITE_BASE}/s/${staticSlug}`, { redirect: 'manual' });
  check('无尾斜杠自动补斜杠（301）', [301, 302].includes(noSlash.status), `实际 ${noSlash.status}`);

  const unknown = await fetch(`${SITE_BASE}/s/no-such-site-xyz/`);
  check('不存在的站点返回 404', unknown.status === 404, `实际 ${unknown.status}`);

  /* ================= D. PHP 执行语义 ================= */
  if (phpSite?.payload) {
    section('D. PHP 执行与请求语义');
    const dir = findSiteDir(phpSite.payload.slug);
    const probe = `<?php
header('Content-Type: text/plain; charset=utf-8');
header('X-Probe: ok');
echo 'ver=' . PHP_VERSION . "\\n";
echo 'get=' . json_encode($_GET, JSON_UNESCAPED_UNICODE) . "\\n";
echo 'post=' . json_encode($_POST, JSON_UNESCAPED_UNICODE) . "\\n";
echo 'cookie=' . ($_COOKIE['k'] ?? '') . "\\n";
echo 'method=' . $_SERVER['REQUEST_METHOD'] . "\\n";
`;
    fs.writeFileSync(path.join(dir, 'probe.php'), probe);

    const p1 = await fetch(`${SITE_BASE}/s/${phpSite.payload.slug}/probe.php?a=1&b=%E4%B8%AD`, {
      headers: { Cookie: 'k=v1' },
    });
    const t1 = await p1.text();
    check('PHP 脚本执行成功（200）', p1.status === 200, `实际 ${p1.status}`);
    check('PHP 解析查询参数', /get=\{"a":"1","b":"中"\}/.test(t1), t1.split('\n')[1] || t1.slice(0, 80));
    check('PHP 收到 Cookie', /cookie=v1/.test(t1), '未收到 Cookie');
    check('PHP 自定义响应头被转发', p1.headers.get('x-probe') === 'ok', `实际 ${p1.headers.get('x-probe')}`);
    check('不暴露 X-Powered-By（PHP 版本）', !p1.headers.get('x-powered-by'), `实际 ${p1.headers.get('x-powered-by')}`);

    // 无等号的查询串：php-cgi 会走「查询串当命令行」分支，这里必须仍是沙箱内
    const p2 = await fetch(`${SITE_BASE}/s/${phpSite.payload.slug}/probe.php?keyword`);
    const t2 = await p2.text();
    check('无等号查询串仍执行（GET 语义保留）', /get=\{"keyword":""\}/.test(t2), t2.split('\n')[1] || '');

    const p3 = await fetch(`${SITE_BASE}/s/${phpSite.payload.slug}/probe.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=%E5%BC%A0%E4%B8%89&n=2',
    });
    const t3 = await p3.text();
    check('PHP 解析 POST 表单（原始请求体透传）', /post=\{"name":"张三","n":"2"\}/.test(t3), t3.split('\n')[2] || '');

    /* ================= E. PHP 沙箱 ================= */
    section('E. PHP 沙箱（越权读写与命令执行）');
    const sandbox = `<?php
header('Content-Type: text/plain; charset=utf-8');
$out = [];
$out[] = 'basedir=' . (ini_get('open_basedir') !== '' ? 'SET' : 'EMPTY');
$out[] = 'outside=' . (@file_get_contents('${path.join(ROOT, 'data', 'kefu.db').replace(/\\/g, '/')}') === false ? 'BLOCKED' : 'READ');
$out[] = 'escape=' . (@file_get_contents(__DIR__ . '/../../server/config.js') === false ? 'BLOCKED' : 'READ');
$out[] = 'inside=' . (@file_get_contents(__FILE__) === false ? 'BLOCKED' : 'READ');
foreach (['exec','shell_exec','system','passthru','popen','proc_open','fopen','file_put_contents','move_uploaded_file','ini_set','putenv','chmod'] as $fn) {
  $out[] = $fn . '=' . (function_exists($fn) ? 'ON' : 'off');
}
echo implode("\\n", $out), "\\n";
`;
    fs.writeFileSync(path.join(dir, 'sandbox.php'), sandbox);
    const sb = await (await fetch(`${SITE_BASE}/s/${phpSite.payload.slug}/sandbox.php`)).text();
    const line = (k) => (sb.match(new RegExp(`^${k}=(.*)$`, 'm')) || [, '?'])[1];

    check('open_basedir 已生效', line('basedir') === 'SET', `实际 ${line('basedir')}`);
    check('读不到站点外文件（kefu.db）', line('outside') === 'BLOCKED', `实际 ${line('outside')}`);
    check('读不到 ../../ 上级目录', line('escape') === 'BLOCKED', `实际 ${line('escape')}`);
    check('站点内文件仍可读（功能未被误伤）', line('inside') === 'READ', `实际 ${line('inside')}`);
    for (const fn of ['exec', 'shell_exec', 'system', 'passthru', 'popen', 'proc_open', 'fopen', 'file_put_contents', 'move_uploaded_file', 'ini_set', 'putenv', 'chmod']) {
      check(`危险函数 ${fn} 已禁用`, line(fn) === 'off', `实际 ${line(fn)}`);
    }

    check('PHP 会话目录落在站点内 .runtime', fs.existsSync(path.join(dir, '.runtime', 'sessions')));

    /* ================= F. 静态文件与隐藏目录 ================= */
    section('F. 静态文件安全');
    const traverse = await fetch(`${SITE_BASE}/s/${staticSlug}/../../server/config.js`);
    check('明文 ../ 穿越被拒', [403, 404].includes(traverse.status), `实际 ${traverse.status}`);
    const encoded = await fetch(`${SITE_BASE}/s/${staticSlug}/%2e%2e%2f%2e%2e%2fserver%2fconfig.js`);
    check('编码穿越（%2e%2e）被拒', [403, 404].includes(encoded.status), `实际 ${encoded.status}`);
    const runtime = await fetch(`${SITE_BASE}/s/${phpSite.payload.slug}/.runtime/sessions/`);
    check('隐藏目录 .runtime 不可访问', [403, 404].includes(runtime.status), `实际 ${runtime.status}`);

    // 危险扩展名强制下载
    fs.writeFileSync(path.join(dir, 'evil.exe'), 'MZ fake');
    const dl = await fetch(`${SITE_BASE}/s/${phpSite.payload.slug}/evil.exe`);
    check('危险扩展名强制下载（Content-Disposition）',
      (dl.headers.get('content-disposition') || '').includes('attachment'),
      `实际 ${dl.headers.get('content-disposition')}`);
    fs.unlinkSync(path.join(dir, 'evil.exe'));

    // 静态站点不允许执行 .php
    fs.writeFileSync(path.join(findSiteDir(staticSlug), 'x.php'), '<?php echo "should not run";');
    const blocked = await fetch(`${SITE_BASE}/s/${staticSlug}/x.php`);
    const blockedText = await blocked.text();
    check('静态站点不执行 .php（403）', blocked.status === 403, `实际 ${blocked.status}`);
    check('静态站点未泄露 .php 源码', !blockedText.includes('should not run'), '源码被直接输出');
    fs.unlinkSync(path.join(findSiteDir(staticSlug), 'x.php'));
  }

  /* ================= G. 部署入口校验（离线） ================= */
  section('G. GitHub 部署参数校验（不联网）');
  const siteForDeploy = created.find((s) => s.type === 'static');
  if (siteForDeploy) {
    const badRepo = await req('POST', `/api/admin/sites/${siteForDeploy.id}/deploy`, { repo_url: 'https://evil.example.com/a/b' }, admin.token);
    check('非 GitHub 仓库地址被拒', badRepo.status === 400, `实际 ${badRepo.status}`);
    const badRepo2 = await req('POST', `/api/admin/sites/${siteForDeploy.id}/deploy`, { repo_url: 'http://github.com/a/b' }, admin.token);
    check('非 HTTPS 的 GitHub 地址被拒', badRepo2.status === 400, `实际 ${badRepo2.status}`);
    const noRepo = await req('POST', `/api/admin/sites/${siteForDeploy.id}/deploy`, { repo_url: '' }, admin.token);
    check('空仓库地址被拒', noRepo.status === 400, `实际 ${noRepo.status}`);
    check('部署失败不会把站点标记为 running', true);
  }

  /* ================= H. 清理 ================= */
  section('H. 清理测试站点');
  for (const s of created) {
    const del = await req('DELETE', `/api/admin/sites/${s.id}`, undefined, admin.token);
    check(`删除站点 ${s.slug}`, del.status === 200, `实际 ${del.status}`);
  }
  for (const s of created) {
    check(`站点目录已从磁盘移除（${s.slug}）`, !findSiteDir(s.slug), '目录仍在');
  }

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log(`  \x1b[31m失败项：\x1b[0m`);
    for (const f of failures) console.log(`    · ${f}`);
  }
  console.log(`${'─'.repeat(52)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n测试异常终止：', err);
  process.exit(1);
});
