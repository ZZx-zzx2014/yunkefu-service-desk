/**
 * 文件上传安全模块
 *
 * 设计原则（修复原先基于黑名单 + 用户扩展名的实现）：
 *  1. 白名单：只接受明确允许的图片与文档类型，其余一律拒绝
 *  2. 落盘文件名完全由服务端生成，扩展名从「经校验的 MIME」推导，绝不采用用户的扩展名
 *  3. 图片按文件头魔数校验，防止把脚本伪装成图片上传
 *  4. 原始文件名仅作为展示元数据保存，并做清洗（去控制字符、HTML 元字符、限长）
 */

/** 允许上传的文档类型：MIME -> 落盘扩展名 */
export const ALLOWED_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',

  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/gzip': '.gz',
  'application/x-gzip': '.gz',
  'application/x-tar': '.tar',
  'text/x-log': '.log',
  'application/octet-stream': null, // 需结合文件头判定，见 resolveExtension
};

/** 仅这些 MIME 会以 inline 方式内联展示（可安全渲染），其余强制下载 */
export const INLINE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp',
]);

/**
 * 明确禁止的扩展名（纵深防御；即使 MIME 伪造也拒绝明显危险的原始文件名）
 * 注意：这不是主要防线，主要防线是白名单 + 服务端生成扩展名。
 */
const DANGEROUS_EXT = new Set([
  // 服务端脚本
  'php', 'php1', 'php2', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8', 'phps', 'phtml', 'phtm', 'phar', 'inc',
  'asp', 'aspx', 'ascx', 'ashx', 'asmx', 'cer', 'cdx', 'asa',
  'jsp', 'jspx', 'jspf', 'jhtml', 'jspa', 'jsw', 'jsv', 'jtml',
  'cgi', 'pl', 'pm', 'py', 'pyc', 'rb', 'rbw', 'lua', 'go', 'sh', 'bash', 'zsh', 'ksh', 'csh',
  'cfm', 'cfc', 'shtml', 'shtm', 'stm', 'do', 'action', 'jsx', 'tsx',
  // 可执行与库
  'exe', 'com', 'bat', 'cmd', 'msi', 'msp', 'scr', 'pif', 'cpl', 'dll', 'sys', 'drv', 'vxd', 'ocx',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ws', 'wsc', 'hta', 'ps1', 'ps1xml', 'ps2', 'psc1', 'psd1', 'psm1',
  'jar', 'class', 'war', 'ear', 'apk', 'app', 'deb', 'rpm', 'dmg', 'so', 'dylib',
  // 服务器配置
  'htaccess', 'htpasswd', 'user ini', 'ini', 'conf', 'config', 'htgroups', 'htdigest',
  // 文档中的主动脚本
  'html', 'htm', 'xhtml', 'xht', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'xaml', 'mhtml', 'mht', 'eml',
  'swf', 'vb', 'cs', 'as', 'mx', 'jse',
]);

/** 提取小写扩展名（不含点），支持 .htaccess 这类无扩展名的点文件 */
export function getExtension(filename) {
  const base = String(filename || '').split(/[\\/]/).pop() || '';
  if (base.startsWith('.') && !base.slice(1).includes('.')) {
    return base.slice(1).toLowerCase(); // .htaccess -> htaccess
  }
  const idx = base.lastIndexOf('.');
  if (idx <= 0 || idx === base.length - 1) return '';
  return base.slice(idx + 1).toLowerCase();
}

/** 原始文件名是否属于明显危险的类型 */
export function isDangerousFilename(filename) {
  const name = String(filename || '');
  // 双扩展名（shell.php.jpg）也要能识别出中间的危险段
  const segments = name.split(/[\\/]/).pop().split('.');
  for (const seg of segments.slice(1)) {
    const s = seg.trim().toLowerCase();
    if (!s) continue;
    if (DANGEROUS_EXT.has(s)) return true;
    if (DANGEROUS_EXT.has(s.replace(/[^a-z0-9]/g, ''))) return true;
  }
  const ext = getExtension(name);
  if (ext && DANGEROUS_EXT.has(ext)) return true;
  return false;
}

