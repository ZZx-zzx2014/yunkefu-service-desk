/**
 * 通用中间件与响应工具
 */
import { verifyAccessToken } from './auth.js';
import { get } from './db.js';

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function ok(res, data = null, message = 'ok') {
  return res.json({ success: true, code: 0, message, data });
}

export function fail(res, message = '操作失败', status = 400, code = 1) {
  return res.status(status).json({ success: false, code, message, data: null });
}

export class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** 解析 Bearer Token 并挂载 req.user（不强制登录）
 *  使用 verifyAccessToken：2FA 待验证令牌（purpose=2fa）不能用于访问业务接口
 */
export function attachUser(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
  const payload = verifyAccessToken(token);
  if (payload) {
    const user = get('SELECT id, username, name, role, email, phone, avatar, department_id, level, skills, status, max_concurrent FROM users WHERE id = ? AND active = 1', [payload.id]);
    if (user) req.user = user;
  }
  next();
}

/** 必须登录 */
export function requireAuth(req, res, next) {
  if (!req.user) return fail(res, '请先登录', 401, 401);
  next();
}

/** 角色校验 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return fail(res, '请先登录', 401, 401);
    if (!roles.includes(req.user.role)) return fail(res, '没有权限执行该操作', 403, 403);
    next();
  };
}

/** 统一错误处理 */
export function errorHandler(err, req, res, _next) {
  // multer 的文件限制错误：转为可读的 400，而不是 500
  if (err && typeof err.code === 'string' && err.code.startsWith('LIMIT_')) {
    const messages = {
      LIMIT_FILE_SIZE: '文件大小超出限制（单个文件最大 10MB）',
      LIMIT_FILE_COUNT: '一次只能上传一个文件',
      LIMIT_UNEXPECTED_FILE: '上传字段不正确，请使用 file 字段',
      LIMIT_PART_COUNT: '表单内容过多',
      LIMIT_FIELD_COUNT: '表单字段过多',
      LIMIT_FIELD_KEY: '表单字段名过长',
      LIMIT_FIELD_VALUE: '表单字段值过大',
    };
    console.warn(`[upload] ${req.method} ${req.originalUrl} -> ${err.code}`);
    return res.status(400).json({
      success: false, code: 400,
      message: messages[err.code] || '文件上传失败，请检查文件大小与格式',
      data: null,
    });
  }

  const status = err.status || 500;
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl} -> ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
  }
  return res.status(status).json({ success: false, code: status, message: err.message || '服务器内部错误', data: null });
}
