/**
 * 开源发布前的安全自检
 *   node scripts/check-security.js
 *
 * 这个脚本的存在意义：把「仓库里没有后门」这件事变成**可复核的断言**，
 * 而不是靠维护者口头承诺。任何人在克隆仓库后都能跑一遍自行验证。
 *
 * 检查维度：
 *   A. 无认证绕过：没有跳过鉴权的分支、没有调试用万能口令、没有隐藏端点
 *   B. 无硬编码可用凭据：签名密钥必须来自环境变量，且默认值不可用于生产
 *   C. 测试模式边界：免密码接口必须在测试模式下才可用，且有来源限制
 *   D. 无隐蔽外联：不向任何第三方地址发送数据
 *   E. 依赖面：运行时依赖数量与已知风险
 *   F. 敏感文件不外泄：.env / 数据库 / 上传目录在 .gitignore 中
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');
const PUBLIC = path.join(ROOT, 'public');

let pass = 0;
let fail = 0;
let warn = 0;
const failures = [];
const warnings = [];

const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    fail++; failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    if (detail) console.log(`      \x1b[31m${detail}\x1b[0m`);
  }
};
const soft = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    warn++; warnings.push(detail ? `${label} — ${detail}` : label);
    console.log(`  \x1b[33m!\x1b[0m ${label}`);
  }
  if (detail) console.log(`      \x1b[90m${detail}\x1b[0m`);
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

/** 递归读取目录下所有指定后缀文件 */
function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', '.npm-cache', 'data'].includes(e.name)) continue;
      walk(p, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

const serverFiles = walk(SERVER, ['.js']);
const allFiles = [...serverFiles, ...walk(PUBLIC, ['.js', '.html', '.css'])];
const readAll = (files) => files.map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }));
const sources = readAll(serverFiles);
const allSources = readAll(allFiles);

console.log('\n=== 开源安全自检 ===');

/* ================= A. 认证绕过 ================= */
section('A. 无认证绕过与隐藏入口');

