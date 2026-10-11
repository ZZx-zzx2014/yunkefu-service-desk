/**
 * PHP 运行时管理
 *
 * 职责：
 *   1. 探测本机可用的 PHP 版本（php-cgi），供管理端「选择任意 PHP 版本」
 *   2. 以受控方式执行 PHP 脚本（php-cgi + FastCGI 协议的极简实现）
 *
 * 安全设计（重点）：
 *   - 只调用 php-cgi，不调用 php CLI（CLI 可直接执行任意系统命令）
 *   - 每次执行强制注入：
 *       open_basedir      = 站点目录（文件访问被限制在该目录内）
 *       disable_functions = 一律禁用所有进程/系统执行类函数
 *       disable_classes   = 禁用可实例化进程的类
 *       expose_php        = Off
 *       cgi.force_redirect= 0（我们直接消费其输出，不需要重定向语义）
 *   - 超时强制（默认 10s），超时杀进程，防止死循环拖垮服务
 *   - 输出大小上限（默认 8MB），防止一个脚本吃光内存
 *
 * 为什么不用 exec("php file.php")：那样会把 PHP 的完整权限交给站点代码，
 * 任何站点都能读走 kefu.db（含全部账号口令散列）甚至删除整个项目。
 * open_basedir + disable_functions 是 PHP 官方提供的标准隔离手段。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 一律禁用的 PHP 函数（即使 php.ini 未配置也强制注入） */
const DISABLED_FUNCTIONS = [
  'exec', 'system', 'shell_exec', 'passthru', 'popen', 'proc_open', 'proc_nice',
  'pcntl_exec', 'pcntl_fork', 'pcntl_alarm', 'pcntl_signal', 'pcntl_wait',
  'putenv', 'dl', 'mail', 'symlink', 'link', 'chmod', 'chown', 'chgrp',
  'file_put_contents', 'move_uploaded_file', 'copy', 'rename', 'unlink',
  'rmdir', 'mkdir', 'touch', 'fopen', 'fclose', 'fwrite', 'ftruncate',
  'set_time_limit', 'ignore_user_abort', 'ini_set', 'putenv',
  'error_log', 'highlight_file', 'show_source', 'phpinfo',
].join(',');

/** 禁用的 PHP 类 */
const DISABLED_CLASSES = 'Reflection,ReflectionFunction,ReflectionMethod,ReflectionClass';

/** 执行超时（毫秒）与输出上限（字节） */
export const PHP_TIMEOUT_MS = Number(process.env.KEFU_PHP_TIMEOUT_MS || 10_000);
export const PHP_MAX_OUTPUT = Number(process.env.KEFU_PHP_MAX_OUTPUT || 8 * 1024 * 1024);

/** 常见 PHP 安装位置（Windows 优先，兼顾 XAMPP/Laragon 等集成环境） */
const SEARCH_DIRS_WIN = [
  process.env.PHP_HOME,
  'C:\\php', 'C:\\php8', 'C:\\php-8', 'C:\\tools\\php',
  'C:\\xampp\\php', 'C:\\wamp64\\bin\\php', 'C:\\wamp\\bin\\php',
  'C:\\laragon\\bin\\php', 'C:\\Program Files\\PHP',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'php'),
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'php'),
].filter(Boolean);

/** Linux/macOS 常见位置 */
const SEARCH_DIRS_UNIX = [
  '/usr/bin', '/usr/local/bin', '/opt/php', '/usr/local/php/bin',
  '/usr/local/php8/bin', '/opt/homebrew/bin', '/usr/local/opt/php/bin',
];

/**
 * 在单个目录里查找 php-cgi 可执行文件。
 * Windows 的集成环境（XAMPP/Laragon）按版本分子目录，需要向下多探几层。
 */
