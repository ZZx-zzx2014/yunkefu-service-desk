/**
 * 数据访问层
 * 基于 Node.js 内置 node:sqlite（Node >= 22.5），无需原生编译依赖。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DB_FILE } from './config.js';

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new DatabaseSync(DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
-- 性能调优：WAL 模式下 synchronous=NORMAL 兼顾持久性与写入速度（掉电最多丢最后一个事务，不会损坏库）
PRAGMA synchronous = NORMAL;
-- 页缓存 16MB（默认 2MB），减少热点数据读盘
PRAGMA cache_size = -16000;
-- 临时表/排序放内存，加速列表页 ORDER BY
PRAGMA temp_store = MEMORY;
`);

/* ------------------------------------------------------------------ *
 * 工具封装：统一 run/get/all，屏蔽 node:sqlite 的细节
 * ------------------------------------------------------------------ */

export function run(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.run(...normalize(params));
}

export function get(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.get(...normalize(params)) ?? null;
}

export function all(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.all(...normalize(params));
}

/** node:sqlite 只接受 null / number / bigint / string / Uint8Array / boolean */
function normalize(params) {
  const arr = Array.isArray(params) ? params : [params];
  return arr.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return Number.isInteger(v) ? v : v;
    if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
    return v;
  });
}

/** 简单事务包装 */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * 建表
 * ------------------------------------------------------------------ */

db.exec(`
-- 部门
CREATE TABLE IF NOT EXISTS departments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 用户（坐席 / 管理员 / 客户，统一账号体系）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'agent',      -- admin | agent | customer
  email         TEXT DEFAULT '',
  phone         TEXT DEFAULT '',
  avatar        TEXT DEFAULT '',
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  level         TEXT DEFAULT '初级',                 -- 坐席等级
  skills        TEXT DEFAULT '[]',                   -- 技能标签 JSON
  max_concurrent INTEGER DEFAULT 5,                  -- 最大同时接待数
  status        TEXT NOT NULL DEFAULT 'offline',     -- online | busy | away | offline
  active        INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  -- 双因素认证（TOTP）
  totp_secret        TEXT,                            -- Base32 密钥（启用后才有值）
  totp_enabled       INTEGER NOT NULL DEFAULT 0,      -- 是否已启用
  totp_confirmed_at  TEXT,                            -- 启用时间
  totp_last_step     INTEGER,                         -- 最近一次校验通过的时间步（防重放）
  backup_codes       TEXT DEFAULT '[]',               -- 备份码散列数组 JSON
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- 会话
CREATE TABLE IF NOT EXISTS conversations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,               -- 会话编号 KH20240101-0001
  customer_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  channel        TEXT NOT NULL DEFAULT 'web',        -- web | app | wechat | phone | email
  subject        TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'queued',     -- queued | active | closed
  priority       TEXT NOT NULL DEFAULT 'normal',     -- low | normal | high | urgent
  tag            TEXT DEFAULT '',
  source_url     TEXT DEFAULT '',
  rating         INTEGER,                            -- 1-5 满意度
  rating_comment TEXT DEFAULT '',
  queued_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  started_at     TEXT,
  closed_at      TEXT,
  closed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_message_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  unread_customer INTEGER NOT NULL DEFAULT 0,
  unread_agent    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agent_id);
CREATE INDEX IF NOT EXISTS idx_conv_customer ON conversations(customer_id);
-- 列表页高频排序：按会话状态 + 最近消息时间取 Top N
CREATE INDEX IF NOT EXISTS idx_conv_status_lastmsg ON conversations(status, last_message_at DESC);
-- 工作台「我的会话」与客户历史查询
CREATE INDEX IF NOT EXISTS idx_conv_agent_status ON conversations(agent_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_cust_status ON conversations(customer_id, status, last_message_at DESC);

-- 消息
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_role     TEXT NOT NULL,                     -- customer | agent | system | bot
  sender_name     TEXT DEFAULT '',
  type            TEXT NOT NULL DEFAULT 'text',      -- text | image | file | system | card | quick
  content         TEXT NOT NULL DEFAULT '',
  meta            TEXT DEFAULT '{}',
  is_read         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
-- 未读数统计与「最新消息」查询
CREATE INDEX IF NOT EXISTS idx_msg_conv_read ON messages(conversation_id, is_read);

-- 快捷话术
CREATE TABLE IF NOT EXISTS quick_replies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  category      TEXT DEFAULT '通用',
  scope         TEXT NOT NULL DEFAULT 'all',         -- all | personal | department
  owner_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  department_id INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  use_count     INTEGER NOT NULL DEFAULT 0,
  is_favorite   INTEGER NOT NULL DEFAULT 0,          -- 常用（在工作台置顶）
  favorite_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 工单
CREATE TABLE IF NOT EXISTS tickets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,               -- GD20240101-0001
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL DEFAULT '其他',
  priority       TEXT NOT NULL DEFAULT 'normal',     -- low | normal | high | urgent
  status         TEXT NOT NULL DEFAULT 'pending',    -- pending | processing | resolved | closed | reopened
  creator_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assignee_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  sla_due_at     TEXT,
  resolved_at    TEXT,
  closed_at      TEXT,
  rating         INTEGER,
  rating_comment TEXT DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_ticket_assignee ON tickets(assignee_id);
-- 工单列表页按状态+更新时间分页；创建者的「我的工单」
CREATE INDEX IF NOT EXISTS idx_ticket_status_updated ON tickets(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_creator ON tickets(creator_id, updated_at DESC);
-- 看板趋势按创建时间聚合
CREATE INDEX IF NOT EXISTS idx_ticket_created ON tickets(created_at);

-- 工单处理记录
CREATE TABLE IF NOT EXISTS ticket_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name  TEXT DEFAULT '',
  action     TEXT NOT NULL DEFAULT 'comment',        -- comment | assign | status | priority | create | resolve
  content    TEXT NOT NULL DEFAULT '',
  internal   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_tc_ticket ON ticket_comments(ticket_id, id);

-- 知识库分类
CREATE TABLE IF NOT EXISTS kb_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  icon        TEXT DEFAULT '📄',
  description TEXT DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 知识库文章 / 帮助中心
CREATE TABLE IF NOT EXISTS kb_articles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES kb_categories(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  summary     TEXT DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  tags        TEXT DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'published',     -- draft | published | archived
  visibility  TEXT NOT NULL DEFAULT 'public',        -- public | internal
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  views       INTEGER NOT NULL DEFAULT 0,
  helpful     INTEGER NOT NULL DEFAULT 0,
  not_helpful INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_kb_status ON kb_articles(status);
-- 帮助中心列表（公开已发布文章按更新时间），热门文章按浏览量
CREATE INDEX IF NOT EXISTS idx_kb_pub ON kb_articles(status, visibility, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_views ON kb_articles(status, visibility, views DESC);
CREATE INDEX IF NOT EXISTS idx_kb_category ON kb_articles(category_id);

-- 系统设置
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 操作日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name  TEXT DEFAULT '',
  action     TEXT NOT NULL,
  target     TEXT DEFAULT '',
  detail     TEXT DEFAULT '',
  ip         TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- 通知
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT DEFAULT '',
  type       TEXT NOT NULL DEFAULT 'info',
  link       TEXT DEFAULT '',
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

-- 站点托管：每个站点是一个独立的「虚拟主机」
CREATE TABLE IF NOT EXISTS sites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,                 -- 访问路径 /s/<slug>
  name          TEXT NOT NULL,                        -- 显示名
  type          TEXT NOT NULL DEFAULT 'static',       -- static | php
  php_version   TEXT DEFAULT '',                      -- PHP 版本标识（type=php 时必填）
  root_dir      TEXT DEFAULT '',                      -- 站点根目录（相对 SITES_DIR；部署后自动填写）
  source        TEXT NOT NULL DEFAULT 'manual',      -- manual | github
  repo_url      TEXT DEFAULT '',                      -- GitHub 仓库（https://github.com/<o>/<r>）
  repo_ref      TEXT DEFAULT 'main',                  -- 分支 / tag / commit
  sub_dir       TEXT DEFAULT '',                      -- 仓库内的站点根（如 docs/ 或 /）
  status        TEXT NOT NULL DEFAULT 'stopped',      -- running | stopped | error
  last_error    TEXT DEFAULT '',
  deploy_log    TEXT DEFAULT '',                      -- 最近一次部署摘要（JSON：步骤+耗时）
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_slug ON sites(slug);

-- 站点部署历史（每次部署一条记录）
CREATE TABLE IF NOT EXISTS site_deploys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,                           -- manual | github
  ref        TEXT DEFAULT '',
  status     TEXT NOT NULL,                           -- success | failed
  duration_ms INTEGER NOT NULL DEFAULT 0,
  detail     TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_deploys_site ON site_deploys(site_id, id);

`);

