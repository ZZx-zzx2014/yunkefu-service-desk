/**
 * 局域网访问页：/lan
 *
 * 供「手机扫码接入」使用：页面直接展示二维码与可点击地址，
 * 电脑上打开后用手机扫码即可进入客户咨询中心。
 */
export function renderLanPage({ siteName, slogan, addresses, port, qrDataUri, localhost }) {
  const lanList = addresses.filter((a) => a.kind === 'lan');
  const otherList = addresses.filter((a) => a.kind !== 'lan');
  const primary = lanList[0] || addresses[0] || null;

  const row = (a, highlight) => `
    <a class="addr ${highlight ? 'addr--primary' : ''}" href="${a.url}" target="_blank" rel="noopener">
      <span class="addr__badge">${a.kind === 'lan' ? '局域网' : a.kind === 'virtual' ? '虚拟网卡/VPN' : a.kind === 'public' ? '公网' : '其它'}</span>
      <span class="addr__url">${a.url}</span>
      <span class="addr__iface">${escapeHtml(a.interface)}</span>
    </a>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>手机扫码接入 - ${escapeHtml(siteName)}</title>
<link rel="stylesheet" href="/assets/base.css">
<style>
  .lan-wrap { max-width: 860px; margin: 0 auto; padding: 34px 20px 60px; }
  .lan-head { text-align: center; margin-bottom: 26px; }
  .lan-logo { width: 56px; height: 56px; border-radius: 16px; margin: 0 auto 14px;
    background: linear-gradient(135deg, var(--brand-light), var(--accent)); display: grid; place-items: center;
    font-size: 27px; box-shadow: 0 8px 22px rgba(37,99,235,.32); }
  .lan-title { font-size: 24px; font-weight: 700; }
  .lan-sub { color: var(--text-3); font-size: 14px; margin-top: 8px; }

  .lan-grid { display: grid; grid-template-columns: 320px 1fr; gap: 22px; align-items: start; }
  @media (max-width: 780px) { .lan-grid { grid-template-columns: 1fr; } }

  .qr-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-xl);
    padding: 22px; text-align: center; box-shadow: var(--shadow); }
  .qr-card img { width: 100%; max-width: 268px; margin: 0 auto; border-radius: 12px; }
  .qr-hint { font-size: 13px; color: var(--text-3); margin-top: 14px; line-height: 1.8; }

  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
  .panel__head { padding: 13px 18px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 14.5px;
    display: flex; align-items: center; gap: 8px; }
  .panel__body { padding: 16px 18px; }

  .addr { display: flex; align-items: center; gap: 10px; padding: 11px 13px; border: 1px solid var(--border);
    border-radius: var(--radius); margin-bottom: 9px; text-decoration: none; color: var(--text);
    transition: border-color .15s, background .15s; }
  .addr:hover { border-color: var(--brand); background: var(--brand-softer); }
  .addr--primary { border-color: var(--brand); background: var(--brand-soft); }
  .addr__badge { font-size: 11.5px; padding: 2px 8px; border-radius: 99px; background: var(--bg-2);
    color: var(--text-2); flex-shrink: 0; }
  .addr--primary .addr__badge { background: var(--brand); color: #fff; }
  .addr__url { font-family: var(--mono); font-size: 13.5px; color: var(--brand-dark); flex: 1; word-break: break-all; }
  .addr__iface { font-size: 11.5px; color: var(--text-3); flex-shrink: 0; max-width: 130px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }

  .tips { font-size: 13px; color: var(--text-2); line-height: 2; }
  .tips code { font-family: var(--mono); background: var(--bg-2); padding: 1px 6px; border-radius: 4px; font-size: 12.5px; }
  .warn { background: var(--warning-soft); border: 1px solid #fde68a; color: #92400e;
    border-radius: var(--radius); padding: 12px 14px; font-size: 13px; line-height: 1.85; }
</style>
</head>
<body>
<div class="lan-wrap">
  <div class="lan-head">
    <div class="lan-logo">🎧</div>
    <div class="lan-title">${escapeHtml(siteName)} · 手机扫码接入</div>
    <div class="lan-sub">${escapeHtml(slogan)}</div>
  </div>

  <div class="lan-grid">
    <div class="qr-card">
      ${primary
        ? `<img src="${qrDataUri}" alt="扫码访问 ${escapeHtml(primary.url)}">`
        : '<div class="empty__icon">📡</div>'}
      <div class="qr-hint">
        ${primary
          ? `用手机相机或微信扫一扫<br>即可打开 <strong>${escapeHtml(primary.url)}</strong>`
          : '未检测到可用的局域网地址'}
      </div>
    </div>

    <div>
      <div class="panel mb-20">
        <div class="panel__head">🌐 可访问地址</div>
        <div class="panel__body">
          ${primary ? row(primary, true) : '<div class="text-sm text-muted">未检测到非本机地址，请确认已连接网络</div>'}
          ${otherList.length ? `<div class="text-xs text-muted mt-14 mb-8">其它地址（一般不用扫码）</div>${otherList.map((a) => row(a, false)).join('')}` : ''}
          <div class="text-xs text-muted mt-14 mb-8">本机</div>
          <a class="addr" href="${localhost}" target="_blank" rel="noopener">
            <span class="addr__badge">本机</span>
            <span class="addr__url">${localhost}</span>
            <span class="addr__iface">localhost</span>
          </a>
        </div>
      </div>

      <div class="panel mb-20">
        <div class="panel__head">📱 扫码后能做什么</div>
        <div class="panel__body tips">
          · 进入 <strong>客户咨询中心</strong>，可注册/登录后与客服实时对话<br>
          · 手机与电脑浏览器处于同一会话体系：手机发消息，工作台立即收到<br>
          · 客户咨询中心地址：<code>${primary ? escapeHtml(primary.url) : '—'}</code><br>
          · 客服工作台：<code>${primary ? escapeHtml(primary.url + 'agent') : '—'}</code>（建议在电脑上使用）
        </div>
      </div>

      <div class="panel">
        <div class="panel__head">⚠️ 安全提示</div>
        <div class="panel__body">
          <div class="warn">
            当前为 <strong>HTTP 明文</strong> 且监听所有网卡，局域网内任何设备都可访问。<br>
            请仅在可信网络中使用；对外提供服务时，务必设置 <code>KEFU_SECRET</code> 环境变量，
            并通过反向代理启用 HTTPS。
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
