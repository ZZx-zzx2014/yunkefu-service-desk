/**
 * 零依赖的 HTTP 响应压缩中间件
 *
 * 为什么不用 compression 包：本项目刻意保持零多余运行时依赖（只有 express/multer/ws），
 * 压缩只需要 Node 内置的 zlib。
 *
 * 实现方式（v2.1 —— 缓冲 + 同步压缩）：
 *   v1（zlib 流式管道把输出异步接回 res.write）：Express 的 res.send() 只调
 *   res.end(body) 一次，异步 flush 窗口里输出丢失——实测表现为「有 gzip 头、
 *   body 却是原文」。v2（只拦 end）修复了 JSON 路由，但 express.static 走
 *   write()+end() 无参调用，完全绕过。v2.1 同时拦 write/end：write 缓冲，
 *   end 时一次性 gzipSync。
 *
 *   缓冲整包的内存代价对本项目可接受：最大静态资源 base.css 33KB；
 *   JSON 响应均 < 100KB；/uploads 路径已明确跳过（图片等已压缩格式，
 *   且由专用中间件直接 pipe）。
 *
 * 设计要点：
 *   - 只压文本类响应（JS/CSS/HTML/JSON/SVG/CSV）
 *   - 尊重 Accept-Encoding（gzip / deflate）
 *   - 小于 1KB 不压缩；压缩反而变大时回退原文
 *   - HEAD / 204 / 304 / 上传文件路径不压缩
 */
import zlib from 'node:zlib';

/** 可压缩的 Content-Type 前缀 */
const COMPRESSIBLE = [
  'text/',
  'application/json',
  'application/javascript',
  'application/xml',
  'image/svg+xml',
  'application/manifest+json',
];

const isCompressibleType = (type = '') =>
  COMPRESSIBLE.some((t) => type.includes(t));

/** 解析 Accept-Encoding，返回客户端支持且我们愿意用的编码 */
function pickEncoding(acceptEncoding = '') {
  const ae = String(acceptEncoding).toLowerCase();
  if (ae.includes('gzip') || ae.includes('*')) return 'gzip';
  if (ae.includes('deflate')) return 'deflate';
  return null;
}

/** 压缩阈值：小于该字节数不压缩 */
const THRESHOLD = 1024;
/** 单个响应体超过该大小则放弃压缩（防御性上限） */
const MAX_COMPRESS_SIZE = 32 * 1024 * 1024;

function compressBuf(buf, encoding, level) {
  if (encoding === 'gzip') return zlib.gzipSync(buf, { level });
  return zlib.deflateSync(buf, { level });
}

/**
 * 压缩中间件。
 * 用法：app.use(compress())，放在最前（任何路由与静态服务之前）。
 */
export function compress(options = {}) {
  const level = options.level ?? zlib.constants.Z_BEST_SPEED;

  return (req, res, next) => {
    if (req.method === 'HEAD') return next();
    const encoding = pickEncoding(req.headers['accept-encoding']);
    if (!encoding) return next();
    // 上传文件（图片等已压缩内容）与二维码图片：跳过，交给专用投递中间件
    if (req.path.startsWith('/uploads/') || req.path.startsWith('/api/qr')) return next();

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    /** 缓冲已写出的响应体；一旦决定「不压缩」则改为直通模式 */
    let chunks = [];
    let buffered = true;

    res.write = function write(chunk, enc, cb) {
      if (!buffered) return originalWrite(chunk, enc, cb);
      if (chunk) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8') : Buffer.from(chunk));
      return true;
    };

    res.end = function end(chunk, enc, cb) {
      if (!buffered) return originalEnd(chunk, enc, cb);
      buffered = false;
      if (chunk && typeof chunk !== 'function') {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8') : Buffer.from(chunk));
      }
      const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      chunks = [];

      const type = String(res.getHeader('Content-Type') || '');
      const status = res.statusCode;
      const compressible =
        res.getHeader('Content-Encoding') == null &&
        body.length >= THRESHOLD && body.length <= MAX_COMPRESS_SIZE &&
        status >= 200 && status < 300 &&
        status !== 204 && status !== 304 &&
        isCompressibleType(type);

      if (!compressible) {
        // 直通：把缓冲的原文一次性写回
        res.setHeader('Content-Length', String(body.length));
        return originalEnd(body);
      }

      const compressed = compressBuf(body, encoding, level);
      // 压缩收益为负则回退原文
      if (compressed.length >= body.length) {
        res.setHeader('Content-Length', String(body.length));
        return originalEnd(body);
      }

      res.setHeader('Content-Encoding', encoding);
      const vary = res.getHeader('Vary');
      res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
      res.setHeader('Content-Length', String(compressed.length));
      // 原文的 ETag 与压缩表示不匹配，移除以免缓存混淆
      res.removeHeader('ETag');
      return originalEnd(compressed);
    };

    next();
  };
}
