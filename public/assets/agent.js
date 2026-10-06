/* ==========================================================================
   客服工作台
   ========================================================================== */
(function () {
  'use strict';
  const { api, auth, fmt, $, $$, el, escapeHtml, markdown, toast, modal, confirm, formModal,
    statusBadge, avatar, emptyState, loading, on, sendWS, paginationHtml, bindPagination, debounce } = Kefu;

  const PAGE_META = {
    '/workspace': ['在线会话', '实时接待客户咨询'],
    '/tickets': ['我的工单', '处理并流转您负责的工单'],
    '/customers': ['客户列表', '查看客户资料与服务历史'],
    '/kb': ['知识库', '接待时快速检索与引用文章'],
    '/quick': ['快捷话术', '管理常用回复模板'],
    '/stats': ['我的绩效', '个人服务数据统计'],
  };

  let activeConvId = null;
  let activeConv = null;
  let lastMessageId = 0;
  let currentTab = 'queue';
  let currentPage = 1;
  let wsBound = false;
  let quickReplies = [];
  let quickFavorites = [];
  let ticketPollTimer = null;

  /* ============================== 侧边栏初始化 ============================== */

  function initShell() {
    const u = auth.user;
    $('#meAvatar').innerHTML = avatar(u.name, 'sm');
    $('#meName').textContent = u.name;
    $('#meDept').textContent = `${u.department_name || ''} ${u.level || ''}`.trim() || Kefu.STATUS_TEXT[u.role];

    renderStatusPicker();
    $('#btnLogout').addEventListener('click', async () => {
      if (await confirm({ title: '退出登录', message: '确定要退出当前账号吗？', confirmText: '退出' })) auth.logout();
    });
    $('#btnRefresh').addEventListener('click', () => { toast('已刷新', 'success'); loadBadges(); route(); });
    $('#btnNotif').addEventListener('click', openNotifications);

    Kefu.connectWS();
    bindRealtime();
    loadQuickReplies();
    loadBadges();
    setInterval(loadBadges, 30000);
  }

  function renderStatusPicker() {
    const picker = $('#statusPicker');
    const cur = auth.user.status || 'online';
    $$('.agent-status-picker__item', picker).forEach((b) => {
      b.classList.toggle('is-active', b.dataset.status === cur);
      b.style.color = b.classList.contains('is-active') ? '' : '#cbd5e1';
    });
    picker.onclick = async (e) => {
      const btn = e.target.closest('[data-status]');
      if (!btn) return;
      const status = btn.dataset.status;
      if (!sendWS({ type: 'agent:status', status })) return toast('实时连接未就绪，请稍后重试', 'warning');
      auth.user.status = status;
      Kefu.state.user.status = status;
      try { localStorage.setItem('kefu.session', JSON.stringify({ token: auth.token, user: auth.user })); } catch { /* ignore */ }
      renderStatusPicker();
      toast(`状态已切换为「${Kefu.STATUS_TEXT[status]}」`, 'success');
    };
  }

  function bindRealtime() {
    if (wsBound) return;
    wsBound = true;

    on('open', () => {
      const s = $('#wsStatus');
      if (s) s.innerHTML = '<span class="dot dot--online"></span>实时已连接';
      if (auth.user.status && auth.user.status !== 'offline') {
        sendWS({ type: 'agent:status', status: auth.user.status });
      }
    });
    on('close', () => {
      const s = $('#wsStatus');
      if (s) s.innerHTML = '<span class="dot dot--busy"></span>连接中断，重连中…';
    });

    on('message', (msg) => {
      if (!msg.message) return;
      const convId = msg.conversationId;
      const fromCustomer = msg.message.sender_role === 'customer';

      if (convId === activeConvId) {
        if (msg.message.id > lastMessageId) {
          lastMessageId = msg.message.id;
          appendMessage(msg.message, true);
          scrollChat();
          // 坐席侧收到客户消息自动标记已读
          if (fromCustomer) {
            api.get(`/api/conversations/${activeConvId}/messages`).catch(() => {});
          }
        }
      } else if (fromCustomer) {
        // 未打开的会话：提示坐席并同步刷新列表，不必手动刷新页面
        toast(`客户「${msg.message.sender_name}」发来新消息：${String(msg.message.content).slice(0, 30)}`, 'info', 3600);
        playBeep();
        unreadHint(convId);
      }
      if (location.hash.startsWith('#/workspace')) loadConversations(true);
      loadBadges();
    });

    on('event', (evt) => {
      // 排队/列表刷新：带消息时说明有新客户消息
      if (evt.type === 'queue:update' || evt.type === 'queue:refresh') {
        const conv = evt.conversation;
        const msg = evt.message;
        const isMine = conv && conv.agent_id === auth.user.id;

        if (msg && msg.sender_role === 'customer') {
          // 未打开该会话时提醒（负责坐席已通过 message 事件收到，避免重复提示）
          if (evt.conversationId !== activeConvId && !isMine) {
            toast(`客户「${msg.sender_name}」：${String(msg.content).slice(0, 30)}`, 'info', 3600);
            playBeep();
            unreadHint(evt.conversationId);
          }
          // 新消息到达时更新已打开会话的消息区
          if (evt.conversationId === activeConvId && msg.id > lastMessageId) {
            lastMessageId = msg.id;
            appendMessage(msg, true);
            scrollChat();
          }
        }

        if (location.hash.startsWith('#/workspace')) loadConversations(true);
        loadBadges();
      }

      // 新会话创建：实时提醒，无需刷新
      if (evt.type === 'conversation:new') {
        const conv = evt.conversation || {};
        if (evt.action !== 'assigned' && conv.agent_id === auth.user.id) {
          toast(`新会话 ${conv.code || ''}（${conv.customer_name || '客户'}）已分配给你`, 'success', 4200);
          playBeep();
        }
        if (location.hash.startsWith('#/workspace')) loadConversations(true);
        loadBadges();
      }

      // 会话被分配/转接：如果分给了我，提示并高亮
      if (evt.type === 'conversation:assigned') {
        const conv = evt.conversation || {};
        if (conv.agent_id === auth.user.id && evt.previousAgentId !== auth.user.id) {
          toast(`会话 ${conv.code || ''}（${conv.customer_name || '客户'}）已转给你`, 'success', 4200);
          playBeep();
        } else if (evt.previousAgentId === auth.user.id && conv.agent_id !== auth.user.id) {
          toast(`会话 ${conv.code || ''} 已被转交给 ${conv.agent_name || '其他坐席'}`, 'info', 3200);
        }
        if (conv.id === activeConvId) {
          activeConv = { ...activeConv, ...conv };
          renderChatHead();
        }
        if (location.hash.startsWith('#/workspace')) loadConversations(true);
        loadBadges();
      }

      if (evt.type === 'conversation:update') {
        if (evt.conversation.id === activeConvId) {
          const prevStatus = activeConv?.status;
          activeConv = { ...activeConv, ...evt.conversation };
          renderChatHead();
          if (evt.reason === 'closed' && prevStatus !== 'closed') toast('该会话已被结束', 'info');
        }
        if (location.hash.startsWith('#/workspace')) loadConversations(true);
      }

      // 工单变更：列表与统计自动刷新
      if (evt.type === 'ticket:update' && location.hash.startsWith('#/tickets')) loadTickets();
      if (evt.type === 'ticket:stats') {
        loadTicketStats();
        loadBadges();
        if (location.hash.startsWith('#/tickets')) loadTickets();
      }

      // 知识库实时更新：管理员/坐席无需刷新页面
      if (evt.type === 'kb:update') {
        handleKbUpdate(evt);
      }
    });

    on('notification', (n) => {
      if (!n) return;
      toast(`${n.title}${n.body ? `：${n.body}` : ''}`, n.type === 'warning' ? 'warning' : 'info', 4200);
      loadBadges();
      playBeep();
    });
  }

  let audioCtx = null;

  /** 给未打开会话的列表项打上未读标记并轻微高亮，避免坐席漏看 */
  function unreadHint(convId) {
    const item = $(`.conv-item[data-conv="${convId}"]`);
    if (!item) return;
    if (!item.querySelector('.conv-item__unread')) {
      const badge = el('span', { class: 'conv-item__unread', text: '1' });
      item.appendChild(badge);
    } else {
      const badge = item.querySelector('.conv-item__unread');
      badge.textContent = String(Number(badge.textContent || 0) + 1);
    }
    item.style.transition = 'background .3s';
    item.style.background = 'var(--warning-soft, #fffbeb)';
    setTimeout(() => { item.style.background = ''; }, 1600);
  }

  /** 知识库变更：工作台内的知识库页面与话术引用自动同步 */
  function handleKbUpdate(evt) {
    const onKbPage = location.hash.startsWith('#/kb');
    const action = String(evt.action || '');
    if (onKbPage) {
      const labels = {
        'article:created': '有新的知识库文章',
        'article:updated': '文章「' + (evt.title || '') + '」已被更新',
        'article:deleted': '文章「' + (evt.title || '') + '」已被删除',
        'category:created': '有新的知识库分类',
        'category:updated': '知识库分类已更新',
        'category:deleted': '知识库分类已删除',
      };
      if (labels[action]) toast(labels[action], 'info', 3200);
      loadKbArticles(1);
    } else if (action.startsWith('article:')) {
      toast(`知识库已更新：${evt.title || ''}`, 'info', 2600);
    }
  }
  function playBeep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.28);
      osc.start(); osc.stop(audioCtx.currentTime + 0.3);
    } catch { /* 忽略音频不可用 */ }
  }

  async function loadBadges() {
    try {
      const [stats, notify] = await Promise.all([
        api.get('/api/conversations/stats'),
        api.get('/api/admin/notifications'),
      ]);
      const bq = $('#badgeQueue');
      bq.textContent = stats.queue;
      bq.classList.toggle('hidden', !stats.queue);
      bq.classList.toggle('nav-item__badge--alert', stats.queue > 0);

      const nt = await api.get('/api/tickets/stats');
      const bt = $('#badgeTickets');
      bt.textContent = nt.mine;
      bt.classList.toggle('hidden', !nt.mine);

      const nb = $('#notifBadge');
      nb.textContent = notify.unread;
      nb.style.display = notify.unread ? 'grid' : 'none';
    } catch { /* ignore */ }
  }

  async function openNotifications() {
    const ctx = modal({ title: '通知中心', size: '', body: '<div class="loading-block"><span class="spinner spinner--lg"></span></div>' });
    try {
      const { list } = await api.get('/api/admin/notifications');
      if (!list.length) { ctx.body.innerHTML = emptyState('🔔', '暂无通知'); return; }
      ctx.body.innerHTML = list.map((n) => `
        <div class="note-item" style="border-left-color:${n.type === 'danger' ? 'var(--danger)' : n.type === 'warning' ? 'var(--warning)' : n.type === 'success' ? 'var(--success)' : 'var(--brand)'};${n.is_read ? 'opacity:.6' : ''}">
          <div class="flex items-center gap-8">
            <span class="fw-500">${escapeHtml(n.title)}</span>
            ${n.is_read ? '' : '<span class="badge badge--danger" style="height:17px;font-size:10.5px">未读</span>'}
            <span class="text-xs text-muted ml-auto">${fmt.time(n.created_at)}</span>
          </div>
          <div class="text-sm text-2 mt-4">${escapeHtml(n.body || '')}</div>
        </div>`).join('');
      await api.post('/api/admin/notifications/read', {});
      loadBadges();
    } catch (err) { ctx.body.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  function loadQuickReplies() {
    api.get('/api/conversations/quick-replies/list').then((res) => {
      // 接口历史上出现过两种形态：纯数组，以及 {list, favorites} 对象。
      // 这里统一归一化为数组，避免任一形态导致 .slice()/.map() 运行时报错。
      let arr = [];
      if (Array.isArray(res)) arr = res;
      else if (res && Array.isArray(res.list)) arr = res.list;
      else if (res && Array.isArray(res.data)) arr = res.data;
      quickReplies = arr.filter((q) => q && typeof q === 'object');
      quickFavorites = quickReplies.filter((q) => Number(q.is_favorite) === 1);
    }).catch((err) => {
      console.warn('[quick-replies] 加载失败：', err.message);
      quickReplies = [];
      quickFavorites = [];
    });
  }

  /* ============================== 路由 ============================== */

  const routes = {
    '/workspace': viewWorkspace,
    '/tickets': viewTickets,
    '/customers': viewCustomers,
    '/kb': viewKb,
    '/quick': viewQuick,
    '/stats': viewStats,
  };

  function route() {
    const hash = location.hash.replace(/^#/, '') || '/workspace';
    const [path, qs] = hash.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    const handler = routes[path] || viewWorkspace;
    const meta = PAGE_META[path] || PAGE_META['/workspace'];
    $('#pageTitle').textContent = meta[0];
    $('#pageDesc').textContent = meta[1];
    $$('.nav-item').forEach((n) => n.classList.toggle('is-active', n.dataset.route === path));
    if (ticketPollTimer) { clearInterval(ticketPollTimer); ticketPollTimer = null; }
    handler(query);
  }

  /* ============================== 在线会话 ============================== */

  function viewWorkspace(query) {
    $('#view').innerHTML = `
      <div class="ws">
        <section class="ws__list">
          <div class="list-head">
            <div class="list-tabs" id="convTabs">
              <div class="list-tab is-active" data-tab="queue">排队中 <span class="list-tab__count" data-count="queue">0</span></div>
              <div class="list-tab" data-tab="mine">我的 <span class="list-tab__count" data-count="mine">0</span></div>
              <div class="list-tab" data-tab="all">全部 <span class="list-tab__count" data-count="all">0</span></div>
            </div>
            <div class="search-box">
              <input class="input" id="convSearch" placeholder="搜索客户 / 会话号…" style="height:32px;font-size:13px">
            </div>
          </div>
          <div class="conv-list" id="convList"><div class="loading-block"><span class="spinner"></span></div></div>
        </section>

        <section class="ws__main" id="wsMain">
          <div class="ws-empty">${emptyState('💬', '选择一个会话开始接待', '从左侧列表点击「接入」即可与客户对话')}</div>
        </section>

        <aside class="ws__right" id="wsRight">
          <div class="side-section">
            <div class="side-section__head" data-collapse>👤 客户资料 <span class="side-section__arrow">▼</span></div>
            <div class="side-section__body"><div class="text-sm text-muted">请选择会话</div></div>
          </div>
        </aside>
      </div>`;

    $('#convTabs').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (!tab) return;
      currentTab = tab.dataset.tab;
      currentPage = 1;
      $$('.list-tab', $('#convTabs')).forEach((t) => t.classList.toggle('is-active', t === tab));
      loadConversations();
    });
    $('#convSearch').addEventListener('input', debounce(() => { currentPage = 1; loadConversations(); }, 320));

    // 折叠面板
    $('#wsRight').addEventListener('click', (e) => {
      const head = e.target.closest('[data-collapse]');
      if (head) head.parentElement.classList.toggle('is-collapsed');
    });

    loadConversations().then(() => {
      if (query.conv) openConversation(Number(query.conv));
    });
  }

  async function loadConversations(silent) {
    const list = $('#convList');
    if (!list) return;
    if (!silent) loading(list, '');

    const scopeMap = { queue: 'queue', mine: 'mine', all: '' };
    const params = {
      page: currentPage,
      pageSize: 30,
      keyword: $('#convSearch')?.value || '',
    };
    const scope = scopeMap[currentTab];
    if (scope) params.scope = scope;

    try {
      const res = await api.get(`/api/conversations${Kefu.qs(params)}`);

      // 更新数量
      try {
        const [stats, mineRes, allRes] = await Promise.all([
          api.get('/api/conversations/stats'),
          api.get('/api/conversations?scope=mine&pageSize=1'),
          api.get('/api/conversations?pageSize=1'),
        ]);
        const setCount = (k, v) => { const n = $(`[data-count="${k}"]`); if (n) n.textContent = v; };
        setCount('queue', stats.queue);
        setCount('mine', mineRes.pagination.total);
        setCount('all', allRes.pagination.total);
      } catch { /* ignore */ }

      if (!res.list.length) {
        list.innerHTML = emptyState('📭', currentTab === 'queue' ? '暂无排队会话' : '暂无会话记录');
        return;
      }

      list.innerHTML = res.list.map((c) => {
        const unread = currentTab === 'queue' ? 0 : Number(c.unread_agent || 0);
        const isActive = c.id === activeConvId;
        const preview = c.last_message
          ? `${c.last_sender_role === 'customer' ? '' : c.last_sender_role === 'agent' ? '我：' : ''}${String(c.last_message).replace(/\n/g, ' ').slice(0, 40)}`
          : '暂无消息';
        return `
        <div class="conv-item${isActive ? ' is-active' : ''}" data-conv="${c.id}">
          <div class="conv-item__top">
            <span class="avatar avatar--sm avatar--c${(String(c.customer_name).charCodeAt(0) % 5) + 1}">${escapeHtml(c.customer_name.charAt(0))}</span>
            <span class="conv-item__name">${escapeHtml(c.customer_name)}</span>
            <span class="conv-item__time">${fmt.time(c.last_message_at)}</span>
          </div>
          <div class="conv-item__preview">${escapeHtml(preview)}</div>
          <div class="conv-item__tags">
            ${statusBadge(c.status)}
            ${c.priority !== 'normal' ? statusBadge(c.priority, `优先级 ${Kefu.STATUS_TEXT[c.priority]}`) : ''}
            ${c.tag ? `<span class="badge badge--outline">${escapeHtml(c.tag)}</span>` : ''}
            ${c.agent_name ? `<span class="text-xs text-muted">${escapeHtml(c.agent_name)}</span>` : ''}
          </div>
          ${unread ? `<span class="conv-item__unread">${unread}</span>` : ''}
        </div>`;
      }).join('');

      list.onclick = (e) => {
        const item = e.target.closest('[data-conv]');
        if (item) openConversation(Number(item.dataset.conv));
      };
      if (activeConvId) {
        const active = list.querySelector(`[data-conv="${activeConvId}"]`);
        if (active) active.scrollIntoView({ block: 'nearest' });
      }
    } catch (err) {
      list.innerHTML = emptyState('😥', '加载失败', err.message);
    }
  }

  async function openConversation(id) {
    try {
      const detail = await api.get(`/api/conversations/${id}`);
      activeConvId = id;
      activeConv = detail.conversation;
      lastMessageId = 0;
      renderChatArea(detail);
      renderRightPanel(detail);
      $$('.conv-item').forEach((n) => n.classList.toggle('is-active', Number(n.dataset.conv) === id));
      await loadMessages();
      loadConversations(true);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderChatArea(detail) {
    const conv = detail.conversation;
    $('#wsMain').innerHTML = `
      <div class="chat-head" id="chatHead">
        <span class="avatar avatar--c${(String(conv.customer_name).charCodeAt(0) % 5) + 1}">${escapeHtml(conv.customer_name.charAt(0))}</span>
        <div class="flex-1" style="min-width:0">
          <div class="chat-head__title">
            ${escapeHtml(conv.customer_name)}
            ${statusBadge(conv.status)}
            ${conv.priority !== 'normal' ? statusBadge(conv.priority, Kefu.STATUS_TEXT[conv.priority]) : ''}
          </div>
          <div class="chat-head__sub">
            <span>${escapeHtml(conv.code)}</span>
            <span>${Kefu.STATUS_TEXT[conv.channel] || conv.channel}</span>
            <span>${escapeHtml(conv.customer_phone || conv.customer_email || '')}</span>
            ${conv.tag ? `<span class="badge badge--outline" style="height:17px;font-size:10.5px">${escapeHtml(conv.tag)}</span>` : ''}
          </div>
        </div>
        <div class="chat-head__actions">
          ${conv.status === 'closed' ? '' : `
            ${!conv.agent_id || conv.agent_id !== auth.user.id ? '<button class="btn btn--sm btn--primary" id="btnTake">接入会话</button>' : ''}
            <button class="btn btn--sm" id="btnTransfer">转接</button>
            <button class="btn btn--sm" id="btnQuick">⚡ 话术</button>
            <button class="btn btn--sm" id="btnToTicket">🎫 转工单</button>
            <button class="btn btn--sm btn--danger" id="btnEnd">结束会话</button>`}
          ${conv.status === 'closed' ? `<span class="badge badge--info">会话已结束${conv.rating ? ` · 客户评价 ${conv.rating} 星` : ''}</span>` : ''}
        </div>
      </div>
      <div class="chat-scroll" id="chatScroll"></div>
      ${conv.status === 'closed' ? '' : `
      <div class="chat-foot-ws" style="position:relative">
        <div id="kbSuggest"></div>
        <div class="flex items-center gap-8 mb-8">
          <button class="btn btn--sm btn--icon" id="btnImage" title="发送图片">🖼️</button>
          <button class="btn btn--sm btn--icon" id="btnFile" title="发送文件">📎</button>
          <button class="btn btn--sm" id="btnFiles" title="会话文件库：查看并重发历史附件">🗂️ 文件库</button>
          <button class="btn btn--sm" id="btnKbSearch">📚 知识库</button>
          <span class="text-xs text-muted ml-auto">Enter 发送 · Ctrl+Enter 换行</span>
        </div>
        <div class="flex gap-10 items-center">
          <textarea class="input" id="replyInput" placeholder="输入回复内容…" rows="1"
            style="flex:1;height:42px;padding:10px 13px;resize:none;max-height:130px;line-height:1.5"></textarea>
          <button class="btn btn--primary btn--lg" id="btnSend" style="height:42px">发送</button>
        </div>
        <input type="file" id="filePicker" class="hidden">
      </div>`}`;

    bindChatActions();
  }

  function renderChatHead() {
    if (!activeConv) return;
    const head = $('#chatHead');
    if (!head) return;
    const conv = activeConv;
    head.innerHTML = `
      <span class="avatar avatar--c${(String(conv.customer_name).charCodeAt(0) % 5) + 1}">${escapeHtml(conv.customer_name.charAt(0))}</span>
      <div class="flex-1" style="min-width:0">
        <div class="chat-head__title">
          ${escapeHtml(conv.customer_name)}
          ${statusBadge(conv.status)}
          ${conv.priority !== 'normal' ? statusBadge(conv.priority, Kefu.STATUS_TEXT[conv.priority]) : ''}
        </div>
        <div class="chat-head__sub">
          <span>${escapeHtml(conv.code)}</span>
          <span>${Kefu.STATUS_TEXT[conv.channel] || conv.channel}</span>
          ${conv.agent_name ? `<span>当前客服：${escapeHtml(conv.agent_name)}</span>` : '<span>未分配</span>'}
        </div>
      </div>
      <div class="chat-head__actions">
        ${conv.status === 'closed' ? '<span class="badge badge--info">会话已结束</span>' : `
          ${!conv.agent_id || conv.agent_id !== auth.user.id ? '<button class="btn btn--sm btn--primary" id="btnTake">接入会话</button>' : ''}
          <button class="btn btn--sm" id="btnTransfer">转接</button>
          <button class="btn btn--sm" id="btnQuick">⚡ 话术</button>
          <button class="btn btn--sm" id="btnToTicket">🎫 转工单</button>
          <button class="btn btn--sm btn--danger" id="btnEnd">结束会话</button>`}
      </div>`;
    bindChatActions();
  }

  function bindChatActions() {
    const takeBtn = $('#btnTake');
    if (takeBtn) takeBtn.onclick = async () => {
      try {
        await api.post(`/api/conversations/${activeConvId}/assign`, {});
        toast('已接入会话', 'success');
        await openConversation(activeConvId);
      } catch (err) { toast(err.message, 'error'); }
    };

    const transferBtn = $('#btnTransfer');
    if (transferBtn) transferBtn.onclick = openTransfer;

    const quickBtn = $('#btnQuick');
    if (quickBtn) quickBtn.onclick = openQuickPanel;

    const ticketBtn = $('#btnToTicket');
    if (ticketBtn) ticketBtn.onclick = () => createTicketFromConv();

    const endBtn = $('#btnEnd');
    if (endBtn) endBtn.onclick = async () => {
      if (!await confirm({ title: '结束会话', message: '结束后客户将无法继续发送消息，确定吗？', confirmText: '结束会话', danger: true })) return;
      try {
        await api.post(`/api/conversations/${activeConvId}/close`, {});
        toast('会话已结束', 'success');
        await openConversation(activeConvId);
      } catch (err) { toast(err.message, 'error'); }
    };

    const input = $('#replyInput');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); sendReply(); }
      });
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
        if (activeConvId) sendWS({ type: 'typing', conversationId: activeConvId });
        suggestKb(input.value);
      });
    }
    const sendBtn = $('#btnSend');
    if (sendBtn) sendBtn.onclick = sendReply;

    const picker = $('#filePicker');
    const imageBtn = $('#btnImage');
    if (imageBtn) imageBtn.onclick = () => { picker.accept = 'image/*'; picker.dataset.kind = 'image'; picker.click(); };
    const fileBtn = $('#btnFile');
    if (fileBtn) fileBtn.onclick = () => { picker.accept = ''; picker.dataset.kind = 'file'; picker.click(); };
    if (picker) picker.onchange = async () => {
      if (picker.files[0]) await uploadAndSend(picker.files[0]);
      picker.value = '';
    };
    const kbBtn = $('#btnKbSearch');
    if (kbBtn) kbBtn.onclick = openKbSearch;

    const filesBtn = $('#btnFiles');
    if (filesBtn) filesBtn.onclick = openFileLibrary;
  }

  /** 会话文件库：集中查看本次会话收发过的图片与附件，可一键重发 */
  async function openFileLibrary() {
    if (!activeConvId) return toast('请先打开一个会话', 'warning');
    const ctx = modal({ title: '会话文件库', size: 'lg', body: '<div class="loading-block"><span class="spinner spinner--lg"></span><span>加载附件…</span></div>' });

    let data;
    try {
      data = await api.get(`/api/conversations/${activeConvId}/files`);
    } catch (err) {
      ctx.body.innerHTML = emptyState('😥', '附件加载失败', err.message);
      return;
    }

    if (!data.list.length) {
      ctx.body.innerHTML = emptyState('🗂️', '本会话还没有任何附件', '发送图片或文件后会出现在这里，可随时重发');
      return;
    }

    const render = (filter) => {
      const list = filter === 'all' ? data.list
        : filter === 'image' ? data.list.filter((f) => f.type === 'image')
          : data.list.filter((f) => f.type === 'file');
      if (!list.length) return emptyState('🗂️', '该分类下暂无附件');
      return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px">
        ${list.map((f) => `
          <div class="file-card" data-url="${escapeHtml(f.url)}" data-type="${f.type}"
               data-name="${escapeHtml(f.name)}" style="border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface)">
            ${f.type === 'image'
              ? `<div style="height:98px;background:var(--surface-2);display:grid;place-items:center;overflow:hidden;cursor:zoom-in" data-preview="${escapeHtml(f.url)}">
                   <img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.name)}" loading="lazy" style="width:100%;height:100%;object-fit:cover">
                 </div>`
              : `<div style="height:98px;background:var(--surface-2);display:grid;place-items:center;font-size:30px">📎</div>`}
            <div style="padding:9px 11px">
              <div class="text-sm ellipsis" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
              <div class="text-xs text-muted mt-4">
                ${f.sender_role === 'agent' ? '我发出' : escapeHtml(f.sender_name || '客户')} · ${fmt.bytes(f.size)}
                ${f.times > 1 ? ` · 发过 ${f.times} 次` : ''}
              </div>
              <div class="text-xs text-muted">${fmt.datetime(f.created_at)}</div>
              <div class="flex gap-6 mt-8">
                <button class="btn btn--sm flex-1" data-resend="${escapeHtml(f.url)}" data-rtype="${f.type}"
                        data-rname="${escapeHtml(f.name)}" data-rsize="${f.size}">重新发送</button>
                <a class="btn btn--sm" href="${escapeHtml(f.url)}" download="${escapeHtml(f.name)}" title="下载">⬇</a>
              </div>
            </div>
          </div>`).join('')}
      </div>`;
    };

    ctx.body.innerHTML = `
      <div class="flex items-center gap-10 mb-14 flex-wrap">
        <div class="segmented" id="fileFilter">
          <button class="segmented__item is-active" data-filter="all">全部 ${data.total}</button>
          <button class="segmented__item" data-filter="image">图片 ${data.images}</button>
          <button class="segmented__item" data-filter="file">文件 ${data.files}</button>
        </div>
        <span class="text-xs text-muted">客户发送 ${data.fromCustomer} 个 · 我发送 ${data.fromAgent} 个</span>
      </div>
      <div id="fileGrid">${render('all')}</div>`;

    $('#fileFilter', ctx.body).onclick = (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      $$('.segmented__item', $('#fileFilter', ctx.body)).forEach((x) => x.classList.toggle('is-active', x === b));
      $('#fileGrid', ctx.body).innerHTML = render(b.dataset.filter);
    };

    ctx.body.onclick = async (e) => {
      // 图片预览
      const prev = e.target.closest('[data-preview]');
      if (prev) {
        modal({ title: '图片预览', size: 'lg', body: `<img src="${prev.dataset.preview}" style="width:100%;border-radius:10px">` });
        return;
      }
      // 重新发送已上传的文件（无需再次上传）
      const btn = e.target.closest('[data-resend]');
      if (!btn) return;
      const meta = { name: btn.dataset.rname, size: Number(btn.dataset.rsize) || 0 };
      try {
        const msg = await api.post(`/api/conversations/${activeConvId}/messages`, {
          content: btn.dataset.resend, type: btn.dataset.rtype, meta,
        });
        if (msg && msg.id > lastMessageId) { lastMessageId = msg.id; appendMessage(msg, true); scrollChat(); }
        toast('已重新发送', 'success');
        ctx.close();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  async function loadMessages() {
    if (!activeConvId) return;
    const box = $('#chatScroll');
    if (!box) return;
    box.innerHTML = '<div class="loading-block"><span class="spinner"></span></div>';
    try {
      const list = await api.get(`/api/conversations/${activeConvId}/messages`);
      box.innerHTML = '';
      let lastDay = '';
      for (const m of list) {
        const day = String(m.created_at).slice(0, 10);
        if (day !== lastDay) { lastDay = day; box.appendChild(el('div', { class: 'chat-body__daydiv', html: `<span>${fmt.date(m.created_at)}</span>` })); }
        appendMessage(m, false);
        if (m.id > lastMessageId) lastMessageId = m.id;
      }
      scrollChat();
    } catch (err) {
      box.innerHTML = emptyState('😥', '消息加载失败', err.message);
    }
  }

  function appendMessage(m, animate) {
    const box = $('#chatScroll');
    if (!box) return;
    const isMine = m.sender_role === 'agent';
    const node = el('div', { class: `msg${isMine ? ' msg--mine' : ''}${m.sender_role === 'system' ? ' msg--system' : ''}` });

    if (m.sender_role === 'system') {
      node.innerHTML = `<div class="msg__bubble">${escapeHtml(m.content)}</div>`;
    } else {
      const colorIdx = (String(m.sender_name || '客').charCodeAt(0) % 5) + 1;
      let contentHtml;
      if (m.type === 'image') {
        contentHtml = `<img class="msg__img" src="${escapeHtml(m.content)}" alt="图片" loading="lazy">`;
      } else if (m.type === 'file') {
        const meta = safeJSON(m.meta);
        contentHtml = `<a class="msg__file" href="${escapeHtml(m.content)}" target="_blank" download="${escapeHtml(meta.name || '')}">
          <span style="font-size:18px">📎</span><div class="flex-1"><div class="fw-500">${escapeHtml(meta.name || '附件')}</div>
          <div class="text-xs text-muted">${fmt.bytes(meta.size || 0)}</div></div><span>⬇</span></a>`;
      } else {
        contentHtml = markdown(m.content);
      }
      node.innerHTML = `
        <span class="avatar avatar--sm avatar--c${colorIdx}">${escapeHtml(String(m.sender_name || '客').charAt(0))}</span>
        <div class="msg__main">
          <div class="msg__meta"><span>${escapeHtml(isMine ? '我' : (m.sender_name || '客户'))}</span><span>${fmt.clock(m.created_at)}</span></div>
          <div class="msg__bubble">${contentHtml}</div>
        </div>`;
    }
    box.appendChild(node);
    const img = node.querySelector('.msg__img');
    if (img) img.addEventListener('click', () => modal({ title: '图片预览', size: 'lg', body: `<img src="${img.src}" style="width:100%;border-radius:10px">` }));
    void animate;
  }

  function safeJSON(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

  function scrollChat() {
    const box = $('#chatScroll');
    if (box) box.scrollTop = box.scrollHeight;
  }

  async function sendReply(text) {
    const input = $('#replyInput');
    const content = (text !== undefined ? text : input.value).trim();
    if (!content) return;
    if (!activeConvId) return;
    if (activeConv && activeConv.status === 'closed') return toast('会话已结束，无法发送消息', 'warning');
    if (text === undefined) { input.value = ''; input.style.height = '42px'; }
    $('#kbSuggest').innerHTML = '';
    try {
      const msg = await api.post(`/api/conversations/${activeConvId}/messages`, { content, type: 'text' });
      if (msg && msg.id > lastMessageId) { lastMessageId = msg.id; appendMessage(msg, true); scrollChat(); }
      if (!activeConv.agent_id) {
        activeConv.agent_id = auth.user.id;
        activeConv.agent_name = auth.user.name;
        activeConv.status = 'active';
        renderChatHead();
      }
      loadConversations(true);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function uploadAndSend(file) {
    if (file.size > 10 * 1024 * 1024) return toast('文件不能超过 10MB', 'warning');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const up = await api.upload('/api/conversations/upload', fd);
      const msg = await api.post(`/api/conversations/${activeConvId}/messages`, {
        content: up.url, type: up.type, meta: { name: up.name, size: up.size, mime: up.mime },
      });
      if (msg && msg.id > lastMessageId) { lastMessageId = msg.id; appendMessage(msg, true); scrollChat(); }
    } catch (err) { toast(err.message, 'error'); }
  }

  const suggestKb = debounce(async (q) => {
    const box = $('#kbSuggest');
    if (!box) return;
    if (!q || q.trim().length < 2) { box.innerHTML = ''; return; }
    try {
      const list = await api.get(`/api/kb/suggest${Kefu.qs({ q })}`);
      if (!list.length) { box.innerHTML = ''; return; }
      box.innerHTML = `<div class="kb-suggest">
        <div class="text-xs fw-600 mb-8" style="color:#92400e">📚 知识库匹配到 ${list.length} 篇相关文章（点击引用）</div>
        ${list.map((a) => `<div class="kb-suggest__item" data-kb="${a.id}">
          <span>📄</span><span class="flex-1"><strong>${escapeHtml(a.title)}</strong>
          <span class="text-xs">${escapeHtml(String(a.summary || '').slice(0, 46))}</span></span></div>`).join('')}
      </div>`;
      box.onclick = async (e) => {
        const item = e.target.closest('[data-kb]');
        if (!item) return;
        const { article } = await api.get(`/api/kb/articles/${item.dataset.kb}`);
        await sendReply(`${article.title}\n\n${article.content}`);
        box.innerHTML = '';
      };
    } catch { /* ignore */ }
  }, 420);

  function openQuickPanel() {
    const foot = $('.chat-foot-ws');
    if (!foot) return;
    const existing = $('#quickPanel');
    if (existing) { existing.remove(); return; }
    const panel = el('div', { class: 'quick-panel', id: 'quickPanel' });

    // 兜底归一化：任何情况下都按数组处理，避免运行时报「不是函数」
    const list = Array.isArray(quickReplies) ? quickReplies : [];

    if (!list.length) {
      panel.innerHTML = '<div class="text-sm text-muted" style="padding:16px">暂无快捷话术，可在「快捷话术」页面新增</div>';
    } else {
      const favs = list.filter((q) => Number(q.is_favorite) === 1);
      const rest = list.filter((q) => Number(q.is_favorite) !== 1);
      const groups = {};
      for (const q of rest) (groups[q.category] = groups[q.category] || []).push(q);

      // 单条话术的渲染（★ 用于切换常用，点击正文插入输入框）
      const item = (q, showStar = true) => `
        <div class="quick-panel__item" data-quick="${q.id}">
          <div class="quick-panel__title">
            ${q.is_favorite ? '<span style="color:#f59e0b">★</span>' : ''}
            ${escapeHtml(q.title)}
            <span class="text-xs text-muted">用过 ${q.use_count} 次</span>
            ${showStar ? `<button class="quick-star" data-fav="${q.id}" title="${q.is_favorite ? '取消常用' : '设为常用'}"
              style="margin-left:auto;font-size:15px;line-height:1;color:${q.is_favorite ? '#f59e0b' : '#cbd5e1'};padding:2px 5px">${q.is_favorite ? '★' : '☆'}</button>` : ''}
          </div>
          <div class="quick-panel__content">${escapeHtml(q.content)}</div>
        </div>`;

      panel.innerHTML = `
        ${favs.length ? `<div style="padding:8px 14px;background:var(--warning-soft,#fffbeb);font-size:11.5px;color:#b45309;font-weight:600">
          ★ 常用话术（${favs.length}）</div>${favs.map((q) => item(q)).join('')}` : ''}
        ${Object.entries(groups).map(([cat, items]) => `
          <div style="padding:8px 14px;background:var(--surface-2);font-size:11.5px;color:var(--text-3);font-weight:600">${escapeHtml(cat)}</div>
          ${items.map((q) => item(q)).join('')}`).join('')}`;

      panel.onclick = async (e) => {
        // 点击星标：切换常用（不插入文本）
        const star = e.target.closest('[data-fav]');
        if (star) {
          e.stopPropagation();
          const id = Number(star.dataset.fav);
          const q = list.find((x) => x.id === id);
          try {
            const updated = await api.post(`/api/conversations/quick-replies/${id}/favorite`, {});
            q.is_favorite = updated.is_favorite;
            toast(updated.is_favorite ? '已加入常用话术' : '已取消常用', 'success', 1800);
            panel.remove();
            openQuickPanel();
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        // 点击话术本体：填入输入框
        const node = e.target.closest('[data-quick]');
        if (!node) return;
        const q = list.find((x) => String(x.id) === node.dataset.quick);
        if (!q) return;
        const input = $('#replyInput');
        input.value = q.content.replace('{code}', activeConv ? activeConv.code : '');
        input.focus();
        panel.remove();
        api.post(`/api/conversations/quick-replies/${q.id}/use`, {}).catch(() => {});
      };
    }

    foot.appendChild(panel);
    setTimeout(() => {
      const close = (e) => {
        if (!panel.contains(e.target)) { panel.remove(); document.removeEventListener('mousedown', close); }
      };
      document.addEventListener('mousedown', close);
    }, 0);
  }

  async function openTransfer() {
    const ctx = modal({ title: '转接会话', body: '<div class="loading-block"><span class="spinner spinner--lg"></span></div>' });
    try {
      const agents = await api.get('/api/conversations/agents/online');
      const others = agents.filter((a) => a.id !== auth.user.id);
      ctx.body.innerHTML = `
        <div class="text-sm text-muted mb-14">选择要转接的客服，转接后客户会收到通知</div>
        ${others.length ? others.map((a) => `
          <div class="ticket-mini flex items-center gap-10" data-agent="${a.id}" style="${a.status !== 'online' ? 'opacity:.6' : ''}">
            ${avatar(a.name, 'sm')}
            <div class="flex-1">
              <div class="fw-500 flex items-center gap-6">${escapeHtml(a.name)} ${Kefu.statusDot(a.status)}
                <span class="text-xs text-muted">${Kefu.STATUS_TEXT[a.status] || a.status}</span></div>
              <div class="text-xs text-muted">${escapeHtml(a.department_name || '')} · ${a.level || ''} · 接待中 ${a.load}/${a.max_concurrent} · ${(a.skills || []).join('、')}</div>
            </div>
            ${a.status === 'online' && a.load < a.max_concurrent ? '<span class="badge badge--success">可接入</span>' : '<span class="badge">繁忙</span>'}
          </div>`).join('') : emptyState('👤', '暂无其他客服')}`;

      ctx.body.onclick = async (e) => {
        const item = e.target.closest('[data-agent]');
        if (!item) return;
        try {
          await api.post(`/api/conversations/${activeConvId}/assign`, { agentId: Number(item.dataset.agent) });
          toast('转接成功', 'success');
          ctx.close();
          await openConversation(activeConvId);
        } catch (err) { toast(err.message, 'error'); }
      };
    } catch (err) { ctx.body.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  function openKbSearch() {
    const ctx = modal({ title: '知识库检索', size: 'lg', body: `
      <div class="search-box mb-14"><input class="input" id="kbq" placeholder="输入关键词检索文章…"></div>
      <div id="kbResults"><div class="text-sm text-muted">输入关键词开始检索，点击文章可直接发送给客户</div></div>` });
    const search = debounce(async (q) => {
      const box = $('#kbResults', ctx.body);
      if (!q) { box.innerHTML = '<div class="text-sm text-muted">输入关键词开始检索</div>'; return; }
      loading(box, '检索中…');
      try {
        const res = await api.get(`/api/kb/articles${Kefu.qs({ keyword: q, pageSize: 15 })}`);
        if (!res.list.length) { box.innerHTML = emptyState('🔍', '未找到相关文章'); return; }
        box.innerHTML = res.list.map((a) => `
          <div class="ticket-mini" data-kb="${a.id}">
            <div class="fw-500 flex items-center gap-8">${escapeHtml(a.title)}
              ${a.visibility === 'internal' ? '<span class="badge badge--warning">内部</span>' : ''}</div>
            <div class="text-xs text-muted mt-4">${escapeHtml(a.category_name || '')} · ${fmt.number(a.views)} 次浏览</div>
            <div class="text-sm text-2 mt-4 clamp-2">${escapeHtml(a.summary || '')}</div>
          </div>`).join('');
        box.onclick = async (e) => {
          const item = e.target.closest('[data-kb]');
          if (!item) return;
          const { article } = await api.get(`/api/kb/articles/${item.dataset.kb}`);
          if (await confirm({ title: '发送文章给客户', message: `确定把《${article.title}》的完整内容发送给客户吗？`, confirmText: '发送' })) {
            await sendReply(article.title + '\n\n' + article.content);
            ctx.close();
          }
        };
      } catch (err) { box.innerHTML = emptyState('😥', '检索失败', err.message); }
    }, 350);
    $('#kbq', ctx.body).addEventListener('input', (e) => search(e.target.value.trim()));
  }

  async function createTicketFromConv() {
    const data = await formModal({
      title: '转为工单',
      submitText: '创建工单',
      fields: [
        { name: 'title', label: '工单标题', required: true, value: activeConv ? (activeConv.tag ? `【${activeConv.tag}】` : '') + (activeConv.subject || `客户 ${activeConv.customer_name} 的问题`) : '' },
        { name: 'category', label: '问题类型', type: 'select', value: activeConv?.tag || '技术支持',
          options: ['产品咨询', '技术支持', '账务问题', '投诉建议', '功能申请', '其他'].map((c) => ({ value: c, label: c })) },
        { name: 'priority', label: '优先级', type: 'select', value: 'normal',
          options: [{ value: 'low', label: '低' }, { value: 'normal', label: '中' }, { value: 'high', label: '高' }, { value: 'urgent', label: '紧急' }] },
        { name: 'description', label: '问题描述', type: 'textarea', required: true, rows: 4, placeholder: '请描述客户反馈的问题与已沟通情况' },
      ],
    });
    if (!data) return;
    try {
      const t = await api.post('/api/tickets', { ...data, creator_id: activeConv?.customer_id, conversation_id: activeConvId });
      toast(`工单 ${t.code} 已创建`, 'success');
      await sendReply(`已为您创建工单（${t.code}），我们会有专人跟进处理，请留意进度通知。`);
      loadBadges();
    } catch (err) { toast(err.message, 'error'); }
  }

  function renderRightPanel(detail) {
    const { conversation: conv, customerStats, history } = detail;
    api.get(`/api/tickets${Kefu.qs({ keyword: conv.customer_name, pageSize: 5 })}`).catch(() => null);

    $('#wsRight').innerHTML = `
      <div class="side-section">
        <div class="side-section__head" data-collapse>👤 客户资料 <span class="side-section__arrow">▼</span></div>
        <div class="side-section__body">
          <div class="flex items-center gap-10 mb-14">
            ${avatar(conv.customer_name, 'lg')}
            <div class="flex-1" style="min-width:0">
              <div class="fw-600">${escapeHtml(conv.customer_name)}</div>
              <div class="text-xs text-muted ellipsis">@${escapeHtml(conv.customer_username)}</div>
            </div>
          </div>
          <div class="info-row"><span class="info-row__label">手机号</span><span class="info-row__value">${escapeHtml(conv.customer_phone || '未填写')}</span></div>
          <div class="info-row"><span class="info-row__label">邮箱</span><span class="info-row__value">${escapeHtml(conv.customer_email || '未填写')}</span></div>
          <div class="info-row"><span class="info-row__label">首次咨询</span><span class="info-row__value">${fmt.date(customerStats.firstSeen)}</span></div>
          <div class="divider"></div>
          <div class="grid-2" style="gap:10px">
            <div><div class="text-xs text-muted">历史会话</div><div class="fw-600 text-lg">${customerStats.totalConversations}</div></div>
            <div><div class="text-xs text-muted">历史工单</div><div class="fw-600 text-lg">${customerStats.totalTickets}</div></div>
            <div><div class="text-xs text-muted">未完成工单</div><div class="fw-600 text-lg ${customerStats.openTickets ? 'text-warning' : ''}">${customerStats.openTickets}</div></div>
            <div><div class="text-xs text-muted">会话评分</div><div class="fw-600 text-lg">${conv.rating ? `${conv.rating} 星` : '-'}</div></div>
          </div>
        </div>
      </div>

      <div class="side-section">
        <div class="side-section__head" data-collapse>🏷️ 会话标签与优先级 <span class="side-section__arrow">▼</span></div>
        <div class="side-section__body">
          <div class="field">
            <label class="field__label">业务标签</label>
            <select class="select" id="convTag">
              ${['', '产品咨询', '技术支持', '账务问题', '投诉建议', '功能申请', '退换货'].map((t) => `<option value="${t}" ${conv.tag === t ? 'selected' : ''}>${t || '未设置'}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field__label">优先级</label>
            <select class="select" id="convPriority">
              ${[['low', '低'], ['normal', '中'], ['high', '高'], ['urgent', '紧急']].map(([v, l]) => `<option value="${v}" ${conv.priority === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <button class="btn btn--primary btn--block btn--sm" id="btnSaveMeta">保存设置</button>
        </div>
      </div>

      <div class="side-section">
        <div class="side-section__head" data-collapse>📜 历史会话 <span class="side-section__arrow">▼</span></div>
        <div class="side-section__body">
          ${history.length ? history.map((h) => `
            <div class="ticket-mini" data-histconv="${h.id}">
              <div class="flex items-center gap-8">
                <span class="text-sm flex-1 ellipsis">${escapeHtml(h.subject || h.code)}</span>
                ${statusBadge(h.status)}
              </div>
              <div class="text-xs text-muted mt-4">${escapeHtml(h.code)} · ${fmt.date(h.created_at)} ${h.rating ? `· ${h.rating} 星` : ''}</div>
            </div>`).join('') : '<div class="text-sm text-muted">暂无历史会话</div>'}
        </div>
      </div>

      <div class="side-section">
        <div class="side-section__head" data-collapse>🎫 客户工单 <span class="side-section__arrow">▼</span></div>
        <div class="side-section__body" id="custTickets">
          <div class="loading-block" style="padding:16px"><span class="spinner"></span></div>
        </div>
      </div>

      <div class="side-section">
        <div class="side-section__head" data-collapse>⚡ 常用话术 <span class="side-section__arrow">▼</span></div>
        <div class="side-section__body" id="sideQuick"></div>
      </div>`;

    $('#btnSaveMeta').onclick = async () => {
      try {
        const updated = await api.put(`/api/conversations/${activeConvId}`, {
          tag: $('#convTag').value, priority: $('#convPriority').value,
        });
        activeConv = { ...activeConv, ...updated };
        renderChatHead();
        toast('会话设置已保存', 'success');
        loadConversations(true);
      } catch (err) { toast(err.message, 'error'); }
    };

    $$('[data-histconv]').forEach((n) => n.addEventListener('click', () => openConversation(Number(n.dataset.histconv))));

    // 客户工单
    api.get(`/api/tickets${Kefu.qs({ keyword: conv.customer_username, pageSize: 5 })}`).then((res) => {
      const box = $('#custTickets');
      if (!box) return;
      const mine = (res.list || []).filter((t) => t.creator_name === conv.customer_name);
      box.innerHTML = mine.length ? mine.map((t) => `
        <div class="ticket-mini" data-ticket="${t.id}">
          <div class="flex items-center gap-8">
            <span class="text-sm flex-1 ellipsis fw-500">${escapeHtml(t.title)}</span>
            ${statusBadge(t.status)}
          </div>
          <div class="text-xs text-muted mt-4">${escapeHtml(t.code)} · ${escapeHtml(t.category)}</div>
        </div>`).join('') : '<div class="text-sm text-muted">暂无工单记录</div>';
      box.onclick = (e) => {
        const item = e.target.closest('[data-ticket]');
        if (item) { location.hash = `#/tickets?id=${item.dataset.ticket}`; }
      };
    }).catch(() => {});

    // 侧边话术：常用优先（对 quickReplies 形态做兜底，避免非数组时报错）
    const sideQuick = $('#sideQuick');
    const allQuick = Array.isArray(quickReplies) ? quickReplies : [];
    const sideList = allQuick
      .slice()
      .sort((a, b) => (Number(b.is_favorite) - Number(a.is_favorite)) || (Number(b.use_count) - Number(a.use_count)))
      .slice(0, 6);
    sideQuick.innerHTML = sideList.map((q) => `
      <div class="ticket-mini" style="display:flex;align-items:flex-start;gap:8px">
        <div class="flex-1" data-sidequick="${q.id}" style="cursor:pointer;min-width:0">
          <div class="text-sm fw-500">${q.is_favorite ? '<span style="color:#f59e0b">★</span> ' : ''}${escapeHtml(q.title)}</div>
          <div class="text-xs text-muted mt-4 ellipsis">${escapeHtml(q.content)}</div>
        </div>
        <button data-sidefav="${q.id}" title="${q.is_favorite ? '取消常用' : '设为常用'}"
          style="font-size:15px;line-height:1;color:${q.is_favorite ? '#f59e0b' : '#cbd5e1'};padding:2px 4px">${q.is_favorite ? '★' : '☆'}</button>
      </div>`).join('') || '<div class="text-sm text-muted">暂无话术</div>';
    sideQuick.onclick = async (e) => {
      const fav = e.target.closest('[data-sidefav]');
      if (fav) {
        try {
          const updated = await api.post(`/api/conversations/quick-replies/${fav.dataset.sidefav}/favorite`, {});
          const q = allQuick.find((x) => String(x.id) === fav.dataset.sidefav);
          if (q) q.is_favorite = updated.is_favorite;
          toast(updated.is_favorite ? '已加入常用话术' : '已取消常用', 'success', 1800);
          renderRightPanel(await api.get(`/api/conversations/${activeConvId}`));
        } catch (err) { toast(err.message, 'error'); }
        return;
      }
      const item = e.target.closest('[data-sidequick]');
      if (!item) return;
      const q = allQuick.find((x) => String(x.id) === item.dataset.sidequick);
      if (q) {
        const input = $('#replyInput');
        if (input) { input.value = q.content.replace('{code}', activeConv?.code || ''); input.focus(); }
      }
    };
  }

  /* ============================== 工单 ============================== */

  function viewTickets(query) {
    if (query.id) return viewTicketDetail(query.id);
    $('#view').innerHTML = `
      <div class="page">
        <div class="stat-grid mb-20" id="tkStats"></div>
        <div class="card">
          <div class="card__head">
            <div class="segmented" id="tkScope">
              <button class="segmented__item is-active" data-scope="mine">我负责的</button>
              <button class="segmented__item" data-scope="unassigned">待认领</button>
              <button class="segmented__item" data-scope="">全部工单</button>
            </div>
            <div class="card__actions">
              <div class="search-box" style="width:210px"><input class="input" id="tkSearch" placeholder="搜索工单号 / 标题…"></div>
              <select class="select" id="tkStatus" style="width:120px">
                <option value="">全部状态</option>
                <option value="pending">待处理</option>
                <option value="processing">处理中</option>
                <option value="resolved">已解决</option>
                <option value="closed">已关闭</option>
              </select>
              <select class="select" id="tkPriority" style="width:110px">
                <option value="">全部优先级</option>
                <option value="urgent">紧急</option><option value="high">高</option>
                <option value="normal">中</option><option value="low">低</option>
              </select>
            </div>
          </div>
          <div class="card__body card__body--flush" id="tkList"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>
        </div>
      </div>`;

    let scope = 'mine';
    $('#tkScope').onclick = (e) => {
      const b = e.target.closest('[data-scope]');
      if (!b) return;
      scope = b.dataset.scope;
      $$('.segmented__item', $('#tkScope')).forEach((x) => x.classList.toggle('is-active', x === b));
      loadTickets(1, scope);
    };
    $('#tkSearch').addEventListener('input', debounce(() => loadTickets(1, scope), 320));
    $('#tkStatus').onchange = () => loadTickets(1, scope);
    $('#tkPriority').onchange = () => loadTickets(1, scope);

    loadTicketStats();
    loadTickets(1, scope);
    ticketPollTimer = setInterval(() => { loadTicketStats(); }, 45000);
  }

  async function loadTicketStats() {
    try {
      const s = await api.get('/api/tickets/stats');
      const box = $('#tkStats');
      if (!box) return;
      box.innerHTML = `
        ${miniStat('🎫', '我负责的', s.mine, '')}
        ${miniStat('🆕', '待认领', s.unassigned, s.unassigned ? 'stat--warning' : '')}
        ${miniStat('🔧', '处理中', s.processing, 'stat--info')}
        ${miniStat('⏰', '已超时', s.overdue, s.overdue ? 'stat--danger' : '')}
        ${miniStat('✅', '已解决', s.resolved, 'stat--success')}
        ${miniStat('⭐', '平均评分', s.avgRating || '-', '')}`;
    } catch { /* ignore */ }
  }

  function miniStat(icon, label, value, cls) {
    return `<div class="stat ${cls}"><div class="stat__icon">${icon}</div>
      <div class="stat__label">${label}</div><div class="stat__value">${value}</div></div>`;
  }

  async function loadTickets(page = 1, scope = 'mine') {
    const box = $('#tkList');
    if (!box) return;
    loading(box);
    try {
      const res = await api.get(`/api/tickets${Kefu.qs({
        page, pageSize: 15, scope,
        keyword: $('#tkSearch')?.value || '',
        status: $('#tkStatus')?.value || '',
        priority: $('#tkPriority')?.value || '',
      })}`);

      if (!res.list.length) { box.innerHTML = emptyState('🎫', '暂无工单'); return; }

      box.innerHTML = `
        <div class="table-wrap"><table class="table">
          <thead><tr>
            <th>工单</th><th>客户</th><th>分类</th><th>优先级</th><th>状态</th>
            <th>处理人</th><th>SLA</th><th style="text-align:right">操作</th>
          </tr></thead>
          <tbody>${res.list.map((t) => `
            <tr data-ticket="${t.id}">
              <td><div class="cell-main ellipsis" style="max-width:230px">${escapeHtml(t.title)}</div>
                  <div class="cell-sub text-mono">${escapeHtml(t.code)}</div></td>
              <td>${escapeHtml(t.creator_name)}<div class="cell-sub">${escapeHtml(t.creator_phone || '')}</div></td>
              <td><span class="badge">${escapeHtml(t.category)}</span></td>
              <td>${statusBadge(t.priority, Kefu.STATUS_TEXT[t.priority])}</td>
              <td>${statusBadge(t.status)}</td>
              <td>${t.assignee_name ? escapeHtml(t.assignee_name) : '<span class="text-muted">待指派</span>'}</td>
              <td>${t.status === 'closed' || t.status === 'resolved' ? '<span class="text-muted">已完成</span>'
                : `<span class="${t.is_overdue ? 'text-danger fw-600' : 'text-muted'} text-xs">${fmt.countdown(t.sla_due_at)}</span>`}</td>
              <td><div class="table__actions">
                ${t.assignee_id === auth.user.id || auth.is('admin') ? '' : `<button class="btn btn--sm btn--primary" data-claim="${t.id}">认领</button>`}
                <button class="btn btn--sm" data-view="${t.id}">详情</button>
              </div></td>
            </tr>`).join('')}</tbody>
        </table></div>
        ${paginationHtml(res.pagination)}`;

      box.onclick = async (e) => {
        const claim = e.target.closest('[data-claim]');
        if (claim) {
          e.stopPropagation();
          try {
            await api.put(`/api/tickets/${claim.dataset.claim}`, { assignee_id: auth.user.id, status: 'processing' });
            toast('已认领该工单', 'success');
            loadTickets(page, scope); loadTicketStats(); loadBadges();
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        const view = e.target.closest('[data-view]');
        const row = e.target.closest('[data-ticket]');
        if (view || row) location.hash = `#/tickets?id=${(view || row).dataset.view || (view || row).dataset.ticket}`;
      };
      bindPagination(box, (p) => loadTickets(p, scope));
    } catch (err) {
      box.innerHTML = emptyState('😥', '加载失败', err.message);
    }
  }

  async function viewTicketDetail(id) {
    $('#view').innerHTML = '<div class="page"><div class="loading-block"><span class="spinner spinner--lg"></span><span>加载工单详情…</span></div></div>';
    try {
      const [{ ticket, comments }, meta, agents] = await Promise.all([
        api.get(`/api/tickets/${id}`),
        api.get('/api/tickets/meta'),
        api.get('/api/conversations/agents/online'),
      ]);

      $('#view').innerHTML = `
        <div class="page">
          <button class="btn btn--sm mb-14" data-action="go-tickets">‹ 返回工单列表</button>
          <div style="display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start">
            <div>
              <div class="card mb-20">
                <div class="card__head">
                  <div class="flex-1">
                    <div class="card__title">${escapeHtml(ticket.title)}</div>
                    <div class="card__sub">${escapeHtml(ticket.code)} · ${escapeHtml(ticket.category)} · 提交于 ${fmt.datetime(ticket.created_at)}</div>
                  </div>
                  ${ticket.is_overdue ? '' : ''}
                  ${statusBadge(ticket.status)}
                  ${statusBadge(ticket.priority, Kefu.STATUS_TEXT[ticket.priority])}
                </div>
                <div class="card__body">
                  <div class="text-2" style="white-space:pre-wrap;line-height:1.8">${escapeHtml(ticket.description || '无详细描述')}</div>
                </div>
              </div>

              <div class="card">
                <div class="card__head"><span class="card__title">处理记录（${comments.length}）</span></div>
                <div class="card__body" style="max-height:420px;overflow-y:auto">
                  ${comments.length ? comments.map((c) => `
                    <div class="flex gap-10 mb-14">
                      ${avatar(c.user_name || '系统', 'sm')}
                      <div class="flex-1">
                        <div class="text-xs text-muted mb-4">
                          <strong>${escapeHtml(c.user_name || '系统')}</strong> · ${fmt.datetime(c.created_at)}
                          ${c.action !== 'comment' ? `<span class="badge badge--info" style="height:17px;font-size:10.5px">${escapeHtml(c.action)}</span>` : ''}
                          ${c.internal ? '<span class="badge badge--warning" style="height:17px;font-size:10.5px">内部备注</span>' : ''}
                        </div>
                        <div class="${c.internal ? 'text-muted' : 'text-2'}" style="white-space:pre-wrap;line-height:1.7;font-size:13.5px">${escapeHtml(c.content)}</div>
                      </div>
                    </div>`).join('') : '<div class="text-sm text-muted">暂无处理记录</div>'}
                </div>
                <div class="card__body" style="border-top:1px solid var(--border)">
                  <textarea class="textarea" id="tkReply" placeholder="输入处理说明或回复客户…" rows="3"></textarea>
                  <div class="flex items-center gap-10 mt-8">
                    <label class="checkbox"><input type="checkbox" id="tkInternal"><span class="text-sm">仅内部可见</span></label>
                    <button class="btn btn--primary ml-auto" id="btnTkReply">发送回复</button>
                  </div>
                </div>
              </div>
            </div>

            <aside>
              <div class="card mb-14">
                <div class="card__head"><span class="card__title">工单操作</span></div>
                <div class="card__body">
                  <div class="field"><label class="field__label">状态</label>
                    <select class="select" id="tkSetStatus">
                      ${Object.entries(Kefu.STATUS_TEXT).filter(([k]) => ['pending', 'processing', 'resolved', 'closed', 'reopened'].includes(k))
                        .map(([k, v]) => `<option value="${k}" ${ticket.status === k ? 'selected' : ''}>${v}</option>`).join('')}
                    </select></div>
                  <div class="field"><label class="field__label">优先级</label>
                    <select class="select" id="tkSetPriority">
                      ${[['low', '低'], ['normal', '中'], ['high', '高'], ['urgent', '紧急']].map(([v, l]) => `<option value="${v}" ${ticket.priority === v ? 'selected' : ''}>${l}</option>`).join('')}
                    </select></div>
                  <div class="field"><label class="field__label">处理人</label>
                    <select class="select" id="tkSetAssignee">
                      <option value="">未指派</option>
                      ${agents.map((a) => `<option value="${a.id}" ${ticket.assignee_id === a.id ? 'selected' : ''}>${escapeHtml(a.name)}（${Kefu.STATUS_TEXT[a.status] || a.status}）</option>`).join('')}
                    </select></div>
                  <div class="field"><label class="field__label">分类</label>
                    <select class="select" id="tkSetCategory">
                      ${meta.categories.map((c) => `<option value="${c}" ${ticket.category === c ? 'selected' : ''}>${c}</option>`).join('')}
                    </select></div>
                  <button class="btn btn--primary btn--block" id="btnSaveTicket">保存修改</button>
                </div>
              </div>

              <div class="card">
                <div class="card__head"><span class="card__title">客户信息</span></div>
                <div class="card__body">
                  <div class="info-row"><span class="info-row__label">姓名</span><span class="info-row__value">${escapeHtml(ticket.creator_name)}</span></div>
                  <div class="info-row"><span class="info-row__label">账号</span><span class="info-row__value">@${escapeHtml(ticket.creator_username || '-')}</span></div>
                  <div class="info-row"><span class="info-row__label">手机</span><span class="info-row__value">${escapeHtml(ticket.creator_phone || '-')}</span></div>
                  <div class="info-row"><span class="info-row__label">邮箱</span><span class="info-row__value">${escapeHtml(ticket.creator_email || '-')}</span></div>
                  <div class="divider"></div>
                  <div class="info-row"><span class="info-row__label">SLA</span>
                    <span class="info-row__value ${new Date(ticket.sla_due_at) < new Date() && !['closed', 'resolved'].includes(ticket.status) ? 'text-danger fw-600' : ''}">
                      ${fmt.datetime(ticket.sla_due_at)}<br><span class="text-xs">${fmt.countdown(ticket.sla_due_at)}</span></span></div>
                  <div class="info-row"><span class="info-row__label">解决时间</span><span class="info-row__value">${ticket.resolved_at ? fmt.datetime(ticket.resolved_at) : '-'}</span></div>
                  ${ticket.rating ? `<div class="info-row"><span class="info-row__label">客户评价</span><span class="info-row__value">${Kefu.stars(ticket.rating)} ${escapeHtml(ticket.rating_comment || '')}</span></div>` : ''}
                  ${ticket.conversation_id ? `<button class="btn btn--sm btn--block mt-8" id="btnGoConv">💬 查看关联会话</button>` : ''}
                </div>
              </div>
            </aside>
          </div>
        </div>`;

      $('#btnTkReply').onclick = async () => {
        const content = $('#tkReply').value.trim();
        if (!content) return toast('请输入回复内容', 'warning');
        try {
          await api.post(`/api/tickets/${id}/comments`, { content, internal: $('#tkInternal').checked ? 1 : 0 });
          toast('回复成功', 'success');
          viewTicketDetail(id);
        } catch (err) { toast(err.message, 'error'); }
      };

      $('#btnSaveTicket').onclick = async () => {
        try {
          await api.put(`/api/tickets/${id}`, {
            status: $('#tkSetStatus').value,
            priority: $('#tkSetPriority').value,
            assignee_id: $('#tkSetAssignee').value === '' ? null : Number($('#tkSetAssignee').value),
            category: $('#tkSetCategory').value,
          });
          toast('工单已更新', 'success');
          loadBadges();
          viewTicketDetail(id);
        } catch (err) { toast(err.message, 'error'); }
      };

      const goConv = $('#btnGoConv');
      if (goConv) goConv.onclick = () => { location.hash = `#/workspace?conv=${ticket.conversation_id}`; };
    } catch (err) {
      $('#view').innerHTML = `<div class="page">${emptyState('😥', '工单加载失败', err.message)}</div>`;
    }
  }

  /* ============================== 客户列表 ============================== */

  function viewCustomers(query) {
    $('#view').innerHTML = `
      <div class="page">
        <div class="card">
          <div class="card__head">
            <span class="card__title">客户档案</span>
            <div class="card__actions">
              <div class="search-box" style="width:240px"><input class="input" id="cuSearch" placeholder="搜索客户姓名 / 手机号 / 邮箱…"></div>
            </div>
          </div>
          <div class="card__body card__body--flush" id="cuList"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>
        </div>
      </div>`;
    $('#cuSearch').addEventListener('input', debounce(() => loadCustomers(1), 320));
    loadCustomers(1, query.id);
  }

  async function loadCustomers(page = 1) {
    const box = $('#cuList');
    if (!box) return;
    loading(box);
    try {
      const res = await api.get(`/api/admin/users${Kefu.qs({
        role: 'customer', page, pageSize: 15, keyword: $('#cuSearch')?.value || '',
      })}`);
      if (!res.list.length) { box.innerHTML = emptyState('👥', '暂无客户'); return; }
      box.innerHTML = `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>客户</th><th>联系方式</th><th>会话数</th><th>注册时间</th><th>最近登录</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>${res.list.map((u) => `
            <tr data-customer="${u.id}">
              <td><div class="flex items-center gap-10">${avatar(u.name, 'sm')}
                <div><div class="cell-main">${escapeHtml(u.name)}</div><div class="cell-sub">@${escapeHtml(u.username)}</div></div></div></td>
              <td>${escapeHtml(u.phone || '-')}<div class="cell-sub">${escapeHtml(u.email || '')}</div></td>
              <td class="num">${u.total_sessions}</td>
              <td class="text-sm text-muted">${fmt.date(u.created_at)}</td>
              <td class="text-sm text-muted">${u.last_login_at ? fmt.time(u.last_login_at) : '从未登录'}</td>
              <td><div class="table__actions"><button class="btn btn--sm" data-detail="${u.id}">查看详情</button></div></td>
            </tr>`).join('')}</tbody></table></div>
        ${paginationHtml(res.pagination)}`;
      box.onclick = (e) => {
        const b = e.target.closest('[data-detail]');
        const row = e.target.closest('[data-customer]');
        if (b || row) openCustomerDetail((b || row).dataset.detail || (b || row).dataset.customer);
      };
      bindPagination(box, (p) => loadCustomers(p));
    } catch (err) {
      box.innerHTML = emptyState('😥', '加载失败', err.message);
    }
  }

  async function openCustomerDetail(id) {
    const ctx = modal({ title: '客户详情', size: 'lg', body: '<div class="loading-block"><span class="spinner spinner--lg"></span></div>' });
    try {
      const [convs, tickets, stats] = await Promise.all([
        api.get(`/api/conversations${Kefu.qs({ pageSize: 8 })}`),
        api.get(`/api/tickets${Kefu.qs({ pageSize: 8 })}`),
        api.get('/api/dashboard/realtime'),
      ]);
      void stats;
      ctx.body.innerHTML = `
        <div class="flex items-center gap-14 mb-20">
          ${avatar('客', 'xl')}
          <div>
            <div class="text-lg fw-600">客户 #${id}</div>
            <div class="text-sm text-muted">共 ${convs.pagination.total} 次会话咨询 · ${tickets.pagination.total} 个工单</div>
          </div>
        </div>
        <div class="grid-2">
          <div>
            <div class="fw-600 mb-8">最近会话</div>
            ${convs.list.slice(0, 6).map((c) => `<div class="ticket-mini" data-c="${c.id}">
              <div class="flex items-center gap-8"><span class="text-sm flex-1 ellipsis">${escapeHtml(c.subject || c.code)}</span>${statusBadge(c.status)}</div>
              <div class="text-xs text-muted mt-4">${escapeHtml(c.code)} · ${fmt.datetime(c.created_at)}</div></div>`).join('') || '<div class="text-sm text-muted">暂无</div>'}
          </div>
          <div>
            <div class="fw-600 mb-8">最近工单</div>
            ${tickets.list.slice(0, 6).map((t) => `<div class="ticket-mini" data-t="${t.id}">
              <div class="flex items-center gap-8"><span class="text-sm flex-1 ellipsis">${escapeHtml(t.title)}</span>${statusBadge(t.status)}</div>
              <div class="text-xs text-muted mt-4">${escapeHtml(t.code)} · ${fmt.date(t.created_at)}</div></div>`).join('') || '<div class="text-sm text-muted">暂无</div>'}
          </div>
        </div>`;
      ctx.body.onclick = (e) => {
        const c = e.target.closest('[data-c]');
        const t = e.target.closest('[data-t]');
        if (c) { ctx.close(); location.hash = `#/workspace?conv=${c.dataset.c}`; }
        if (t) { ctx.close(); location.hash = `#/tickets?id=${t.dataset.t}`; }
      };
    } catch (err) { ctx.body.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  /* ============================== 知识库 ============================== */

  function viewKb() {
    $('#view').innerHTML = `
      <div class="page">
        <div class="stat-grid mb-20" id="kbStats"></div>
        <div class="card">
          <div class="card__head">
            <span class="card__title">文章列表</span>
            <div class="card__actions">
              <div class="search-box" style="width:230px"><input class="input" id="kbq" placeholder="搜索标题 / 内容…"></div>
              <select class="select" id="kbCat" style="width:150px"><option value="">全部分类</option></select>
              <button class="btn btn--primary btn--sm" id="btnNewArticle">＋ 新建文章</button>
            </div>
          </div>
          <div class="card__body card__body--flush" id="kbList"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>
        </div>
      </div>`;

    api.get('/api/kb/stats').then((s) => {
      $('#kbStats').innerHTML = `
        ${miniStat('📚', '文章总数', s.total, '')}
        ${miniStat('✅', '已发布', s.published, 'stat--success')}
        ${miniStat('✏️', '草稿', s.draft, 'stat--warning')}
        ${miniStat('🔒', '内部文章', s.internal, 'stat--info')}
        ${miniStat('👁️', '总浏览量', fmt.number(s.totalViews), '')}
        ${miniStat('👍', '有用反馈', fmt.number(s.totalHelpful), '')}`;
      const sel = $('#kbCat');
      for (const c of s.categoriesStat) sel.appendChild(el('option', { value: c.name, text: `${c.icon} ${c.name}（${c.count}）` }));
    }).catch(() => {});

    $('#kbq').addEventListener('input', debounce(() => loadKbArticles(1), 320));
    $('#kbCat').onchange = () => loadKbArticles(1);
    $('#btnNewArticle').onclick = () => openArticleEditor(null);
    loadKbArticles(1);
  }

  async function loadKbArticles(page = 1) {
    const box = $('#kbList');
    if (!box) return;
    loading(box);
    try {
      const res = await api.get(`/api/kb/articles${Kefu.qs({
        page, pageSize: 15, keyword: $('#kbq')?.value || '', category: $('#kbCat')?.value || '',
      })}`);
      if (!res.list.length) { box.innerHTML = emptyState('📚', '暂无文章'); return; }
      box.innerHTML = `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>标题</th><th>分类</th><th>可见性</th><th>状态</th><th class="num">浏览</th><th class="num">有用</th><th>更新</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>${res.list.map((a) => `
            <tr data-article="${a.id}">
              <td><div class="cell-main ellipsis" style="max-width:280px">${escapeHtml(a.title)}</div>
                  <div class="cell-sub clamp-2" style="max-width:280px">${escapeHtml(a.summary || '')}</div></td>
              <td><span class="badge">${a.category_icon || ''} ${escapeHtml(a.category_name || '未分类')}</span></td>
              <td>${a.visibility === 'internal' ? '<span class="badge badge--warning">内部</span>' : '<span class="badge badge--success">公开</span>'}</td>
              <td>${statusBadge(a.status)}</td>
              <td class="num">${fmt.number(a.views)}</td>
              <td class="num">${a.helpful}</td>
              <td class="text-sm text-muted">${fmt.date(a.updated_at)}</td>
              <td><div class="table__actions">
                <button class="btn btn--sm" data-send="${a.id}">发送</button>
                <button class="btn btn--sm" data-edit="${a.id}">编辑</button>
              </div></td>
            </tr>`).join('')}</tbody></table></div>
        ${paginationHtml(res.pagination)}`;

      box.onclick = async (e) => {
        const send = e.target.closest('[data-send]');
        if (send) {
          e.stopPropagation();
          if (!activeConvId) return toast('请先打开一个会话', 'warning');
          const { article } = await api.get(`/api/kb/articles/${send.dataset.send}`);
          if (await confirm({ title: '发送给客户', message: `确定把《${article.title}》发送到当前会话吗？`, confirmText: '发送' })) {
            await sendReply(article.title + '\n\n' + article.content);
            toast('已发送到当前会话', 'success');
          }
          return;
        }
        const edit = e.target.closest('[data-edit]');
        if (edit) { e.stopPropagation(); openArticleEditor(Number(edit.dataset.edit)); return; }
        const row = e.target.closest('[data-article]');
        if (row) openArticlePreview(Number(row.dataset.article));
      };
      bindPagination(box, (p) => loadKbArticles(p));
    } catch (err) {
      box.innerHTML = emptyState('😥', '加载失败', err.message);
    }
  }

  async function openArticlePreview(id) {
    const ctx = modal({ title: '文章预览', size: 'lg', body: '<div class="loading-block"><span class="spinner spinner--lg"></span></div>' });
    try {
      const { article } = await api.get(`/api/kb/articles/${id}`);
      ctx.body.innerHTML = `
        <h2 style="font-size:21px;font-weight:700;margin-bottom:8px">${escapeHtml(article.title)}</h2>
        <div class="text-sm text-muted mb-20">${escapeHtml(article.category_name || '')} · ${fmt.number(article.views)} 次浏览 · ${article.helpful} 人觉得有用</div>
        <div class="article-view__content">${markdown(article.content)}</div>`;
    } catch (err) { ctx.body.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  async function openArticleEditor(id) {
    let article = { title: '', summary: '', content: '', tags: [], status: 'published', visibility: 'public', category_id: null };
    if (id) {
      try { article = (await api.get(`/api/kb/articles/${id}`)).article; } catch (err) { return toast(err.message, 'error'); }
    }
    const cats = await api.get('/api/kb/categories').catch(() => []);

    const form = el('div');
    form.innerHTML = `
      <div class="form-row">
        <div class="field"><label class="field__label">标题<span class="req">*</span></label>
          <input class="input" id="aTitle" value="${escapeHtml(article.title)}" placeholder="文章标题"></div>
        <div class="field"><label class="field__label">分类</label>
          <select class="select" id="aCat">${cats.map((c) => `<option value="${c.id}" ${article.category_id === c.id ? 'selected' : ''}>${c.icon} ${escapeHtml(c.name)}</option>`).join('')}</select></div>
      </div>
      <div class="form-row">
        <div class="field"><label class="field__label">状态</label>
          <select class="select" id="aStatus">
            <option value="published" ${article.status === 'published' ? 'selected' : ''}>已发布</option>
            <option value="draft" ${article.status === 'draft' ? 'selected' : ''}>草稿</option>
            <option value="archived" ${article.status === 'archived' ? 'selected' : ''}>已归档</option>
          </select></div>
        <div class="field"><label class="field__label">可见范围</label>
          <select class="select" id="aVis">
            <option value="public" ${article.visibility === 'public' ? 'selected' : ''}>公开（客户可见）</option>
            <option value="internal" ${article.visibility === 'internal' ? 'selected' : ''}>内部（仅坐席可见）</option>
          </select></div>
      </div>
      <div class="field"><label class="field__label">摘要</label>
        <input class="input" id="aSummary" value="${escapeHtml(article.summary || '')}" placeholder="一句话摘要，展示在列表中"></div>
      <div class="field"><label class="field__label">正文<span class="req">*</span></label>
        <textarea class="textarea" id="aContent" rows="12" placeholder="支持 Markdown：## 标题、**粗体**、- 列表、\`代码\`、| 表格 |">${escapeHtml(article.content || '')}</textarea>
        <div class="field__hint">支持 Markdown 语法，前台会自动渲染</div></div>`;

    const ctx = modal({
      title: id ? '编辑文章' : '新建文章',
      size: 'xl',
      body: form,
      onMount(c) {
        c.foot = el('div', { class: 'modal__foot' });
        c.foot.appendChild(el('button', { class: 'btn', text: '取消', onClick: () => c.close() }));
        if (id && auth.is('admin')) {
          c.foot.appendChild(el('button', {
            class: 'btn btn--danger', text: '删除', onClick: async () => {
              if (!await confirm({ title: '删除文章', message: '删除后不可恢复，确定吗？', confirmText: '删除', danger: true })) return;
              try { await api.del(`/api/kb/articles/${id}`); toast('文章已删除', 'success'); c.close(); loadKbArticles(); } catch (err) { toast(err.message, 'error'); }
            },
          }));
        }
        c.foot.appendChild(el('button', {
          class: 'btn btn--primary', text: '保存', onClick: async () => {
            const payload = {
              title: $('#aTitle', form).value.trim(),
              category_id: Number($('#aCat', form).value) || null,
              status: $('#aStatus', form).value,
              visibility: $('#aVis', form).value,
              summary: $('#aSummary', form).value.trim(),
              content: $('#aContent', form).value,
            };
            if (!payload.title) return toast('请填写标题', 'warning');
            if (!payload.content.trim()) return toast('请填写正文', 'warning');
            try {
              if (id) await api.put(`/api/kb/articles/${id}`, payload);
              else await api.post('/api/kb/articles', payload);
              toast(id ? '文章已更新' : '文章已创建', 'success');
              c.close();
              loadKbArticles();
            } catch (err) { toast(err.message, 'error'); }
          },
        }));
        c.dialog.appendChild(c.foot);
      },
    });
  }

  /* ============================== 快捷话术 ============================== */

  function viewQuick() {
    $('#view').innerHTML = `
      <div class="page">
        <div class="card">
          <div class="card__head">
            <span class="card__title">快捷话术库</span>
            <div class="card__actions">
              <span class="text-xs text-muted">支持变量 <code class="kbd">{code}</code> 自动替换为会话编号</span>
              <button class="btn btn--primary btn--sm" id="btnNewQuick">＋ 新增话术</button>
            </div>
          </div>
          <div class="card__body card__body--flush" id="quickList"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>
        </div>
      </div>`;
    $('#btnNewQuick').onclick = () => openQuickEditor(null);
    loadQuickList();
  }

  async function loadQuickList() {
    const box = $('#quickList');
    try {
      const { list } = await api.get('/api/admin/quick-replies');
      if (!list.length) { box.innerHTML = emptyState('⚡', '暂无快捷话术'); return; }
      box.innerHTML = `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>标题</th><th>内容</th><th>分类</th><th>范围</th><th class="num">使用次数</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>${list.map((q) => `
            <tr>
              <td class="cell-main">${escapeHtml(q.title)}</td>
              <td class="text-sm text-2" style="max-width:340px"><div class="clamp-2">${escapeHtml(q.content)}</div></td>
              <td><span class="badge">${escapeHtml(q.category)}</span></td>
              <td>${q.scope === 'all' ? '<span class="badge badge--brand">公共</span>' : q.scope === 'department' ? '<span class="badge badge--info">部门</span>' : '<span class="badge">个人</span>'}</td>
              <td class="num">${q.use_count}</td>
              <td><div class="table__actions">
                <button class="btn btn--sm" data-copy="${q.id}">复制</button>
                <button class="btn btn--sm" data-edit="${q.id}">编辑</button>
                <button class="btn btn--sm btn--danger" data-del="${q.id}">删除</button>
              </div></td>
            </tr>`).join('')}</tbody></table></div>`;

      box.onclick = async (e) => {
        const copy = e.target.closest('[data-copy]');
        if (copy) {
          const q = list.find((x) => String(x.id) === copy.dataset.copy);
          navigator.clipboard?.writeText(q.content).then(() => toast('已复制到剪贴板', 'success'), () => toast('复制失败', 'error'));
          return;
        }
        const edit = e.target.closest('[data-edit]');
        if (edit) { openQuickEditor(list.find((x) => String(x.id) === edit.dataset.edit)); return; }
        const del = e.target.closest('[data-del]');
        if (del) {
          if (!await confirm({ title: '删除话术', message: '确定删除这条快捷话术吗？', confirmText: '删除', danger: true })) return;
          try { await api.del(`/api/admin/quick-replies/${del.dataset.del}`); toast('已删除', 'success'); loadQuickList(); loadQuickReplies(); } catch (err) { toast(err.message, 'error'); }
        }
      };
    } catch (err) { box.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  async function openQuickEditor(qr) {
    const data = await formModal({
      title: qr ? '编辑快捷话术' : '新增快捷话术',
      fields: [
        { name: 'title', label: '标题', required: true, value: qr?.title || '', placeholder: '例如：开场问候' },
        { name: 'category', label: '分类', type: 'select', value: qr?.category || '通用',
          options: ['开场', '沟通', '转接', '售后', '工单', '结束', '通用'].map((c) => ({ value: c, label: c })) },
        { name: 'content', label: '话术内容', type: 'textarea', required: true, rows: 5, value: qr?.content || '',
          placeholder: '支持变量 {code} 替换为会话编号' },
        ...(auth.is('admin') ? [{ name: 'scope', label: '使用范围', type: 'select', value: qr?.scope || 'all',
          options: [{ value: 'all', label: '全体坐席可用（公共）' }, { value: 'personal', label: '仅自己可用' }] }] : []),
      ],
    });
    if (!data) return;
    try {
      if (qr) await api.put(`/api/admin/quick-replies/${qr.id}`, data);
      else await api.post('/api/admin/quick-replies', data);
      toast('话术已保存', 'success');
      loadQuickList();
      loadQuickReplies();
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ============================== 我的绩效 ============================== */

  async function viewStats() {
    $('#view').innerHTML = '<div class="page"><div class="loading-block"><span class="spinner spinner--lg"></span><span>正在统计…</span></div></div>';
    try {
      const [perf, trend, dist, realtime] = await Promise.all([
        api.get('/api/dashboard/agent-performance?range=7d'),
        api.get('/api/dashboard/trend?range=7d'),
        api.get('/api/dashboard/distribution?range=7d'),
        api.get('/api/dashboard/realtime'),
      ]);

      const me = perf.find((p) => p.id === auth.user.id) || {};
      const rank = perf.findIndex((p) => p.id === auth.user.id) + 1;

      $('#view').innerHTML = `
        <div class="page">
          <div class="stat-grid mb-20">
            ${miniStat('💬', '周期接待会话', me.sessions || 0, '')}
            ${miniStat('✅', '已结束会话', me.closed || 0, 'stat--success')}
            ${miniStat('⭐', '平均评分', me.rating || '-', 'stat--warning')}
            ${miniStat('⚡', '平均首响', me.avgResponseSec ? `${me.avgResponseSec} 秒` : '-', 'stat--info')}
            ${miniStat('⏱️', '平均处理时长', me.avgHandleMin ? `${me.avgHandleMin} 分` : '-', '')}
            ${miniStat('🎫', '处理工单', `${me.ticketsResolved || 0}/${me.tickets || 0}`, '')}
            ${miniStat('🏆', '团队排名', rank ? `第 ${rank} 名` : '-', '')}
          </div>

          <div class="grid-2 mb-20">
            <div class="card">
              <div class="card__head"><span class="card__title">近 7 天会话趋势</span></div>
              <div class="card__body"><div class="chart-line" id="trendChart"></div></div>
            </div>
            <div class="card">
              <div class="card__head"><span class="card__title">咨询渠道分布</span></div>
              <div class="card__body"><div id="distChart"></div></div>
            </div>
          </div>

          <div class="card">
            <div class="card__head"><span class="card__title">团队坐席绩效对比</span>
              <div class="card__actions"><span class="text-xs text-muted">按近 7 天数据统计</span></div></div>
            <div class="card__body card__body--flush">
              <div class="table-wrap"><table class="table">
                <thead><tr><th>排名</th><th>坐席</th><th>部门</th><th>状态</th><th class="num">接待会话</th><th class="num">已结束</th>
                  <th class="num">评分</th><th class="num">平均首响</th><th class="num">平均处理</th><th class="num">工单</th></tr></thead>
                <tbody>${perf.map((p, i) => `
                  <tr style="${p.id === auth.user.id ? 'background:var(--brand-soft)' : ''}">
                    <td>${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td>
                    <td><div class="flex items-center gap-8">${avatar(p.name, 'sm')}<span class="fw-500">${escapeHtml(p.name)}</span>
                      ${p.id === auth.user.id ? '<span class="badge badge--brand">我</span>' : ''}</div></td>
                    <td class="text-sm text-muted">${escapeHtml(p.department_name || '-')}</td>
                    <td>${Kefu.statusDot(p.status)} <span class="text-sm">${Kefu.STATUS_TEXT[p.status] || p.status}</span></td>
                    <td class="num">${p.sessions}</td>
                    <td class="num">${p.closed}</td>
                    <td class="num">${p.rating ? `${p.rating} ★` : '-'}</td>
                    <td class="num">${p.avgResponseSec ? `${p.avgResponseSec}s` : '-'}</td>
                    <td class="num">${p.avgHandleMin ? `${p.avgHandleMin}min` : '-'}</td>
                    <td class="num">${p.ticketsResolved}/${p.tickets}</td>
                  </tr>`).join('')}</tbody></table></div>
            </div>
          </div>

          <div class="card mt-20">
            <div class="card__head"><span class="card__title">团队实时概览</span></div>
            <div class="card__body">
              <div class="bar-chart">
                <div class="bar-row"><div class="bar-row__label">排队中</div>
                  <div class="bar-track"><div class="bar-fill bar-fill--warning" style="width:${Math.min(100, realtime.queue * 20)}%"></div></div>
                  <div class="bar-row__value">${realtime.queue}</div></div>
                <div class="bar-row"><div class="bar-row__label">进行中会话</div>
                  <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, realtime.active * 10)}%"></div></div>
                  <div class="bar-row__value">${realtime.active}</div></div>
                <div class="bar-row"><div class="bar-row__label">在线坐席</div>
                  <div class="bar-track"><div class="bar-fill bar-fill--success" style="width:${Math.min(100, realtime.onlineAgents * 20)}%"></div></div>
                  <div class="bar-row__value">${realtime.onlineAgents}</div></div>
                <div class="bar-row"><div class="bar-row__label">今日会话</div>
                  <div class="bar-track"><div class="bar-fill bar-fill--purple" style="width:${Math.min(100, realtime.todaySessions * 5)}%"></div></div>
                  <div class="bar-row__value">${realtime.todaySessions}</div></div>
              </div>
            </div>
          </div>
        </div>`;

      Kefu.lineChart($('#trendChart'), [trend.map((d) => d.conversations), trend.map((d) => d.closed)],
        { labels: trend.map((d) => d.date), names: ['会话量', '已结束'], showLegend: true });
      Kefu.donutChart($('#distChart'), dist.channels, { centerLabel: '总会话' });
    } catch (err) {
      $('#view').innerHTML = `<div class="page">${emptyState('😥', '统计加载失败', err.message)}</div>`;
    }
  }

  /* ============================== 启动 ============================== */

  if (!auth.guard(['agent', 'admin'])) return;
  initShell();
  window.addEventListener('hashchange', route);
  route();
})();
