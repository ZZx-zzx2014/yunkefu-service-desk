/**
 * 局域网访问地址探测
 *
 * 一台机器通常有多个网卡（虚拟网卡、VPN、容器网桥等），
 * 直接把所有 IPv4 列出来会让用户不知道该扫/该访问哪一个。
 * 这里按「大概率是真实局域网」的顺序排出优先级。
 */
import os from 'node:os';

/** 虚拟网卡 / 隧道接口的名称特征（不优先推荐） */
const VIRTUAL_HINTS = [
  /vmware/i, /virtualbox/i, /vbox/i, /hyper-?v/i, /vethernet/i,
  /loopback/i, /docker/i, /wsl/i, /radmin/i, /tailscale/i, /zerotier/i,
  /hamachi/i, /npcap/i, /tap/i, /tun\d/i, /utun/i, /bridge\d/i, /vpn/i,
];

/** 私有网段判断 */
function isPrivate(ip) {
  return /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/**
 * 列出可用于访问本服务的地址，按推荐程度排序
 * @param {number} port
 * @returns {Array<{ address: string, interface: string, url: string, kind: string, recommended: boolean }>}
 */
export function listAccessAddresses(port) {
  const out = [];
  const interfaces = os.networkInterfaces();

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const address = a.address;

      // 169.254.x.x 是链路本地地址，通常不可用
      const isLinkLocal = /^169\.254\./.test(address);
      const virtual = VIRTUAL_HINTS.some((re) => re.test(name));
      const priv = isPrivate(address);

      let kind = 'other';
      if (isLinkLocal) kind = 'link-local';
      else if (virtual && priv) kind = 'virtual';
      else if (priv) kind = 'lan';
      else kind = 'public';

      out.push({ address, interface: name, url: `http://${address}:${port}/`, kind, virtual });
    }
  }

  // 排序：真实局域网 > 其它私有 > 公网 > 虚拟网卡 > 链路本地
  const rank = (x) => {
    if (x.kind === 'lan' && !x.virtual) return 0;
    if (x.kind === 'lan') return 1;
    if (x.kind === 'virtual') return 2;
    if (x.kind === 'public') return 3;
    if (x.kind === 'link-local') return 5;
    return 4;
  };
  out.sort((a, b) => rank(a) - rank(b) || a.interface.localeCompare(b.interface));

  if (out.length) out[0].recommended = true;
  return out;
}

/** 推荐的局域网地址（找不到则返回 null） */
export function primaryAddress(port) {
  const list = listAccessAddresses(port);
  return list.find((x) => x.recommended) || list[0] || null;
}

/** 人类可读的地址类型说明 */
export function kindLabel(kind) {
  return {
    lan: '局域网',
    virtual: '虚拟网卡/VPN',
    public: '公网地址',
    'link-local': '链路本地（通常不可用）',
    other: '其它',
  }[kind] || kind;
}

/** 判断某个地址是否是建议给手机扫码用的 */
export function isRecommendedForMobile(entry) {
  return entry.kind === 'lan';
}