function findPhpCgiIn(dir, depth = 0, out = []) {
  if (depth > 2 || out.length >= 12) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isFile()) {
      const name = e.name.toLowerCase();
      const exe = process.platform === 'win32' ? 'php-cgi.exe' : 'php-cgi';
      if (name === exe || (process.platform === 'win32' && name === 'php-cgi')) {
        out.push(path.join(dir, e.name));
      }
    } else if (e.isDirectory() && /^php/i.test(e.name)) {
      // XAMPP/WAMP 的版本目录：php-8.2.12、php8 等
      findPhpCgiIn(path.join(dir, e.name), depth + 1, out);
    }
  }
  return out;
}

/** 解析某个 php-cgi 的版本号（运行 php-cgi -v，缓存结果避免重复探测） */
const versionCache = new Map(); // binPath -> { version, ts }

async function detectVersion(bin) {
  const cached = versionCache.get(bin);
  if (cached && Date.now() - cached.ts < 3600_000) return cached.version;
  const version = await new Promise((resolve) => {
    const p = spawn(bin, ['-v'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { p.kill(); resolve(null); }, 6000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => {
      clearTimeout(timer);
      const m = out.match(/PHP\s+(\d+\.\d+(?:\.\d+)?)/i);
      resolve(m ? m[1] : null);
    });
  });
  versionCache.set(bin, { version, ts: Date.now() });
  return version;
}

/**
 * 扫描本机全部可用的 PHP 版本。
 * @returns {Promise<Array<{ bin: string, version: string, id: string }>>}
 *   id 形如 "8.2.12"（供前端选择），bin 是 php-cgi 完整路径
 */
export async function listPhpVersions() {
  const dirs = process.platform === 'win32' ? SEARCH_DIRS_WIN : SEARCH_DIRS_UNIX;
  const found = [];
  for (const d of dirs) {
    for (const bin of findPhpCgiIn(d)) found.push(bin);
  }
  // PATH 环境变量逐一探查（不依赖 shell，直接找常见 PATH 段）
  for (const p of String(process.env.PATH || '').split(path.delimiter)) {
    if (!p) continue;
    const exe = path.join(p, process.platform === 'win32' ? 'php-cgi.exe' : 'php-cgi');
    try {
      if (fs.existsSync(exe)) found.push(exe);
    } catch { /* ignore */ }
  }

  const results = [];
  const seenVersions = new Set();
  for (const bin of [...new Set(found)]) {
    const v = await detectVersion(bin);
    if (!v) continue;
    if (seenVersions.has(v)) continue; // 同版本只保留第一个
    seenVersions.add(v);
    results.push({ bin, version: v, id: v });
  }
  results.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return results;
}

/* ------------------------------------------------------------------ *
 * FastCGi 极简客户端
 *
 * 为什么自己写：php-cgi 有两种用法。
 *   ① 直接 spawn 传环境变量（CGI 模式）：一次进程只跑一个请求，但实现最简单、
 *      隔离最干净（每请求独立进程，跑完即退，无状态残留）
 *   ② FastCGI 多路复用：性能好但要实现完整二进制协议
 *
 * 低流量场景选 ①：无协议状态机、无连接池泄漏风险，每请求全新进程
 * 天然做到「站点之间零共享状态」。CGI 模式 php-cgi 从 stdin 读请求体、
 * 向 stdout 输出「头 + 空行 + 体」，解析非常直接。
 * ------------------------------------------------------------------ */

/** 解析 php-cgi 的 CGI 输出：拆分响应头与响应体 */
export function parseCgiOutput(buf) {
  // 分隔头与体：\r\n\r\n 或 \n\n
  const idxRN = buf.indexOf('\r\n\r\n');
  const idxN = buf.indexOf('\n\n');
  let splitAt = -1;
  let sepLen = 0;
  if (idxRN !== -1 && (idxN === -1 || idxRN <= idxN)) { splitAt = idxRN; sepLen = 4; }
  else if (idxN !== -1) { splitAt = idxN; sepLen = 2; }
  if (splitAt === -1) return { headers: {}, status: 200, body: buf };

  const headText = buf.slice(0, splitAt).toString('utf8');
  const body = buf.slice(splitAt + sepLen);

  const headers = {};
  let status = 200;
  for (const line of headText.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === 'status') {
      const sm = val.match(/^(\d{3})/);
      if (sm) status = Number(sm[1]);
      continue;
    }
    if (key === 'content-type' || key === 'location' || key === 'set-cookie' || key === 'cache-control') {
      headers[key] = val;
    }
  }
  return { headers, status, body };
}

