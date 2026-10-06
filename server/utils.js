/**
 * 通用工具：编号生成、分页、参数校验
 */
import { get } from './db.js';

/** 生成业务编号，如 KH20240101-0001 / GD20240101-0001 */
export function nextCode(prefix, table) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const like = `${prefix}${ymd}-%`;
  const row = get(`SELECT code FROM ${table} WHERE code LIKE ? ORDER BY code DESC LIMIT 1`, [like]);
  const seq = row ? Number(row.code.split('-')[1]) + 1 : 1;
  return `${prefix}${ymd}-${String(seq).padStart(4, '0')}`;
}

/** 解析分页参数 */
export function pagination(query, defaultSize = 20, maxSize = 200) {
  const page = Math.max(1, Number(query.page) || 1);
  const size = Math.min(maxSize, Math.max(1, Number(query.pageSize) || defaultSize));
  return { page, size, offset: (page - 1) * size };
}

export function pagedResult(list, total, page, size) {
  return {
    list,
    pagination: {
      page,
      pageSize: size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
    },
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** 本地时间字符串 YYYY-MM-DD HH:mm:ss（与 SQLite 的 datetime('now','localtime') 保持一致） */
export function fmtLocal(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 当前本地时间字符串（全库统一时间基准） */
export function nowStr() {
  return fmtLocal(new Date());
}

export function addHours(dateStr, hours) {
  const d = dateStr ? new Date(String(dateStr).replace(' ', 'T')) : new Date();
  d.setHours(d.getHours() + hours);
  return fmtLocal(d);
}

/** 安全 JSON 解析 */
export function parseJSON(str, fallback = []) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/** SQL 排序字段白名单 */
export function safeSort(input, allowed, fallback) {
  const v = String(input || '').trim();
  return allowed.includes(v) ? v : fallback;
}

/** 简易速率限制（内存版，用于登录等敏感接口） */
const buckets = new Map();
export function rateLimit(key, limit = 20, windowMs = 60_000) {
  const now = Date.now();
  const rec = buckets.get(key);
  if (!rec || now > rec.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  rec.count++;
  return rec.count <= limit;
}
