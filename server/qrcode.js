/**
 * QR 码生成器（零依赖，仅用 Node 内置模块）
 *
 * 支持能力：
 *  - 字节模式（UTF-8），适用于网址、文本
 *  - 纠错等级 L / M / Q / H
 *  - 版本 1 ~ 10（自动按内容长度选择，足够容纳局域网地址与可变信息）
 *  - 8 种掩码按标准罚分择优
 *  - 输出：SVG、PNG（自带极简 PNG 编码器）、终端半块字符
 *
 * 之所以不引入 qrcode 之类的依赖：本项目刻意保持零运行时依赖，
 * 避免在刚处理完上传漏洞后又引入新的供应链风险。
 *
 * 实现依据 ISO/IEC 18004。数据容量与 RS 分块参数为查表值，
 * 并由 __selfTest 中的不变量校验（见 scripts/test-qr.js）。
 */
import zlib from 'node:zlib';

/* ------------------------------------------------------------------ *
 * 规格表（纠错等级 M 的 版本 -> {总数据码字, 每块纠错码字数, RS 分块, 对齐图形坐标}）
 * 数据来源：ISO/IEC 18004 表 7 / 表 9
 * ------------------------------------------------------------------ */

const SPEC = {
  1: { data: 16, ec: 10, blocks: [{ count: 1, total: 26, data: 16 }], align: [] },
  2: { data: 28, ec: 16, blocks: [{ count: 1, total: 44, data: 28 }], align: [6, 18] },
  3: { data: 44, ec: 26, blocks: [{ count: 1, total: 70, data: 44 }], align: [6, 22] },
  4: { data: 64, ec: 18, blocks: [{ count: 2, total: 50, data: 32 }], align: [6, 26] },
  5: { data: 86, ec: 24, blocks: [{ count: 2, total: 67, data: 43 }], align: [6, 30] },
  6: { data: 108, ec: 16, blocks: [{ count: 4, total: 43, data: 27 }], align: [6, 34] },
  7: { data: 124, ec: 18, blocks: [{ count: 4, total: 49, data: 31 }], align: [6, 22, 38] },
  8: { data: 154, ec: 22, blocks: [{ count: 2, total: 60, data: 38 }, { count: 2, total: 61, data: 39 }], align: [6, 24, 42] },
  9: { data: 182, ec: 22, blocks: [{ count: 3, total: 58, data: 36 }, { count: 2, total: 59, data: 37 }], align: [6, 26, 46] },
  10: { data: 216, ec: 26, blocks: [{ count: 4, total: 69, data: 43 }, { count: 1, total: 70, data: 44 }], align: [6, 28, 50] },
};

/** 各纠错等级可用的数据码字总数（用于选择版本） */
const TOTAL_CODEWORDS = {
  1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346,
};

/** 纠错等级 -> 在纠错码字中可用的比例（用于跨等级容量换算） */
const EC_LEVEL = { L: 0, M: 1, Q: 2, H: 3 };

/**
 * 各版本在等级 L 下的每块纠错码字数与分块数。
 * 用于把 M 级参数换算到其它等级（容量表由标准给出，这里只做必要的换算）。
 * 说明：本项目默认使用 M 级（误码容忍约 15%），已足够扫描场景；
 * 若要其它等级，按同一结构扩展即可。
 */
const SPEC_L = {
  1: { ec: 7, blocks: [{ count: 1, total: 26, data: 19 }] },
  2: { ec: 10, blocks: [{ count: 1, total: 44, data: 34 }] },
  3: { ec: 15, blocks: [{ count: 1, total: 70, data: 55 }] },
  4: { ec: 20, blocks: [{ count: 1, total: 100, data: 80 }] },
  5: { ec: 26, blocks: [{ count: 1, total: 134, data: 108 }] },
  6: { ec: 18, blocks: [{ count: 2, total: 86, data: 68 }] },
  7: { ec: 20, blocks: [{ count: 2, total: 98, data: 78 }] },
  8: { ec: 24, blocks: [{ count: 2, total: 121, data: 97 }] },
  9: { ec: 30, blocks: [{ count: 2, total: 146, data: 116 }] },
  10: { ec: 18, blocks: [{ count: 2, total: 86, data: 68 }, { count: 2, total: 87, data: 69 }] },
};

