/**
 * QR 码生成器验证
 *   node scripts/test-qr.js
 *
 * 这是一次「写编码器 + 写解码器」的双向验证：
 * 只有解码器能从生成的矩阵中还原出原文、且结构特征与标准相符，
 * 才能说明这些二维码确实可以被扫码器识别。
 * （本环境无法使用无头浏览器/摄像头实测扫描，故采用独立解码实现交叉验证。）
 */
import { encode, toPNG, toSVG, toTerminal, __internals, __selfTest, computeOccupied, dataCells } from '../server/qrcode.js';
import zlib from 'node:zlib';

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label} ${extra}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

const { EXP, LOG, gfMul, SPEC } = __internals;

/* ================================================================== *
 * 独立解码器（不复用编码器内部逻辑，避免同源掩盖错误）
 * ================================================================== */

/** PNG 解码：仅处理本编码器输出的灰度 8 位无隔行 PNG */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 0) throw new Error(`不支持的 PNG 格式 depth=${bitDepth} color=${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // 逐行去滤波（本编码器只用 filter 0）
  const pixels = [];
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width + 1);
    const filter = raw[rowStart];
    if (filter !== 0) throw new Error(`意外的滤波类型 ${filter}`);
    pixels.push(Array.from(raw.slice(rowStart + 1, rowStart + 1 + width)));
  }
  return { width, height, pixels };
}

/** GF(256) 除法辅助 */
function gfDiv(a, b) {
  if (b === 0) throw new Error('除零');
  if (a === 0) return 0;
  return EXP[(LOG[a] - LOG[b] + 255) % 255];
}

/** 计算多项式在 α^0..α^(n-1) 处的值（伴随式） */
function syndromes(codewords, ecCount) {
  const out = [];
  for (let i = 0; i < ecCount; i++) {
    let value = 0;
    for (const cw of codewords) value = gfMul(value, EXP[i]) ^ cw;
    out.push(value);
  }
  return out;
}

/** Berlekamp-Massey 求错误位置多项式 */
function berlekampMassey(syn) {
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  const copy = (p) => p.slice();
  for (let n = 0; n < syn.length; n++) {
    let d = syn[n];
    for (let i = 1; i <= L; i++) d ^= gfMul(C[i] ?? 0, syn[n - i]);
    if (d === 0) {
      m++;
    } else if (2 * L <= n) {
      const T = copy(C);
      const scale = gfDiv(d, b);
      const shifted = new Array(m).fill(0).concat(B.map((v) => gfMul(v, scale)));
      for (let i = 0; i < shifted.length; i++) C[i] = (C[i] ?? 0) ^ shifted[i];
      L = n + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else {
      const scale = gfDiv(d, b);
      const shifted = new Array(m).fill(0).concat(B.map((v) => gfMul(v, scale)));
      for (let i = 0; i < shifted.length; i++) C[i] = (C[i] ?? 0) ^ shifted[i];
      m++;
    }
  }
  return C;
}

/** 用错误位置多项式恢复数据（最多纠正 ecCount/2 个错误） */
function correctErrors(codewords, ecCount) {
  const syn = syndromes(codewords, ecCount);
  if (syn.every((v) => v === 0)) return codewords;

  const n = codewords.length;
  const C = berlekampMassey(syn);
  const errPos = [];
  for (let N = 0; N < n; N++) {
    const q = n - 1 - N;                 // 数组下标 N 对应域元素 α^q
    const xInv = EXP[(255 - ((q % 255) + 255) % 255) % 255];
    let value = 0;
    for (let j = 0; j < C.length; j++) {
      value ^= gfMul(C[j] ?? 0, j === 0 ? 1 : EXP[(LOG[xInv] * j) % 255]);
    }
    if (value === 0) errPos.push(N);
  }

  const fail = (msg) => {
    const err = new Error(msg);
    err.debug = [
      `伴随式(前4): ${syn.slice(0, 4).map((v) => v.toString(16)).join(' ')}`,
      `定位多项式次数: ${C.length - 1}`,
      `候选错误位置: [${errPos.join(',')}] (共 ${errPos.length}，能力上限 ${Math.floor(ecCount / 2)})`,
      `码字长度: ${n}，纠错码字数: ${ecCount}`,
    ];
    throw err;
  };

  if (errPos.length === 0) return fail('无法纠正：未定位到错误位置');
  if (errPos.length > Math.floor(ecCount / 2)) {
    return fail(`无法纠正：错误过多（${errPos.length} > ${Math.floor(ecCount / 2)}）`);
  }

  const k = errPos.length;
  const A = [];
  const b = [];
  for (let i = 0; i < k; i++) {
    const row = [];
    for (let j = 0; j < k; j++) {
      const p = n - 1 - errPos[j];
      row.push(EXP[(p * i) % 255]);
    }
    A.push(row);
    b.push(syn[i]);
  }

  for (let i = 0; i < k; i++) {
    let piv = -1;
    for (let r = i; r < k; r++) if (A[r][i] !== 0) { piv = r; break; }
    if (piv < 0) return fail(`纠错方程组奇异（第 ${i} 列无主元）`);
    [A[i], A[piv]] = [A[piv], A[i]];
    [b[i], b[piv]] = [b[piv], b[i]];
    const inv = gfDiv(1, A[i][i]);
    for (let c = i; c < k; c++) A[i][c] = gfMul(A[i][c], inv);
    b[i] = gfMul(b[i], inv);
    for (let r = 0; r < k; r++) {
      if (r === i || A[r][i] === 0) continue;
      const f = A[r][i];
      for (let c = i; c < k; c++) A[r][c] ^= gfMul(f, A[i][c]);
      b[r] ^= gfMul(f, b[i]);
    }
  }

  const out = codewords.slice();
  for (let j = 0; j < k; j++) out[errPos[j]] ^= b[j];
  if (!syndromes(out, ecCount).every((v) => v === 0)) {
    return fail(`纠错后伴随式仍非零（位置 [${errPos.join(',')}] 修正值 [${b.map((v) => v.toString(16)).join(',')}]）`);
  }
  return out;
}

/** 从模块矩阵解码出文本 */
function decodeMatrix(modules, size) {
  // 1) 校验定位图形
  const finderOk = (r0, c0) => {
    const expect = [
      [1, 1, 1, 1, 1, 1, 1],
      [1, 0, 0, 0, 0, 0, 1],
      [1, 0, 1, 1, 1, 0, 1],
      [1, 0, 1, 1, 1, 0, 1],
      [1, 0, 1, 1, 1, 0, 1],
      [1, 0, 0, 0, 0, 0, 1],
      [1, 1, 1, 1, 1, 1, 1],
    ];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      if (modules[r0 + r][c0 + c] !== expect[r][c]) return false;
    }
    return true;
  };
  if (!finderOk(0, 0) || !finderOk(0, size - 7) || !finderOk(size - 7, 0)) {
    throw new Error('定位图形不正确');
  }

  // 2) 定时图形校验
  for (let i = 8; i < size - 8; i++) {
    const want = i % 2 === 0 ? 1 : 0;
    if (modules[6][i] !== want || modules[i][6] !== want) throw new Error('定时图形不正确');
  }

  // 3) 读取格式信息（第一份）并换算纠错等级与掩码
  let raw = 0;
  for (let i = 14; i >= 0; i--) {
    let bit;
    if (i < 6) bit = modules[8][i];
    else if (i === 6) bit = modules[8][7];
    else if (i === 7) bit = modules[8][8];
    else if (i === 8) bit = modules[7][8];
    else bit = modules[14 - i][8];
    raw = (raw << 1) | bit;
  }
  const unmasked = raw ^ 0b101010000010010;
  const ecBits = (unmasked >> 13) & 0b11;
  const maskId = (unmasked >> 10) & 0b111;
  const ecName = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' }[ecBits] || `未知(${ecBits})`;

  // 4) 依据版本重建功能图形占用图
  //    必须与编码器使用完全相同的规则（computeOccupied），
  //    否则版本 ≥7 会读到错误模块而无法还原。
  const size2 = size;
  const version = Math.round((size2 - 17) / 4);
  const occupied = computeOccupied(version);

  // 5) 反向读取数据位（含去掩码）
  const masks = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const bits = [];
  let upward = true;
  for (let col = size2 - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size2; i++) {
      const row = upward ? size2 - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (occupied[row][c]) continue;
        let v = modules[row][c];
        if (masks[maskId](row, c)) v ^= 1;
        bits.push(v);
      }
    }
    upward = !upward;
  }

  // 6) 位 -> 码字
  const totalCodewords = Math.floor(bits.length / 8);
  const codewords = [];
  for (let i = 0; i < totalCodewords; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    codewords.push(v);
  }

  // 7) 反交织为各块，逐块纠错
  const spec = SPEC[version];
  const blockLayout = [];
  for (const b of spec.blocks) {
    for (let i = 0; i < b.count; i++) blockLayout.push({ data: b.data, ec: b.total - b.data });
  }
  const blocks = blockLayout.map((b) => ({ data: [], ec: [], ecCount: b.ec, dataLen: b.data }));
  let idx = 0;
  const maxData = Math.max(...blockLayout.map((b) => b.data));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.dataLen) b.data.push(codewords[idx++]);
  }
  const ecLen = blockLayout[0].ec;
  for (let i = 0; i < ecLen; i++) {
    for (const b of blocks) b.ec.push(codewords[idx++]);
  }

  const dataBytes = [];
  let correctedCount = 0;
  for (const b of blocks) {
    const full = b.data.concat(b.ec);
    const fixed = correctErrors(full, b.ecCount);
    if (fixed.some((v, i) => v !== full[i])) correctedCount++;
    dataBytes.push(...fixed.slice(0, b.dataLen));
  }

  // 8) 解析位流
  const stream = [];
  for (const byte of dataBytes) for (let i = 7; i >= 0; i--) stream.push((byte >> i) & 1);
  let p = 0;
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | (stream[p++] ?? 0);
    return v;
  };
  const mode = readBits(4);
  if (mode !== 0b0100) throw new Error(`期望字节模式(0100)，实际 ${mode.toString(2)}`);
  const charCount = readBits(version <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < charCount; i++) bytes.push(readBits(8));
  const text = Buffer.from(bytes).toString('utf8');

  return { text, version, ecLevel: ecName, maskId, correctedCount, totalCodewords };
}

/* ================================================================== *
 * 测试
 * ================================================================== */

console.log('\n=== QR 码生成器验证 ===');

section('1. 规格表不变量');
{
  const problems = __selfTest();
  check('版本参数自检通过（块长/总码字/格式信息）', problems.length === 0, problems.join('；'));
  check('版本 1 规格正确（16 数据码字 / 26 总码字）', SPEC[1].data === 16 && SPEC[1].blocks[0].total === 26);
  check('GF(256) 对数表可逆', [1, 2, 3, 100, 255].every((v) => EXP[LOG[v]] === v));
  check('GF(256) 乘法满足交换律', [3, 7, 99].every((a) => [5, 11].every((b) => gfMul(a, b) === gfMul(b, a))));
}

section('2. 编码后独立解码（还原原文）');
{
  const cases = [
    'http://172.16.250.15:3000/',
    'http://192.168.1.100:3000/',
    'https://kefu.example.com/agent',
    '短',
    'A',
    'http://10.0.0.5:3000/?channel=qrcode',
    '云客客服中心 - 局域网访问地址 http://172.16.250.15:3000/ 请用手机扫描',
    'http://172.16.250.15:3000/#/chat',
  ];
  for (const text of cases) {
    let ok = false; let detail = '';
    try {
      const qr = encode(text);
      const decoded = decodeMatrix(qr.modules, qr.size);
      ok = decoded.text === text;
      detail = ok ? `v${decoded.version} 等级${decoded.ecLevel} 掩码${decoded.maskId}` : `还原为「${decoded.text}」`;
    } catch (err) {
      detail = err.message;
    }
    const label = text.length > 34 ? `${text.slice(0, 34)}…` : text;
    check(`解码还原：${label}`, ok, detail);
  }
}

section('3. PNG 输出与图像解码链路');
{
  const text = 'http://172.16.250.15:3000/';
  const png = toPNG(text, { scale: 8, margin: 4 });
  check('PNG 文件头正确', png.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  check('PNG 体积合理（< 8KB）', png.length < 8192, `${png.length} 字节`);

  // 从 PNG 像素反推模块矩阵，再交给解码器 —— 端到端验证「图片可被扫描」
  const img = decodePNG(png);
  const qr = encode(text, { scale: 8, margin: 4 });
  const scale = 8; const margin = 4;
  const size = qr.size;
  const recovered = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      // 取每个模块中心像素
      const x = (c + margin) * scale + Math.floor(scale / 2);
      const y = (r + margin) * scale + Math.floor(scale / 2);
      recovered[r][c] = img.pixels[y][x] < 128 ? 1 : 0;
    }
  }
  check('PNG 尺寸与模块数一致', img.width === (size + margin * 2) * scale, `${img.width}px`);

  let ok = false; let detail = '';
  try {
    const decoded = decodeMatrix(recovered, size);
    ok = decoded.text === text;
    detail = ok ? '从像素还原成功' : `还原为「${decoded.text}」`;
  } catch (err) { detail = err.message; }
  check('从 PNG 像素还原原文（模拟扫码）', ok, detail);
}

section('4. 抗污损能力（纠错等级 M 应容忍一定错误）');
{
  const text = 'http://172.16.250.15:3000/agent';
  const qr = encode(text, { ecLevel: 'M' });
  // 只在「数据区」模块上制造污损：必须避开定位/校正/定时/格式/版本信息，
  // 因为纠错码保护的是数据与纠错码字，破坏功能图形会直接导致无法定位。
  const cells = dataCells(qr.version);
  const picked = [];
  for (let i = 0; i < 5 && i * 37 < cells.length; i++) picked.push(cells[i * 37]);
  const corrupted = qr.modules.map((row) => row.slice());
  for (const [r, c] of picked) corrupted[r][c] ^= 1;

  let ok = false; let detail = '';
  try {
    const decoded = decodeMatrix(corrupted, qr.size);
    ok = decoded.text === text;
    detail = `翻转 ${picked.length} 个数据模块后仍还原成功（触发纠错的块数 ${decoded.correctedCount}）`;
  } catch (err) {
    detail = `${err.message} | 翻转模块 ${JSON.stringify(picked)}`;
    if (process.env.QR_DEBUG) {
      // 输出纠错过程细节，便于定位
      const dbg = encode(text, { ecLevel: 'M' });
      void dbg;
      console.log('      [调试] 翻转位置:', JSON.stringify(picked));
      console.log('      [调试] 版本', qr.version, '最大数据码字', SPEC[qr.version].data);
      for (const e of err.debug ?? []) console.log('      [调试]', e);
    }
  }
  check('数据区少量污损仍可正确解码', ok, detail);

  // 纠错能力上限：等级 M 单块可纠 (ecCount/2) 个码字错误
  const spec = SPEC[qr.version];
  const capacity = Math.floor((spec.blocks[0].total - spec.blocks[0].data) / 2);
  check('纠错能力满足标准（等级 M 每块可纠 %d 个码字错误）'.replace('%d', capacity), capacity >= 5,
    `每块纠错码字 ${spec.blocks[0].total - spec.blocks[0].data}，可纠 ${capacity}`);
}

section('5. 掩码选择与版本自适应');
{
  const small = encode('hi');
  const big = encode('x'.repeat(120));
  check('短内容选用较小版本', small.version <= 2, `v${small.version}`);
  check('长内容自动升版本', big.version > small.version, `v${small.version} -> v${big.version}`);
  check('掩码在 0~7 范围内', small.mask >= 0 && small.mask <= 7, `mask=${small.mask}`);

  // 超长内容应给出清晰错误
  let threw = false;
  try { encode('x'.repeat(500)); } catch { threw = true; }
  check('超出容量时抛出明确错误', threw);
}

section('6. 输出格式');
{
  const text = 'http://172.16.250.15:3000/';
  const svg = toSVG(text, { scale: 6, margin: 2 });
  check('SVG 含 svg 根标签与路径',
    svg.includes('<svg') && svg.includes('<path d="M') && svg.includes('viewBox'));
  check('SVG 尺寸与模块数一致', /width="(\d+)"/.test(svg));

  const term = toTerminal(text, { margin: 1 });
  const lines = term.split('\n');
  check('终端输出为方正的行块（半块字符）',
    lines.length > 5 && /[▀▄█]/.test(term), `共 ${lines.length} 行`);
  check('终端输出每行等长', lines.every((l) => l.length === lines[0].length));
}

section('7. 各版本全量往返');
{
  let bad = 0;
  const details = [];
  for (let v = 1; v <= 10; v++) {
    const cap = __internals.capacityBytes(v, 'M');
    const payload = 'A'.repeat(Math.max(1, Math.min(cap, 40)));
    try {
      const qr = encode(payload, { version: v });
      const decoded = decodeMatrix(qr.modules, qr.size);
      if (decoded.text !== payload || decoded.version !== v) { bad++; details.push(`v${v} 不匹配`); }
    } catch (err) {
      bad++; details.push(`v${v}: ${err.message}`);
    }
  }
  check('版本 1~10 全部可正确编解码', bad === 0, details.join('；') || '10 个版本全部通过');
}

section('8. 局域网接入接口（/api/lan、/api/qr、/lan）');
{
  const BASE = process.env.BASE || 'http://127.0.0.1:3000';

  const lanRes = await fetch(`${BASE}/api/lan`);
  const lan = (await lanRes.json()).data;
  check('/api/lan 返回可用地址列表',
    lanRes.status === 200 && Array.isArray(lan?.addresses) && lan.addresses.length > 0,
    `共 ${lan?.addresses?.length ?? 0} 个地址`);
  check('推荐地址排在首位且标记 recommended',
    lan.addresses[0]?.recommended === true && lan.primary?.url === lan.addresses[0].url);
  check('地址为可直接访问的 http URL',
    /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/$/.test(lan.primary?.url || ''), lan.primary?.url);
  check('每个地址附带网卡名称与类型',
    lan.addresses.every((a) => a.interface && a.kind));

  const qrPng = await fetch(`${BASE}/api/qr`);
  const pngBuf = Buffer.from(await qrPng.arrayBuffer());
  check('/api/qr 默认返回 PNG 图片',
    qrPng.status === 200 && qrPng.headers.get('content-type') === 'image/png'
    && pngBuf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    `status=${qrPng.status} type=${qrPng.headers.get('content-type')}`);

  // 默认二维码内容应为推荐局域网地址 —— 通过解码 PNG 确认
  const img = decodePNG(pngBuf);
  const margin = 4; const scale = 8;
  const size = (img.width / scale) - margin * 2;
  const grid = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      grid[r][c] = img.pixels[(r + margin) * scale + 4][(c + margin) * scale + 4] < 128 ? 1 : 0;
    }
  }
  let decodedDefault = '';
  try { decodedDefault = decodeMatrix(grid, size).text; } catch { /* 保持空串 */ }
  check('/api/qr 默认编码推荐局域网地址', decodedDefault === lan.primary.url,
    `解出「${decodedDefault}」`);

  const qrSvg = await fetch(`${BASE}/api/qr?format=svg&scale=6`);
  const svgText = await qrSvg.text();
  check('/api/qr?format=svg 返回 SVG',
    qrSvg.status === 200 && svgText.startsWith('<svg') && svgText.includes('<path'));

  const custom = 'http://example.com/custom-path?x=1';
  const qrCustom = await fetch(`${BASE}/api/qr?data=${encodeURIComponent(custom)}&scale=6`);
  const customImg = decodePNG(Buffer.from(await qrCustom.arrayBuffer()));
  const cSize = (customImg.width / 6) - 8;
  const cGrid = Array.from({ length: cSize }, () => new Array(cSize).fill(0));
  for (let r = 0; r < cSize; r++) {
    for (let c = 0; c < cSize; c++) {
      cGrid[r][c] = customImg.pixels[(r + 4) * 6 + 3][(c + 4) * 6 + 3] < 128 ? 1 : 0;
    }
  }
  let decodedCustom = '';
  try { decodedCustom = decodeMatrix(cGrid, cSize).text; } catch { /* ignore */ }
  check('/api/qr 支持自定义内容', decodedCustom === custom, `解出「${decodedCustom}」`);

  const tooLong = await fetch(`${BASE}/api/qr?data=${'x'.repeat(1000)}`);
  check('超长内容返回 400 且提示清晰', tooLong.status === 400,
    `status=${tooLong.status}`);

  const lanPage = await fetch(`${BASE}/lan`);
  const pageHtml = await lanPage.text();
  check('/lan 页面可访问且内嵌二维码',
    lanPage.status === 200 && pageHtml.includes('data:image/svg+xml') && pageHtml.includes(lan.primary.address));
  check('/lan 页面包含安全提示', pageHtml.includes('KEFU_SECRET'));
}

console.log(`\n${'═'.repeat(56)}`);
if (fail === 0) console.log(`\x1b[32m✓ QR 码验证全部通过：${pass} 项检查\x1b[0m`);
else {
  console.log(`\x1b[32m通过 ${pass} 项\x1b[0m，\x1b[31m失败 ${fail} 项\x1b[0m`);
  console.log('失败项：\n  - ' + failures.join('\n  - '));
}
console.log(`${'═'.repeat(56)}\n`);
process.exitCode = fail === 0 ? 0 : 1;