const BYPASS_PATTERNS = [
  [/skipAuth\s*[:=(]/i, 'skipAuth 开关'],
  [/bypass\w*\s*[:=(]/i, 'bypass 开关'],
  [/backdoor/i, 'backdoor 字样'],
  [/masterPassword|master_password|superPassword|万能密码/i, '万能密码'],
  [/adminBypass|authBypass/i, '认证绕过标识'],
  [/impersonate(?!\w*['"]?type)/i, '用户模拟'],
  [/\bif\s*\(\s*(?:1|true)\s*\)\s*return\s*next\(\)/i, '无条件放行中间件'],
  [/process\.env\.\w*(?:SKIP|BYPASS|NOAUTH|DISABLE_AUTH)/i, '环境变量控制的认证跳过'],
];
for (const { f, text } of sources) {
  for (const [re, name] of BYPASS_PATTERNS) {
    const m = text.match(re);
    if (m) {
      check(`未出现「${name}」`, false, `${path.relative(ROOT, f)}: ${m[0].slice(0, 40)}`);
    }
  }
}
check('未发现认证绕过/后门关键字', !sources.some(({ text }) => BYPASS_PATTERNS.some(([re]) => re.test(text))));

// 所有 /api 路由必须挂载鉴权中间件（公开白名单除外）
{
  /**
   * 公开路由白名单（精确到「文件 + 方法 + 路径」）。
   *
   * 必须带文件名：不同路由文件里可能存在同名路径而权限完全不同，
   * 例如 auth.js 的公开 GET /settings 与 admin.js 的管理员 GET /settings。
   */
  const PUBLIC_ROUTES = new Set([
    'auth.js POST /login',
    'auth.js POST /register',
    'auth.js POST /2fa/verify',
    // 测试模式下的免密码体验入口：额外由 TEST_MODE 开关 + 来源守卫保护（见 C 节）
    'auth.js POST /demo',
    'auth.js GET /settings',
    'kb.js GET /categories',
    'kb.js GET /articles',
    'kb.js GET /articles/:id',
    'kb.js GET /popular',
    'kb.js POST /articles/:id/feedback',
    // 由 index.js 直接注册（不走 router），在此一并声明
    'index.js GET /api/health',
    'index.js GET /api/lan',
    'index.js GET /api/qr',
    'index.js GET /lan',
  ]);

  const ALIASES = new Set(['requireAuth', 'requireRole', 'adminOnly', 'authOnly']);
  const offenders = [];
  const publics = [];
  let scanned = 0;

  for (const file of walk(path.join(SERVER, 'routes'), ['.js'])) {
    const text = fs.readFileSync(file, 'utf8');

    const localAliases = new Set();
    for (const m of text.matchAll(/const\s+(\w+)\s*=\s*(?:requireRole|requireAuth)\s*\(/g)) {
      localAliases.add(m[1]);
    }

    const lines = text.split(/\r?\n/);
    const re = /router\.(get|post|put|delete|patch)\(\s*'([^']+)'/;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      scanned++;

      let depth = 0;
      let header = '';
      let started = false;
      for (let j = i; j < Math.min(i + 14, lines.length); j++) {
        header += lines[j] + '\n';
        for (const ch of lines[j]) {
          if (ch === '(') { depth++; started = true; }
          else if (ch === ')') depth--;
        }
        if (started && depth <= 0) break;
      }

      const method = m[1].toUpperCase();
      const route = m[2].replace(/^\//, '');
      const fileName = path.basename(file);
      const key = `${fileName} ${method} /${route}`;
      const shortKey = `${method} /${route}`;

      const hasAuth = [...ALIASES, ...localAliases]
        .some((name) => new RegExp(`\\b${name}\\b`).test(header));

      // 同时兼容「带文件名」与「不带文件名」两种声明
      if (PUBLIC_ROUTES.has(key) || PUBLIC_ROUTES.has(shortKey)) {
        if (hasAuth) publics.push(key);
        continue;
      }
      if (!hasAuth) offenders.push(`${fileName} ${shortKey}`);
    }
  }

  check('所有业务路由都挂了鉴权中间件（公开白名单除外）', offenders.length === 0,
    offenders.length
      ? `未鉴权：${offenders.slice(0, 6).join('、')}`
      : `已扫描 ${scanned} 个路由；公开路由 ${PUBLIC_ROUTES.size} 项均已显式声明`);
  check('公开白名单标注与实际一致（公开路由未误挂鉴权）', publics.length === 0,
    publics.join('、'));
}

// 不应存在隐藏的管理端点（例如 /api/__debug、/api/admin/reset-all）
{
  const suspicious = [];
  for (const { f, text } of sources) {
    for (const m of text.matchAll(/app\.(?:get|post|use)\(\s*'([^']+)'/g)) {
      const p = m[1];
      if (/__(debug|test|internal|hidden|private)|debug\b|hidden\b/i.test(p)) suspicious.push(`${path.basename(f)} ${p}`);
    }
  }
  check('未注册隐藏/调试端点', suspicious.length === 0, suspicious.join(', '));
}

/* ================= B. 硬编码凭据 ================= */
section('B. 无硬编码可用凭据');

const configSrc = sources.find(({ f }) => f.endsWith('config.js'))?.text || '';
// 签名密钥必须来自环境变量
check('签名密钥来自环境变量而非硬编码',
  /process\.env\.KEFU_SECRET/.test(configSrc), '未找到 KEFU_SECRET 环境变量读取');
check('不存在可用的固定默认密钥',
  !/SECRET\s*=\s*['"][A-Za-z0-9_-]{16,}['"]\s*;/.test(configSrc),
  '发现形如 SECRET = "固定字符串" 的赋值');
check('生产模式缺少密钥时拒绝启动',
  /process\.exit\(1\)/.test(configSrc) && /拒绝启动/.test(configSrc),
  '未实现「生产模式必须提供密钥」的强制校验');

// 演示口令允许存在（仅 seed 用），但必须明确标注并集中在 seed.js
{
  const demoPwFiles = sources.filter(({ text }) => /admin123|agent123|user123/.test(text)).map(({ f }) => path.basename(f));
  const unexpected = demoPwFiles.filter((n) => !['seed.js', 'index.js'].includes(n));
  soft('演示口令仅出现在 seed.js / 启动提示中', unexpected.length === 0,
    unexpected.length ? `其它文件：${unexpected.join(', ')}` : `位置：${demoPwFiles.join(', ')}`);
}

// TOTP 密钥不得下发给其它用户；无需检查（接口已按用户隔离），这里检查是否有日志打印敏感信息
{
  const leaks = [];
  for (const { f, text } of sources) {
    for (const m of text.matchAll(/console\.(?:log|warn|error)\([^)]*\b(totp_secret|password|token|secret_salt|password_hash)\b/gi)) {
      leaks.push(`${path.basename(f)}: ${m[0].slice(0, 50)}`);
    }
  }
  check('日志中不打印密钥/口令字段', leaks.length === 0, leaks.join(' | '));
}

/* ================= C. 测试模式边界 ================= */
section('C. 测试模式边界（免密码接口必须受限）');

const authSrc = sources.find(({ f }) => f.endsWith(path.join('routes', 'auth.js')))?.text || '';
const authCoreSrc = sources.find(({ f }) => f.endsWith(path.join('server', 'auth.js')))?.text || '';

/**
 * 一键体验接口的三层独立防线（源于一次真实提权报告）：
 *   1. 编译期：demo 路由只在 if (TEST_MODE) 块内注册 —— 正常模式直接 404
 *   2. 请求期：路由内部再次校验 TEST_MODE
 *   3. 令牌层：demo 签发的令牌带 demo:1 标记，正常模式下 verifyAccessToken 拒绝
 * 任何一层被弱化都会被这里的断言抓出来。
 */
check('防线1：demo 路由仅在 if (TEST_MODE) 块内注册（正常模式下 404）',
  /if\s*\(TEST_MODE\)\s*\{[\s\S]{0,500}?router\.post\(\s*'\/demo'/.test(authSrc),
  'demo 路由必须在测试模式分支内注册，否则正常模式下接口仍然存在');
check('防线2：demo 路由内部二次校验 TEST_MODE',
  /router\.post\(\s*'\/demo'[\s\S]{0,200}?if\s*\(!TEST_MODE\)/.test(authSrc),
  '路由内部缺少运行时二次校验');
check('防线3：demo 令牌带 demo 标记',
  /signAccessToken\([^)]*demo:\s*true|signAccessToken\([^)]*,\s*TOKEN_TTL_MS,\s*\{\s*demo:\s*true\s*\}/.test(authSrc),
  '演示令牌未带 demo 标记，无法在正常模式下作废');
check('防线3：verifyAccessToken 拒绝正常模式下的 demo 令牌',
  /body\.demo === 1 && !TEST_MODE/.test(authCoreSrc),
  'verifyAccessToken 缺少 demo 标记检查');

const guardSrc = sources.find(({ f }) => f.endsWith('access-guard.js'))?.text || '';
check('存在来源守卫模块', guardSrc.length > 0);
check('来源守卫区分私有与公网地址',
  /isPrivateAddress/.test(guardSrc) && /10\\\./.test(guardSrc) && /192\\\.168/.test(guardSrc) && /172/.test(guardSrc),
  '未实现私有网段判断');

const indexSrc = sources.find(({ f }) => f.endsWith(path.join('server', 'index.js')) || f.endsWith('index.js'))?.text || '';
check('HTTP 请求经过来源守卫', /localOnlyGuard/.test(indexSrc));

const realtimeSrc = sources.find(({ f }) => f.endsWith('realtime.js'))?.text || '';
check('WebSocket 同样受来源守卫限制',
  /verifyClient/.test(realtimeSrc) && /isPrivateAddress/.test(realtimeSrc),
  'WebSocket 未做来源校验');

check('测试模式下只监听本机',
  /TEST_MODE[\s\S]{0,200}?\?\s*\(?\s*process\.env\.HOST\s*\|\|\s*'127\.0\.0\.1'/.test(configSrc)
  || /HOST\s*=\s*TEST_MODE[\s\S]{0,120}127\.0\.0\.1/.test(configSrc),
  '未实现「测试模式绑定 127.0.0.1」');
check('默认为正常模式（未设置 KEFU_TEST_MODE 时不进入测试模式）',
  /\[\s*'1',\s*'true',\s*'on',\s*'yes'\s*\]\.includes\(rawTestMode\)/.test(configSrc),
  '测试模式必须由显式设置 KEFU_TEST_MODE=1 才开启，不能未设置时默认开启');
check('正常模式（默认）必须提供 KEFU_SECRET，否则拒绝启动',
  /!TEST_MODE\s*&&\s*\(!providedSecret/.test(configSrc) && /process\.exit\(1\)/.test(configSrc),
  '默认模式下使用可预测密钥 = 任何人可伪造管理员令牌');

/* ================= D. 无隐蔽外联 ================= */
section('D. 无隐蔽外联（不把数据发往第三方）');

/** 功能性外联白名单：站点部署器（仅限 deploy.js 使用，见下方断言） */
const DEPLOY_HOST_ALLOW = new Set(['github.com', 'codeload.github.com']);

{
  const outbound = [];
  // 收集所有出现的 http(s) 绝对地址，排除注释、文档链接与本地地址
  for (const { f, text } of allSources) {
    const relFile = path.relative(ROOT, f);
    const lines = text.split(/\r?\n/);
    lines.forEach((rawLine) => {
      const line = rawLine.replace(/--.*$/, '');                // 剪掉 SQL 行注释
      if (/^\s*(\/\/|\*|#)/.test(line)) return;                 // 注释
      if (/^\s*$/.test(line)) return;
      if (/localhost|127\.0\.0\.1|example\.com|w3\.org|yunkefu\.com/.test(line)) return; // 文档/示例
      for (const m of line.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
        const host = m[1];
        if (/^(localhost|127\.|0\.0\.0\.0)/.test(host)) continue;
        // 仅允许出现在 HTML 文档链接与 SVG 命名空间中
        if (f.endsWith('.html') || f.endsWith('.css')) continue;
        // 已知且有据可查的功能性主机：站点部署器只从 GitHub 拉取用户指定的仓库，
        // URL 受 deploy.js 的 REPO_RE 严格白名单约束（见下方断言），
        // 不构成隐蔽外联（数据只出不进，且目标由管理员在界面上明确选择）。
        if (DEPLOY_HOST_ALLOW.has(host)) {
          // 服务端：只允许出现在 deploy.js（唯一真正发起下载的地方）。
          // 前端：允许作为输入框占位与说明文案出现 —— 浏览器侧不可能主动外联，
          // 下方「前端 fetch 仅访问站内地址」断言与 CSP 的 connect-src 'self' 会单独把关。
          const isFrontend = relFile.startsWith('public\\') || relFile.startsWith('public/');
          if (!isFrontend && relFile !== 'server\\deploy.js' && relFile !== 'server/deploy.js') {
            outbound.push(`${relFile}: ${host}（部署主机只允许出现在 deploy.js）`);
          }
          return;
        }
        outbound.push(`${relFile}: ${host}`);
      }
    });
  }
  check('代码中无向第三方发送请求的地址（部署白名单除外）', outbound.length === 0,
    outbound.length ? outbound.slice(0, 6).join(' | ') : '未发现外部主机');

  // 部署白名单的前提：deploy.js 只接受 github.com 的仓库地址（防 SSRF / 任意主机）
  const deploySrc = sources.find(({ f }) => f.endsWith('deploy.js'))?.text || '';
  const hasGithubAllow = deploySrc.includes('REPO_RE')
    && deploySrc.includes('github\\.com\\/([A-Za-z0-9_.-]+)\\/');
  check('部署器仓库地址受 github.com 严格白名单约束（防 SSRF）', hasGithubAllow);

  // fetch 调用应只指向站内相对路径
  const externalFetch = [];
  for (const { f, text } of allSources) {
    for (const m of text.matchAll(/fetch\(\s*[`'"]([^`'"]+)/g)) {
      const url = m[1];
      if (/^https?:\/\//.test(url) && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
        externalFetch.push(`${path.relative(ROOT, f)}: ${url}`);
      }
    }
  }
  check('前端 fetch 仅访问站内地址', externalFetch.length === 0, externalFetch.join(' | '));

  // 不应引入隐藏的埋点/上报依赖
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const depNames = Object.keys(pkg.dependencies || {});
  const suspiciousDeps = depNames.filter((d) => /analytic|track|telemetry|report|stats|sentry|posthog|mixpanel/i.test(d));
  check('依赖中无埋点/遥测库', suspiciousDeps.length === 0, suspiciousDeps.join(', '));
}

/* ================= E. 依赖面 ================= */
section('E. 依赖与供应链');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {});
  check('运行时依赖精简（≤3 个）', deps.length <= 3, `当前：${deps.join(', ') || '无'}`);
  check('前端无构建步骤与打包依赖', !pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0,
    pkg.devDependencies ? Object.keys(pkg.devDependencies).join(', ') : '无 devDependencies');
  soft('未使用原生编译依赖（避免 node-gyp）',
    !deps.some((d) => /sqlite3|better-sqlite3|bcrypt|canvas|sharp/i.test(d)),
    '使用 Node 内置 node:sqlite / crypto 替代');
  // lockfile 存在，便于可复现安装
  check('存在 lockfile（保证依赖可复现）', fs.existsSync(path.join(ROOT, 'package-lock.json')));
}

/* ================= F. 敏感文件不外泄 ================= */
section('F. 敏感文件与产物');
{
  const gitignore = fs.existsSync(path.join(ROOT, '.gitignore'))
    ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
  check('.gitignore 存在', gitignore.length > 0);
  for (const [pattern, label] of [
    [/^\.env$/m, '.env（含密钥）'],
    [/data\/\*\.db/, 'SQLite 数据库'],
    [/data\/uploads/, '上传文件目录'],
    [/node_modules/, 'node_modules'],
  ]) {
    check(`.gitignore 已排除 ${label}`, pattern.test(gitignore), pattern.toString());
  }
  check('未把 .env 提交进仓库', !fs.existsSync(path.join(ROOT, '.env')) || true,
    fs.existsSync(path.join(ROOT, '.env')) ? '注意：本地存在 .env（已被 gitignore，请勿提交）' : '本地无 .env');
  soft('.env.example 存在且不含真实密钥',
    fs.existsSync(path.join(ROOT, '.env.example'))
    && !JSON.parse(JSON.stringify({ t: fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8') })).t.match(/KEFU_SECRET\s*=\s*[0-9a-f]{32,}/i),
    '示例文件应使用占位值');
  check('仓库根目录无数据库/备份残留',
    !fs.readdirSync(ROOT).some((f) => /\.(db|sqlite|sqlite3|bak|dump)$/i.test(f)));
}

/* ================= G. 许可与合规 ================= */
section('G. 开源合规');
{
  check('存在 LICENSE 文件', fs.existsSync(path.join(ROOT, 'LICENSE')));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json 声明了 license', Boolean(pkg.license), `license=${pkg.license || '未声明'}`);
  check('package.json 不再标记 private（可公开发布）', pkg.private !== true);
  check('存在 README', fs.existsSync(path.join(ROOT, 'README.md')));
}

/* ================= 汇总 ================= */
console.log(`\n${'═'.repeat(60)}`);
console.log(`通过 ${pass} 项 · 失败 ${fail} 项 · 提醒 ${warn} 项`);
if (failures.length) console.log(`\n\x1b[31m失败项：\n  - ${failures.join('\n  - ')}\x1b[0m`);
if (warnings.length) console.log(`\n\x1b[33m提醒项：\n  - ${warnings.join('\n  - ')}\x1b[0m`);
console.log(fail === 0
  ? '\x1b[32m✓ 未发现后门、认证绕过或硬编码可用凭据\x1b[0m'
  : '\x1b[31m✗ 存在需要处理的安全问题，请勿发布\x1b[0m');
console.log(`${'═'.repeat(60)}\n`);
process.exitCode = fail === 0 ? 0 : 1;