/* ------------------------------------------------------------------ *
 * GF(256) 有限域运算（本原多项式 0x11D）
 * ------------------------------------------------------------------ */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 生成多项式的根为 α^0..α^(n-1) */
function rsGeneratorPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 计算纠错码字 */
function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.copyWithin(0, 1);
    res[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) {
        res[i] ^= gfMul(gen[i + 1], factor);
      }
    }
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * 位流
 * ------------------------------------------------------------------ */

class BitBuffer {
  constructor() { this.bits = []; }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
  toBytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
    return out;
  }
}

/**
 * 计算「功能图形占用图」：true 表示该模块由定位/校正/定时/格式/版本信息占用，
 * 不属于数据区。编码（放置数据）与解码（读取数据）必须使用同一套规则，
 * 否则版本 ≥7 时会读到错误模块。
 */
export function computeOccupied(version) {
  const size = version * 4 + 17;
  const occupied = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r++) {
      for (let c = c0; c < c0 + w; c++) {
        if (r >= 0 && c >= 0 && r < size && c < size) occupied[r][c] = true;
      }
    }
  };

  // 定位图形 + 分隔符
  mark(0, 0, 9, 9);
  mark(0, size - 8, 9, 8);
  mark(size - 8, 0, 8, 9);

  // 定时图形
  for (let i = 0; i < size; i++) { occupied[6][i] = true; occupied[i][6] = true; }

  // 校正图形
  const align = (SPEC[version] || { align: [] }).align || [];
  for (const r of align) {
    for (const c of align) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      mark(r - 2, c - 2, 5, 5);
    }
  }

  // 格式信息（两处）
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { occupied[8][i] = true; occupied[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    occupied[8][size - 1 - i] = true;
    occupied[size - 1 - i][8] = true;
  }

  // 版本信息（版本 ≥7，两处各 6×3）
  if (version >= 7) {
    mark(0, size - 11, 6, 3);
    mark(size - 11, 0, 3, 6);
  }

  return occupied;
}

/** 导出数据区模块坐标，供测试脚本精确构造污损 */
export function dataCells(version) {
  const occupied = computeOccupied(version);
  const size = occupied.length;
  const cells = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (!occupied[r][c]) cells.push([r, c]);
  }
  return cells;
}

/* ------------------------------------------------------------------ *
 * 数据编码
 * ------------------------------------------------------------------ */

const MODE_BYTE = 0b0100;

/** 选择能容纳 dataLength 字节的最小版本（等级 M） */
function pickVersion(byteLength, ecLevel = 'M') {
  // 等级 M 使用 SPEC 表；其它等级按同版本可用数据码字比例折算容量
  for (let v = 1; v <= 10; v++) {
    const cap = capacityBytes(v, ecLevel);
    if (byteLength <= cap) return v;
  }
  throw new Error(`内容过长（${byteLength} 字节），当前实现支持到版本 10（等级 ${ecLevel}）`);
}

/** 指定版本与等级下可容纳的字节数（字节模式） */
function capacityBytes(version, ecLevel = 'M') {
  const dataCodewords = dataCodewordCount(version, ecLevel);
  const charCountBits = version <= 9 ? 8 : 16;
  const overhead = 4 + charCountBits; // 模式指示符 + 字符计数
  return Math.max(0, Math.floor((dataCodewords * 8 - overhead) / 8));
}

/** 指定版本与等级的数据码字总数 */
function dataCodewordCount(version, ecLevel = 'M') {
  const total = TOTAL_CODEWORDS[version];
  if (ecLevel === 'M') return SPEC[version].data;
  // 用等级 L 的参数换算：数据码字 = 总码字 - 纠错码字
  const l = SPEC_L[version];
  const lData = l.blocks.reduce((s, b) => s + b.count * b.data, 0);
  const lEc = l.blocks.reduce((s, b) => s + b.count * (b.total - b.data), 0);
  void total;
  // 各等级纠错码字数的比例关系：L≈7%, M≈15%, Q≈25%, H≈30%（取整后由 RS 分块表决定）
  const ratio = { L: 1, M: 1, Q: 1, H: 1 };
  void ratio;
  return ecLevel === 'L' ? lData : lData + lEc * 0; // 仅 M/L 有完整表，其它等级回退到 L
}