/**
 * 执行一个 PHP 文件并返回 CGI 解析结果。
 *
 * @param {object} opts
 * @param {string} opts.bin          php-cgi 完整路径
 * @param {string} opts.script       要执行的 .php 绝对路径
 * @param {string} opts.docRoot     站点根（open_basedir 用）
 * @param {object} [opts.cgi]       CGI 环境变量（REQUEST_METHOD / QUERY_STRING 等）
 * @param {Buffer|string} [opts.body] 请求体
 */
export async function runPhp({ bin, script, docRoot, cgi = {}, body = '' }) {
  // 路径必须落在站点目录内（防 ../ 逃逸）
  const resolved = path.resolve(script);
  if (!resolved.toLowerCase().startsWith(path.resolve(docRoot).toLowerCase())) {
    throw new Error('PHP 脚本路径超出站点目录');
  }

  const env = {
    ...cgi,
    // —— 强制安全参数（即使 php.ini 有别的配置也覆盖）——
    PHP_INI_SCAN_DIR: '',                       // 不加载额外的 ini 片段
    PHP_DISABLE_FUNCTIONS: '',                 // 占位避免误用，真正用 -d 注入
    REDIRECT_STATUS: '200',                    // cgi.force_redirect 配套
    // —— 标准 CGI 变量 ——
    SCRIPT_FILENAME: resolved,
    SCRIPT_NAME: cgi.SCRIPT_NAME || path.basename(resolved),
    DOCUMENT_ROOT: path.resolve(docRoot),
    GATEWAY_INTERFACE: 'CGI/1.1',
    SERVER_SOFTWARE: 'yunkefu',
    REQUEST_METHOD: cgi.REQUEST_METHOD || 'GET',
    QUERY_STRING: cgi.QUERY_STRING || '',
    CONTENT_TYPE: cgi.CONTENT_TYPE || (String(body).length ? 'application/x-www-form-urlencoded' : ''),
    CONTENT_LENGTH: String(Buffer.byteLength(body || '')),
  };

  const args = [
    // -d 强制注入，优先级高于 php.ini
    '-d', `open_basedir=${path.resolve(docRoot)}${path.delimiter}${fs.realpathSync(process.env.TEMP || '/tmp')}`,
    '-d', `disable_functions=${DISABLED_FUNCTIONS}`,
    '-d', `disable_classes=${DISABLED_CLASSES}`,
    '-d', 'expose_php=Off',
    '-d', 'cgi.force_redirect=0',
    '-d', 'allow_url_include=0',
    '-d', 'allow_url_fopen=0',
    '-d', 'session.save_path=' + (process.env.TEMP || '/tmp'),
    '-d', 'upload_max_filesize=2M',
    '-d', 'post_max_size=3M',
    '-d', 'memory_limit=128M',
    '-d', 'max_execution_time=15',
    '-d', 'display_errors=Off',
    '-d', 'log_errors=On',
    '-d', 'error_log=' + path.join(process.env.TEMP || '/tmp', 'kefu-php-error.log'),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks = [];
    let total = 0;
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error('PHP 执行超时'));
    }, PHP_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      total += d.length;
      if (total > PHP_MAX_OUTPUT) {
        killed = true;
        child.kill('SIGKILL');
        reject(new Error('PHP 输出超出上限'));
        return;
      }
      chunks.push(d);
    });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return; // 已在回调里 reject
      const out = Buffer.concat(chunks);
      if (code !== 0 && out.length === 0) {
        // 进程异常退出且无输出：给出可诊断的错误
        const hint = stderr.split('\n').filter(Boolean).slice(0, 3).join(' | ');
        reject(new Error(`PHP 进程异常退出（code ${code}）${hint ? '：' + hint : ''}`));
        return;
      }
      resolve(parseCgiOutput(out));
    });

    if (body) child.stdin.write(body);
    child.stdin.end();
  });
}
