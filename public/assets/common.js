/* ==========================================================================
   云客客服系统 - 前端公共库
   提供：API 客户端、鉴权状态、WebSocket、DOM 助手、UI 组件、图表
   ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */
  const STORAGE_KEY = 'kefu.session';
  const state = {
    token: '',
    user: null,
    ws: null,
    wsReady: false,
    settings: {},
    listeners: { message: [], event: [], notification: [], open: [], close: [] },
    reconnectTimer: null,
    reconnectDelay: 1000,
  };

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      state.token = data.token || '';
      state.user = data.user || null;
    } catch { /* ignore */ }
  }

  function saveSession() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: state.token, user: state.user }));
    } catch { /* ignore */ }
  }

  function clearSession() {
    state.token = '';
    state.user = null;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * HTTP 请求
   * ------------------------------------------------------------------ */
  async function request(method, path, body, opts = {}) {
    const headers = { Accept: 'application/json' };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    let payload;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(path, { method, headers, body: payload });
    } catch {
      throw new Error('网络连接失败，请检查服务是否运行');
    }

    if (res.status === 401 && !opts.noRedirect) {
      clearSession();
      if (!location.pathname.startsWith('/login')) {
        setTimeout(() => { location.href = '/'; }, 400);
      }
      throw new Error('登录状态已失效，请重新登录');
    }

    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json().catch(() => null);
    } else {
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new Error(text || `请求失败 (${res.status})`);
      return text;
    }

    if (!res.ok || (data && data.success === false)) {
      throw new Error((data && data.message) || `请求失败 (${res.status})`);
    }
    return data ? data.data : null;
  }

  const api = {
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b, o) => request('POST', p, b, o),
    put: (p, b, o) => request('PUT', p, b, o),
    del: (p, o) => request('DELETE', p, undefined, o),
    upload: (p, formData) => request('POST', p, formData),
  };

  function qs(params = {}) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      sp.append(k, v);
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  /* ------------------------------------------------------------------ *
   * 鉴权
   * ------------------------------------------------------------------ */
  const auth = {
    get user() { return state.user; },
    get token() { return state.token; },
    get isLogin() { return Boolean(state.token && state.user); },
    get role() { return state.user ? state.user.role : ''; },
    is(role) { return state.user && state.user.role === role; },
    isStaff() { return state.user && (state.user.role === 'agent' || state.user.role === 'admin'); },

    /**
     * 登录第一步（口令校验）
     * 返回原始结果：可能带 token+user（直接登录成功），
     * 也可能带 twoFactorRequired + twoFactorToken（需要第二步验证）
     */
    async login(username, password) {
      const data = await api.post('/api/auth/login', { username, password });
      if (data && data.twoFactorRequired) return data;   // 交给调用方走第二步
      auth.setSession(data.token, data.user);
      return data;
    },

    /** 登录第二步：校验 TOTP 动态验证码或备份码 */
    async verifyTwoFactor(twoFactorToken, code) {
      const data = await api.post('/api/auth/2fa/verify', { twoFactorToken, code });
      auth.setSession(data.token, data.user);
      return data;
    },

    /** 写入登录态（供两步登录复用） */
    setSession(token, user) {
      state.token = token;
      state.user = user;
      saveSession();
      return user;
    },
    async demo(role) {
      const data = await api.post('/api/auth/demo', { role });
      return auth.setSession(data.token, data.user);
    },
    async register(payload) {
      const data = await api.post('/api/auth/register', payload);
      return auth.setSession(data.token, data.user);
    },
    async refresh() {
      if (!state.token) return null;
      const user = await api.get('/api/auth/me');
      state.user = user;
      saveSession();
      return user;
    },
    logout() {
      clearSession();
      if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } }
      location.href = '/';
    },
    /** 页面守卫：未登录则跳转首页 */
    guard(roles) {
      if (!auth.isLogin) { location.href = '/'; return false; }
      if (roles && roles.length && !roles.includes(state.user.role)) {
        toast('没有权限访问该页面', 'error');
        setTimeout(() => { location.href = state.user.role === 'customer' ? '/' : '/agent'; }, 800);
        return false;
      }
      return true;
    },
  };

  /* ------------------------------------------------------------------ *
   * WebSocket
   * ------------------------------------------------------------------ */
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connectWS() {
    if (!state.token) return;
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;

    let ws;
    try { ws = new WebSocket(wsUrl()); } catch { return; }
    state.ws = ws;

    ws.onopen = () => {
      state.reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'auth', token: state.token }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'auth:ok') {
        state.wsReady = true;
        emit('open', msg.user);
        // 自动重连后重新同步在线状态
        if (auth.isStaff() && state.user.status && state.user.status !== 'offline') {
          ws.send(JSON.stringify({ type: 'agent:status', status: state.user.status }));
        }
        return;
      }
      if (msg.type === 'auth:fail') { auth.logout(); return; }
      if (msg.type === 'pong') return;

      if (msg.type === 'message') emit('message', msg);
      else if (msg.type === 'notification') emit('notification', msg.notification);
      else emit('event', msg);
    };

    ws.onclose = () => {
      state.wsReady = false;
      emit('close');
      if (state.token) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(connectWS, state.reconnectDelay);
        state.reconnectDelay = Math.min(state.reconnectDelay * 1.6, 15000);
      }
    };
    ws.onerror = () => { /* onclose 会处理重连 */ };
  }

  function sendWS(payload) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  function on(type, fn) {
    if (!state.listeners[type]) state.listeners[type] = [];
    state.listeners[type].push(fn);
    return () => off(type, fn);
  }
  function off(type, fn) {
    const arr = state.listeners[type];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i > -1) arr.splice(i, 1);
  }
  function emit(type, payload) {
    (state.listeners[type] || []).forEach((fn) => {
      try { fn(payload); } catch (err) { console.error('[listener]', err); }
    });
  }

  /* ------------------------------------------------------------------ *
   * DOM 助手
   * ------------------------------------------------------------------ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
        else node.setAttribute(k, v);
      }
    }
    if (children !== undefined && children !== null) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      }
    }
    return node;
  }

  /** 事件委托 */
  function delegate(root, selector, event, handler) {
    root.addEventListener(event, (e) => {
      const target = e.target.closest(selector);
      if (target && root.contains(target)) handler(e, target);
    });
  }

  /* ------------------------------------------------------------------ *
   * 声明式行为绑定（data-action）
   *
   * 用于替代 HTML 中的内联事件属性（onclick="..."）。
   * 内联事件属性会强制 CSP 保留 script-src 'unsafe-inline'，
   * 从而让 XSS 防护形同虚设，因此统一改用事件委托 + 行为注册表。
   * ------------------------------------------------------------------ */

  const actions = new Map();

  /** 注册一个行为处理函数：node 带 data-action="name" 时点击触发 */
  function registerAction(name, handler) {
    actions.set(name, handler);
  }

  let actionDelegationBound = false;
  function bindActionDelegation() {
    if (actionDelegationBound) return;
    actionDelegationBound = true;
    document.addEventListener('click', (e) => {
      const node = e.target.closest('[data-action]');
      if (!node) return;
      const handler = actions.get(node.dataset.action);
      if (!handler) return;
      e.preventDefault();
      handler(node, e);
    });
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /** 链接协议白名单：仅允许 http/https/mailto/tel/站内相对路径 */
  function isSafeUrl(url) {
    const u = String(url || '').trim().toLowerCase();
    if (!u) return false;
    if (/^(https?:|mailto:|tel:)/.test(u)) return true;
    // 站内相对路径、锚点
    if (u.startsWith('/') || u.startsWith('#') || u.startsWith('?')) return true;
    // 其余协议（javascript:、data:、vbscript: 等）一律视为不安全
    return !/^[a-z][a-z0-9+.-]*:/.test(u);
  }

  /** 轻量 Markdown 渲染（标题、粗体、代码、列表、表格、引用、链接） */
  function markdown(src) {
    if (!src) return '';
    const lines = String(src).replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let inCode = false;
    let inList = false;
    let inTable = false;
    let listType = 'ul';

    const closeList = () => { if (inList) { html += `</${listType}>`; inList = false; } };
    const closeTable = () => { if (inTable) { html += '</tbody></table>'; inTable = false; } };

    const inline = (t) => escapeHtml(t)
      .replace(/`([^`]+)`/g, '<code class="kbd">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      // 危险协议的链接只保留文本，不生成 <a>，避免被点击后执行脚本
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (full, text, href) => (
        isSafeUrl(href)
          ? `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>`
          : `<span class="text-danger" title="已阻止不安全链接">${text}</span>`
      ));

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        if (inCode) { html += '</code></pre>'; inCode = false; }
        else { closeList(); closeTable(); html += '<pre class="code-block"><code>'; inCode = true; }
        continue;
      }
      if (inCode) { html += escapeHtml(line) + '\n'; continue; }

      if (/^\s*\|.*\|\s*$/.test(line)) {
        const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
        if (/^[\s|:-]+$/.test(lines[i + 1] || '')) {
          closeList();
          if (!inTable) { html += '<table class="table table--compact"><thead><tr>' + cells.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'; inTable = true; }
          else html += '<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
          i++;
        } else {
          closeTable();
          html += '<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
        }
        continue;
      }
      closeTable();

      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); const lv = h[1].length + 1; html += `<h${lv}>${inline(h[2])}</h${lv}>`; continue; }

      if (/^\s*[-*+]\s+/.test(line)) {
        if (!inList || listType !== 'ul') { closeList(); html += '<ul>'; inList = true; listType = 'ul'; }
        html += `<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`;
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        if (!inList || listType !== 'ol') { closeList(); html += '<ol>'; inList = true; listType = 'ol'; }
        html += `<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`;
        continue;
      }
      closeList();

      if (/^>\s?/.test(line)) { html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`; continue; }
      if (/^---+$/.test(line.trim())) { html += '<hr>'; continue; }
      if (!line.trim()) { continue; }
      html += `<p>${inline(line)}</p>`;
    }
    closeList(); closeTable();
    if (inCode) html += '</code></pre>';
    return html;
  }

  /* ------------------------------------------------------------------ *
   * 格式化
   * ------------------------------------------------------------------ */
  const pad = (n) => String(n).padStart(2, '0');

  function parseDate(str) {
    if (!str) return null;
    const d = new Date(String(str).replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const fmt = {
    /** 友好时间：刚刚 / x分钟前 / 今天 HH:mm / MM-DD HH:mm */
    time(str) {
      const d = parseDate(str);
      if (!d) return '';
      const now = new Date();
      const diff = (now - d) / 1000;
      if (diff < 60) return '刚刚';
      if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
      if (diff < 86400 && d.getDate() === now.getDate()) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      if (diff < 172800) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },
    /** 聊天气泡时间 */
    clock(str) {
      const d = parseDate(str);
      if (!d) return '';
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
    datetime(str) {
      const d = parseDate(str);
      if (!d) return '-';
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
    date(str) {
      const d = parseDate(str);
      if (!d) return '-';
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },
    /** 相对截止时间 */
    countdown(str) {
      const d = parseDate(str);
      if (!d) return '';
      const diff = (d - Date.now()) / 1000;
      const abs = Math.abs(diff);
      const unit = abs < 3600 ? `${Math.max(1, Math.round(abs / 60))} 分钟` : abs < 86400 ? `${Math.round(abs / 3600)} 小时` : `${Math.round(abs / 86400)} 天`;
      return diff >= 0 ? `剩余 ${unit}` : `已超时 ${unit}`;
    },
    duration(sec) {
      const s = Number(sec) || 0;
      if (s < 60) return `${s} 秒`;
      if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
      return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
    },
    minutes(min) {
      const m = Number(min) || 0;
      if (m < 60) return `${m} 分钟`;
      return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
    },
    bytes(n) {
      const b = Number(n) || 0;
      if (b < 1024) return `${b} B`;
      if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
      return `${(b / 1048576).toFixed(1)} MB`;
    },
    number(n) {
      return Number(n || 0).toLocaleString('zh-CN');
    },
    pct(n) { return `${Number(n || 0).toFixed(1)}%`; },
  };

  function stars(rating, size) {
    const r = Number(rating) || 0;
    const full = Math.round(r);
    const style = size ? ` style="font-size:${size}"` : '';
    return `<span class="stars${r ? '' : ' stars--empty'}"${style}>${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span>`;
  }

  function avatar(name, size = '', color) {
    const initial = String(name || '?').trim().charAt(0).toUpperCase();
    const idx = color ?? (String(name || '').charCodeAt(0) % 5 + 1);
    return `<div class="avatar avatar--c${idx}${size ? ` avatar--${size}` : ''}">${escapeHtml(initial)}</div>`;
  }

  const STATUS_TEXT = {
    online: '在线', busy: '忙碌', away: '离开', offline: '离线',
    queued: '排队中', active: '进行中', closed: '已结束',
    pending: '待处理', processing: '处理中', resolved: '已解决', reopened: '重新打开',
    low: '低', normal: '中', high: '高', urgent: '紧急',
    draft: '草稿', published: '已发布', archived: '已归档',
    public: '公开', internal: '内部',
    web: '网页', app: 'APP', wechat: '公众号', phone: '电话', email: '邮件',
    admin: '管理员', agent: '客服', customer: '客户',
  };

  const STATUS_CLASS = {
    online: 'success', busy: 'warning', away: 'info', offline: '',
    queued: 'warning', active: 'success', closed: '',
    pending: 'warning', processing: 'brand', resolved: 'success', reopened: 'danger',
    urgent: 'danger', high: 'warning', normal: 'info', low: '',
    published: 'success', draft: 'warning', archived: '',
    public: 'success', internal: 'warning',
  };

  function statusBadge(value, labelOverride) {
    if (value === null || value === undefined || value === '') return '<span class="badge">-</span>';
    const cls = STATUS_CLASS[value] || '';
    const text = labelOverride || STATUS_TEXT[value] || value;
    return `<span class="badge${cls ? ` badge--${cls}` : ''}">${escapeHtml(text)}</span>`;
  }

  function statusDot(value) {
    return `<span class="dot dot--${value || 'offline'}"></span>`;
  }

  /* ------------------------------------------------------------------ *
   * UI 组件：Toast / Modal / Confirm
   * ------------------------------------------------------------------ */
  function toastHost() {
    let host = $('.toast-wrap');
    if (!host) {
      host = el('div', { class: 'toast-wrap' });
      document.body.appendChild(host);
    }
    return host;
  }

  const TOAST_ICON = { success: '✅', error: '⛔', warning: '⚠️', info: 'ℹ️' };

  function toast(message, type = 'info', duration = 2800) {
    const host = toastHost();
    const node = el('div', { class: `toast toast--${type}`, html: `<span>${TOAST_ICON[type] || ''}</span><span>${escapeHtml(message)}</span>` });
    host.appendChild(node);
    setTimeout(() => {
      node.classList.add('toast--leaving');
      setTimeout(() => node.remove(), 220);
    }, duration);
    return node;
  }

  /** 通用弹窗 */
  function modal({ title = '', body = '', footer = '', size = '', onMount, closeOnMask = true }) {
    const mask = el('div', { class: 'modal-mask' });
    const dialog = el('div', { class: `modal${size ? ` modal--${size}` : ''}` });
    const head = el('div', { class: 'modal__head' }, [
      el('div', { class: 'modal__title', text: title }),
      el('button', { class: 'modal__close', html: '&times;', onClick: () => close() }),
    ]);
    const bodyNode = el('div', { class: 'modal__body' });
    if (typeof body === 'string') bodyNode.innerHTML = body;
    else bodyNode.appendChild(body);

    dialog.appendChild(head);
    dialog.appendChild(bodyNode);

    let footNode = null;
    if (footer) {
      footNode = el('div', { class: 'modal__foot' });
      if (typeof footer === 'string') footNode.innerHTML = footer;
      else footNode.appendChild(footer);
      dialog.appendChild(footNode);
    }

    mask.appendChild(dialog);
    if (closeOnMask) mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });

    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    function close() {
      document.removeEventListener('keydown', onKey);
      mask.remove();
    }

    document.body.appendChild(mask);
    const ctx = { mask, dialog, body: bodyNode, foot: footNode, close };
    if (onMount) onMount(ctx);
    const focusable = dialog.querySelector('input, textarea, select');
    if (focusable) setTimeout(() => focusable.focus(), 60);
    return ctx;
  }

  /** 确认框 */
  function confirm({ title = '确认操作', message = '', confirmText = '确定', cancelText = '取消', danger = false }) {
    return new Promise((resolve) => {
      const ctx = modal({
        title,
        size: 'sm',
        body: `<div style="font-size:14px;color:var(--text-2);line-height:1.7">${escapeHtml(message)}</div>`,
        footer: (() => {
          const wrap = el('div', { class: 'flex gap-10', style: { marginLeft: 'auto' } });
          wrap.appendChild(el('button', { class: 'btn', text: cancelText, onClick: () => { ctx.close(); resolve(false); } }));
          wrap.appendChild(el('button', {
            class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, text: confirmText,
            onClick: () => { ctx.close(); resolve(true); },
          }));
          return wrap;
        })(),
      });
    });
  }

  /** 表单弹窗（返回 Promise，resolve 为表单数据或 null） */
  function formModal({ title, fields, submitText = '保存', size = '' }) {
    return new Promise((resolve) => {
      const form = el('form', { class: 'form' });
      for (const f of fields) {
        const field = el('div', { class: 'field' });
        field.appendChild(el('label', { class: 'field__label', html: `${escapeHtml(f.label)}${f.required ? '<span class="req">*</span>' : ''}` }));
        let input;
        if (f.type === 'textarea') {
          input = el('textarea', { class: 'textarea', name: f.name, placeholder: f.placeholder || '', rows: f.rows || 4 });
          if (f.value) input.value = f.value;
        } else if (f.type === 'select') {
          input = el('select', { class: 'select', name: f.name });
          for (const opt of f.options || []) {
            const o = el('option', { value: opt.value, text: opt.label });
            if (String(opt.value) === String(f.value)) o.selected = true;
            input.appendChild(o);
          }
        } else if (f.type === 'checkbox') {
          const wrap = el('label', { class: 'checkbox' });
          input = el('input', { type: 'checkbox', name: f.name });
          input.checked = Boolean(f.value);
          wrap.appendChild(input);
          wrap.appendChild(el('span', { text: f.checkboxLabel || f.label }));
          field.innerHTML = '';
          field.appendChild(wrap);
        } else {
          input = el('input', { class: 'input', type: f.type || 'text', name: f.name, placeholder: f.placeholder || '' });
          if (f.value !== undefined && f.value !== null) input.value = f.value;
        }
        if (input.tagName !== 'LABEL') field.appendChild(input);
        if (f.hint) field.appendChild(el('div', { class: 'field__hint', text: f.hint }));
        form.appendChild(field);
      }

      const ctx = modal({
        title,
        size,
        body: form,
        onMount(c) {
          c.foot = el('div', { class: 'modal__foot' });
          const cancel = el('button', { class: 'btn', text: '取消', type: 'button', onClick: () => { c.close(); resolve(null); } });
          const submit = el('button', { class: 'btn btn--primary', text: submitText, type: 'submit', form: '' });
          submit.addEventListener('click', (e) => { e.preventDefault(); form.requestSubmit(); });
          c.foot.appendChild(cancel);
          c.foot.appendChild(submit);
          c.dialog.appendChild(c.foot);

          form.addEventListener('submit', (e) => {
            e.preventDefault();
            const data = {};
            for (const f of fields) {
              const input = form.querySelector(`[name="${f.name}"]`);
              if (!input) continue;
              if (f.type === 'checkbox') data[f.name] = input.checked;
              else if (f.type === 'number') data[f.name] = input.value === '' ? null : Number(input.value);
              else data[f.name] = input.value;
              if (f.required && (data[f.name] === '' || data[f.name] === null)) {
                toast(`请填写「${f.label}」`, 'warning');
                input.focus();
                return;
              }
            }
            c.close();
            resolve(data);
          });
        },
      });
      void ctx;
    });
  }

  /** 下拉菜单 */
  function dropdown(anchor, items) {
    const existing = anchor.parentElement.querySelector('.dropdown__menu');
    if (existing) { existing.remove(); return; }
    const menu = el('div', { class: 'dropdown__menu' });
    for (const item of items) {
      if (item.divider) { menu.appendChild(el('div', { class: 'dropdown__divider' })); continue; }
      const btn = el('button', {
        class: 'dropdown__item',
        html: `${item.icon ? `<span>${item.icon}</span>` : ''}<span>${escapeHtml(item.label)}</span>`,
        onClick: () => { menu.remove(); item.onClick && item.onClick(); },
      });
      if (item.danger) btn.style.color = 'var(--danger)';
      menu.appendChild(btn);
    }
    anchor.parentElement.style.position = 'relative';
    anchor.parentElement.appendChild(menu);
    const close = (e) => {
      if (!menu.contains(e.target) && e.target !== anchor) {
        menu.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  /* ------------------------------------------------------------------ *
   * 图表
   * ------------------------------------------------------------------ */

  /** 折线 / 面积图 */
  function lineChart(container, series, opts = {}) {
    const data = Array.isArray(series) ? series : [series];
    const labels = opts.labels || data[0]?.map((_, i) => String(i + 1)) || [];
    const allValues = data.flatMap((s) => s.map((v) => Number(v) || 0));
    const max = opts.max ?? Math.max(1, ...allValues);
    const height = opts.height || 220;
    const padL = 34;
    const padR = 12;
    const padT = 12;
    const padB = 26;
    const W = 720;
    const H = height;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const n = Math.max(1, labels.length - 1);
    const x = (i) => padL + (i / n) * innerW;
    const y = (v) => padT + innerH - (Number(v) / max) * innerH;

    const colors = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444'];
    const names = opts.names || ['系列 1'];

    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">`;
    svg += '<defs>';
    data.forEach((_, si) => {
      svg += `<linearGradient id="grad${si}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${colors[si % colors.length]}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="${colors[si % colors.length]}" stop-opacity="0"/>
      </linearGradient>`;
    });
    svg += '</defs>';

    // 网格与 Y 轴刻度
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const val = (max / ticks) * t;
      const yy = y(val);
      svg += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#e4e9f2" stroke-width="1" ${t === 0 ? '' : 'stroke-dasharray="3 4"'}/>`;
      svg += `<text x="${padL - 7}" y="${yy + 4}" text-anchor="end" font-size="10" fill="#94a3b8">${Math.round(val)}</text>`;
    }

    // X 轴标签（最多 8 个）
    const step = Math.max(1, Math.ceil(labels.length / 8));
    labels.forEach((lb, i) => {
      if (i % step !== 0 && i !== labels.length - 1) return;
      svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#94a3b8">${escapeHtml(String(lb).slice(-5))}</text>`;
    });

    data.forEach((s, si) => {
      const color = colors[si % colors.length];
      let line = '';
      let area = `M ${x(0)} ${y(0)}`;
      s.forEach((v, i) => {
        line += `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(v)} `;
        area += ` L ${x(i)} ${y(v)}`;
      });
      area += ` L ${x(s.length - 1)} ${y(0)} Z`;
      svg += `<path d="${area}" fill="url(#grad${si})"/>`;
      svg += `<path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
      s.forEach((v, i) => {
        svg += `<circle cx="${x(i)}" cy="${y(v)}" r="3.2" fill="#fff" stroke="${color}" stroke-width="2"><title>${escapeHtml(names[si])} ${labels[i]}: ${v}</title></circle>`;
      });
    });

    svg += '</svg>';
    container.innerHTML = svg + (opts.showLegend === false ? '' : `<div class="chart-legend mt-14">${data.map((_, si) => `<div class="chart-legend__item"><span class="chart-legend__swatch" style="background:${colors[si % colors.length]}"></span>${escapeHtml(names[si] || `系列${si + 1}`)}</div>`).join('')}</div>`);
    return container;
  }

  /** 环形图 */
  function donutChart(container, items, opts = {}) {
    const total = items.reduce((s, i) => s + (Number(i.count) || 0), 0);
    const colors = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#64748b'];
    let acc = 0;
    const stops = items.map((it, i) => {
      const start = total ? (acc / total) * 360 : 0;
      acc += Number(it.count) || 0;
      const end = total ? (acc / total) * 360 : 0;
      return `${colors[i % colors.length]} ${start}deg ${end}deg`;
    }).join(', ');

    container.innerHTML = `
      <div class="donut-wrap">
        <div class="donut" style="background: conic-gradient(${stops || '#e4e9f2 0deg 360deg'})">
          <div class="donut__center">
            <div class="donut__value">${opts.centerValue ?? total}</div>
            <div class="donut__label">${escapeHtml(opts.centerLabel || '总计')}</div>
          </div>
        </div>
        <div class="bar-chart flex-1" style="min-width:180px">
          ${items.map((it, i) => `
            <div class="chart-legend__item">
              <span class="chart-legend__swatch" style="background:${colors[i % colors.length]}"></span>
              <span class="flex-1">${escapeHtml(it.label ?? it.name ?? '')}</span>
              <strong>${it.count ?? 0}</strong>
              <span class="text-muted text-xs">${total ? ((it.count / total) * 100).toFixed(0) : 0}%</span>
            </div>`).join('')}
        </div>
      </div>`;
    return container;
  }

  /** 横向条形图 */
  function barChart(container, items, opts = {}) {
    const max = Math.max(1, ...items.map((i) => Number(i.count) || 0));
    const variant = opts.variant || '';
    container.innerHTML = `<div class="bar-chart">${items.map((it) => `
      <div class="bar-row">
        <div class="bar-row__label" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}</div>
        <div class="bar-track"><div class="bar-fill${variant ? ` bar-fill--${variant}` : ''}" style="width:${((it.count || 0) / max) * 100}%"></div></div>
        <div class="bar-row__value">${fmt.number(it.count || 0)}${opts.suffix || ''}</div>
      </div>`).join('')}</div>`;
    return container;
  }

  /* ------------------------------------------------------------------ *
   * 其他助手
   * ------------------------------------------------------------------ */
  function debounce(fn, delay = 300) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), delay);
    };
  }

  function paginationHtml(pagination) {
    if (!pagination) return '';
    const { page, totalPages, total } = pagination;
    const pages = [];
    const push = (p) => pages.push(`<button class="page-btn${p === page ? ' is-active' : ''}" data-page="${p}">${p}</button>`);
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    if (start > 1) { push(1); if (start > 2) pages.push('<span class="text-muted">…</span>'); }
    for (let p = start; p <= end; p++) push(p);
    if (end < totalPages) { if (end < totalPages - 1) pages.push('<span class="text-muted">…</span>'); push(totalPages); }
    return `<div class="pagination">
      <div class="pagination__info">共 ${total} 条 · 第 ${page}/${totalPages} 页</div>
      <button class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹</button>
      ${pages.join('')}
      <button class="page-btn" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>›</button>
    </div>`;
  }

  function bindPagination(root, onChange) {
    delegate(root, '[data-page]', 'click', (e, btn) => {
      if (btn.disabled) return;
      const p = Number(btn.dataset.page);
      if (p >= 1) onChange(p);
    });
  }

  function loading(container, text = '加载中…') {
    container.innerHTML = `<div class="loading-block"><span class="spinner spinner--lg"></span><span>${escapeHtml(text)}</span></div>`;
  }

  function emptyState(icon, title, desc = '') {
    return `<div class="empty"><div class="empty__icon">${icon}</div><div class="empty__title">${escapeHtml(title)}</div>${desc ? `<div class="empty__desc">${escapeHtml(desc)}</div>` : ''}</div>`;
  }

  function stateColor(name) {
    return { online: 'var(--success)', busy: 'var(--warning)', away: 'var(--text-3)', offline: '#cbd5e1' }[name] || 'var(--text-3)';
  }

  /** 简易哈希路由 */
  function router(routes, defaultRoute) {
    function resolve() {
      const hash = location.hash.replace(/^#/, '') || defaultRoute || '/';
      const [pathPart, queryPart] = hash.split('?');
      const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
      const path = pathPart || '/';
      let handler = routes[path];
      let params = {};
      if (!handler) {
        for (const [pattern, fn] of Object.entries(routes)) {
          if (!pattern.includes(':')) continue;
          const pp = pattern.split('/').filter(Boolean);
          const cp = path.split('/').filter(Boolean);
          if (pp.length !== cp.length) continue;
          const matched = pp.every((seg, i) => seg.startsWith(':') || seg === cp[i]);
          if (matched) {
            handler = fn;
            params = Object.fromEntries(pp.map((seg, i) => [seg.slice(1), cp[i]]).filter(([k]) => k));
            break;
          }
        }
      }
      if (handler) handler({ path, query, params });
      $$('[data-route]').forEach((node) => {
        node.classList.toggle('is-active', node.dataset.route === path);
      });
    }
    window.addEventListener('hashchange', resolve);
    resolve();
    return { resolve, go: (p) => { location.hash = p; } };
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */
  const Kefu = {
    api, qs, auth, state,
    connectWS, sendWS, on, off, emit,
    $, $$, el, delegate, escapeHtml, markdown,
    registerAction, bindActionDelegation,
    fmt, stars, avatar, statusBadge, statusDot, stateColor,
    toast, modal, confirm, formModal, dropdown,
    lineChart, donutChart, barChart,
    debounce, paginationHtml, bindPagination, loading, emptyState, router,
    STATUS_TEXT,
  };

  global.Kefu = Kefu;
  loadSession();
  bindActionDelegation();

  /* 通用导航行为：替代内联 onclick，使 CSP 无需放开内联脚本 */
  registerAction('go-tickets', () => { location.hash = '#/tickets'; });
  registerAction('go-help', () => { location.hash = '#/help'; });
  registerAction('go-back', () => { history.back(); });
  registerAction('redirect-help', () => { location.replace('/#/help'); });

  // 启动即拉取站点配置
  api.get('/api/auth/settings', { noRedirect: true })
    .then((s) => { state.settings = s || {}; document.dispatchEvent(new CustomEvent('settings:ready', { detail: s })); })
    .catch(() => { /* ignore */ });
})(window);