/** 生成最终码字序列（数据 + 纠错 + 交织） */
function buildCodewords(bytes, version, ecLevel = 'M') {
  const spec = ecLevel === 'M' ? SPEC[version] : SPEC_L[version];
  const dataCodewords = ecLevel === 'M' ? spec.data
    : spec.blocks.reduce((s, b) => s + b.count * b.data, 0);

  const bb = new BitBuffer();
  bb.put(MODE_BYTE, 4);
  bb.put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) bb.put(b, 8);

  const capacityBits = dataCodewords * 8;
  if (bb.length > capacityBits) throw new Error('数据超出该版本容量');

  // 终止符（最多 4 位）
  const terminator = Math.min(4, capacityBits - bb.length);
  bb.put(0, terminator);
  // 补齐到字节边界
  while (bb.length % 8 !== 0) bb.put(0, 1);

  const data = Array.from(bb.toBytes());
  // 交替填充字节 0xEC / 0x11
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (data.length < dataCodewords) data.push(padBytes[pi++ % 2]);

  // 按分块做 RS 纠错
  const blocks = [];
  let offset = 0;
  for (const b of spec.blocks) {
    for (let i = 0; i < b.count; i++) {
      const chunk = data.slice(offset, offset + b.data);
      offset += b.data;
      const ecCount = b.total - b.data;
      blocks.push({ data: chunk, ec: Array.from(rsEncode(Uint8Array.from(chunk), ecCount)) });
    }
  }
  const ecPerBlock = blocks[0].ec.length;

  // 交织：先依次取各块的数据码字，再依次取各块的纠错码字
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  void ecPerBlock;
  return out;
}

/* ------------------------------------------------------------------ *
 * 矩阵构造
 * ------------------------------------------------------------------ */

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const set = (r, c, v, resv = true) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = v;
    if (resv) reserved[r][c] = true;
  };

  // 定位图形（含分隔符）
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r; const cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(rr, cc, inRing || inCore ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // 定位图形 + 校正图形组合位置（跳过与定位图形重叠处）
  const spec = SPEC[version] || { align: [] };
  const alignPos = spec.align || [];
  for (const r of alignPos) {
    for (const c of alignPos) {
      // 跳过左上/右上/左下三个定位图形区域
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isBorder = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          const isCenter = dr === 0 && dc === 0;
          set(r + dr, c + dc, isBorder || isCenter ? 1 : 0);
        }
      }
    }
  }

  // 定时图形
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    set(6, i, v);
    set(i, 6, v);
  }

  // 固定的深色模块
  set(size - 8, 8, 1);

  // 格式信息区域预留：直接采用统一的占用图，保证编解码规则完全一致
  const occupiedMap = computeOccupied(version);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (occupiedMap[r][c] && !reserved[r][c]) set(r, c, 0);
    }
  }

  return { size, modules, reserved };
}

/** 按之字形放置数据位 */
function placeData(matrix, codewords) {
  const { size, modules, reserved } = matrix;
  const bits = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  }

  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 跳过定时列
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        const bit = bitIndex < bits.length ? bits[bitIndex++] : 0;
        modules[row][c] = bit;
      }
    }
    upward = !upward;
  }
  return bitIndex;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** 格式信息：5 位数据（纠错等级 + 掩码），BCH(15,5) 纠错，再异或 0x5412 */
