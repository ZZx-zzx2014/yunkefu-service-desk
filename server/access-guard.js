/**
 * 测试模式与访问范围守卫
 *
 * 设计目标（面向开源发布的安全默认值）：
 *  - 默认以「测试模式」启动：只监听本机、只接受私有网段来源
 *  - 生产模式必须显式声明，并且必须提供自己的 KEFU_SECRET
 *
 * 为什么需要它：/api/auth/demo 会免密码签发管理员令牌。
 * 若把测试模式的功能直接暴露到公网，等于给所有人开了管理员权限。
 */

/** 判断是否私有/本机地址（IPv4 与 IPv6 回环） */
export function isPrivateAddress(raw) {
  if (!raw) return false;
  // 去掉 IPv6 前缀与端口
  let ip = String(raw).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);       // IPv4-mapped IPv6
  if (ip === '::1' || ip === 'localhost') return true;
  if (ip.includes(':')) {
    // 其它 IPv6：仅接受回环与链路本地
    return ip === '::1' || /^fe80:/i.test(ip) || /^f[cd]/i.test(ip);
  }
  ip = ip.replace(/:\d+$/, '');
  if (ip === '127.0.0.1' || ip.startsWith('127.')) return true;
  if (ip === '0.0.0.0') return false;
  // RFC1918 私有网段
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // 链路本地（169.254/16）与 CGNAT（100.64/10）视作不可信但非公网
  if (/^169\.254\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  return false;
}

/** 取请求的真实来源地址（优先 X-Forwarded-For 的最后一跳含义由代理可信度决定，这里保守取 socket） */
export function clientAddress(req) {
  // 不信任可伪造的 XFF 做安全判定；在反向代理下应由代理设置并配合 KEFU_TRUST_PROXY 使用
  const forwarded = req.headers['x-forwarded-for'];
  if (process.env.KEFU_TRUST_PROXY === '1' && forwarded) {
    return String(forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || '';
}

/**
 * 测试模式下的来源校验中间件：
 * 拒绝来自非私有网段的请求，避免误把测试实例暴露到公网。
 */
export function localOnlyGuard(config) {
  return (req, res, next) => {
    if (!config.testMode) return next();
    const addr = clientAddress(req);
    if (isPrivateAddress(addr)) return next();
    console.warn(`[test-mode] 拒绝来自公网地址的请求：${addr} ${req.method} ${req.originalUrl}`);
    return res.status(403).json({
      success: false,
      code: 403,
      message: '当前为测试模式，仅允许本机与局域网访问。如需对外提供服务，请设置 KEFU_TEST_MODE=0 并配置 KEFU_SECRET。',
      data: null,
    });
  };
}
