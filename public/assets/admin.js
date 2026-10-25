/* ==========================================================================
   管理后台
   ========================================================================== */
(function () {
  'use strict';
  const { api, auth, fmt, $, $$, el, escapeHtml, markdown, toast, modal, confirm, formModal,
    statusBadge, avatar, emptyState, loading, on, paginationHtml, bindPagination, debounce } = Kefu;

  const META = {
    '/dashboard': ['数据看板', '全局服务数据概览'],
    '/reports': ['统计分析', '多维度数据报表与导出'],
    '/conversations': ['会话记录', '查看全部历史会话明细'],
    '/tickets': ['工单中心', '工单全局管理与督办'],
    '/kb': ['知识库', '文章的增删改查与分类管理'],
    '/quick': ['快捷话术', '公共话术与部门话术管理'],
    '/agents': ['坐席管理', '账号、权限与接待配置'],
    '/customers': ['客户管理', '客户档案与活跃度'],
    '/departments': ['部门管理', '组织架构与人员归属'],
    '/settings': ['系统设置', '站点信息与服务规则'],
    '/sites': ['站点托管', '静态站点与 PHP 站点托管'],
    '/logs': ['操作日志', '系统操作审计记录'],
  };

  let range = '7d';

  /* ============================== 外壳 ============================== */

  function initShell() {
    const u = auth.user;
    $('#meAvatar').innerHTML = avatar(u.name, 'sm');
    $('#meName').textContent = u.name;

    $('#btnLogout').onclick = async () => {
      if (await confirm({ title: '退出登录', message: '确定要退出管理后台吗？', confirmText: '退出' })) auth.logout();
    };
    $('#rangeSelect').onchange = (e) => {
      range = e.target.value;
      if (location.hash.startsWith('#/dashboard')) viewDashboard();
      else if (location.hash.startsWith('#/reports')) viewReports();
      else toast(`统计范围已切换为 ${e.target.selectedOptions[0].text}`, 'success');
    };
    $('#btnBroadcast').onclick = openBroadcast;
    $('#btnNotif').onclick = openNotifications;

    Kefu.connectWS();
    on('ticket:update', () => {
      loadBadges();
      if (location.hash.startsWith('#/tickets')) { loadAdminTickets(1); loadTkStats(); }
    });
    on('ticket:stats', () => {
      loadBadges();
      if (location.hash.startsWith('#/tickets')) loadTkStats();
    });
    on('message', (msg) => {
      // 管理后台不参与接待，仅在会话记录页实时刷新
      if (msg?.conversationId && location.hash.startsWith('#/conversations')) loadConvList(1);
    });
    on('event', (evt) => {
      if (evt.type === 'conversation:new' || evt.type === 'queue:refresh' || evt.type === 'conversation:assigned') {
        if (location.hash.startsWith('#/conversations')) loadConvList(1);
      }
      // 知识库实时同步：无需管理员手动刷新页面
      if (evt.type === 'kb:update') handleKbUpdate(evt);
    });
    on('notification', (n) => { if (n) toast(`${n.title}${n.body ? `：${n.body}` : ''}`, 'info', 4000); });
    loadBadges();
    setInterval(loadBadges, 45000);
  }

  /** 知识库变更实时同步 */
  function handleKbUpdate(evt) {
    const action = String(evt.action || '');
    const labels = {
      'article:created': `新增文章「${evt.title || ''}」`,
      'article:updated': `文章「${evt.title || ''}」已更新`,
      'article:deleted': `文章「${evt.title || ''}」已删除`,
      'category:created': `新增分类「${evt.name || ''}」`,
      'category:updated': `分类「${evt.name || ''}」已更新`,
      'category:deleted': `分类「${evt.name || ''}」已删除`,
    };
    if (labels[action]) toast(`知识库已同步：${labels[action]}`, 'success', 3200);
    if (location.hash.startsWith('#/kb')) {
      loadArticles(1);
      loadStats();
    }
  }

  async function loadBadges() {
    try {
      const [ts, notify] = await Promise.all([api.get('/api/tickets/stats'), api.get('/api/admin/notifications')]);
      const b = $('#badgePendingTicket');
      b.textContent = ts.pending + ts.reopened;
      b.classList.toggle('hidden', !(ts.pending + ts.reopened));
      const nb = $('#notifBadge');
      nb.textContent = notify.unread;
      nb.style.display = notify.unread ? 'grid' : 'none';
    } catch { /* ignore */ }
  }

  async function openNotifications() {
    const ctx = modal({ title: '通知中心', body: '<div class="loading-block"><span class="spinner spinner--lg"></span></div>' });
    try {
      const { list } = await api.get('/api/admin/notifications');
      if (!list.length) { ctx.body.innerHTML = emptyState('🔔', '暂无通知'); return; }
      ctx.body.innerHTML = list.map((n) => `
        <div class="log-item" style="${n.is_read ? 'opacity:.6' : ''}">
          <div class="log-item__icon">${n.type === 'warning' ? '⚠️' : n.type === 'danger' ? '⛔' : n.type === 'success' ? '✅' : 'ℹ️'}</div>
          <div class="flex-1">
            <div class="flex items-center gap-8"><span class="fw-500">${escapeHtml(n.title)}</span>
              ${n.is_read ? '' : '<span class="badge badge--danger" style="height:17px;font-size:10.5px">未读</span>'}
              <span class="text-xs text-muted ml-auto">${fmt.time(n.created_at)}</span></div>
            <div class="text-sm text-muted mt-4">${escapeHtml(n.body || '')}</div>
          </div>
        </div>`).join('');
      await api.post('/api/admin/notifications/read', {});
      loadBadges();
    } catch (err) { ctx.body.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  function openBroadcast() {
    formModal({
      title: '发送系统通知',
      submitText: '立即发送',
      fields: [
        { name: 'title', label: '通知标题', required: true, placeholder: '例如：系统维护通知' },
        { name: 'body', label: '通知内容', type: 'textarea', rows: 4, placeholder: '通知正文…' },
        { name: 'type', label: '通知类型', type: 'select', value: 'info',
          options: [{ value: 'info', label: '普通信息' }, { value: 'warning', label: '警告提醒' }, { value: 'success', label: '成功提示' }, { value: 'danger', label: '紧急通知' }] },
        { name: 'target', label: '发送对象', type: 'select', value: 'online',
          options: [{ value: 'online', label: '仅在线坐席' }, { value: 'all', label: '全部坐席与管理员' }] },
      ],
    }).then(async (data) => {
      if (!data) return;
      try {
        const res = await api.post('/api/admin/broadcast', data);
        toast(`通知已发送给 ${res.count} 人`, 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  /* ============================== 路由 ============================== */

  const routes = {
    '/dashboard': viewDashboard,
    '/reports': viewReports,
    '/conversations': viewConversations,
    '/tickets': viewTickets,
    '/kb': viewKb,
    '/quick': viewQuick,
    '/agents': viewAgents,
    '/customers': viewCustomers,
    '/departments': viewDepartments,
    '/settings': viewSettings,
    '/sites': viewSites,
    '/logs': viewLogs,
  };

  function route() {
    const hash = location.hash.replace(/^#/, '') || '/dashboard';
    const [path, qs] = hash.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    const handler = routes[path] || viewDashboard;
    const meta = META[path] || META['/dashboard'];
    $('#pageTitle').textContent = meta[0];
    $('#pageDesc').textContent = meta[1];
    $$('.nav-item').forEach((n) => n.classList.toggle('is-active', n.dataset.route === path));
    handler(query);
  }

  /* ============================== 数据看板 ============================== */

  async function viewDashboard() {
    $('#view').innerHTML = '<div class="page"><div class="loading-block"><span class="spinner spinner--lg"></span><span>正在汇总数据…</span></div></div>';
    try {
      const [ov, trend, perf, dist, hourly] = await Promise.all([
        api.get(`/api/dashboard/overview?range=${range}`),
        api.get(`/api/dashboard/trend?range=${range}`),
        api.get(`/api/dashboard/agent-performance?range=${range}`),
        api.get(`/api/dashboard/distribution?range=${range}`),
        api.get(`/api/dashboard/hourly?range=${range}`),
      ]);
      const c = ov.cards;
      const maxHour = Math.max(1, ...hourly.map((h) => h.count));

      $('#view').innerHTML = `
        <div class="page">
          <div class="kpi-strip mb-20">
            ${kpi('今日会话量', c.todaySessions.value, c.todaySessions.delta, '💬')}
            ${kpi('周期会话量', c.sessions.value, c.sessions.delta, '📈')}
            ${kpi('平均满意度', c.avgRating.value || '-', c.avgRating.delta, '⭐')}
            ${kpi('好评率', `${c.satisfactionRate.value}%`, null, '😊')}
            ${kpi('平均首响', `${c.avgResponseSec.value}s`, null, '⚡')}
            ${kpi('平均处理时长', `${c.avgHandleMin.value}min`, null, '⏱️')}
            ${kpi('周期新增工单', c.tickets.value, null, '🎫')}
            ${kpi('工单解决率', `${c.ticketResolveRate.value}%`, null, '✅')}
            ${kpi('超时工单', c.overdueTickets.value, null, '⏰', c.overdueTickets.value > 0 ? 'danger' : '')}
            ${kpi('在线坐席', `${c.onlineAgents.value}/${c.totalAgents.value}`, null, '👤')}
            ${kpi('进行中会话', c.activeNow.value, null, '🔴')}
            ${kpi('排队中', c.queue.value, null, '⏳', c.queue.value > 5 ? 'warning' : '')}
          </div>

          <div class="grid-2 mb-20" style="align-items:start">
            <div class="card">
              <div class="card__head"><span class="card__title">会话与工单趋势</span>
                <div class="card__actions"><span class="text-xs text-muted">${range === '1d' ? '今日' : `近 ${range.replace('d', '')} 天`}</span></div></div>
              <div class="card__body"><div class="chart-line" id="trendChart"></div></div>
            </div>
            <div class="card">
              <div class="card__head"><span class="card__title">渠道分布</span></div>
              <div class="card__body"><div id="channelChart"></div></div>
            </div>
          </div>

          <div class="grid-2 mb-20" style="align-items:start">
            <div class="card">
              <div class="card__head"><span class="card__title">24 小时咨询高峰</span>
                <div class="card__actions"><span class="text-xs text-muted">热力越深表示咨询越集中</span></div></div>
              <div class="card__body">
                <div class="heat-grid" id="heatGrid"></div>
                <div class="flex justify-between mt-8 text-xs text-muted">
                  <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
                </div>
              </div>
            </div>
            <div class="card">
              <div class="card__head"><span class="card__title">客户满意度分布</span></div>
              <div class="card__body"><div id="ratingChart"></div></div>
            </div>
          </div>

          <div class="grid-2 mb-20" style="align-items:start">
            <div class="card">
              <div class="card__head"><span class="card__title">坐席绩效排行榜</span>
                <div class="card__actions"><span class="text-xs text-muted">按接待量排序</span></div></div>
              <div class="card__body card__body--flush">
                <div class="table-wrap"><table class="table table--compact">
                  <thead><tr><th>#</th><th>坐席</th><th>状态</th><th class="num">接待</th><th class="num">已结束</th>
                    <th class="num">评分</th><th class="num">平均首响</th><th class="num">工单</th></tr></thead>
                  <tbody>${perf.slice(0, 8).map((p, i) => `
                    <tr>
                      <td>${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td>
                      <td><div class="flex items-center gap-8">${avatar(p.name, 'sm')}<span class="fw-500">${escapeHtml(p.name)}</span></div></td>
                      <td>${Kefu.statusDot(p.status)}<span class="text-xs ml-4">${Kefu.STATUS_TEXT[p.status] || p.status}</span></td>
                      <td class="num">${p.sessions}</td>
                      <td class="num">${p.closed}</td>
                      <td class="num">${p.rating ? `${p.rating}★` : '-'}</td>
                      <td class="num">${p.avgResponseSec ? `${p.avgResponseSec}s` : '-'}</td>
                      <td class="num">${p.ticketsResolved}/${p.tickets}</td>
                    </tr>`).join('')}</tbody></table></div>
              </div>
            </div>
            <div class="card">
              <div class="card__head"><span class="card__title">工单分类分布</span></div>
              <div class="card__body"><div id="ticketCatChart"></div></div>
            </div>
          </div>

          <div class="grid-2" style="align-items:start">
            <div class="card">
              <div class="card__head"><span class="card__title">业务标签分布</span></div>
              <div class="card__body"><div id="tagChart"></div></div>
            </div>
            <div class="card">
              <div class="card__head"><span class="card__title">会话状态构成</span></div>
              <div class="card__body"><div id="statusChart"></div></div>
            </div>
          </div>
        </div>`;

      Kefu.lineChart($('#trendChart'),
        [trend.map((d) => d.conversations), trend.map((d) => d.tickets), trend.map((d) => d.closed)],
        { labels: trend.map((d) => d.date), names: ['新增会话', '新增工单', '结束会话'], height: 240 });

      Kefu.donutChart($('#channelChart'), dist.channels, { centerLabel: '会话总量' });
      Kefu.donutChart($('#ratingChart'), dist.ratings.map((r) => ({ label: `${r.star} 星`, count: r.count })), { centerLabel: '评价数' });
      Kefu.barChart($('#ticketCatChart'), dist.ticketCategories, { variant: 'warning', suffix: ' 单' });
      Kefu.barChart($('#tagChart'), dist.tags, { suffix: ' 个' });
      Kefu.donutChart($('#statusChart'), dist.statuses, { centerLabel: '会话数' });

      $('#heatGrid').innerHTML = hourly.map((h) => {
        const ratio = h.count / maxHour;
        const alpha = 0.08 + ratio * 0.82;
        return `<div class="heat-cell" data-tip="${String(h.hour).padStart(2, '0')}:00 · ${h.count} 次咨询"
          style="background: rgba(37,99,235,${alpha.toFixed(2)})"></div>`;
      }).join('');
    } catch (err) {
      $('#view').innerHTML = `<div class="page">${emptyState('😥', '数据加载失败', err.message)}</div>`;
    }
  }

  function kpi(label, value, delta, icon, variant) {
    const deltaHtml = delta === null || delta === undefined ? '' : `
      <div class="kpi__delta ${delta >= 0 ? 'trend--up' : 'trend--down'}">
        ${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}% <span class="text-muted">较上周期</span>
      </div>`;
    return `<div class="kpi ${variant ? `stat--${variant}` : ''}">
      <div class="kpi__spark">${icon}</div>
      <div class="kpi__label">${label}</div>
      <div class="kpi__value">${value}</div>
      ${deltaHtml}
    </div>`;
  }

  /* ============================== 统计分析 ============================== */

  async function viewReports() {
    $('#view').innerHTML = '<div class="page"><div class="loading-block"><span class="spinner spinner--lg"></span><span>生成报表…</span></div></div>';
    try {
      const [trend, perf, dist, ov] = await Promise.all([
        api.get(`/api/dashboard/trend?range=${range}`),
        api.get(`/api/dashboard/agent-performance?range=${range}`),
        api.get(`/api/dashboard/distribution?range=${range}`),
        api.get(`/api/dashboard/overview?range=${range}`),
      ]);

      const totalConv = trend.reduce((s, d) => s + d.conversations, 0);
      const totalClosed = trend.reduce((s, d) => s + d.closed, 0);
      const totalTicket = trend.reduce((s, d) => s + d.tickets, 0);
      const totalResolved = trend.reduce((s, d) => s + d.resolved, 0);

      $('#view').innerHTML = `
        <div class="page">
          <div class="card mb-20">
            <div class="card__head">
              <span class="card__title">会话明细报表</span>
              <div class="card__actions">
                <span class="text-xs text-muted">统计区间：${range === '1d' ? '今日' : `近 ${range.replace('d', '')} 天`}</span>
                <button class="btn btn--sm btn--primary" id="btnExport">⬇ 导出 CSV</button>
              </div>
            </div>
            <div class="card__body">
              <div class="kpi-strip">
                ${kpi('会话总量', totalConv, null, '💬')}
                ${kpi('已结束', totalClosed, null, '✅')}
                ${kpi('结束率', `${totalConv ? ((totalClosed / totalConv) * 100).toFixed(1) : 0}%`, null, '📊')}
                ${kpi('新增工单', totalTicket, null, '🎫')}
                ${kpi('工单解决率', `${totalTicket ? ((totalResolved / totalTicket) * 100).toFixed(1) : 0}%`, null, '✔️')}
                ${kpi('平均满意度', ov.cards.avgRating.value || '-', null, '⭐')}
              </div>
            </div>
          </div>

          <div class="card mb-20">
            <div class="card__head"><span class="card__title">逐日数据明细</span></div>
            <div class="card__body card__body--flush">
              <div class="table-wrap"><table class="table">
                <thead><tr><th>日期</th><th class="num">新增会话</th><th class="num">结束会话</th>
                  <th class="num">新增工单</th><th class="num">工单解决</th><th class="num">会话评分</th></tr></thead>
                <tbody>${trend.map((d) => `
                  <tr><td class="fw-500">${d.date}</td>
                    <td class="num">${d.conversations}</td><td class="num">${d.closed}</td>
                    <td class="num">${d.tickets}</td><td class="num">${d.resolved}</td>
                    <td class="num">${d.rating ? `${d.rating} ${Kefu.stars(d.rating)}` : '-'}</td></tr>`).join('')}
                  <tr style="background:var(--surface-2);font-weight:600">
                    <td>合计</td><td class="num">${totalConv}</td><td class="num">${totalClosed}</td>
                    <td class="num">${totalTicket}</td><td class="num">${totalResolved}</td><td class="num">-</td></tr>
                </tbody></table></div>
            </div>
          </div>

          <div class="grid-2" style="align-items:start">
            <div class="card">
              <div class="card__head"><span class="card__title">坐席服务排行</span></div>
              <div class="card__body card__body--flush">
                <div class="table-wrap"><table class="table table--compact">
                  <thead><tr><th>坐席</th><th>部门</th><th class="num">接待</th><th class="num">评分</th>
                    <th class="num">首响</th><th class="num">处理时长</th></tr></thead>
                  <tbody>${perf.map((p) => `
                    <tr><td class="fw-500">${escapeHtml(p.name)}</td>
                      <td class="text-sm text-muted">${escapeHtml(p.department_name || '-')}</td>
                      <td class="num">${p.sessions}</td>
                      <td class="num">${p.rating ? `${p.rating}★` : '-'}</td>
                      <td class="num">${p.avgResponseSec ? `${p.avgResponseSec}s` : '-'}</td>
                      <td class="num">${p.avgHandleMin ? `${p.avgHandleMin}min` : '-'}</td></tr>`).join('')}</tbody>
                </table></div>
              </div>
            </div>
            <div class="card">
              <div class="card__head"><span class="card__title">渠道与工单构成</span></div>
              <div class="card__body">
                <div class="mb-20"><div class="fw-500 mb-8 text-sm">咨询渠道</div><div id="rChannel"></div></div>
                <div><div class="fw-500 mb-8 text-sm">工单分类</div><div id="rTicketCat"></div></div>
              </div>
            </div>
          </div>
        </div>`;

      Kefu.barChart($('#rChannel'), dist.channels, { suffix: ' 会话' });
      Kefu.barChart($('#rTicketCat'), dist.ticketCategories, { variant: 'warning', suffix: ' 单' });

      $('#btnExport').onclick = async () => {
        try {
          const csv = await api.get(`/api/dashboard/export?range=${range}`);
          const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `会话报表-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
          URL.revokeObjectURL(a.href);
          toast('报表已导出', 'success');
        } catch (err) { toast(err.message, 'error'); }
      };
    } catch (err) {
      $('#view').innerHTML = `<div class="page">${emptyState('😥', '报表加载失败', err.message)}</div>`;
    }
  }

  /* ============================== 会话记录 ============================== */

  function viewConversations(query) {
    $('#view').innerHTML = `
      <div class="page">
        <div class="card">
          <div class="card__head">
            <span class="card__title">全部会话记录</span>
            <div class="card__actions">
              <div class="search-box" style="width:220px"><input class="input" id="cvSearch" placeholder="客户 / 会话号 / 坐席…"></div>
              <select class="select" id="cvStatus" style="width:120px">
                <option value="">全部状态</option><option value="queued">排队中</option>
                <option value="active">进行中</option><option value="closed">已结束</option>
              </select>
              <select class="select" id="cvChannel" style="width:120px">
                <option value="">全部渠道</option><option value="web">网页</option><option value="app">APP</option>
                <option value="wechat">公众号</option><option value="phone">电话</option><option value="email">邮件</option>
              </select>
              <input class="input" type="date" id="cvFrom" style="width:150px" title="开始日期">
              <input class="input" type="date" id="cvTo" style="width:150px" title="结束日期">
            </div>
          </div>
          <div class="card__body card__body--flush" id="cvList"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>
        </div>
      </div>`;

    $('#cvSearch').addEventListener('input', debounce(() => loadConvList(1), 320));
    ['#cvStatus', '#cvChannel', '#cvFrom', '#cvTo'].forEach((s) => $(s).addEventListener('change', () => loadConvList(1)));
    loadConvList(1, query.id);
  }

  async function loadConvList(page = 1) {
    const box = $('#cvList');
    if (!box) return;
    loading(box);
    try {
      const res = await api.get(`/api/conversations${Kefu.qs({
        page, pageSize: 15,
        keyword: $('#cvSearch')?.value || '',
        status: $('#cvStatus')?.value || '',
        channel: $('#cvChannel')?.value || '',
        dateFrom: $('#cvFrom')?.value || '',
        dateTo: $('#cvTo')?.value || '',
      })}`);
      if (!res.list.length) { box.innerHTML = emptyState('💬', '没有符合条件的会话'); return; }
      box.innerHTML = `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>会话编号</th><th>客户</th><th>客服</th><th>渠道</th><th>标签</th>
            <th>状态</th><th class="num">消息数</th><th>评分</th><th>创建时间</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>${res.list.map((c) => `
            <tr>
              <td class="text-mono text-sm">${escapeHtml(c.code)}</td>
              <td>${escapeHtml(c.customer_name)}<div class="cell-sub">${escapeHtml(c.customer_phone || '')}</div></td>
              <td>${c.agent_name ? escapeHtml(c.agent_name) : '<span class="text-muted">未分配</span>'}</td>
              <td><span class="badge">${Kefu.STATUS_TEXT[c.channel] || c.channel}</span></td>
              <td>${c.tag ? `<span class="badge badge--outline">${escapeHtml(c.tag)}</span>` : '-'}</td>
              <td>${statusBadge(c.status)}</td>
              <td class="num">${c.message_count}</td>
              <td>${c.rating ? Kefu.stars(c.rating) : '<span class="text-muted">-</span>'}</td>
              <td class="text-sm text-muted">${fmt.datetime(c.created_at)}</td>
              <td><div class="table__actions"><button class="btn btn--sm" data-view="${c.id}">查看记录</button></div></td>
            </tr>`).join('')}</tbody></table></div>
        ${paginationHtml(res.pagination)}`;
      box.onclick = (e) => {
        const b = e.target.closest('[data-view]');
        if (b) openConvTranscript(Number(b.dataset.view));
      };
      bindPagination(box, (p) => loadConvList(p));
    } catch (err) { box.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  async function openConvTranscript(id) {
    const ctx = modal({ title: '会话记录详情', size: 'lg', body: '<div class="loading-block"><span class="spinner spinner--lg"></span></div>' });
    try {
      const [detail, messages] = await Promise.all([
        api.get(`/api/conversations/${id}`),
        api.get(`/api/conversations/${id}/messages`),
      ]);
      const c = detail.conversation;
      ctx.body.innerHTML = `
        <div class="flex items-center gap-14 mb-14 flex-wrap">
          ${avatar(c.customer_name, 'lg')}
          <div class="flex-1">
            <div class="fw-600 text-lg">${escapeHtml(c.customer_name)} <span class="text-sm text-muted">@${escapeHtml(c.customer_username)}</span></div>
            <div class="text-sm text-muted">${escapeHtml(c.code)} · ${Kefu.STATUS_TEXT[c.channel]} · ${fmt.datetime(c.created_at)}</div>
          </div>
          ${statusBadge(c.status)}
          ${c.rating ? Kefu.stars(c.rating, '17px') : ''}
        </div>
        <div class="grid-3 mb-20 text-sm">
          <div><div class="text-muted text-xs">服务客服</div><div>${escapeHtml(c.agent_name || '未分配')}</div></div>
          <div><div class="text-muted text-xs">业务标签</div><div>${escapeHtml(c.tag || '-')}</div></div>
          <div><div class="text-muted text-xs">优先级</div><div>${Kefu.STATUS_TEXT[c.priority] || c.priority}</div></div>
          <div><div class="text-muted text-xs">客户历史会话</div><div>${detail.customerStats.totalConversations} 次</div></div>
          <div><div class="text-muted text-xs">客户历史工单</div><div>${detail.customerStats.totalTickets} 个</div></div>
          <div><div class="text-muted text-xs">消息条数</div><div>${messages.length} 条</div></div>
        </div>
        ${c.rating_comment ? `<div class="badge badge--warning mb-14" style="height:auto;padding:8px 12px">客户评价：${escapeHtml(c.rating_comment)}</div>` : ''}
        <div class="divider"></div>
        <div style="max-height:420px;overflow-y:auto;padding-right:6px">
          ${messages.map((m) => m.sender_role === 'system'
            ? `<div class="text-center text-xs text-muted" style="margin:10px 0"><span style="background:rgba(148,163,184,.14);padding:3px 11px;border-radius:99px">${escapeHtml(m.content)}</span></div>`
            : `<div class="flex gap-8 mb-14" style="${m.sender_role === 'agent' ? 'flex-direction:row-reverse' : ''}">
                ${avatar(m.sender_name, 'sm')}
                <div style="max-width:78%">
                  <div class="text-xs text-muted mb-4" style="${m.sender_role === 'agent' ? 'text-align:right' : ''}">${escapeHtml(m.sender_name)} · ${fmt.clock(m.created_at)}</div>
                  <div class="msg__bubble" style="${m.sender_role === 'agent' ? 'background:var(--brand);color:#fff;border-color:var(--brand)' : ''}">${markdown(m.content)}</div>
                </div></div>`).join('')}
        </div>`;
    } catch (err) { ctx.body.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  /* ============================== 工单中心 ============================== */

  function viewTickets(query) {
    if (query.id) return viewTicketDetail(query.id);
    $('#view').innerHTML = `
      <div class="page">
        <div class="kpi-strip mb-20" id="tkStats"></div>
        <div class="card">
          <div class="card__head">
            <span class="card__title">工单全局管理</span>
            <div class="card__actions">
              <div class="search-box" style="width:210px"><input class="input" id="tkSearch" placeholder="工单号 / 标题 / 客户…"></div>
              <select class="select" id="tkStatus" style="width:120px">
                <option value="">全部状态</option><option value="pending">待处理</option>
                <option value="processing">处理中</option><option value="resolved">已解决</option>
                <option value="closed">已关闭</option><option value="reopened">重新打开</option>
              </select>
              <select class="select" id="tkPriority" style="width:110px">
                <option value="">全部优先级</option><option value="urgent">紧急</option>
                <option value="high">高</option><option value="normal">中</option><option value="low">低</option>
              </select>
              <select class="select" id="tkCategory" style="width:130px"><option value="">全部分类</option></select>
            </div>
          </div>
          <div class="card__body card__body--flush" id="tkList"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>
        </div>
      </div>`;

    api.get('/api/tickets/meta').then((m) => {
      const sel = $('#tkCategory');
      for (const c of m.categories) sel.appendChild(el('option', { value: c, text: c }));
    });

    $('#tkSearch').addEventListener('input', debounce(() => loadAdminTickets(1), 320));
    ['#tkStatus', '#tkPriority', '#tkCategory'].forEach((s) => $(s).addEventListener('change', () => loadAdminTickets(1)));
    loadTkStats();
    loadAdminTickets(1);
  }

  async function loadTkStats() {
    try {
      const s = await api.get('/api/tickets/stats');
      const box = $('#tkStats');
      if (!box) return;
      box.innerHTML = `
        ${kpi('工单总数', s.total, null, '🎫')}
        ${kpi('待处理', s.pending, null, '⏳', s.pending > 5 ? 'warning' : '')}
        ${kpi('处理中', s.processing, null, '🔧')}
        ${kpi('已解决', s.resolved, null, '✅')}
        ${kpi('超时未闭环', s.overdue, null, '⏰', s.overdue > 0 ? 'danger' : '')}
        ${kpi('未指派', s.unassigned, null, '❓', s.unassigned > 0 ? 'warning' : '')}`;
    } catch { /* ignore */ }
  }

  async function loadAdminTickets(page = 1) {
    const box = $('#tkList');
    if (!box) return;
    loading(box);
    try {
      const res = await api.get(`/api/tickets${Kefu.qs({
        page, pageSize: 15,
        keyword: $('#tkSearch')?.value || '',
        status: $('#tkStatus')?.value || '',
        priority: $('#tkPriority')?.value || '',
        category: $('#tkCategory')?.value || '',
      })}`);
      if (!res.list.length) { box.innerHTML = emptyState('🎫', '没有符合条件的工单'); return; }
      box.innerHTML = `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>工单</th><th>客户</th><th>分类</th><th>优先级</th><th>状态</th>
            <th>处理人</th><th>SLA</th><th>提交时间</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>${res.list.map((t) => `
            <tr>
              <td><div class="cell-main ellipsis" style="max-width:220px">${escapeHtml(t.title)}</div>
                  <div class="cell-sub text-mono">${escapeHtml(t.code)}</div></td>
              <td>${escapeHtml(t.creator_name)}<div class="cell-sub">${escapeHtml(t.creator_phone || '')}</div></td>
              <td><span class="badge">${escapeHtml(t.category)}</span></td>
              <td>${statusBadge(t.priority, Kefu.STATUS_TEXT[t.priority])}</td>
              <td>${statusBadge(t.status)}</td>
              <td>${t.assignee_name ? escapeHtml(t.assignee_name) : '<span class="text-muted">待指派</span>'}</td>
              <td>${['closed', 'resolved'].includes(t.status) ? '<span class="text-muted text-xs">已完成</span>'
                : `<span class="${t.is_overdue ? 'text-danger fw-600' : 'text-muted'} text-xs">${fmt.countdown(t.sla_due_at)}</span>`}</td>
              <td class="text-sm text-muted">${fmt.datetime(t.created_at)}</td>
              <td><div class="table__actions">
                <button class="btn btn--sm" data-view="${t.id}">处理</button>
                <button class="btn btn--sm btn--danger" data-del="${t.id}">删除</button>
              </div></td>
            </tr>`).join('')}</tbody></table></div>
        ${paginationHtml(res.pagination)}`;
      box.onclick = async (e) => {
        const view = e.target.closest('[data-view]');
        if (view) { location.hash = `#/tickets?id=${view.dataset.view}`; return; }
        const del = e.target.closest('[data-del]');
        if (del) {
          if (!await confirm({ title: '删除工单', message: '删除后不可恢复，确定吗？', confirmText: '删除', danger: true })) return;
          try { await api.del(`/api/tickets/${del.dataset.del}`); toast('工单已删除', 'success'); loadAdminTickets(page); loadTkStats(); loadBadges(); } catch (err) { toast(err.message, 'error'); }
        }
      };
      bindPagination(box, (p) => loadAdminTickets(p));
    } catch (err) { box.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  async function viewTicketDetail(id) {
    $('#view').innerHTML = '<div class="page"><div class="loading-block"><span class="spinner spinner--lg"></span><span>加载工单…</span></div></div>';
    try {
      const [{ ticket, comments }, meta, agents] = await Promise.all([
        api.get(`/api/tickets/${id}`),
        api.get('/api/tickets/meta'),
        api.get('/api/conversations/agents/online'),
      ]);
      $('#view').innerHTML = `
        <div class="page">
          <button class="btn btn--sm mb-14" data-action="go-tickets">‹ 返回工单列表</button>
          <div style="display:grid;grid-template-columns:1fr 330px;gap:18px;align-items:start">
            <div>
              <div class="card mb-20">
                <div class="card__head">
                  <div class="flex-1">
                    <div class="card__title">${escapeHtml(ticket.title)}</div>
                    <div class="card__sub">${escapeHtml(ticket.code)} · ${escapeHtml(ticket.category)} · 提交于 ${fmt.datetime(ticket.created_at)}</div>
                  </div>
                  ${statusBadge(ticket.status)}${statusBadge(ticket.priority, Kefu.STATUS_TEXT[ticket.priority])}
                </div>
                <div class="card__body"><div class="text-2" style="white-space:pre-wrap;line-height:1.8">${escapeHtml(ticket.description || '')}</div></div>
              </div>
              <div class="card">
                <div class="card__head"><span class="card__title">处理记录（${comments.length}）</span></div>
                <div class="card__body" style="max-height:380px;overflow-y:auto">
                  ${comments.length ? comments.map((c) => `
                    <div class="flex gap-10 mb-14">
                      ${avatar(c.user_name || '系统', 'sm')}
                      <div class="flex-1">
                        <div class="text-xs text-muted mb-4"><strong>${escapeHtml(c.user_name || '系统')}</strong> · ${fmt.datetime(c.created_at)}
                          ${c.internal ? '<span class="badge badge--warning" style="height:17px;font-size:10.5px">内部</span>' : ''}</div>
                        <div class="text-2" style="white-space:pre-wrap;font-size:13.5px;line-height:1.7">${escapeHtml(c.content)}</div>
                      </div></div>`).join('') : '<div class="text-sm text-muted">暂无处理记录</div>'}
                </div>
                <div class="card__body" style="border-top:1px solid var(--border)">
                  <textarea class="textarea" id="tkReply" rows="3" placeholder="添加处理说明…"></textarea>
                  <div class="flex items-center gap-10 mt-8">
                    <label class="checkbox"><input type="checkbox" id="tkInternal"><span class="text-sm">内部备注</span></label>
                    <button class="btn btn--primary ml-auto" id="btnReply">提交</button>
                  </div>
                </div>
              </div>
            </div>
            <aside class="card">
              <div class="card__head"><span class="card__title">工单操作</span></div>
              <div class="card__body">
                <div class="field"><label class="field__label">状态</label>
                  <select class="select" id="sStatus">${['pending', 'processing', 'resolved', 'closed', 'reopened']
                    .map((k) => `<option value="${k}" ${ticket.status === k ? 'selected' : ''}>${Kefu.STATUS_TEXT[k]}</option>`).join('')}</select></div>
                <div class="field"><label class="field__label">优先级</label>
                  <select class="select" id="sPriority">${[['low', '低'], ['normal', '中'], ['high', '高'], ['urgent', '紧急']]
                    .map(([v, l]) => `<option value="${v}" ${ticket.priority === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
                <div class="field"><label class="field__label">处理人</label>
                  <select class="select" id="sAssignee"><option value="">未指派</option>
                    ${agents.map((a) => `<option value="${a.id}" ${ticket.assignee_id === a.id ? 'selected' : ''}>${escapeHtml(a.name)}（${Kefu.STATUS_TEXT[a.status]}）</option>`).join('')}</select></div>
                <div class="field"><label class="field__label">分类</label>
                  <select class="select" id="sCategory">${meta.categories.map((c) => `<option value="${c}" ${ticket.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
                <button class="btn btn--primary btn--block" id="btnSave">保存修改</button>
                <div class="divider"></div>
                <div class="info-row"><span class="info-row__label">客户</span><span class="info-row__value">${escapeHtml(ticket.creator_name)}<br><span class="text-xs text-muted">${escapeHtml(ticket.creator_phone || '')} ${escapeHtml(ticket.creator_email || '')}</span></span></div>
                <div class="info-row"><span class="info-row__label">SLA</span><span class="info-row__value">${fmt.datetime(ticket.sla_due_at)}<br><span class="text-xs">${fmt.countdown(ticket.sla_due_at)}</span></span></div>
                <div class="info-row"><span class="info-row__label">部门</span><span class="info-row__value">${escapeHtml(ticket.department_name || '-')}</span></div>
                ${ticket.rating ? `<div class="info-row"><span class="info-row__label">评价</span><span class="info-row__value">${Kefu.stars(ticket.rating)}<br><span class="text-xs">${escapeHtml(ticket.rating_comment || '')}</span></span></div>` : ''}
                ${ticket.conversation_id ? `<button class="btn btn--sm btn--block mt-8" id="btnGoConv">💬 关联会话记录</button>` : ''}
              </div>
            </aside>
          </div>
        </div>`;

      $('#btnReply').onclick = async () => {
        const content = $('#tkReply').value.trim();
        if (!content) return toast('请输入内容', 'warning');
        try {
          await api.post(`/api/tickets/${id}/comments`, { content, internal: $('#tkInternal').checked ? 1 : 0 });
          toast('已提交', 'success');
          viewTicketDetail(id);
        } catch (err) { toast(err.message, 'error'); }
      };
      $('#btnSave').onclick = async () => {
        try {
          await api.put(`/api/tickets/${id}`, {
            status: $('#sStatus').value, priority: $('#sPriority').value,
            assignee_id: $('#sAssignee').value === '' ? null : Number($('#sAssignee').value),
            category: $('#sCategory').value,
          });
          toast('工单已更新', 'success');
          loadBadges();
          viewTicketDetail(id);
        } catch (err) { toast(err.message, 'error'); }
      };
      const g = $('#btnGoConv');
      if (g) g.onclick = () => { location.hash = `#/conversations?id=${ticket.conversation_id}`; };
    } catch (err) {
      $('#view').innerHTML = `<div class="page">${emptyState('😥', '加载失败', err.message)}</div>`;
    }
  }

  /* ============================== 知识库管理 ============================== */

  function viewKb() {
    $('#view').innerHTML = `
      <div class="page">
        <div class="kpi-strip mb-20" id="kbStats"></div>
        <div class="grid-2" style="align-items:start">
          <div class="card">
            <div class="card__head">
              <span class="card__title">文章管理</span>
              <div class="card__actions">
                <div class="search-box" style="width:170px"><input class="input" id="kbq" placeholder="搜索…"></div>
                <select class="select" id="kbVis" style="width:110px">
                  <option value="">全部可见性</option><option value="public">公开</option><option value="internal">内部</option>
                </select>
                <button class="btn btn--primary btn--sm" id="btnNew">＋ 新建</button>
              </div>
            </div>
            <div class="card__body card__body--flush" id="kbList"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>
          </div>
          <div>
            <div class="card mb-20">
              <div class="card__head"><span class="card__title">分类管理</span>
                <div class="card__actions"><button class="btn btn--sm btn--primary" id="btnNewCat">＋ 新增分类</button></div></div>
              <div class="card__body" id="catList"></div>
            </div>
            <div class="card">
              <div class="card__head"><span class="card__title">热门文章 TOP8</span></div>
              <div class="card__body" id="topArticles"></div>
            </div>
          </div>
        </div>
      </div>`;

    $('#kbq').addEventListener('input', debounce(() => loadArticles(1), 320));
    $('#kbVis').onchange = () => loadArticles(1);
    $('#btnNew').onclick = () => openEditor(null);
    $('#btnNewCat').onclick = () => formModal({
      title: '新增知识库分类',
      fields: [
        { name: 'name', label: '分类名称', required: true, placeholder: '例如：常见问题' },
        { name: 'icon', label: '图标（Emoji）', value: '📄' },
        { name: 'description', label: '分类描述', placeholder: '一句话说明该分类包含的内容' },
        { name: 'sort_order', label: '排序值', type: 'number', value: 10 },
      ],
    }).then(async (d) => {
      if (!d) return;
      try { await api.post('/api/kb/categories', d); toast('分类已创建', 'success'); loadStats(); } catch (err) { toast(err.message, 'error'); }
    });

    loadStats();
    loadArticles(1);
  }

  async function loadStats() {
    try {
      const s = await api.get('/api/kb/stats');
      const box = $('#kbStats');
      if (!box) return;
      box.innerHTML = `
        ${kpi('文章总数', s.total, null, '📚')}
        ${kpi('已发布', s.published, null, '✅')}
        ${kpi('草稿', s.draft, null, '✏️')}
        ${kpi('内部文章', s.internal, null, '🔒')}
        ${kpi('总浏览量', fmt.number(s.totalViews), null, '👁️')}
        ${kpi('有用反馈', fmt.number(s.totalHelpful), null, '👍')}`;

      $('#catList').innerHTML = s.categoriesStat.map((c) => `
        <div class="dept-card mb-8" style="padding:12px 14px">
          <div class="flex items-center gap-10">
            <span style="font-size:20px">${c.icon || '📄'}</span>
            <div class="flex-1">
              <div class="fw-500">${escapeHtml(c.name)}</div>
              <div class="text-xs text-muted">${c.count} 篇文章 · ${fmt.number(c.views)} 次浏览</div>
            </div>
            <button class="btn btn--sm btn--danger" data-delcat="${c.name}">删除</button>
          </div>
        </div>`).join('');

      $('#topArticles').innerHTML = s.topArticles.map((a, i) => `
        <div class="flex items-center gap-10 mb-8" style="font-size:13px">
          <span class="text-muted" style="width:16px">${i + 1}</span>
          <span class="flex-1 ellipsis">${escapeHtml(a.title)}</span>
          <span class="text-muted text-xs">${fmt.number(a.views)} 浏览</span>
          <span class="badge badge--success" style="height:18px">👍 ${a.helpful}</span>
        </div>`).join('');

      $('#catList').onclick = async (e) => {
        const b = e.target.closest('[data-delcat]');
        if (!b) return;
        const cat = s.categoriesStat.find((c) => c.name === b.dataset.delcat);
        if (!await confirm({ title: '删除分类', message: `确定删除分类「${cat.name}」吗？分类下有文章时将无法删除。`, confirmText: '删除', danger: true })) return;
        try {
          const cats = await api.get('/api/kb/categories');
          const target = cats.find((c) => c.name === cat.name);
          await api.del(`/api/kb/categories/${target.id}`);
          toast('分类已删除', 'success');
          loadStats();
        } catch (err) { toast(err.message, 'error'); }
      };
    } catch { /* ignore */ }
  }

  async function loadArticles(page = 1) {
    const box = $('#kbList');
    if (!box) return;
    loading(box);
    try {
      const res = await api.get(`/api/kb/articles${Kefu.qs({
        page, pageSize: 12, keyword: $('#kbq')?.value || '', visibility: $('#kbVis')?.value || '',
      })}`);
      if (!res.list.length) { box.innerHTML = emptyState('📚', '暂无文章'); return; }
      box.innerHTML = `
        <div class="table-wrap"><table class="table table--compact">
          <thead><tr><th>标题</th><th>分类</th><th>状态</th><th>可见</th><th class="num">浏览</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>${res.list.map((a) => `
            <tr>
              <td><div class="cell-main ellipsis" style="max-width:190px">${escapeHtml(a.title)}</div>
                  <div class="cell-sub">${fmt.date(a.updated_at)}</div></td>
              <td><span class="badge">${escapeHtml(a.category_name || '-')}</span></td>
              <td>${statusBadge(a.status)}</td>
              <td>${a.visibility === 'internal' ? '<span class="badge badge--warning">内部</span>' : '<span class="badge badge--success">公开</span>'}</td>
              <td class="num">${fmt.number(a.views)}</td>
              <td><div class="table__actions">
                <button class="btn btn--sm" data-edit="${a.id}">编辑</button>
                <button class="btn btn--sm btn--danger" data-del="${a.id}">删除</button>
              </div></td>
            </tr>`).join('')}</tbody></table></div>
        ${paginationHtml(res.pagination)}`;
      box.onclick = async (e) => {
        const edit = e.target.closest('[data-edit]');
        if (edit) { openEditor(Number(edit.dataset.edit)); return; }
        const del = e.target.closest('[data-del]');
        if (del) {
          if (!await confirm({ title: '删除文章', message: '删除后不可恢复，确定吗？', confirmText: '删除', danger: true })) return;
          try { await api.del(`/api/kb/articles/${del.dataset.del}`); toast('已删除', 'success'); loadArticles(page); loadStats(); } catch (err) { toast(err.message, 'error'); }
        }
      };
      bindPagination(box, (p) => loadArticles(p));
    } catch (err) { box.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  async function openEditor(id) {
    let article = { title: '', summary: '', content: '', status: 'published', visibility: 'public', category_id: null };
    if (id) {
      try { article = (await api.get(`/api/kb/articles/${id}`)).article; } catch (err) { return toast(err.message, 'error'); }
    }
    const cats = await api.get('/api/kb/categories').catch(() => []);
    const form = el('div');
    form.innerHTML = `
      <div class="form-row">
        <div class="field"><label class="field__label">标题<span class="req">*</span></label>
          <input class="input" id="aTitle" value="${escapeHtml(article.title)}"></div>
        <div class="field"><label class="field__label">分类</label>
          <select class="select" id="aCat">${cats.map((c) => `<option value="${c.id}" ${article.category_id === c.id ? 'selected' : ''}>${c.icon} ${escapeHtml(c.name)}</option>`).join('')}</select></div>
      </div>
      <div class="form-row">
        <div class="field"><label class="field__label">状态</label>
          <select class="select" id="aStatus">${[['published', '已发布'], ['draft', '草稿'], ['archived', '已归档']]
            .map(([v, l]) => `<option value="${v}" ${article.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label class="field__label">可见范围</label>
          <select class="select" id="aVis">${[['public', '公开（客户可见）'], ['internal', '内部（仅坐席可见）']]
            .map(([v, l]) => `<option value="${v}" ${article.visibility === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label class="field__label">摘要</label>
        <input class="input" id="aSummary" value="${escapeHtml(article.summary || '')}"></div>
      <div class="field"><label class="field__label">正文<span class="req">*</span></label>
        <textarea class="textarea" id="aContent" rows="13">${escapeHtml(article.content || '')}</textarea>
        <div class="field__hint">支持 Markdown：# 标题、**粗体**、- 列表、\`代码\`、| 表格 |</div></div>`;

    modal({
      title: id ? '编辑文章' : '新建文章',
      size: 'xl',
      body: form,
      onMount(c) {
        c.foot = el('div', { class: 'modal__foot' });
        c.foot.appendChild(el('button', { class: 'btn', text: '取消', onClick: () => c.close() }));
        c.foot.appendChild(el('button', {
          class: 'btn btn--primary', text: '保存',
          onClick: async () => {
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
              toast('已保存', 'success');
              c.close();
              loadArticles(); loadStats();
            } catch (err) { toast(err.message, 'error'); }
          },
        }));
        c.dialog.appendChild(c.foot);
      },
    });
  }

  /* ============================== 快捷话术管理 ============================== */

  function viewQuick() {
    $('#view').innerHTML = `
      <div class="page">
        <div class="card">
          <div class="card__head">
            <span class="card__title">快捷话术管理</span>
            <div class="card__actions">
              <div class="search-box" style="width:200px"><input class="input" id="qrSearch" placeholder="搜索标题 / 内容…"></div>
              <select class="select" id="qrScope" style="width:120px">
                <option value="">全部范围</option><option value="all">公共</option>
                <option value="department">部门</option><option value="personal">个人</option>
              </select>
              <button class="btn btn--primary btn--sm" id="btnNew">＋ 新增话术</button>
            </div>
          </div>
          <div class="card__body card__body--flush" id="qrList"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>
        </div>
      </div>`;
    $('#qrSearch').addEventListener('input', debounce(() => loadQuickList(), 320));
    $('#qrScope').onchange = () => loadQuickList();
    $('#btnNew').onclick = () => openQuickEditor(null);
    loadQuickList();
  }

  async function loadQuickList() {
    const box = $('#qrList');
    if (!box) return;
    loading(box);
    try {
      const { list } = await api.get(`/api/admin/quick-replies${Kefu.qs({
        keyword: $('#qrSearch')?.value || '', scope: $('#qrScope')?.value || '',
      })}`);
      if (!list.length) { box.innerHTML = emptyState('⚡', '暂无快捷话术'); return; }
      box.innerHTML = `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>常用</th><th>标题</th><th>内容</th><th>分类</th><th>范围</th><th>归属</th><th class="num">使用次数</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>${list.map((q) => `
            <tr>
              <td><button data-fav="${q.id}" title="${q.is_favorite ? '取消常用' : '设为常用'}"
                style="font-size:17px;line-height:1;color:${q.is_favorite ? '#f59e0b' : '#cbd5e1'};padding:2px 4px">${q.is_favorite ? '★' : '☆'}</button></td>
              <td class="cell-main">${escapeHtml(q.title)}</td>
              <td class="text-sm text-2" style="max-width:300px"><div class="clamp-2">${escapeHtml(q.content)}</div></td>
              <td><span class="badge">${escapeHtml(q.category)}</span></td>
              <td>${q.scope === 'all' ? '<span class="badge badge--brand">公共</span>' : q.scope === 'department' ? '<span class="badge badge--info">部门</span>' : '<span class="badge">个人</span>'}</td>
              <td class="text-sm text-muted">${escapeHtml(q.owner_name || q.department_name || '-')}</td>
              <td class="num">${q.use_count}</td>
              <td><div class="table__actions">
                <button class="btn btn--sm" data-edit="${q.id}">编辑</button>
                <button class="btn btn--sm btn--danger" data-del="${q.id}">删除</button>
              </div></td>
            </tr>`).join('')}</tbody></table></div>`;
      box.onclick = async (e) => {
        const fav = e.target.closest('[data-fav]');
        if (fav) {
          try {
            const updated = await api.post(`/api/admin/quick-replies/${fav.dataset.fav}/favorite`, {});
            toast(updated.is_favorite ? '已设为常用，将在工作台置顶' : '已取消常用', 'success');
            loadQuickList();
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        const edit = e.target.closest('[data-edit]');
        if (edit) { openQuickEditor(list.find((x) => String(x.id) === edit.dataset.edit)); return; }
        const del = e.target.closest('[data-del]');
        if (del) {
          if (!await confirm({ title: '删除话术', message: '确定删除这条话术吗？', confirmText: '删除', danger: true })) return;
          try { await api.del(`/api/admin/quick-replies/${del.dataset.del}`); toast('已删除', 'success'); loadQuickList(); } catch (err) { toast(err.message, 'error'); }
        }
      };
    } catch (err) { box.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  async function openQuickEditor(qr) {
    const data = await formModal({
      title: qr ? '编辑快捷话术' : '新增快捷话术',
      fields: [
        { name: 'title', label: '标题', required: true, value: qr?.title || '' },
        { name: 'category', label: '分类', type: 'select', value: qr?.category || '通用',
          options: ['开场', '沟通', '转接', '售后', '工单', '结束', '通用'].map((c) => ({ value: c, label: c })) },
        { name: 'content', label: '话术内容', type: 'textarea', required: true, rows: 5, value: qr?.content || '',
          hint: '支持变量 {code} 自动替换为会话编号' },
        { name: 'is_favorite', label: '常用', type: 'checkbox', checkboxLabel: '设为常用话术（在工作台置顶显示）', value: Boolean(qr?.is_favorite) },
        { name: 'scope', label: '使用范围', type: 'select', value: qr?.scope || 'all',
          options: [{ value: 'all', label: '全体坐席（公共）' }, { value: 'personal', label: '仅自己可见' }] },
      ],
    });
    if (!data) return;
    data.is_favorite = data.is_favorite ? 1 : 0;
    try {
      if (qr) await api.put(`/api/admin/quick-replies/${qr.id}`, data);
      else await api.post('/api/admin/quick-replies', data);
      toast('话术已保存', 'success');
      loadQuickList();
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ============================== 坐席管理 ============================== */

  function viewAgents() {
    $('#view').innerHTML = `
      <div class="page">
        <div class="card">
          <div class="card__head">
            <span class="card__title">账号与坐席管理</span>
            <div class="card__actions">
              <div class="search-box" style="width:200px"><input class="input" id="agSearch" placeholder="搜索姓名 / 账号 / 手机…"></div>
              <select class="select" id="agRole" style="width:120px">
                <option value="">全部角色</option><option value="agent">客服</option>
                <option value="admin">管理员</option><option value="customer">客户</option>
              </select>
              <select class="select" id="agDept" style="width:140px"><option value="">全部部门</option></select>
              <select class="select" id="agStatus" style="width:110px">
                <option value="">全部状态</option><option value="online">在线</option>
                <option value="busy">忙碌</option><option value="away">离开</option><option value="offline">离线</option>
              </select>
              <button class="btn btn--primary btn--sm" id="btnNewUser">＋ 新增账号</button>
            </div>
          </div>
          <div class="card__body card__body--flush" id="agList"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>
        </div>
      </div>`;

    api.get('/api/admin/departments').then((list) => {
      const sel = $('#agDept');
      for (const d of list) sel.appendChild(el('option', { value: d.id, text: d.name }));
    });

    $('#agSearch').addEventListener('input', debounce(() => loadUsers(1), 320));
    ['#agRole', '#agDept', '#agStatus'].forEach((s) => $(s).addEventListener('change', () => loadUsers(1)));
    $('#btnNewUser').onclick = () => openUserEditor(null);
    loadUsers(1);
  }

  async function loadUsers(page = 1) {
    const box = $('#agList');
    if (!box) return;
    loading(box);
    try {
      const [res, departments] = await Promise.all([
        api.get(`/api/admin/users${Kefu.qs({
          page, pageSize: 15,
          keyword: $('#agSearch')?.value || '',
          role: $('#agRole')?.value || '',
          department_id: $('#agDept')?.value || '',
          status: $('#agStatus')?.value || '',
        })}`),
        api.get('/api/admin/departments'),
      ]);
      if (!res.list.length) { box.innerHTML = emptyState('👤', '没有符合条件的账号'); return; }

      box.innerHTML = `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>成员</th><th>角色</th><th>部门</th><th>等级 / 技能</th><th>状态</th>
            <th class="num">接待中</th><th class="num">累计会话</th><th class="num">待办工单</th><th>最近登录</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>${res.list.map((u) => `
            <tr style="${u.active ? '' : 'opacity:.5'}">
              <td><div class="flex items-center gap-10">${avatar(u.name, 'sm')}
                <div><div class="cell-main">${escapeHtml(u.name)} ${u.active ? '' : '<span class="badge badge--danger" style="height:17px;font-size:10.5px">已停用</span>'}</div>
                <div class="cell-sub">@${escapeHtml(u.username)} · ${escapeHtml(u.email || u.phone || '')}</div></div></div></td>
              <td>${statusBadge(u.role, Kefu.STATUS_TEXT[u.role])}</td>
              <td class="text-sm">${escapeHtml(u.department_name || '-')}</td>
              <td class="text-sm">${escapeHtml(u.level || '-')}
                ${u.skills?.length ? `<div class="cell-sub">${u.skills.map((s) => `<span class="badge badge--outline" style="height:17px;font-size:10.5px">${escapeHtml(s)}</span>`).join(' ')}</div>` : ''}</td>
              <td>${Kefu.statusDot(u.status)} <span class="text-sm">${Kefu.STATUS_TEXT[u.status] || u.status}</span></td>
              <td class="num">${u.role === 'agent' ? `${u.load}/${u.max_concurrent}` : '-'}</td>
              <td class="num">${u.total_sessions}</td>
              <td class="num">${u.open_tickets}</td>
              <td class="text-sm text-muted">${u.last_login_at ? fmt.time(u.last_login_at) : '<span class="text-muted">从未登录</span>'}</td>
              <td><div class="table__actions">
                <button class="btn btn--sm" data-edit="${u.id}">编辑</button>
                <button class="btn btn--sm" data-toggle="${u.id}">${u.active ? '停用' : '启用'}</button>
                <button class="btn btn--sm btn--danger" data-del="${u.id}">删除</button>
              </div></td>
            </tr>`).join('')}</tbody></table></div>
        ${paginationHtml(res.pagination)}`;

      box.onclick = async (e) => {
        const edit = e.target.closest('[data-edit]');
        if (edit) { openUserEditor(res.list.find((x) => String(x.id) === edit.dataset.edit), departments); return; }
        const toggle = e.target.closest('[data-toggle]');
        if (toggle) {
          try {
            const r = await api.post(`/api/admin/users/${toggle.dataset.toggle}/toggle`, {});
            toast(r.active ? '账号已启用' : '账号已停用', 'success');
            loadUsers(page);
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        const del = e.target.closest('[data-del]');
        if (del) {
          if (!await confirm({ title: '删除账号', message: '删除后该账号将无法登录，确定吗？', confirmText: '删除', danger: true })) return;
          try { await api.del(`/api/admin/users/${del.dataset.del}`); toast('账号已删除', 'success'); loadUsers(page); } catch (err) { toast(err.message, 'error'); }
        }
      };
      bindPagination(box, (p) => loadUsers(p));
    } catch (err) { box.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  async function openUserEditor(user, departments) {
    const depts = departments || await api.get('/api/admin/departments').catch(() => []);
    const isNew = !user;
    const form = el('div');
    form.innerHTML = `
      <div class="form-row">
        <div class="field"><label class="field__label">姓名<span class="req">*</span></label>
          <input class="input" id="uName" value="${escapeHtml(user?.name || '')}"></div>
        <div class="field"><label class="field__label">登录账号<span class="req">*</span></label>
          <input class="input" id="uUsername" value="${escapeHtml(user?.username || '')}" ${isNew ? '' : 'disabled'}></div>
      </div>
      <div class="form-row">
        <div class="field"><label class="field__label">${isNew ? '初始密码' : '重置密码（留空不改）'}<span class="req">${isNew ? '*' : ''}</span></label>
          <input class="input" id="uPassword" type="text" placeholder="至少 6 位"></div>
        <div class="field"><label class="field__label">角色</label>
          <select class="select" id="uRole">${[['agent', '客服'], ['admin', '管理员'], ['customer', '客户']]
            .map(([v, l]) => `<option value="${v}" ${user?.role === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="form-row">
        <div class="field"><label class="field__label">手机号</label>
          <input class="input" id="uPhone" value="${escapeHtml(user?.phone || '')}"></div>
        <div class="field"><label class="field__label">邮箱</label>
          <input class="input" id="uEmail" value="${escapeHtml(user?.email || '')}"></div>
      </div>
      <div class="form-row form-row--3">
        <div class="field"><label class="field__label">所属部门</label>
          <select class="select" id="uDept"><option value="">未分配</option>
            ${depts.map((d) => `<option value="${d.id}" ${user?.department_id === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}</select></div>
        <div class="field"><label class="field__label">坐席等级</label>
          <select class="select" id="uLevel">${['初级', '中级', '高级', '资深', '金牌']
            .map((l) => `<option value="${l}" ${user?.level === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label class="field__label">最大同时接待</label>
          <input class="input" id="uMax" type="number" min="1" max="99" value="${user?.max_concurrent || 5}"></div>
      </div>
      <div class="field"><label class="field__label">技能标签</label>
        <input class="input" id="uSkills" value="${escapeHtml((user?.skills || []).join(','))}" placeholder="多个标签用英文逗号分隔，例如：技术支持,接口对接"></div>
      ${isNew ? '' : `<div class="field"><label class="checkbox"><input type="checkbox" id="uActive" ${user.active ? 'checked' : ''}><span>账号启用</span></label></div>`}`;

    modal({
      title: isNew ? '新增账号' : `编辑账号：${user.name}`,
      size: 'lg',
      body: form,
      onMount(c) {
        c.foot = el('div', { class: 'modal__foot' });
        c.foot.appendChild(el('button', { class: 'btn', text: '取消', onClick: () => c.close() }));
        c.foot.appendChild(el('button', {
          class: 'btn btn--primary', text: '保存',
          onClick: async () => {
            const payload = {
              name: $('#uName', form).value.trim(),
              username: $('#uUsername', form).value.trim(),
              password: $('#uPassword', form).value,
              role: $('#uRole', form).value,
              phone: $('#uPhone', form).value.trim(),
              email: $('#uEmail', form).value.trim(),
              department_id: $('#uDept', form).value ? Number($('#uDept', form).value) : null,
              level: $('#uLevel', form).value,
              max_concurrent: Number($('#uMax', form).value) || 5,
              skills: $('#uSkills', form).value.split(',').map((s) => s.trim()).filter(Boolean),
            };
            if (!payload.name) return toast('请填写姓名', 'warning');
            if (isNew) {
              if (!payload.username) return toast('请填写登录账号', 'warning');
              if (!payload.password || payload.password.length < 6) return toast('密码至少 6 位', 'warning');
            } else {
              payload.active = $('#uActive', form).checked ? 1 : 0;
              if (!payload.password) delete payload.password;
            }
            try {
              if (isNew) await api.post('/api/admin/users', payload);
              else await api.put(`/api/admin/users/${user.id}`, payload);
              toast('已保存', 'success');
              c.close();
              loadUsers();
            } catch (err) { toast(err.message, 'error'); }
          },
        }));
        c.dialog.appendChild(c.foot);
      },
    });
  }

  /* ============================== 客户管理 ============================== */

  function viewCustomers() {
    $('#view').innerHTML = `
      <div class="page">
        <div class="card">
          <div class="card__head">
            <span class="card__title">客户档案</span>
            <div class="card__actions">
              <div class="search-box" style="width:230px"><input class="input" id="cuSearch" placeholder="搜索姓名 / 账号 / 手机 / 邮箱…"></div>
              <button class="btn btn--primary btn--sm" id="btnNewCust">＋ 新增客户</button>
            </div>
          </div>
          <div class="card__body card__body--flush" id="cuList"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>
        </div>
      </div>`;
    $('#cuSearch').addEventListener('input', debounce(() => loadCustomers(1), 320));
    $('#btnNewCust').onclick = () => {
      openUserEditor(null);
      setTimeout(() => { const s = document.querySelector('#uRole'); if (s) s.value = 'customer'; }, 80);
    };
    loadCustomers(1);
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
          <thead><tr><th>客户</th><th>联系方式</th><th class="num">会话数</th><th class="num">工单数</th>
            <th>注册时间</th><th>最近登录</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>${res.list.map((u) => `
            <tr>
              <td><div class="flex items-center gap-10">${avatar(u.name, 'sm')}
                <div><div class="cell-main">${escapeHtml(u.name)}</div><div class="cell-sub">@${escapeHtml(u.username)}</div></div></div></td>
              <td>${escapeHtml(u.phone || '-')}<div class="cell-sub">${escapeHtml(u.email || '')}</div></td>
              <td class="num">${u.total_sessions}</td>
              <td class="num">${u.open_tickets}</td>
              <td class="text-sm text-muted">${fmt.date(u.created_at)}</td>
              <td class="text-sm text-muted">${u.last_login_at ? fmt.time(u.last_login_at) : '从未登录'}</td>
              <td><div class="table__actions">
                <button class="btn btn--sm" data-edit="${u.id}">编辑</button>
                <button class="btn btn--sm" data-toggle="${u.id}">${u.active ? '停用' : '启用'}</button>
              </div></td>
            </tr>`).join('')}</tbody></table></div>
        ${paginationHtml(res.pagination)}`;
      box.onclick = async (e) => {
        const edit = e.target.closest('[data-edit]');
        if (edit) { openUserEditor(res.list.find((x) => String(x.id) === edit.dataset.edit)); return; }
        const t = e.target.closest('[data-toggle]');
        if (t) {
          try { await api.post(`/api/admin/users/${t.dataset.toggle}/toggle`, {}); toast('已更新', 'success'); loadCustomers(page); } catch (err) { toast(err.message, 'error'); }
        }
      };
      bindPagination(box, (p) => loadCustomers(p));
    } catch (err) { box.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  /* ============================== 部门管理 ============================== */

  async function viewDepartments() {
    $('#view').innerHTML = '<div class="page"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>';
    try {
      const [depts, ov] = await Promise.all([api.get('/api/admin/departments'), api.get('/api/admin/overview')]);
      void ov;
      $('#view').innerHTML = `
        <div class="page">
          <div class="flex items-center mb-20">
            <div class="flex-1">
              <div class="text-lg fw-600">部门列表（${depts.length}）</div>
              <div class="text-sm text-muted mt-4">部门用于坐席归属、工单自动指派与技能匹配</div>
            </div>
            <button class="btn btn--primary" id="btnNewDept">＋ 新增部门</button>
          </div>
          <div class="grid-3" id="deptGrid">
            ${depts.map((d) => `
              <div class="dept-card">
                <div class="flex items-center gap-10 mb-14">
                  <div style="width:38px;height:38px;border-radius:10px;background:var(--brand-soft);display:grid;place-items:center;font-size:18px">🏢</div>
                  <div class="flex-1">
                    <div class="fw-600">${escapeHtml(d.name)}</div>
                    <div class="text-xs text-muted">${d.agent_count} 名成员 · ${d.online_count} 人在线</div>
                  </div>
                </div>
                <div class="text-sm text-muted mb-14" style="min-height:38px">${escapeHtml(d.description || '暂无描述')}</div>
                <div class="flex gap-8">
                  <button class="btn btn--sm flex-1" data-edit="${d.id}">编辑</button>
                  <button class="btn btn--sm btn--danger" data-del="${d.id}">删除</button>
                </div>
              </div>`).join('')}
          </div>
        </div>`;

      $('#btnNewDept').onclick = () => deptForm(null);
      $('#deptGrid').onclick = async (e) => {
        const edit = e.target.closest('[data-edit]');
        if (edit) { deptForm(depts.find((d) => String(d.id) === edit.dataset.edit)); return; }
        const del = e.target.closest('[data-del]');
        if (del) {
          const d = depts.find((x) => String(x.id) === del.dataset.del);
          if (!await confirm({ title: '删除部门', message: `确定删除「${d.name}」吗？部门下有成员时将无法删除。`, confirmText: '删除', danger: true })) return;
          try { await api.del(`/api/admin/departments/${d.id}`); toast('部门已删除', 'success'); viewDepartments(); } catch (err) { toast(err.message, 'error'); }
        }
      };
    } catch (err) {
      $('#view').innerHTML = `<div class="page">${emptyState('😥', '加载失败', err.message)}</div>`;
    }
  }

  async function deptForm(dept) {
    const data = await formModal({
      title: dept ? '编辑部门' : '新增部门',
      fields: [
        { name: 'name', label: '部门名称', required: true, value: dept?.name || '', placeholder: '例如：售前咨询部' },
        { name: 'description', label: '部门职责', type: 'textarea', rows: 3, value: dept?.description || '', placeholder: '描述该部门负责的业务范围' },
      ],
    });
    if (!data) return;
    try {
      if (dept) await api.put(`/api/admin/departments/${dept.id}`, data);
      else await api.post('/api/admin/departments', data);
      toast('已保存', 'success');
      viewDepartments();
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ============================== 站点托管 ============================== */

  const SITE_STATUS = {
    running: ['运行中', 'badge--success'],
    error: ['部署失败', 'badge--danger'],
    pending: ['处理中', 'badge--warning'],
  };

  async function viewSites() {
    $('#view').innerHTML = '<div class="page"><div class="loading-block"><span class="spinner spinner--lg"></span><span>正在读取站点…</span></div></div>';

    let sites = [];
    let php = { list: [], available: false };
    try {
      const [data, versions] = await Promise.all([
        api.get('/api/admin/sites'),
        api.get('/api/admin/sites/php-versions').catch(() => ({ list: [], available: false })),
      ]);
      sites = data.list || [];
      php = versions || php;
    } catch (err) {
      $('#view').innerHTML = `<div class="page">${emptyState('😥', '加载失败', err.message)}</div>`;
      return;
    }

    const rowHtml = (s) => {
      const [label, variant] = SITE_STATUS[s.status] || [s.status || '未知', 'badge--gray'];
      const index = s.has_index
        ? `<span class="text-xs text-muted">${escapeHtml(s.has_index.file)}</span>`
        : '<span class="text-xs" style="color:var(--danger)">缺入口文件</span>';
      return `
        <tr>
          <td>
            <div class="fw-600">${escapeHtml(s.name)}</div>
            <div class="text-xs text-muted">/s/${escapeHtml(s.slug)}/ · ${escapeHtml(s.created_at || '')}</div>
          </td>
          <td>
            <span class="badge ${s.type === 'php' ? 'badge--info' : 'badge--gray'}">${s.type === 'php' ? 'PHP' : '静态'}</span>
            <div class="text-xs text-muted mt-4">${s.type === 'php' ? escapeHtml(s.php_version || '-') : '—'}</div>
          </td>
          <td>
            <span class="badge ${variant}">${escapeHtml(label)}</span>
            ${s.source === 'github' ? '<div class="text-xs text-muted mt-4">GitHub 部署</div>' : ''}
            ${s.last_error ? `<div class="text-xs mt-4" style="color:var(--danger);max-width:220px">${escapeHtml(String(s.last_error).slice(0, 120))}</div>` : ''}
          </td>
          <td class="text-sm text-muted">${index}<div class="text-xs mt-4">${fmt.bytes(s.size_bytes)}</div></td>
          <td>
            <div class="flex gap-8 flex-wrap">
              <a class="btn btn--sm" href="${escapeHtml(s.url)}" target="_blank" rel="noopener">打开</a>
              <button class="btn btn--sm" data-deploy="${s.id}">部署</button>
              <button class="btn btn--sm" data-edit="${s.id}">设置</button>
              <button class="btn btn--sm" data-history="${s.id}">记录</button>
              <button class="btn btn--sm btn--danger" data-del="${s.id}">删除</button>
            </div>
          </td>
        </tr>`;
    };

    $('#view').innerHTML = `
      <div class="page">
        <div class="flex items-center mb-20">
          <div class="flex-1">
            <div class="text-lg fw-600">站点托管（${sites.length}）</div>
            <div class="text-sm text-muted mt-4">静态站点与 PHP 站点独立端口运行，与客服系统不同源；PHP 在 open_basedir 沙箱内执行</div>
          </div>
          <button class="btn btn--primary" id="btnNewSite">＋ 新建站点</button>
        </div>

        ${php.available ? '' : `
          <div class="card mb-16" style="border-color:#fcd34d;background:#fffbeb">
            <div class="fw-600 mb-6" style="color:#92400e">未检测到本机 PHP</div>
            <div class="text-sm" style="color:#92400e">静态站点可以正常使用；PHP 站点需要先把 <code>php-cgi</code> 放到 PATH 或配置 <code>KEFU_PHP_DIR</code>，然后重启服务。</div>
          </div>`}

        ${sites.length === 0 ? emptyState('🗂️', '还没有站点', '点击右上角「新建站点」，可以从 GitHub 仓库直接部署，也可以创建空站点后自行放入文件。') : `
          <div class="card">
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>站点</th><th>类型</th><th>状态</th><th>入口 / 体积</th><th style="width:280px">操作</th></tr></thead>
                <tbody>${sites.map(rowHtml).join('')}</tbody>
              </table>
            </div>
          </div>`}

        <div class="text-xs text-muted mt-16">
          提示：PHP 站点已禁用 <code>exec / shell_exec / system / popen / fopen / file_put_contents</code> 等危险函数，
          因此依赖写文件或调用外部命令的程序（部分 CMS、安装向导）会运行失败，这是有意的安全取舍。
        </div>
      </div>`;

    $('#btnNewSite').onclick = () => siteForm(null, php);
    $('#view').onclick = async (e) => {
      const pick = (attr) => {
        const t = e.target.closest(`[${attr}]`);
        return t ? sites.find((s) => String(s.id) === t.getAttribute(attr)) : null;
      };

      const edit = pick('data-edit');
      if (edit) { siteForm(edit, php); return; }

      const deploy = pick('data-deploy');
      if (deploy) { deployForm(deploy); return; }

      const history = pick('data-history');
      if (history) { openDeployHistory(history); return; }

      const del = pick('data-del');
      if (del) {
        if (!await confirm({
          title: '删除站点',
          message: `确定删除「${del.name}」吗？站点目录与全部文件会一并删除，且不可恢复。`,
          confirmText: '删除',
          danger: true,
        })) return;
        try {
          await api.del(`/api/admin/sites/${del.id}`);
          toast('站点已删除', 'success');
          viewSites();
        } catch (err) { toast(err.message, 'error'); }
      }
    };
  }

  async function siteForm(site, php) {
    const isNew = !site;
    const versions = (php && php.list) || [];
    const data = await formModal({
      title: isNew ? '新建站点' : `站点设置：${site.name}`,
      submitText: isNew ? '创建' : '保存',
      fields: isNew ? [
        { name: 'slug', label: '站点标识', required: true, placeholder: '例如：blog（小写字母/数字/连字符，3~30 位）', hint: '访问地址为 /s/<标识>/，创建后不可修改' },
        { name: 'name', label: '站点名称', required: true, placeholder: '例如：产品文档' },
        {
          name: 'type',
          label: '站点类型',
          type: 'select',
          value: 'static',
          options: [{ value: 'static', label: '静态站点（HTML/CSS/JS）' }, { value: 'php', label: 'PHP 站点' }],
        },
        {
          name: 'php_version',
          label: 'PHP 版本',
          type: 'select',
          value: versions[0]?.id || '',
          options: versions.length ? versions.map((v) => ({ value: v.id, label: `PHP ${v.version}` })) : [{ value: '', label: '本机未检测到 PHP' }],
          hint: '仅 PHP 站点需要；选择后会以 php-cgi 沙箱方式运行',
        },
      ] : [
        { name: 'name', label: '站点名称', required: true, value: site.name },
        {
          name: 'php_version',
          label: 'PHP 版本',
          type: 'select',
          value: site.php_version || '',
          options: versions.length ? versions.map((v) => ({ value: v.id, label: `PHP ${v.version}` })) : [{ value: '', label: '本机未检测到 PHP' }],
          hint: site.type === 'php' ? '切换版本会立即对后续请求生效' : '当前是静态站点，版本不生效',
        },
      ],
    });
    if (!data) return;

    try {
      if (isNew) {
        await api.post('/api/admin/sites', data);
        toast('站点已创建', 'success');
      } else {
        await api.put(`/api/admin/sites/${site.id}`, data);
        toast('已保存', 'success');
      }
      viewSites();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deployForm(site) {
    const data = await formModal({
      title: `从 GitHub 部署：${site.name}`,
      submitText: '开始部署',
      fields: [
        {
          name: 'repo_url',
          label: '仓库地址',
          required: true,
          value: site.repo_url || '',
          placeholder: 'https://github.com/owner/repo',
          hint: '仅支持 GitHub 公开仓库（下载 codeload tar.gz）',
        },
        { name: 'repo_ref', label: '分支 / 标签', value: site.repo_ref || 'main', placeholder: 'main' },
        { name: 'sub_dir', label: '子目录（可选）', value: site.sub_dir || '', placeholder: '例如：dist', hint: '仓库里要作为站点根目录的目录，留空表示仓库根' },
      ],
    });
    if (!data) return;

    toast('正在下载并部署，请稍候…', 'info', 4000);
    try {
      const r = await api.post(`/api/admin/sites/${site.id}/deploy`, data);
      void r;
      toast('部署完成', 'success');
    } catch (err) {
      toast(err.message, 'error', 6000);
    }
    viewSites();
  }

  async function openDeployHistory(site) {
    let list = [];
    try {
      const data = await api.get(`/api/admin/sites/${site.id}/deploys`);
      list = data.list || [];
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const body = el('div');
    body.innerHTML = list.length === 0
      ? emptyState('📄', '还没有部署记录', '从 GitHub 部署成功后，这里会保留最近 20 次记录。')
      : `<div class="table-wrap"><table class="table table--compact">
          <thead><tr><th>时间</th><th>来源</th><th>版本</th><th>结果</th><th>耗时</th><th>详情</th></tr></thead>
          <tbody>${list.map((d) => `
            <tr>
              <td class="text-xs text-muted">${escapeHtml(d.created_at || '')}</td>
              <td class="text-xs">${escapeHtml(d.source || '-')}</td>
              <td class="text-xs">${escapeHtml(d.ref || '-')}</td>
              <td>${d.status === 'success'
                ? '<span class="badge badge--success">成功</span>'
                : `<span class="badge badge--danger">失败</span>`}</td>
              <td class="text-xs">${d.duration_ms ? `${d.duration_ms} ms` : '-'}</td>
              <td class="text-xs text-muted" style="max-width:260px">${escapeHtml(String(d.detail || '').slice(0, 160))}</td>
            </tr>`).join('')}</tbody>
        </table></div>`;

    modal({ title: `部署记录：${site.name}`, size: 'lg', body });
  }

  /* ============================== 系统设置 ============================== */

  const SETTING_FIELDS = [
    { key: 'site_name', label: '站点名称', desc: '显示在客户端顶部与浏览器标题', type: 'text' },
    { key: 'site_slogan', label: '站点标语', desc: '客户端首页展示的副标题', type: 'text' },
    { key: 'welcome_message', label: '欢迎语', desc: '客户发起会话时自动发送的第一条消息', type: 'textarea' },
    { key: 'queue_notice', label: '排队提示语', desc: '客户等待分配客服时显示的提示', type: 'textarea' },
    { key: 'offline_message', label: '离线留言提示', desc: '非工作时间发给客户的提示语', type: 'textarea' },
    { key: 'work_time', label: '服务时间', desc: '对外公示的客服工作时间', type: 'text' },
    { key: 'auto_assign', label: '自动分配会话', desc: '开启后系统按技能与负载自动派单给在线坐席', type: 'switch' },
    { key: 'max_concurrent', label: '默认最大同时接待数', desc: '新建坐席时的默认并发接待上限', type: 'number' },
    { key: 'auto_close_minutes', label: '会话自动关闭（分钟）', desc: '超过该时长无新消息的会话将被自动结束，填 0 关闭该功能', type: 'number' },
    { key: 'ticket_sla_hours', label: '工单 SLA 基准（小时）', desc: '普通优先级工单的处理时限，其他优先级按比例折算', type: 'number' },
    { key: 'rating_enabled', label: '开启服务评价', desc: '会话结束后邀请客户进行 1-5 星评价', type: 'switch' },
  ];

  async function viewSettings() {
    $('#view').innerHTML = '<div class="page"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>';
    try {
      const { settings } = await api.get('/api/admin/settings');
      $('#view').innerHTML = `
        <div class="page">
          <div class="grid-2" style="align-items:start">
            <div class="card">
              <div class="card__head"><span class="card__title">站点与服务配置</span>
                <div class="card__actions"><button class="btn btn--primary btn--sm" id="btnSave">保存全部设置</button></div></div>
              <div class="card__body">
                ${SETTING_FIELDS.map((f) => `
                  <div class="setting-item">
                    <div class="setting-item__main">
                      <div class="setting-item__label">${f.label}</div>
                      <div class="setting-item__desc">${f.desc}</div>
                    </div>
                    <div class="setting-item__control">
                      ${f.type === 'switch'
                        ? `<label class="switch"><input type="checkbox" data-key="${f.key}" ${settings[f.key] === '1' ? 'checked' : ''}><span class="switch__slider"></span></label>`
                        : f.type === 'textarea'
                          ? `<textarea class="textarea" data-key="${f.key}" rows="2">${escapeHtml(settings[f.key] || '')}</textarea>`
                          : `<input class="input" type="${f.type}" data-key="${f.key}" value="${escapeHtml(settings[f.key] || '')}">`}
                    </div>
                  </div>`).join('')}
              </div>
            </div>
            <div>
              <div class="card mb-20">
                <div class="card__head"><span class="card__title">系统信息</span></div>
                <div class="card__body">
                  ${[['系统名称', '云客客服系统（YunKe Service Desk）'], ['版本', 'v1.0.0'],
                    ['技术栈', 'Node.js + Express + SQLite + WebSocket'], ['数据库', 'SQLite (WAL 模式，位于 data/kefu.db)'],
                    ['文件上传', '最大 10MB，存于 data/uploads']]
                    .map(([k, v]) => `<div class="info-row"><span class="info-row__label" style="width:76px">${k}</span><span class="info-row__value">${escapeHtml(v)}</span></div>`).join('')}
                </div>
              </div>
              <div class="card mb-20">
                <div class="card__head"><span class="card__title">数据维护</span></div>
                <div class="card__body">
                  <div class="text-sm text-muted mb-14">演示环境可重置全部数据（会清空账号、会话、工单等，操作不可恢复）。</div>
                  <button class="btn btn--danger btn--block" id="btnResetInfo">⚠️ 重置演示数据说明</button>
                </div>
              </div>
              <div class="card">
                <div class="card__head"><span class="card__title">快捷入口</span></div>
                <div class="card__body" style="display:grid;gap:8px">
                  <a class="btn btn--block" href="/" target="_blank">🌐 客户端首页</a>
                  <a class="btn btn--block" href="/help" target="_blank">📚 帮助中心</a>
                  <a class="btn btn--block" href="/agent" target="_blank">💬 客服工作台</a>
                  <a class="btn btn--block" href="/api/health" target="_blank">❤️ 服务健康检查</a>
                </div>
              </div>
            </div>
          </div>
        </div>`;

      $('#btnSave').onclick = async () => {
        const payload = {};
        $$('[data-key]', $('#view')).forEach((node) => {
          const key = node.dataset.key;
          payload[key] = node.type === 'checkbox' ? (node.checked ? '1' : '0') : node.value;
        });
        try {
          await api.put('/api/admin/settings', payload);
          toast('系统设置已保存', 'success');
        } catch (err) { toast(err.message, 'error'); }
      };

      $('#btnResetInfo').onclick = () => modal({
        title: '如何重置演示数据',
        size: '',
        body: `<div class="text-2" style="line-height:1.9;font-size:13.5px">
          在项目根目录执行以下命令即可重置为初始演示数据：<div class="code-block mt-14">npm run reset</div>
          <div class="mt-14 text-sm text-muted">注意：该操作会清空全部账号、会话、工单、知识库数据并重新写入演示数据，且不可恢复。若只需重新初始化（数据库已有数据则跳过），可执行 <code class="kbd">npm run seed</code>。</div>
        </div>`,
      });
    } catch (err) {
      $('#view').innerHTML = `<div class="page">${emptyState('😥', '设置加载失败', err.message)}</div>`;
    }
  }

  /* ============================== 操作日志 ============================== */

  function viewLogs() {
    $('#view').innerHTML = `
      <div class="page">
        <div class="card">
          <div class="card__head">
            <span class="card__title">系统操作日志</span>
            <div class="card__actions">
              <div class="search-box" style="width:230px"><input class="input" id="lgSearch" placeholder="搜索操作人 / 动作 / 对象…"></div>
            </div>
          </div>
          <div class="card__body card__body--flush" id="lgList"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>
        </div>
      </div>`;
    $('#lgSearch').addEventListener('input', debounce(() => loadLogs(1), 320));
    loadLogs(1);
  }

  const ACTION_ICON = (action) => {
    if (action.includes('登录')) return '🔑';
    if (action.includes('删除')) return '🗑️';
    if (action.includes('创建') || action.includes('新增')) return '➕';
    if (action.includes('工单')) return '🎫';
    if (action.includes('会话')) return '💬';
    if (action.includes('知识库')) return '📚';
    if (action.includes('设置')) return '🔧';
    return '📝';
  };

  async function loadLogs(page = 1) {
    const box = $('#lgList');
    if (!box) return;
    loading(box);
    try {
      const res = await api.get(`/api/admin/audit-logs${Kefu.qs({ page, pageSize: 25, keyword: $('#lgSearch')?.value || '' })}`);
      if (!res.list.length) { box.innerHTML = emptyState('📝', '暂无操作日志'); return; }
      box.innerHTML = `
        <div class="card__body">
          ${res.list.map((l) => `
            <div class="log-item">
              <div class="log-item__icon">${ACTION_ICON(l.action)}</div>
              <div class="flex-1">
                <div class="flex items-center gap-8 flex-wrap">
                  <span class="fw-500">${escapeHtml(l.user_name || 'system')}</span>
                  <span class="badge badge--brand">${escapeHtml(l.action)}</span>
                  ${l.target ? `<span class="text-muted text-sm ellipsis" style="max-width:260px">${escapeHtml(l.target)}</span>` : ''}
                  <span class="text-xs text-muted ml-auto">${fmt.datetime(l.created_at)}</span>
                </div>
                ${l.detail ? `<div class="text-sm text-muted mt-4">${escapeHtml(l.detail)}</div>` : ''}
              </div>
              <span class="text-xs text-muted" style="width:100px;text-align:right">${escapeHtml(l.ip || '')}</span>
            </div>`).join('')}
        </div>
        ${paginationHtml(res.pagination)}`;
      bindPagination(box, (p) => loadLogs(p));
    } catch (err) { box.innerHTML = emptyState('😥', '加载失败', err.message); }
  }

  /* ============================== 启动 ============================== */

  if (!auth.guard(['admin'])) return;
  initShell();
  window.addEventListener('hashchange', route);
  route();
})();