/** 清洗用于展示的文件名：去控制字符 / HTML 元字符 / 路径分隔符，限长 120 */
export function sanitizeDisplayName(filename) {
  let name = String(filename || '').split(/[\\/]/).pop() || '';
  // 去掉控制字符（含 %00 解出的空字节）
  name = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  // 去掉 HTML 元字符，避免在页面上形成 XSS 或破坏渲染
  name = name.replace(/[<>"'`&]/g, '_');
  // 去掉首尾点与空格，避免 .htaccess / 尾随点绕过
  name = name.replace(/^[.\s]+/, '').replace(/[\s.]+$/, '');
  if (!name) name = 'file';
  return name.slice(0, 120);
}

/* ------------------------------------------------------------------ *
 * 文件头魔数校验
 * ------------------------------------------------------------------ */

const IMAGE_SIGNATURES = [
  { mime: 'image/png', ext: '.png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: '.jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: '.gif', test: (b) => b.length > 6 && b.slice(0, 3).toString('latin1') === 'GIF' },
  { mime: 'image/webp', ext: '.webp', test: (b) => b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/bmp', ext: '.bmp', test: (b) => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
];

/** 检测图片真实类型；非图片返回 null */
export function detectImage(buf) {
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.test(buf)) return { mime: sig.mime, ext: sig.ext };
  }
  return null;
}

/** 内容是否像可执行的脚本或主动内容（用于拒绝伪装成文档的脚本） */
export function looksLikeScript(buf) {
  const head = buf.slice(0, 1024).toString('latin1');
  const probes = [
    /<\?php/i, /<script[\s>]/i, /<%/, /#!\s*\/.*\b(?:sh|bash|python|perl|ruby)\b/i,
    /^\s*MZ/, /^\x7fELF/, /^%PDF.*\/JavaScript/i, /<svg[\s>]/i, /<iframe[\s>]/i,
    /javascript:/i, /vbscript:/i, /\bActiveXObject\b/i, /\beval\s*\(/i,
  ];
  return probes.some((re) => re.test(head));
}

/* ------------------------------------------------------------------ *
 * 二进制格式的魔数校验
 * 防止把 HTML/脚本内容声明成 application/pdf、docx 等类型上传
 * ------------------------------------------------------------------ */

const BINARY_SIGNATURES = {
  '.pdf': [Buffer.from('%PDF-')],
  '.zip': [Buffer.from('PK\x03\x04'), Buffer.from('PK\x05\x06'), Buffer.from('PK\x07\x08')],
  // docx / xlsx / pptx 实为 zip 容器
  '.docx': [Buffer.from('PK\x03\x04')],
  '.xlsx': [Buffer.from('PK\x03\x04')],
  '.pptx': [Buffer.from('PK\x03\x04')],
  // 旧版 Office 复合文档格式
  '.doc': [Buffer.from('d0cf11e0a1b11ae1', 'hex')],
  '.xls': [Buffer.from('d0cf11e0a1b11ae1', 'hex')],
  '.ppt': [Buffer.from('d0cf11e0a1b11ae1', 'hex')],
  '.gz': [Buffer.from('1f8b', 'hex')],
  '.tar': [Buffer.from('ustar', 'latin1')],
};

/** 校验二进制格式的真实文件头；无签名的格式返回 true（交由其他规则处理） */
export function matchesBinarySignature(buf, ext) {
  const sigs = BINARY_SIGNATURES[ext];
  if (!sigs) return true;

  // .tar 的 "ustar" 出现在偏移 257 处
  if (ext === '.tar') {
    return buf.length > 262 && buf.slice(257, 262).toString('latin1') === 'ustar';
  }
  return sigs.some((sig) => buf.length >= sig.length && buf.slice(0, sig.length).equals(sig));
}

/* ------------------------------------------------------------------ *
 * 主校验入口
 * ------------------------------------------------------------------ */

/**
 * 校验上传文件是否允许
 * @returns {{ ok: true, ext: string, mime: string, inline: boolean, displayName: string }
 *          | { ok: false, reason: string }}
 */
export function validateUpload({ originalname, mimetype, buffer }) {
  const displayName = sanitizeDisplayName(originalname);

  // 1) 原始文件名包含危险扩展名 → 直接拒绝（双扩展名也会被识别）
  if (isDangerousFilename(originalname)) {
    return { ok: false, reason: '出于安全考虑，不支持上传可执行脚本、网页或程序文件' };
  }

  const declared = String(mimetype || '').toLowerCase().split(';')[0].trim();

  // 2) 图片：必须通过魔数校验，且落盘扩展名以真实类型为准
  if (declared.startsWith('image/')) {
    const detected = detectImage(buffer);
    if (!detected) {
      return { ok: false, reason: '图片内容校验未通过，请确认文件是有效的图片' };
    }
    if (looksLikeScript(buffer) && detected.mime !== 'image/svg+xml') {
      // 图片头部合法但内含脚本特征（如伪装的多态文件）→ 拒绝
      return { ok: false, reason: '文件内容包含可疑代码，已拒绝上传' };
    }
    return { ok: true, ext: detected.ext, mime: detected.mime, inline: true, displayName };
  }

  // 3) 文档：MIME 必须命中白名单
  const ext = ALLOWED_MIME[declared];
  if (ext === undefined) {
    return { ok: false, reason: `不支持的文件类型（${declared || '未知'}），仅支持图片与常见文档` };
  }
  if (ext === null) {
    // application/octet-stream：仅当内容不像脚本时，按 .bin 保存并强制下载
    if (looksLikeScript(buffer)) {
      return { ok: false, reason: '文件内容包含可疑代码，已拒绝上传' };
    }
    return { ok: true, ext: '.bin', mime: 'application/octet-stream', inline: false, displayName };
  }

  // 4) 文本类文档也要排除脚本特征（例如 .txt 里写 <?php）
  if (declared.startsWith('text/') || declared === 'application/json') {
    const head = buffer.slice(0, 1024).toString('latin1');
    if (/<\?php/i.test(head) || /<script[\s>]/i.test(head) || /<%/.test(head)) {
      return { ok: false, reason: '文件内容包含可疑代码，已拒绝上传' };
    }
    return { ok: true, ext, mime: declared, inline: INLINE_MIME.has(declared), displayName };
  }

  // 5) 二进制格式必须通过文件头魔数校验（防止 HTML/脚本冒充 PDF、docx 等）
  if (!matchesBinarySignature(buffer, ext)) {
    return { ok: false, reason: '文件内容与声明格式不符，已拒绝上传' };
  }
  // 二进制文件内容中若出现脚本特征，同样拒绝
  if (looksLikeScript(buffer)) {
    return { ok: false, reason: '文件内容包含可疑代码，已拒绝上传' };
  }

  return { ok: true, ext, mime: declared, inline: INLINE_MIME.has(declared), displayName };
}

/** 生成安全的落盘文件名：时间戳 + 随机串 + 服务端决定的扩展名 */
export function buildSafeFilename(ext) {
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(String(ext)) ? ext : '.bin';
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${rand}${safeExt}`;
}