/* ------------------------------------------------------------------ *
 * 轻量迁移：为已存在的数据库补充新增字段
 * （全部为幂等操作，重复执行不会报错）
 * ------------------------------------------------------------------ */

function addColumnIfMissing(table, column, definition) {
  const cols = all(`PRAGMA table_info(${table})`);
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] 已为 ${table} 添加字段 ${column}`);
  return true;
}

if (addColumnIfMissing('quick_replies', 'is_favorite', 'INTEGER NOT NULL DEFAULT 0')) {
  // 首次引入收藏功能时，把使用次数最高的几条标记为常用，便于直接体验
  db.exec(`
    UPDATE quick_replies SET is_favorite = 1
    WHERE id IN (SELECT id FROM quick_replies ORDER BY use_count DESC LIMIT 3)
  `);
}

addColumnIfMissing('quick_replies', 'favorite_at', 'TEXT');

// 双因素认证字段（旧库升级用；新库由 CREATE TABLE 直接建立）
addColumnIfMissing('users', 'totp_secret', 'TEXT');
addColumnIfMissing('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'totp_confirmed_at', 'TEXT');
addColumnIfMissing('users', 'totp_last_step', 'INTEGER');
addColumnIfMissing('users', 'backup_codes', "TEXT DEFAULT '[]'");

/* ------------------------------------------------------------------ *
 * 设置读写助手
 * ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  site_name: '云客客服中心',
  site_slogan: '7×24 小时为您服务',
  welcome_message: '您好！欢迎来到云客客服中心，请问有什么可以帮您？',
  offline_message: '客服当前不在线，您可以留言或提交工单，我们会尽快回复您。',
  auto_assign: '1',
  max_concurrent: '5',
  queue_notice: '正在为您分配客服，请稍候…',
  auto_close_minutes: '30',
  work_time: '09:00-21:00',
  ticket_sla_hours: '24',
  rating_enabled: '1',
};

export function getSetting(key, fallback = '') {
  const row = get('SELECT value FROM settings WHERE key = ?', [key]);
  if (row) return row.value;
  return key in DEFAULT_SETTINGS ? DEFAULT_SETTINGS[key] : fallback;
}

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of all('SELECT key, value FROM settings')) out[row.key] = row.value;
  return out;
}

export function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, String(value ?? '')],
  );
}

export function audit(user, action, target = '', detail = '', ip = '') {
  run(
    'INSERT INTO audit_logs (user_id, user_name, action, target, detail, ip) VALUES (?,?,?,?,?,?)',
    [user?.id ?? null, user?.name ?? 'system', action, target, detail, ip],
  );
}

export { ROOT, DB_FILE };