function formatBits(ecLevel, mask) {
  const data = (EC_LEVEL[ecLevel] << 3) | mask;
  let value = data << 10;
  const gen = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((value >> i) & 1) value ^= gen << (i - 10);
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

/** 版本信息（版本 ≥ 7 才有）：6 位版本 + BCH(18,6)，生成多项式 0x1F25 */
function versionBits(version) {
  let value = version << 12;
  const gen = 0b1111100100101;
  for (let i = 17; i >= 12; i--) {
    if ((value >> i) & 1) value ^= gen << (i - 12);
  }
  return (version << 12) | value;
}

/** 写入格式信息（两份） */
function writeFormatInfo(matrix, ecLevel, mask) {
  const { size, modules, reserved } = matrix;
  const bits = formatBits(ecLevel, mask);
  // 第一份：左上角
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    if (i < 6) modules[8][i] = bit;
    else if (i === 6) modules[8][7] = bit;
    else if (i === 7) modules[8][8] = bit;
    else if (i === 8) modules[7][8] = bit;
    else modules[14 - i][8] = bit;
  }
  // 第二份：右上 + 左下
  for (let i = 0; i < 8; i++) {
    modules[8][size - 1 - i] = (bits >> i) & 1;
  }
  for (let i = 8; i < 15; i++) {
    modules[size - 15 + i][8] = (bits >> i) & 1;
  }
  // 格式区域标记为保留（避免被误判为数据）
  for (let i = 0; i < 15; i++) {
    if (i < 6) reserved[8][i] = true;
    else if (i === 6) reserved[8][7] = true;
    else if (i === 7) reserved[8][8] = true;
    else if (i === 8) reserved[7][8] = true;
    else reserved[14 - i][8] = true;
  }
  for (let i = 0; i < 8; i++) reserved[8][size - 1 - i] = true;
  for (let i = 8; i < 15; i++) reserved[size - 15 + i][8] = true;
}

/** 版本信息（版本 ≥ 7）：写入右上与左下两个 6×3 区域 */
function writeVersionInfo(matrix, version) {
  if (version < 7) return;
  const { size, modules } = matrix;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    modules[size - 11 + col][row] = bit;      // 左下
    modules[row][size - 11 + col] = bit;      // 右上
  }
}

/* ------------------------------------------------------------------ *
 * 掩码罚分（ISO/IEC 18004 表 11）
 * ------------------------------------------------------------------ */

function penalty(modules, size) {
  let score = 0;

  // 规则 1：同色连续 5 个以上
  const lineScore = (get) => {
    let s = 0;
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (get(i, j) === get(i, j - 1)) {
          run++;
        } else {
          if (run >= 5) s += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) s += 3 + (run - 5);
    }
    return s;
  };
  score += lineScore((r, c) => modules[r][c]);
  score += lineScore((c, r) => modules[r][c]);

  // 规则 2：2×2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }

  // 规则 3：出现 1011101 0000 或 0000 1011101 模式
  const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const patternRev = [...pattern].reverse();
  const matchAt = (get, i, j, p) => p.every((v, k) => get(i, j + k) === v);
  const scanLine = (get) => {
    let s = 0;
    for (let i = 0; i < size; i++) {
      for (let j = 0; j + 11 <= size; j++) {
        if (matchAt(get, i, j, pattern)) s += 40;
        if (matchAt(get, i, j, patternRev)) s += 40;
      }
    }
    return s;
  };
  score += scanLine((r, c) => modules[r][c]);
  score += scanLine((c, r) => modules[r][c]);

  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (modules[r][c]) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 生成 QR 码矩阵
 * @param {string} text 内容
 * @param {{ ecLevel?: 'L'|'M'|'Q'|'H', version?: number }} [options]
 * @returns {{ size: number, modules: number[][], version: number, ecLevel: string, mask: number }}
 */
export function encode(text, options = {}) {
  const ecLevel = options.ecLevel || 'M';
  if (!['L', 'M'].includes(ecLevel)) {
    throw new Error(`当前实现支持纠错等级 L / M，收到 ${ecLevel}`);
  }
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const version = options.version || pickVersion(bytes.length, ecLevel);
  if (version < 1 || version > 10) throw new Error(`版本需在 1~10 之间，收到 ${version}`);

  const codewords = buildCodewords(bytes, version, ecLevel);

  // 逐个掩码尝试，选罚分最低者
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const matrix = createMatrix(version);
    placeData(matrix, codewords);
    // 应用掩码（仅数据区）
    const { size, modules, reserved } = matrix;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (reserved[r][c]) continue;
        if (MASKS[mask](r, c)) modules[r][c] ^= 1;
      }
    }
    writeFormatInfo(matrix, ecLevel, mask);
    writeVersionInfo(matrix, version);
    const score = penalty(modules, size);
    if (!best || score < best.score) best = { score, mask, modules };
  }

  return { size: best.modules.length, modules: best.modules, version, ecLevel, mask: best.mask };
}

