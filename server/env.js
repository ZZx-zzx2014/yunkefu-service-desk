/**
 * 零依赖的 .env 加载器
 *
 * 为什么不直接用 dotenv：
 *   本项目刻意保持零多余运行时依赖（见 README「依赖说明」）。
 *   .env 的语法很简单，自己解析足够，也避免多一个供应链依赖。
 *
 * 行为：
 *   - 在 server/config.js 之前被调用，把 .env 的值写入 process.env
 *   - 已存在的环境变量优先（不覆盖真实环境变量，符合 .env 的通用约定）
 *   - 支持 # 注释、引号、export 前缀、\n 转义
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 解析 .env 文本为键值对 */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let [, key, value] = m;
    value = value.trim();
    // 去掉行尾注释（仅当值未被引号包裹）
    if (!/^["']/.test(value)) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx > -1) value = value.slice(0, hashIdx).trim();
    }
    // 去掉包裹引号并还原转义
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    }
    out[key] = value;
  }
  return out;
}

/**
 * 载入 .env（若存在）
 * @returns {{ loaded: boolean, file: string, keys: string[] }}
 */
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return { loaded: false, file, keys: [] };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { loaded: false, file, keys: [] };
  }
  const parsed = parseEnv(text);
  const applied = [];
  for (const [key, value] of Object.entries(parsed)) {
    // 已存在的环境变量优先，避免覆盖运行时的真实配置
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return { loaded: true, file, keys: applied };
}