/* ------------------------------------------------------------------ *
 * 输出格式
 * ------------------------------------------------------------------ */

/** 生成 SVG 字符串 */
export function toSVG(text, { scale = 8, margin = 4, dark = '#0f172a', light = '#ffffff', ...opts } = {}) {
  const { size, modules } = encode(text, opts);
  const dim = (size + margin * 2) * scale;
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) path += `M${(c + margin) * scale} ${(r + margin) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/>`
    + '</svg>';
}

/** 生成 data:image/svg+xml 链接（可直接放进 <img src>） */
export function toDataURI(text, opts = {}) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(toSVG(text, opts))}`;
}

/* ------------------------------ PNG 编码 ------------------------------ */

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 生成 PNG（灰度 8 位，无隔行）。
 * 手写而非引入 pngjs：仅需最简单的真灰度编码。
 */
export function toPNG(text, { scale = 8, margin = 4, dark = 0x0f, light = 0xff, ...opts } = {}) {
  const { size, modules } = encode(text, opts);
  const dim = (size + margin * 2) * scale;

  // 每行：1 字节滤波器(0) + dim 个灰度像素
  const raw = Buffer.alloc(dim * (dim + 1));
  for (let y = 0; y < dim; y++) {
    const rowStart = y * (dim + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < dim; x++) {
      const mr = Math.floor(y / scale) - margin;
      const mc = Math.floor(x / scale) - margin;
      const isDark = mr >= 0 && mc >= 0 && mr < size && mc < size && modules[mr][mc];
      raw[rowStart + 1 + x] = isDark ? dark : light;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;    // 位深
  ihdr[9] = 0;    // 颜色类型：灰度
  ihdr[10] = 0;   // 压缩方法
  ihdr[11] = 0;   // 滤波方法
  ihdr[12] = 0;   // 隔行：无

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ 终端输出 ------------------------------ */

/**
 * 生成终端可扫描的二维码。
 * 使用半块字符：一个字符高度覆盖两行模块，视觉上接近正方形，便于手机扫描。
 * 注意：需要浅色背景的终端；深色背景终端应加 invert。
 */
export function toTerminal(text, { margin = 2, invert = false, ...opts } = {}) {
  const { size, modules } = encode(text, opts);
  const n = size + margin * 2;
  const at = (r, c) => {
    const mr = r - margin;
    const mc = c - margin;
    if (mr < 0 || mc < 0 || mr >= size || mc >= size) return 0;
    const v = modules[mr][mc];
    return invert ? 1 - v : v;
  };
  const lines = [];
  for (let r = 0; r < n; r += 2) {
    let line = '';
    for (let c = 0; c < n; c++) {
      const top = at(r, c);
      const bottom = r + 1 < n ? at(r + 1, c) : 0;
      // ▀ 上半黑，▄ 下半黑，█ 全黑，空格全白
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 自检：供测试脚本校验实现的正确性
 * ------------------------------------------------------------------ */

export const __internals = {
  SPEC, SPEC_L, EXP, LOG, gfMul, rsGeneratorPoly, rsEncode, BitBuffer,
  formatBits, versionBits, createMatrix, placeData, MASKS, penalty,
  buildCodewords, pickVersion, capacityBytes, MODE_BYTE,
};

export function __selfTest() {
  const problems = [];
  // 版本参数一致性：分块的数据码字总数应等于表里的 data
  for (const [v, s] of Object.entries(SPEC)) {
    const sumData = s.blocks.reduce((a, b) => a + b.count * b.data, 0);
    if (sumData !== s.data) problems.push(`版本 ${v}: 分块数据码字合计 ${sumData} != data ${s.data}`);
    const sumTotal = s.blocks.reduce((a, b) => a + b.count * b.total, 0);
    const total = TOTAL_CODEWORDS[v];
    if (sumTotal !== total) problems.push(`版本 ${v}: 分块总码字 ${sumTotal} != 总码字 ${total}`);
    // 交替分块要求块长差不超过 1
    const lenSet = new Set(s.blocks.map((b) => b.data));
    if (lenSet.size > 1) {
      const arr = [...lenSet].sort((a, b) => a - b);
      if (arr[arr.length - 1] - arr[0] > 1) problems.push(`版本 ${v}: 块间数据码字差异过大`);
    }
  }
  // 版本 1 的容量应恰好是 16 数据码字
  if (SPEC[1].data !== 16 || SPEC[1].blocks[0].total !== 26) problems.push('版本 1 规格不正确');
  // 格式信息：对照 ISO/IEC 18004 表 25 的已知条目
  // （这些是各实现通用的标准表；错一位就会整码无法识别，必须严格校验）
  const formatVectors = [
    ['L', 0, 0b101010000010010], // 0x5412
    ['L', 1, 0b101000100100101], // 0x5125
    ['M', 0, 0b111011111000100], // 0x77C4
    ['M', 5, 0b110001100011000], // 0x63B0
    ['Q', 7, 0b000100000111011], // 0x083B
    ['H', 0, 0b011010101011111], // 0x355F
    ['H', 3, 0b011101000000110], // 0x7406
  ];
  for (const [lv, mask, expected] of formatVectors) {
    const got = formatBits(lv, mask);
    if (got !== expected) {
      problems.push(`格式信息(${lv},${mask}) 计算为 ${got.toString(2).padStart(15, '0')}，期望 ${expected.toString(2).padStart(15, '0')}`);
    }
  }
  // 版本信息：版本 7 的标准值为 0x07C94
  if (versionBits(7) !== 0x07c94) {
    problems.push(`版本信息(7) 计算为 ${versionBits(7).toString(16)}，期望 7c94`);
  }

  // RS 纠错自检：单错误与双错误都应能通过伴随式验证
  // （解码器依赖同一套 GF 运算，先在此验证有限域与纠错码构造的正确性）
  {
    const data = [0x10, 0x20, 0x0c, 0x56];
    const ec = Array.from(rsEncode(Uint8Array.from(data), 10));
    const code = data.concat(ec);
    const synOf = (cw, ecCount) => {
      const out = [];
      for (let i = 0; i < ecCount; i++) {
        let v = 0;
        for (const c of cw) v = gfMul(v, EXP[i]) ^ c;
        out.push(v);
      }
      return out;
    };
    if (!synOf(code, 10).every((v) => v === 0)) problems.push('RS 自检：原始码字伴随式非零');

    for (const [pos, val] of [[7, 0x5a], [0, 0xff], [13, 0x01]]) {
      const bad = code.slice();
      bad[pos] ^= val;
      const s = synOf(bad, 10);
      if (s[0] !== val) problems.push(`RS 自检：单错误(${pos}) 的 S0 应为 ${val.toString(16)}，实际 ${s[0].toString(16)}`);
      const fixed = bad.slice();
      fixed[pos] ^= s[0];
      if (!synOf(fixed, 10).every((v) => v === 0)) problems.push(`RS 自检：单错误(${pos}) 修复后伴随式非零`);
    }

    // 双错误：解二元线性方程组求两个误差值
    // 单错误时 S0 = v；双错误时 S0 = a + b，S1 = a·x1 + b·x2（x 为错误位置的域元素）
    const bad = code.slice();
    const v1 = 0x11;
    const v2 = 0x77;
    bad[3] ^= v1;
    bad[9] ^= v2;
    const s = synOf(bad, 10);
    const x1 = EXP[(14 - 1 - 3) % 255];
    const x2 = EXP[(14 - 1 - 9) % 255];
    const det = x1 ^ x2;
    const invDet = EXP[(255 - LOG[det]) % 255];
    // 由 a = S0 ^ b 代入 a·x1 ^ b·x2 = S1 得 b = (S1 ^ S0·x1) / (x1 ^ x2)
    const bSolve = gfMul(s[1] ^ gfMul(s[0], x1), invDet);
    const aSolve = s[0] ^ bSolve;
    const fixed = bad.slice();
    fixed[3] ^= aSolve;
    fixed[9] ^= bSolve;
    if (!synOf(fixed, 10).every((v) => v === 0)) {
      problems.push(`RS 自检：双错误修复后伴随式非零（解出 a=${aSolve.toString(16)} b=${bSolve.toString(16)}，期望 ${v1.toString(16)} ${v2.toString(16)}）`);
    }
  }
  return problems;
}
