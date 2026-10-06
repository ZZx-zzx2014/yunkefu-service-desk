/* ==========================================================================
   客户端门户：首页 / 在线咨询 / 我的工单 / 帮助中心
   ========================================================================== */
(function () {
  'use strict';
  const { api, auth, fmt, $, $$, el, escapeHtml, markdown, toast, modal, confirm, formModal,
    statusBadge, avatar, emptyState, loading, on, sendWS, router, paginationHtml, bindPagination } = Kefu;

  let settings = {};
  let currentConv = null;
  let messageTimer = null;
  let lastMessageId = 0;
  let typingTimer = null;

  /* ============================== 登录 ============================== */

  /** 是否处于测试模式（由服务端 /api/auth/settings 告知） */
  function isTestMode() {
    return (Kefu.state.settings || settings || {}).test_mode === true;
  }

  /** 测试模式提示条：明确告知仅限本机/局域网使用，且「一键体验」可免密码进入 */
  function renderTestModeBanner() {
    const existing = document.getElementById('testModeBanner');
    if (existing) existing.remove();
    if (!isTestMode()) return;

    const bar = document.createElement('div');
    bar.id = 'testModeBanner';
    bar.setAttribute('style', [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:800',
      'background:#fffbeb', 'border-top:1px solid #fde68a', 'color:#92400e',
      'font-size:12.5px', 'padding:8px 14px', 'text-align:center', 'line-height:1.6',
    ].join(';'));
    bar.innerHTML = '⚠️ <strong>测试模式</strong>：仅供本机 / 局域网试用，'
      + '「一键体验」可免密码进入（含管理员）。'
      + '请勿将本机端口映射到公网；对外服务请设置 <code>KEFU_TEST_MODE=0</code> 与 <code>KEFU_SECRET</code>。';
    document.body.appendChild(bar);
  }

  function requireLogin(message = '请先登录后使用该功能') {
    if (auth.isLogin) return true;
    openLogin(message);
    return false;
  }

  function openLogin(hint) {
    const wrap = el('div');
    wrap.innerHTML = `
      ${hint ? `<div class="badge badge--warning mb-14" style="height:auto;padding:8px 12px;border-radius:8px">${escapeHtml(hint)}</div>` : ''}
      <!-- 第一步：口令 -->
      <div id="stepPwd">
        <div class="segmented mb-14" id="loginTab">
          <button class="segmented__item is-active" data-mode="login">登录</button>
          <button class="segmented__item" data-mode="register">注册</button>
        </div>
        <form id="loginForm">
          <div class="field"><label class="field__label">账号 / 邮箱</label>
            <input class="input" name="username" placeholder="请输入账号或邮箱" autocomplete="username"></div>
          <div class="field"><label class="field__label">密码</label>
            <input class="input" type="password" name="password" placeholder="请输入密码" autocomplete="current-password"></div>
          <div class="field hidden" data-reg><label class="field__label">姓名</label>
            <input class="input" name="name" placeholder="请输入您的称呼"></div>
          <div class="field hidden" data-reg><label class="field__label">手机号</label>
            <input class="input" name="phone" placeholder="选填，便于我们联系您"></div>
          <div class="field hidden" data-reg><label class="field__label">邮箱</label>
            <input class="input" name="email" placeholder="选填"></div>
          <button class="btn btn--primary btn--block btn--lg mt-8" type="submit" id="submitBtn">登 录</button>
        </form>
        <div class="demo-accounts" id="demoBox">
          <div class="text-xs text-muted mb-8">快速体验（演示账号）</div>
          <button class="demo-account" data-demo="customer">
            <span class="avatar avatar--sm avatar--c1">客</span>
            <div class="flex-1"><div class="fw-500">客户视角</div><div class="text-xs text-muted">user1 / user123</div></div>
            <span class="text-brand text-sm">一键进入 ›</span>
          </button>
          <button class="demo-account" data-demo="agent">
            <span class="avatar avatar--sm avatar--c2">服</span>
            <div class="flex-1"><div class="fw-500">客服工作台</div><div class="text-xs text-muted">agent1 / agent123</div></div>
            <span class="text-brand text-sm">进入 ›</span>
          </button>
          <button class="demo-account" data-demo="admin">
            <span class="avatar avatar--sm avatar--c4">管</span>
            <div class="flex-1"><div class="fw-500">管理后台</div><div class="text-xs text-muted">admin / admin123</div></div>
            <span class="text-brand text-sm">进入 ›</span>
          </button>
        </div>
      </div>

      <!-- 第二步：双因素验证 -->
      <div id="step2fa" class="hidden">
        <div class="text-center mb-14">
          <div style="font-size:34px">🔐</div>
          <div class="fw-600 text-lg mt-8">两步验证</div>
          <div class="text-sm text-muted mt-4" id="tfHint">请输入验证器应用中的 6 位动态验证码</div>
        </div>
        <div class="field">
          <input class="input" id="tfCode" placeholder="6 位验证码，或备份码" autocomplete="one-time-code"
            style="height:46px;font-size:19px;letter-spacing:5px;text-align:center;font-family:var(--mono)">
        </div>
        <div class="flex items-center gap-8 mb-14">
          <span class="text-xs text-muted" id="tfTimer"></span>
          <button class="btn btn--sm ml-auto" type="button" id="tfBack">‹ 返回</button>
        </div>
        <button class="btn btn--primary btn--block btn--lg" id="tfSubmit">验 证 并 登 录</button>
      </div>`;

    let mode = 'login';
    const ctx = modal({ title: '登录云客客服中心', body: wrap, size: 'sm' });

    const form = $('#loginForm', wrap);
    const submitBtn = $('#submitBtn', wrap);
    const tab = $('#loginTab', wrap);
    const stepPwd = $('#stepPwd', wrap);
    const step2fa = $('#step2fa', wrap);
    let twoFactorToken = '';
    let timerHandle = null;

    const stopTimer = () => { if (timerHandle) { clearInterval(timerHandle); timerHandle = null; } };
    const originalClose = ctx.close;
    ctx.close = () => { stopTimer(); originalClose(); };

    /** 切换到第二步 */
    function showTwoFactor(token, hint) {
      twoFactorToken = token;
      stepPwd.classList.add('hidden');
      step2fa.classList.remove('hidden');
      if (hint) $('#tfHint', wrap).textContent = hint;
      $('.modal__title', ctx.dialog).textContent = '两步验证';
      // 验证码有效期倒计时提示
      let left = 30;
      $('#tfTimer', wrap).textContent = `验证码约 ${left} 秒后更新`;
      stopTimer();
      timerHandle = setInterval(() => {
        left -= 1;
        if (left <= 0) left = 30;
        const node = $('#tfTimer', wrap);
        if (node) node.textContent = `验证码约 ${left} 秒后更新`;
      }, 1000);
      setTimeout(() => $('#tfCode', wrap)?.focus(), 80);
    }

    async function finishLogin(data) {
      auth.setSession(data.token, data.user);
      stopTimer();
      ctx.close();
      if (data.usedBackupCode) {
        toast(`已使用备份码登录，剩余 ${data.backupCodesLeft} 个，请尽快重新生成`, 'warning', 5000);
      } else {
        toast('登录成功，欢迎回来！', 'success');
      }
      renderUserArea();
      route();
    }

    tab.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;
      mode = btn.dataset.mode;
      $$('.segmented__item', tab).forEach((b) => b.classList.toggle('is-active', b === btn));
      $$('[data-reg]', wrap).forEach((n) => n.classList.toggle('hidden', mode !== 'register'));
      // 「一键体验」只在测试模式下显示：该接口在非测试模式会被服务端拒绝
      const demoBox = $('#demoBox', wrap);
      if (demoBox) demoBox.classList.toggle('hidden', mode !== 'login');
      submitBtn.textContent = mode === 'login' ? '登 录' : '注 册 并 登 录';
    });

    // 非测试模式：直接移除一键体验区块（服务端会拒绝该接口）
    if (!isTestMode()) {
      const box = $('#demoBox', wrap);
      if (box) box.remove();
    }

    wrap.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-demo]');
      if (!btn) return;
      try {
        const user = await auth.demo(btn.dataset.demo);
        stopTimer();
        ctx.close();
        toast(`已以「${user.name}」身份进入`, 'success');
        if (user.role !== 'customer') {
          setTimeout(() => { location.href = user.role === 'admin' ? '/admin' : '/agent'; }, 500);
        } else {
          renderUserArea();
          route();
        }
      } catch (err) { toast(err.message, 'error'); }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = {};
      new FormData(form).forEach((v, k) => { data[k] = String(v).trim(); });
      if (!data.username || !data.password) return toast('请填写账号和密码', 'warning');
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner"></span>';
      try {
        if (mode === 'login') {
          const res = await auth.login(data.username, data.password);
          // 该账号启用了 2FA：进入第二步
          if (res && res.twoFactorRequired) {
            showTwoFactor(res.twoFactorToken, res.hint);
            return;
          }
          await finishLogin({ token: res.token, user: res.user });
        } else {
          const user = await auth.register(data);
          await finishLogin({ token: auth.token, user });
        }      } catch (err) {
        toast(err.message, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = mode === 'login' ? '登 录' : '注 册 并 登 录';
      }
    });

    $('#tfBack', wrap).addEventListener('click', () => {
      stopTimer();
      twoFactorToken = '';
      step2fa.classList.add('hidden');
      stepPwd.classList.remove('hidden');
      $('.modal__title', ctx.dialog).textContent = '登录云客客服中心';
      $('#tfCode', wrap).value = '';
    });

    const tfSubmit = $('#tfSubmit', wrap);
    const doVerify = async () => {
      const code = $('#tfCode', wrap).value.trim();
      if (!code) return toast('请输入验证码', 'warning');
      tfSubmit.disabled = true;
      tfSubmit.innerHTML = '<span class="spinner"></span>';
      try {
        const data = await auth.verifyTwoFactor(twoFactorToken, code);
        await finishLogin(data);
      } catch (err) {
        toast(err.message, 'error');
        $('#tfCode', wrap).value = '';
        $('#tfCode', wrap).focus();
      } finally {
        tfSubmit.disabled = false;
        tfSubmit.textContent = '验 证 并 登 录';
      }
    };
    tfSubmit.addEventListener('click', doVerify);
    $('#tfCode', wrap).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doVerify(); }
    });
  }

  function renderUserArea() {
    const area = $('#userArea');
    if (!auth.isLogin) {
      area.innerHTML = '';
      const btn = el('button', { class: 'btn btn--primary btn--sm', text: '登录 / 注册', onClick: () => openLogin() });
      area.appendChild(btn);
      return;
    }
    const u = auth.user;
    area.innerHTML = `
      <div class="portal-user" id="userMenu">
        <span class="avatar avatar--sm avatar--c${(u.name.charCodeAt(0) % 5) + 1}">${escapeHtml(u.name.charAt(0))}</span>
        <div style="line-height:1.25">
          <div class="text-sm fw-500">${escapeHtml(u.name)}</div>
          <div class="text-xs text-muted">${Kefu.STATUS_TEXT[u.role] || u.role}</div>
        </div>
        <span class="text-xs text-muted">▾</span>
      </div>`;
    $('#userMenu').addEventListener('click', (e) => {
      Kefu.dropdown(e.currentTarget, [
        ...(auth.isStaff() ? [
          { icon: '💬', label: '客服工作台', onClick: () => { location.href = '/agent'; } },
          ...(auth.is('admin') ? [{ icon: '⚙️', label: '管理后台', onClick: () => { location.href = '/admin'; } }] : []),
          { divider: true },
        ] : []),
        { icon: '🎫', label: '我的工单', onClick: () => { location.hash = '#/tickets'; } },
        { icon: '📚', label: '帮助中心', onClick: () => { location.hash = '#/help'; } },
        { icon: '🔐', label: '账号安全（两步验证）', onClick: openSecurityCenter },
        { divider: true },
        { icon: '🚪', label: '退出登录', danger: true, onClick: () => auth.logout() },
      ]);
    });
  }

  /* ============================== 账号安全 / 2FA ============================== */

  /** 账号安全中心：启用、关闭、查看与重置两步验证 */
  async function openSecurityCenter() {
    if (!requireLogin()) return;
    const ctx = modal({
      title: '账号安全',
      size: '',
      body: '<div class="loading-block"><span class="spinner spinner--lg"></span><span>读取安全设置…</span></div>',
    });

    let status;
    try {
      status = await api.get('/api/auth/2fa/status');
    } catch (err) {
      ctx.body.innerHTML = emptyState('😥', '读取失败', err.message);
      return;
    }

    const render = (s) => {
      ctx.body.innerHTML = `
        <div class="flex items-center gap-14 mb-20">
          <div style="width:46px;height:46px;border-radius:13px;display:grid;place-items:center;font-size:22px;
            background:${s.enabled ? 'var(--success-soft)' : 'var(--bg-2)'}">${s.enabled ? '🔐' : '🔓'}</div>
          <div class="flex-1">
            <div class="fw-600">两步验证（TOTP）</div>
            <div class="text-sm text-muted mt-4">
              ${s.enabled
                ? `已启用${s.confirmedAt ? ` · 启用时间 ${fmt.datetime(s.confirmedAt)}` : ''}`
                : '未启用。启用后登录需额外输入验证器应用生成的动态验证码'}
            </div>
          </div>
          <span class="badge ${s.enabled ? 'badge--success' : 'badge--warning'}">${s.enabled ? '已启用' : '未启用'}</span>
        </div>

        ${s.enabled ? `
          <div class="card mb-14"><div class="card__body">
            <div class="flex items-center gap-10">
              <div class="flex-1">
                <div class="text-sm fw-500">备份码</div>
                <div class="text-xs text-muted mt-4">
                  剩余 ${s.backupCodesLeft} 个。忘记验证器时可用备份码登录，每个只能使用一次。
                </div>
              </div>
              <button class="btn btn--sm" id="btnRegenBackup">重新生成</button>
            </div>
          </div></div>
          <div class="text-sm text-muted mb-14">
            关闭两步验证需要验证登录密码与当前动态验证码。
          </div>
          <button class="btn btn--danger btn--block" id="btnDisable2fa">关闭两步验证</button>
        ` : `
          <div class="text-sm text-2 mb-14" style="line-height:1.9">
            推荐使用 <strong>Google Authenticator</strong>、<strong>Microsoft Authenticator</strong>
            或 <strong>1Password</strong> 等标准验证器应用。
          </div>
          <button class="btn btn--primary btn--block" id="btnSetup2fa">开始设置</button>
        `}`;

      const setup = $('#btnSetup2fa', ctx.body);
      if (setup) setup.onclick = () => startSetup();

      const disable = $('#btnDisable2fa', ctx.body);
      if (disable) disable.onclick = () => disableTwoFactor();

      const regen = $('#btnRegenBackup', ctx.body);
      if (regen) regen.onclick = () => regenerateBackupCodes();
    };

    /** 展示备份码（仅一次） */
    const showBackupCodes = (codes, warning) => {
      ctx.body.innerHTML = `
        <div class="badge badge--warning mb-14" style="height:auto;padding:10px 12px;border-radius:8px;line-height:1.7">
          ⚠️ ${escapeHtml(warning)}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-family:var(--mono);font-size:14px">
          ${codes.map((c) => `<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:9px 12px;text-align:center;letter-spacing:1px">${escapeHtml(c)}</div>`).join('')}
        </div>
        <div class="flex gap-10 mt-20">
          <button class="btn flex-1" id="btnCopyCodes">复制全部</button>
          <button class="btn" id="btnDownloadCodes">下载 txt</button>
          <button class="btn btn--primary flex-1" id="btnCodesDone">我已保存</button>
        </div>`;
      $('.modal__title', ctx.dialog).textContent = '请保存备份码';

      $('#btnCopyCodes', ctx.body).onclick = () => {
        navigator.clipboard?.writeText(codes.join('\n'))
          .then(() => toast('已复制到剪贴板', 'success'), () => toast('复制失败，请手动记录', 'error'));
      };
      $('#btnDownloadCodes', ctx.body).onclick = () => {
        const blob = new Blob([`云客客服中心 - 两步验证备份码\n账号：${auth.user.username}\n生成时间：${new Date().toLocaleString()}\n\n${codes.join('\n')}\n`],
          { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `2fa-backup-codes-${auth.user.username}.txt`;
        a.click();
        URL.revokeObjectURL(a.href);
      };
      $('#btnCodesDone', ctx.body).onclick = async () => {
        await refreshSecurityStatus();
      };
    };

    const refreshSecurityStatus = async () => {
      $('.modal__title', ctx.dialog).textContent = '账号安全';
      try {
        render(await api.get('/api/auth/2fa/status'));
      } catch (err) {
        ctx.body.innerHTML = emptyState('😥', '读取失败', err.message);
      }
    };

    /** 开始绑定：展示密钥与 otpauth 链接，输入验证码后启用 */
    const startSetup = async () => {
      let info;
      try {
        info = await api.post('/api/auth/2fa/setup', {});
      } catch (err) {
        return toast(err.message, 'error');
      }
      const secretGroups = info.secret.match(/.{1,4}/g).join(' ');

      ctx.body.innerHTML = `
        <div class="text-sm fw-500 mb-8">1. 在验证器应用中添加账号</div>
        <div class="text-xs text-muted mb-14" style="line-height:1.8">
          打开验证器应用 → 添加账号 → 手动输入密钥（或粘贴下方链接）。
          账号名填 <code class="kbd">${escapeHtml(info.account)}</code>，
          发行方 <code class="kbd">${escapeHtml(info.issuer)}</code>。
        </div>

        <div class="field">
          <label class="field__label">密钥（Base32）</label>
          <div class="flex gap-8">
            <input class="input" id="tfSecret" readonly value="${escapeHtml(info.secret)}"
              style="font-family:var(--mono);letter-spacing:1px">
            <button class="btn" id="btnCopySecret" title="复制密钥">复制</button>
          </div>
          <div class="field__hint">格式：每 4 位一组 —— ${escapeHtml(secretGroups)}</div>
        </div>

        <div class="field">
          <label class="field__label">配置链接（otpauth://）</label>
          <div class="flex gap-8">
            <input class="input" id="tfUri" readonly value="${escapeHtml(info.otpauthUrl)}" style="font-size:12px">
            <button class="btn" id="btnCopyUri" title="复制链接">复制</button>
          </div>
          <div class="field__hint">支持点击链接直接唤起本机验证器应用</div>
        </div>

        <div class="divider"></div>

        <div class="text-sm fw-500 mb-8">2. 输入验证器生成的 6 位验证码以完成绑定</div>
        <div class="field">
          <input class="input" id="tfSetupCode" placeholder="000000" inputmode="numeric" maxlength="6"
            autocomplete="one-time-code"
            style="height:46px;font-size:20px;letter-spacing:6px;text-align:center;font-family:var(--mono)">
        </div>
        <button class="btn btn--primary btn--block" id="btnEnable2fa">验证并启用</button>
        <button class="btn btn--block mt-8" id="btnCancelSetup">取消</button>`;

      const copy = (text, label) => {
        navigator.clipboard?.writeText(text)
          .then(() => toast(`${label}已复制`, 'success'), () => toast('复制失败，请手动选择', 'error'));
      };
      $('#btnCopySecret', ctx.body).onclick = () => copy(info.secret, '密钥');
      $('#btnCopyUri', ctx.body).onclick = () => copy(info.otpauthUrl, '配置链接');
      $('#btnCancelSetup', ctx.body).onclick = () => refreshSecurityStatus();

      const enable = async () => {
        const code = $('#tfSetupCode', ctx.body).value.trim();
        if (!/^\d{6}$/.test(code)) return toast('请输入 6 位数字验证码', 'warning');
        const btn = $('#btnEnable2fa', ctx.body);
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
        try {
          const res = await api.post('/api/auth/2fa/enable', { code });
          showBackupCodes(res.backupCodes, res.warning);
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = '验证并启用';
        }
      };
      $('#btnEnable2fa', ctx.body).onclick = enable;
      $('#tfSetupCode', ctx.body).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); enable(); }
      });
      setTimeout(() => $('#tfSetupCode', ctx.body)?.focus(), 80);
    };

    /** 关闭 2FA */
    const disableTwoFactor = async () => {
      const data = await formModal({
        title: '关闭两步验证',
        submitText: '确认关闭',
        fields: [
          { name: 'password', label: '登录密码', type: 'password', required: true, placeholder: '请输入当前登录密码' },
          { name: 'code', label: '动态验证码或备份码', required: true, placeholder: '验证器中的 6 位验证码' },
        ],
      });
      if (!data) return;
      try {
        await api.post('/api/auth/2fa/disable', data);
        toast('两步验证已关闭', 'success');
        refreshSecurityStatus();
      } catch (err) { toast(err.message, 'error'); }
    };

    /** 重新生成备份码 */
    const regenerateBackupCodes = async () => {
      const data = await formModal({
        title: '重新生成备份码',
        submitText: '生成新备份码',
        fields: [{ name: 'code', label: '当前动态验证码', required: true, placeholder: '验证器中的 6 位验证码' }],
      });
      if (!data) return;
      try {
        const res = await api.post('/api/auth/2fa/backup-codes/regenerate', data);
        showBackupCodes(res.backupCodes, res.warning);
      } catch (err) { toast(err.message, 'error'); }
    };

    render(status);
  }

  /* ============================== 首页 ============================== */

  function viewHome() {
    $('#view').innerHTML = `
      <section class="hero">
        <div class="hero__inner">
          <div class="hero__tag">🎧 ${escapeHtml(settings.site_slogan || '7×24 小时为您服务')}</div>
          <h1 class="hero__title">每一个问题<br>都值得被认真对待</h1>
          <p class="hero__desc">
            多渠道在线客服、智能工单流转、完善的知识库与 7×24 服务保障。
            无论您遇到产品咨询、技术支持还是账务问题，我们都随时待命。
          </p>
          <div class="hero__btns">
            <button class="hero__btn hero__btn--primary" data-go="chat">💬 立即在线咨询</button>
            <button class="hero__btn hero__btn--ghost" data-go="tickets">🎫 提交工单</button>
            <button class="hero__btn hero__btn--ghost" data-go="help">📚 浏览帮助中心</button>
          </div>
          <div class="hero__stats">
            <div><div class="hero__stat-value" id="statAgents">-</div><div class="hero__stat-label">在线客服</div></div>
            <div><div class="hero__stat-value" id="statArticles">-</div><div class="hero__stat-label">帮助文档</div></div>
            <div><div class="hero__stat-value">≤ 30s</div><div class="hero__stat-label">平均首次响应</div></div>
            <div><div class="hero__stat-value" id="statRating">-</div><div class="hero__stat-label">客户满意度</div></div>
          </div>
        </div>
      </section>

      <div class="section">
        <div class="section__head">
          <h2 class="section__title">我们能帮您做什么</h2>
          <p class="section__desc">覆盖售前咨询到售后服务的完整服务链路</p>
        </div>
        <div class="feature-grid">
          <div class="feature"><div class="feature__icon" style="background:var(--brand-soft)">💬</div>
            <div class="feature__title">实时在线咨询</div>
            <div class="feature__desc">与真人客服实时对话，支持图片、文件发送，聊天记录永久保留，随时回看历史会话。</div></div>
          <div class="feature"><div class="feature__icon" style="background:var(--success-soft)">🎫</div>
            <div class="feature__title">工单跟踪处理</div>
            <div class="feature__desc">复杂问题一键转工单，跨部门流转，SLA 时效保障，处理进度实时推送。</div></div>
          <div class="feature"><div class="feature__icon" style="background:var(--warning-soft)">📚</div>
            <div class="feature__title">自助帮助中心</div>
            <div class="feature__desc">分类清晰的知识库与搜索，常见问题自助解决，无需等待。</div></div>
          <div class="feature"><div class="feature__icon" style="background:var(--info-soft)">⭐</div>
            <div class="feature__title">服务评价</div>
            <div class="feature__desc">会话结束即可评价，您的每一条反馈都会直达客服主管，帮助我们持续改进。</div></div>
        </div>
      </div>

      <div class="section" style="padding-top:0">
        <div class="section__head">
          <h2 class="section__title">热门帮助文档</h2>
          <p class="section__desc">这些内容最近被查看最多</p>
        </div>
        <div class="kb-grid" id="popularList"></div>
      </div>`;

    $$('[data-go]').forEach((btn) => btn.addEventListener('click', () => {
      if (btn.dataset.go === 'chat' && !requireLogin()) return;
      location.hash = `#/${btn.dataset.go}`;
    }));

    api.get('/api/dashboard/realtime', { noRedirect: true }).then((d) => {
      const a = $('#statAgents'); if (a) a.textContent = d.onlineAgents || 0;
      const r = $('#statRating'); if (r) r.textContent = d.todayRating ? `${d.todayRating} 分` : '4.8 分';
    }).catch(() => {
      const r = $('#statRating'); if (r) r.textContent = '4.8 分';
    });

    api.get('/api/kb/popular').then((list) => {
      const wrap = $('#popularList');
      const st = $('#statArticles'); if (st) st.textContent = list.length ? `${list.length}+` : '10+';
      if (!list.length) { wrap.innerHTML = emptyState('📚', '暂无帮助文档'); return; }
      wrap.innerHTML = list.map((a) => `
        <div class="kb-card" data-article="${a.id}">
          <div class="kb-card__icon">${a.category_icon || '📄'}</div>
          <div class="kb-card__title">${escapeHtml(a.title)}</div>
          <div class="kb-card__desc">${escapeHtml(a.category_name || '')} · ${fmt.number(a.views)} 次浏览 · ${a.helpful} 人觉得有用</div>
        </div>`).join('');
      wrap.addEventListener('click', (e) => {
        const card = e.target.closest('[data-article]');
        if (card) location.hash = `#/help/article/${card.dataset.article}`;
      });
    }).catch(() => {});
  }

  /* ============================== 在线咨询 ============================== */

  function viewChat() {
    if (!requireLogin('登录后即可与客服实时对话')) return;
    if (auth.isStaff()) {
      $('#view').innerHTML = `<div class="section">${emptyState('💼', '您当前是客服/管理员账号', '请前往客服工作台接待客户')}
        <div class="flex justify-center"><a class="btn btn--primary btn--lg" href="/agent">进入客服工作台</a></div></div>`;
      return;
    }

    $('#view').innerHTML = `
      <div class="chat-page">
        <div class="chat-panel">
          <div class="chat-panel__head">
            <span class="avatar avatar--c2" id="agentAvatar">云</span>
            <div class="flex-1">
              <div class="fw-600" id="agentName">智能客服分配中…</div>
              <div class="chat-panel__status" id="agentStatus">
                <span class="dot dot--offline"></span><span>正在为您匹配客服</span>
              </div>
            </div>
            <span class="badge badge--brand" id="convCode">—</span>
            <button class="btn btn--sm" id="btnHistory">历史会话</button>
          </div>
          <div class="chat-body" id="chatBody">
            <div class="loading-block"><span class="spinner spinner--lg"></span><span>正在建立会话…</span></div>
          </div>
          <div class="chat-foot">
            <div class="quick-ask" id="quickAsk"></div>
            <div class="chat-toolbar">
              <button class="chat-toolbar__btn" id="btnImage" title="发送图片">🖼️</button>
              <button class="chat-toolbar__btn" id="btnFile" title="发送文件">📎</button>
              <button class="chat-toolbar__btn" id="btnFiles" title="查看本会话的图片与文件">🗂️</button>
              <button class="chat-toolbar__btn" id="btnTicket" title="转为工单">🎫</button>
              <button class="chat-toolbar__btn" id="btnClose" title="结束会话">✅</button>
              <span class="text-xs text-muted ml-auto">Enter 发送 · Shift+Enter 换行</span>
            </div>
            <div class="chat-input-row">
              <textarea class="chat-input" id="chatInput" placeholder="请输入您的问题，我们会尽快回复…" rows="1"></textarea>
              <button class="btn btn--primary btn--lg" id="btnSend">发送</button>
            </div>
            <input type="file" id="filePicker" class="hidden">
          </div>
        </div>

        <aside>
          <div class="side-card">
            <div class="side-card__head">📌 会话信息</div>
            <div class="side-card__body" id="convInfo">
              <div class="text-sm text-muted">正在加载…</div>
            </div>
          </div>
          <div class="side-card">
            <div class="side-card__head">💡 常见问题</div>
            <div class="side-card__body" id="faqList"></div>
          </div>
          <div class="side-card">
            <div class="side-card__head">📞 其他联系方式</div>
            <div class="side-card__body text-sm text-2" style="line-height:2">
              客服热线：400-800-8888<br>
              服务邮箱：support@yunkefu.com<br>
              工作时间：${escapeHtml(settings.work_time || '09:00-21:00')}
            </div>
          </div>
        </aside>
      </div>`;

    bindChatEvents();
    startConversation();
    loadQuickAsk();
  }

  function bindChatEvents() {
    const input = $('#chatInput');
    const send = () => sendMessage();

    $('#btnSend').addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    });

    const picker = $('#filePicker');
    $('#btnImage').addEventListener('click', () => { picker.accept = 'image/*'; picker.dataset.kind = 'image'; picker.click(); });
    $('#btnFile').addEventListener('click', () => { picker.accept = ''; picker.dataset.kind = 'file'; picker.click(); });
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      if (!file) return;
      await uploadFile(file);
      picker.value = '';
    });

    $('#btnTicket').addEventListener('click', () => openTicketForm(currentConv));
    $('#btnFiles').addEventListener('click', openFileLibrary);
    $('#btnClose').addEventListener('click', async () => {
      if (!currentConv || currentConv.status === 'closed') return;
      if (!await confirm({ title: '结束会话', message: '确定要结束当前会话吗？结束后可以重新发起咨询。', confirmText: '结束会话' })) return;
      try {
        await api.post(`/api/conversations/${currentConv.id}/close`, {});
        toast('会话已结束，期待您的评价', 'success');
        await loadMessages(true);
        maybeAskRating();
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#btnHistory').addEventListener('click', openHistory);
  }

  async function loadQuickAsk() {
    const wrap = $('#quickAsk');
    const questions = ['如何注册账号？', '套餐怎么收费？', '忘记密码怎么办？', '如何申请发票？', 'API 怎么对接？'];
    wrap.innerHTML = questions.map((q) => `<button class="quick-ask__item">${escapeHtml(q)}</button>`).join('');
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.quick-ask__item');
      if (!btn) return;
      const input = $('#chatInput');
      input.value = btn.textContent;
      input.focus();
    });
  }

  async function startConversation() {
    try {
      const res = await api.post('/api/conversations', {
        channel: 'web', subject: '网页在线咨询', source_url: location.href,
      });
      currentConv = res.conversation;
      await loadMessages(true);
      updateConvHeader();
      connectRealtime();
    } catch (err) {
      $('#chatBody').innerHTML = emptyState('😥', '会话建立失败', err.message);
    }
  }

  function updateConvHeader() {
    if (!currentConv) return;
    const code = $('#convCode'); if (code) code.textContent = currentConv.code;
    const name = $('#agentName');
    const status = $('#agentStatus');
    const av = $('#agentAvatar');
    if (!name) return;

    if (currentConv.agent_id) {
      name.textContent = currentConv.agent_name || '客服';
      if (av) { av.textContent = (currentConv.agent_name || '客').charAt(0); }
      status.innerHTML = `<span class="dot dot--online"></span><span>${escapeHtml(currentConv.agent_name || '客服')} 正在为您服务</span>`;
    } else if (currentConv.status === 'closed') {
      name.textContent = currentConv.agent_name || '会话已结束';
      status.innerHTML = '<span class="dot dot--offline"></span><span>本次会话已结束</span>';
    } else {
      name.textContent = '正在分配客服…';
      status.innerHTML = '<span class="dot dot--busy"></span><span>您正在排队，请稍候（前面可能有等待用户）</span>';
    }

    const info = $('#convInfo');
    if (info) {
      const rows = [
        ['会话编号', currentConv.code],
        ['会话状态', statusBadge(currentConv.status)],
        ['服务客服', currentConv.agent_name || '未分配'],
        ['咨询渠道', Kefu.STATUS_TEXT[currentConv.channel] || currentConv.channel],
        ['开始时间', fmt.datetime(currentConv.created_at)],
        ['消息条数', `${currentConv.message_count ?? '-'}`],
      ];
      info.innerHTML = `<div style="display:grid;grid-template-columns:88px 1fr;gap:9px 10px;font-size:13px">
        ${rows.map(([k, v]) => `<div class="text-muted">${k}</div><div>${v}</div>`).join('')}
      </div>`;
    }
  }

  function connectRealtime() {
    on('message', (msg) => {
      if (!currentConv || msg.conversationId !== currentConv.id) return;
      if (msg.message && msg.message.id > lastMessageId) {
        lastMessageId = msg.message.id;
        appendMessage(msg.message, true);
        scrollChat();
      }
    });
    on('event', (evt) => {
      if (evt.type === 'conversation:update' && currentConv && evt.conversation.id === currentConv.id) {
        currentConv = { ...currentConv, ...evt.conversation };
        updateConvHeader();
        if (evt.reason === 'assigned') toast(`客服「${evt.conversation.agent_name || ''}」已接入您的会话`, 'success');
        if (evt.reason === 'closed') maybeAskRating();
      }
      if (evt.type === 'typing' && evt.from === 'agent') showTyping();
    });
  }

  function showTyping() {
    const body = $('#chatBody');
    if (!body || $('#typingIndicator')) return;
    const node = el('div', { class: 'msg', id: 'typingIndicator' });
    node.innerHTML = `<span class="avatar avatar--sm avatar--c2">客</span>
      <div class="msg__bubble" style="color:var(--text-3)">正在输入<span class="spinner" style="width:11px;height:11px;border-width:1.5px;vertical-align:middle;margin-left:6px"></span></div>`;
    body.appendChild(node);
    scrollChat();
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { const n = $('#typingIndicator'); if (n) n.remove(); }, 3200);
  }

  async function loadMessages(reset) {
    if (!currentConv) return;
    try {
      const list = await api.get(`/api/conversations/${currentConv.id}/messages`);
      if (reset) lastMessageId = 0;
      const body = $('#chatBody');
      body.innerHTML = '';
      let lastDay = '';
      for (const m of list) {
        const day = String(m.created_at).slice(0, 10);
        if (day !== lastDay) {
          lastDay = day;
          body.appendChild(el('div', { class: 'chat-body__daydiv', html: `<span>${fmt.date(m.created_at)}</span>` }));
        }
        appendMessage(m, false);
        if (m.id > lastMessageId) lastMessageId = m.id;
      }
      // 若客服接入信息在 messages 里缺失，用接口数据补齐
      const detail = await api.get(`/api/conversations/${currentConv.id}`);
      currentConv = { ...currentConv, ...detail.conversation };
      updateConvHeader();
      scrollChat();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function appendMessage(m, animate) {
    const body = $('#chatBody');
    if (!body) return;
    const isMine = m.sender_role === 'customer';
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
        contentHtml = `<a class="msg__file" href="${escapeHtml(m.content)}" download="${escapeHtml(meta.name || '文件')}" target="_blank">
          <span style="font-size:19px">📎</span>
          <div class="flex-1"><div class="fw-500">${escapeHtml(meta.name || '附件')}</div>
          <div class="text-xs text-muted">${fmt.bytes(meta.size || 0)}</div></div>
          <span>⬇</span></a>`;
      } else {
        contentHtml = markdown(m.content);
      }
      node.innerHTML = `
        <span class="avatar avatar--sm avatar--c${colorIdx}">${escapeHtml(String(m.sender_name || (isMine ? '我' : '客')).charAt(0))}</span>
        <div class="msg__main">
          <div class="msg__meta">
            <span>${escapeHtml(isMine ? '我' : (m.sender_name || '客服'))}</span>
            <span>${fmt.clock(m.created_at)}</span>
          </div>
          <div class="msg__bubble">${contentHtml}</div>
        </div>`;
    }
    if (animate) {
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      body.appendChild(node);
      requestAnimationFrame(() => {
        node.style.transition = 'opacity .2s, transform .2s';
        node.style.opacity = '1';
        node.style.transform = 'none';
      });
    } else {
      body.appendChild(node);
    }
    // 图片预览
    const img = node.querySelector('.msg__img');
    if (img) img.addEventListener('click', () => modal({ title: '图片预览', size: 'lg', body: `<img src="${img.src}" style="width:100%;border-radius:10px">` }));
  }

  function safeJSON(str) { try { return JSON.parse(str || '{}'); } catch { return {}; } }

  /** 会话文件库：查看本会话收发过的图片与附件，可重发或下载 */
  async function openFileLibrary() {
    if (!currentConv) return toast('会话尚未建立完成', 'warning');
    const ctx = modal({ title: '本会话的图片与文件', size: 'lg', body: '<div class="loading-block"><span class="spinner spinner--lg"></span><span>加载中…</span></div>' });
    let data;
    try {
      data = await api.get(`/api/conversations/${currentConv.id}/files`);
    } catch (err) {
      ctx.body.innerHTML = emptyState('😥', '加载失败', err.message);
      return;
    }
    if (!data.list.length) {
      ctx.body.innerHTML = emptyState('🗂️', '还没有发送过图片或文件', '聊天中发送的附件会集中显示在这里');
      return;
    }
    ctx.body.innerHTML = `
      <div class="text-xs text-muted mb-14">共 ${data.total} 个附件 · 我发送 ${data.fromCustomer} 个 · 客服发送 ${data.fromAgent} 个</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px">
        ${data.list.map((f) => `
          <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface)">
            ${f.type === 'image'
              ? `<div style="height:96px;background:var(--surface-2);display:grid;place-items:center;overflow:hidden;cursor:zoom-in" data-preview="${escapeHtml(f.url)}">
                   <img src="${escapeHtml(f.url)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover"></div>`
              : '<div style="height:96px;background:var(--surface-2);display:grid;place-items:center;font-size:30px">📎</div>'}
            <div style="padding:9px 11px">
              <div class="text-sm ellipsis" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
              <div class="text-xs text-muted mt-4">${f.sender_role === 'customer' ? '我发送' : '客服发送'} · ${fmt.bytes(f.size)}</div>
              <div class="text-xs text-muted">${fmt.datetime(f.created_at)}</div>
              <div class="flex gap-6 mt-8">
                <button class="btn btn--sm flex-1" data-resend="${escapeHtml(f.url)}" data-rtype="${f.type}"
                        data-rname="${escapeHtml(f.name)}" data-rsize="${f.size}">重新发送</button>
                <a class="btn btn--sm" href="${escapeHtml(f.url)}" download="${escapeHtml(f.name)}" title="下载">⬇</a>
              </div>
            </div>
          </div>`).join('')}
      </div>`;

    ctx.body.onclick = async (e) => {
      const prev = e.target.closest('[data-preview]');
      if (prev) {
        modal({ title: '图片预览', size: 'lg', body: `<img src="${prev.dataset.preview}" style="width:100%;border-radius:10px">` });
        return;
      }
      const btn = e.target.closest('[data-resend]');
      if (!btn) return;
      try {
        const msg = await api.post(`/api/conversations/${currentConv.id}/messages`, {
          content: btn.dataset.resend, type: btn.dataset.rtype,
          meta: { name: btn.dataset.rname, size: Number(btn.dataset.rsize) || 0 },
        });
        if (msg && msg.id > lastMessageId) { lastMessageId = msg.id; appendMessage(msg, true); scrollChat(); }
        toast('已重新发送', 'success');
        ctx.close();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  function scrollChat() {
    const body = $('#chatBody');
    if (body) body.scrollTop = body.scrollHeight;
  }

  async function sendMessage() {
    const input = $('#chatInput');
    const content = input.value.trim();
    if (!content) return;
    if (!currentConv) return toast('会话尚未建立完成', 'warning');
    if (currentConv.status === 'closed') return toast('会话已结束，请刷新页面重新发起咨询', 'warning');

    input.value = '';
    input.style.height = 'auto';
    try {
      const msg = await api.post(`/api/conversations/${currentConv.id}/messages`, { content, type: 'text' });
      if (msg && msg.id > lastMessageId) { lastMessageId = msg.id; appendMessage(msg, true); scrollChat(); }
    } catch (err) {
      toast(err.message, 'error');
      input.value = content;
    }
  }

  async function uploadFile(file) {
    if (!currentConv) return;
    if (file.size > 10 * 1024 * 1024) return toast('文件不能超过 10MB', 'warning');
    const fd = new FormData();
    fd.append('file', file);
    toast('正在上传…', 'info', 1200);
    try {
      const up = await api.upload('/api/conversations/upload', fd);
      const msg = await api.post(`/api/conversations/${currentConv.id}/messages`, {
        content: up.url, type: up.type, meta: { name: up.name, size: up.size, mime: up.mime },
      });
      if (msg && msg.id > lastMessageId) { lastMessageId = msg.id; appendMessage(msg, true); scrollChat(); }
    } catch (err) { toast(err.message, 'error'); }
  }

  function maybeAskRating() {
    if (settings.rating_enabled === '0') return;
    if (!currentConv || currentConv.status !== 'closed') return;
    if (currentConv.rating) return;
    setTimeout(() => openRating(currentConv), 600);
  }

  function openRating(conv) {
    const wrap = el('div');
    wrap.innerHTML = `
      <div class="text-center mb-14">
        <div style="font-size:38px">🌟</div>
        <div class="fw-600 text-lg mt-8">请为本次服务打分</div>
        <div class="text-sm text-muted mt-4">会话 ${escapeHtml(conv.code)} 已结束</div>
      </div>
      <div class="flex justify-center gap-8 mb-14" id="starRow" style="font-size:34px;color:#cbd5e1;cursor:pointer">
        ${[1, 2, 3, 4, 5].map((s) => `<span data-star="${s}" style="transition:transform .15s">★</span>`).join('')}
      </div>
      <div class="text-center text-sm text-muted mb-14" id="starText">点击星星进行评价</div>
      <div class="field"><textarea class="textarea" id="ratingComment" placeholder="补充您的评价（选填）" rows="3"></textarea></div>`;

    let rating = 0;
    const LABELS = { 1: '很不满意', 2: '不满意', 3: '一般', 4: '满意', 5: '非常满意' };

    const ctx = modal({
      title: '服务评价',
      body: wrap,
      size: 'sm',
      onMount(c) {
        const row = $('#starRow', wrap);
        row.addEventListener('click', (e) => {
          const s = e.target.closest('[data-star]');
          if (!s) return;
          rating = Number(s.dataset.star);
          $$('[data-star]', row).forEach((n) => {
            n.style.color = Number(n.dataset.star) <= rating ? '#fbbf24' : '#cbd5e1';
            n.style.transform = Number(n.dataset.star) === rating ? 'scale(1.2)' : 'none';
          });
          $('#starText', wrap).innerHTML = `<strong style="color:var(--warning)">${LABELS[rating]}</strong>`;
        });

        c.foot = el('div', { class: 'modal__foot' });
        c.foot.appendChild(el('button', { class: 'btn', text: '稍后评价', onClick: () => c.close() }));
        c.foot.appendChild(el('button', {
          class: 'btn btn--primary', text: '提交评价',
          onClick: async () => {
            if (!rating) return toast('请先点击星星选择评分', 'warning');
            try {
              await api.post(`/api/conversations/${conv.id}/rating`, { rating, comment: $('#ratingComment', wrap).value });
              toast('感谢您的评价，我们会继续努力！', 'success');
              c.close();
              if (currentConv && currentConv.id === conv.id) currentConv.rating = rating;
            } catch (err) { toast(err.message, 'error'); }
          },
        }));
        c.dialog.appendChild(c.foot);
      },
    });
  }

  async function openHistory() {
    const ctx = modal({ title: '我的历史会话', size: 'lg', body: '<div class="loading-block"><span class="spinner spinner--lg"></span></div>' });
    try {
      const res = await api.get(`/api/conversations${Kefu.qs({ scope: '', pageSize: 50 })}`);
      const list = res.list || [];
      if (!list.length) { ctx.body.innerHTML = emptyState('💬', '暂无历史会话'); return; }
      ctx.body.innerHTML = list.map((c) => `
        <div class="ticket-item" data-conv="${c.id}">
          <div class="flex items-center gap-10">
            <div class="flex-1">
              <div class="fw-500">${escapeHtml(c.subject || '在线咨询')}</div>
              <div class="text-xs text-muted mt-4">${escapeHtml(c.code)} · ${fmt.datetime(c.created_at)} · ${c.agent_name ? `客服 ${escapeHtml(c.agent_name)}` : '未分配'}</div>
            </div>
            ${statusBadge(c.status)}
            ${c.rating ? Kefu.stars(c.rating) : ''}
          </div>
          <div class="text-sm text-muted mt-8 ellipsis">${escapeHtml(c.last_message || '')}</div>
        </div>`).join('');
      ctx.body.addEventListener('click', (e) => {
        const item = e.target.closest('[data-conv]');
        if (!item) return;
        const conv = list.find((c) => String(c.id) === item.dataset.conv);
        if (conv && conv.status !== 'closed') {
          ctx.close();
          currentConv = { ...conv };
          loadMessages(true);
          toast('已切换到该会话', 'success');
        } else {
          toast('该会话已结束，仅可查看记录', 'info');
        }
      });
    } catch (err) {
      ctx.body.innerHTML = emptyState('😥', '加载失败', err.message);
    }
  }

  /* ============================== 我的工单 ============================== */

  function viewTickets(query) {
    if (!requireLogin('登录后可提交和查看您的工单')) return;
    if (query && query.id) return viewTicketDetail(query.id);

    $('#view').innerHTML = `
      <div class="section">
        <div class="flex items-center mb-20 flex-wrap gap-10">
          <div class="flex-1">
            <h2 class="section__title" style="text-align:left;font-size:22px">我的工单</h2>
            <p class="text-sm text-muted mt-4">跟踪问题处理进度，支持与客服在线沟通</p>
          </div>
          <button class="btn btn--primary" id="btnNewTicket">＋ 新建工单</button>
        </div>
        <div class="stat-grid mb-20" id="ticketStats"></div>
        <div class="card">
          <div class="card__head">
            <div class="search-box flex-1" style="max-width:300px">
              <input class="input" id="ticketSearch" placeholder="搜索工单号或标题…">
            </div>
            <select class="select" id="ticketStatus" style="width:140px">
              <option value="">全部状态</option>
              <option value="pending">待处理</option>
              <option value="processing">处理中</option>
              <option value="resolved">已解决</option>
              <option value="closed">已关闭</option>
            </select>
          </div>
          <div class="card__body" id="ticketList"><div class="loading-block"><span class="spinner spinner--lg"></span></div></div>
        </div>
      </div>`;

    $('#btnNewTicket').addEventListener('click', () => openTicketForm(null));
    const search = Kefu.debounce(() => loadTickets(), 350);
    $('#ticketSearch').addEventListener('input', search);
    $('#ticketStatus').addEventListener('change', () => loadTickets());
    loadTicketStats();
    loadTickets();
  }

  async function loadTicketStats() {
    try {
      const s = await api.get('/api/tickets/stats');
      const box = $('#ticketStats');
      if (!box) return;
      box.innerHTML = `
        ${statCard('📋', '全部工单', s.total, '')}
        ${statCard('⏳', '待处理', s.pending, 'stat--warning')}
        ${statCard('🔧', '处理中', s.processing, 'stat--info')}
        ${statCard('✅', '已解决', s.resolved, 'stat--success')}`;
    } catch { /* ignore */ }
  }

  function statCard(icon, label, value, cls) {
    return `<div class="stat ${cls}"><div class="stat__icon">${icon}</div>
      <div class="stat__label">${label}</div><div class="stat__value">${value}</div></div>`;
  }

  async function loadTickets(page = 1) {
    const box = $('#ticketList');
    if (!box) return;
    loading(box);
    try {
      const res = await api.get(`/api/tickets${Kefu.qs({
        page, pageSize: 10,
        keyword: $('#ticketSearch')?.value || '',
        status: $('#ticketStatus')?.value || '',
      })}`);
      if (!res.list.length) {
        box.innerHTML = emptyState('🎫', '还没有工单', '遇到问题可以随时提交工单，我们会尽快处理');
        return;
      }
      box.innerHTML = res.list.map((t) => `
        <div class="ticket-item" data-ticket="${t.id}">
          <div class="flex items-center gap-10 flex-wrap">
            <div class="flex-1" style="min-width:200px">
              <div class="fw-600">${escapeHtml(t.title)}</div>
              <div class="text-xs text-muted mt-4">
                ${escapeHtml(t.code)} · ${escapeHtml(t.category)} · 提交于 ${fmt.datetime(t.created_at)}
                ${t.assignee_name ? ` · 处理人 ${escapeHtml(t.assignee_name)}` : ' · 待指派'}
              </div>
            </div>
            ${t.is_overdue ? '<span class="badge badge--danger">已超时</span>' : ''}
            ${statusBadge(t.priority, Kefu.STATUS_TEXT[t.priority])}
            ${statusBadge(t.status)}
            ${t.rating ? Kefu.stars(t.rating) : ''}
          </div>
          <div class="text-sm text-muted mt-8 clamp-2">${escapeHtml(t.description || '')}</div>
          <div class="flex items-center gap-10 mt-8 text-xs text-muted">
            <span>💬 ${t.comment_count} 条回复</span>
            ${t.updated_at ? `<span>最近更新 ${fmt.time(t.updated_at)}</span>` : ''}
          </div>
        </div>`).join('') + paginationHtml(res.pagination);

      box.addEventListener('click', (e) => {
        const item = e.target.closest('[data-ticket]');
        if (item) location.hash = `#/tickets?id=${item.dataset.ticket}`;
      });
      bindPagination(box, (p) => loadTickets(p));
    } catch (err) {
      box.innerHTML = emptyState('😥', '加载失败', err.message);
    }
  }

  async function viewTicketDetail(id) {
    $('#view').innerHTML = `<div class="section"><div class="loading-block"><span class="spinner spinner--lg"></span><span>加载工单详情…</span></div></div>`;
    try {
      const { ticket, comments } = await api.get(`/api/tickets/${id}`);
      $('#view').innerHTML = `
        <div class="section" style="max-width:940px">
          <button class="btn btn--sm mb-14" data-action="go-tickets">‹ 返回工单列表</button>
          <div class="card mb-20">
            <div class="card__head">
              <div class="flex-1">
                <div class="flex items-center gap-10 flex-wrap">
                  <span class="card__title">${escapeHtml(ticket.title)}</span>
                  ${statusBadge(ticket.status)}
                  ${statusBadge(ticket.priority, Kefu.STATUS_TEXT[ticket.priority])}
                </div>
                <div class="text-xs text-muted mt-4">工单号 ${escapeHtml(ticket.code)} · ${escapeHtml(ticket.category)} · 提交于 ${fmt.datetime(ticket.created_at)}</div>
              </div>
            </div>
            <div class="card__body">
              <div class="text-2" style="white-space:pre-wrap;line-height:1.8">${escapeHtml(ticket.description || '无详细描述')}</div>
              <div class="divider"></div>
              <div class="grid-3 text-sm">
                <div><div class="text-muted text-xs">处理客服</div><div class="mt-4">${escapeHtml(ticket.assignee_name || '待指派')}</div></div>
                <div><div class="text-muted text-xs">所属部门</div><div class="mt-4">${escapeHtml(ticket.department_name || '-')}</div></div>
                <div><div class="text-muted text-xs">SLA 截止</div><div class="mt-4 ${new Date(ticket.sla_due_at) < new Date() && !['closed','resolved'].includes(ticket.status) ? 'text-danger' : ''}">${fmt.datetime(ticket.sla_due_at)}</div></div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card__head"><span class="card__title">处理记录（${comments.length}）</span></div>
            <div class="card__body">
              ${comments.length ? comments.map((c) => `
                <div class="flex gap-10 mb-14">
                  <span class="avatar avatar--sm avatar--c${(String(c.user_name || '系').charCodeAt(0) % 5) + 1}">${escapeHtml(String(c.user_name || '系').charAt(0))}</span>
                  <div class="flex-1">
                    <div class="text-xs text-muted mb-4">${escapeHtml(c.user_name || '系统')} · ${fmt.datetime(c.created_at)}
                      ${c.action !== 'comment' ? `<span class="badge badge--info" style="height:17px;font-size:10.5px">${escapeHtml(c.action)}</span>` : ''}</div>
                    <div class="text-2" style="white-space:pre-wrap;line-height:1.7">${escapeHtml(c.content)}</div>
                  </div>
                </div>`).join('') : '<div class="text-muted text-sm">暂无处理记录</div>'}
            </div>
            ${['closed', 'resolved'].includes(ticket.status) ? '' : `
            <div class="card__body" style="border-top:1px solid var(--border)">
              <textarea class="textarea" id="replyInput" placeholder="补充说明或回复客服…" rows="3"></textarea>
              <div class="flex justify-between items-center mt-8">
                <span class="text-xs text-muted">回复后若工单已解决，将自动重新打开</span>
                <button class="btn btn--primary" id="btnReply">发送回复</button>
              </div>
            </div>`}
          </div>

          ${['resolved', 'closed'].includes(ticket.status) && !ticket.rating ? `
          <div class="card mt-20"><div class="card__body text-center">
            <div class="fw-600 mb-8">问题解决了吗？为我们的服务打个分吧</div>
            <div id="ticketStars" style="font-size:30px;color:#cbd5e1;cursor:pointer">
              ${[1, 2, 3, 4, 5].map((s) => `<span data-star="${s}" style="margin:0 3px">★</span>`).join('')}
            </div>
          </div></div>` : ''}
        </div>`;

      const replyBtn = $('#btnReply');
      if (replyBtn) {
        replyBtn.addEventListener('click', async () => {
          const content = $('#replyInput').value.trim();
          if (!content) return toast('请输入回复内容', 'warning');
          try {
            await api.post(`/api/tickets/${ticket.id}/comments`, { content });
            toast('回复成功', 'success');
            viewTicketDetail(id);
          } catch (err) { toast(err.message, 'error'); }
        });
      }

      const starRow = $('#ticketStars');
      if (starRow) {
        starRow.addEventListener('click', async (e) => {
          const s = e.target.closest('[data-star]');
          if (!s) return;
          try {
            await api.post(`/api/tickets/${ticket.id}/rating`, { rating: Number(s.dataset.star) });
            toast('感谢您的评价！', 'success');
            viewTicketDetail(id);
          } catch (err) { toast(err.message, 'error'); }
        });
      }
    } catch (err) {
      $('#view').innerHTML = `<div class="section">${emptyState('😥', '工单加载失败', err.message)}</div>`;
    }
  }

  /** 新建工单弹窗；conv 不为空时会把会话关联到工单 */
  async function openTicketForm(conv) {
    if (!requireLogin('登录后可提交工单')) return;
    const data = await formModal({
      title: '提交工单',
      submitText: '提交工单',
      fields: [
        { name: 'title', label: '工单标题', required: true, placeholder: '一句话描述您遇到的问题', value: conv ? (conv.subject || '') : '' },
        { name: 'category', label: '问题类型', type: 'select', value: '技术支持',
          options: ['产品咨询', '技术支持', '账务问题', '投诉建议', '功能申请', '其他'].map((c) => ({ value: c, label: c })) },
        { name: 'priority', label: '优先级', type: 'select', value: 'normal',
          options: [{ value: 'low', label: '低 - 不着急' }, { value: 'normal', label: '中 - 一般问题' }, { value: 'high', label: '高 - 影响使用' }, { value: 'urgent', label: '紧急 - 业务受阻' }] },
        { name: 'description', label: '详细描述', type: 'textarea', required: true, rows: 5,
          placeholder: '请详细描述问题现象、复现步骤、期望结果，便于我们更快定位' },
      ],
    });
    if (!data) return;
    try {
      const created = await api.post('/api/tickets', { ...data, conversation_id: conv ? conv.id : null });
      toast(created.status === 'processing' ? '工单已创建，已自动指派处理人' : '工单已提交，我们会尽快处理', 'success');
      if (location.hash.startsWith('#/tickets') && !Kefu.$('#ticketList')) location.hash = `#/tickets?id=${created.id}`;
      else if (location.hash.startsWith('#/tickets')) { loadTickets(); loadTicketStats(); }
      else location.hash = `#/tickets?id=${created.id}`;
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ============================== 帮助中心 ============================== */

  function viewHelp(query) {
    if (query && query.article) return viewArticle(query.article);
    const category = query && query.category ? Number(query.category) : null;

    if (category) {
      return viewCategory(category, query);
    }

    $('#view').innerHTML = `
      <div class="section">
        <div class="text-center mb-20">
          <h2 class="section__title">帮助中心</h2>
          <p class="section__desc">搜索或浏览下方分类，快速找到答案</p>
          <div class="search-box" style="max-width:520px;margin:22px auto 0">
            <input class="input input--lg" id="kbSearch" placeholder="搜索问题关键词，例如：忘记密码、发票、API…"
              style="height:46px;font-size:15px">
          </div>
        </div>
        <div id="kbResult"></div>
        <div id="kbCategories" class="kb-grid"></div>
        <div id="kbPopular" class="mt-20"></div>
      </div>`;

    const search = Kefu.debounce(async (kw) => {
      const box = $('#kbResult');
      if (!kw || kw.length < 1) {
        box.innerHTML = '';
        $('#kbCategories').classList.remove('hidden');
        $('#kbPopular').classList.remove('hidden');
        return;
      }
      $('#kbCategories').classList.add('hidden');
      $('#kbPopular').classList.add('hidden');
      loading(box, '搜索中…');
      try {
        const res = await api.get(`/api/kb/articles${Kefu.qs({ keyword: kw, pageSize: 20 })}`);
        if (!res.list.length) { box.innerHTML = emptyState('🔍', `没有找到与「${kw}」相关的内容`, '可以换个关键词，或直接联系在线客服'); return; }
        box.innerHTML = `<div class="card mb-20"><div class="card__head"><span class="card__title">搜索结果（${res.pagination.total}）</span></div>
          <div class="card__body card__body--flush">
            ${res.list.map((a) => `
              <div class="kb-list__item" data-article="${a.id}">
                <div class="kb-list__title">${escapeHtml(a.title)}</div>
                <div class="kb-list__meta">${escapeHtml(a.category_name || '')} · ${fmt.number(a.views)} 次浏览</div>
                <div class="text-sm text-muted mt-4 clamp-2">${escapeHtml(a.summary || a.excerpt || '')}</div>
              </div>`).join('')}
          </div></div>`;
        box.addEventListener('click', (e) => {
          const item = e.target.closest('[data-article]');
          if (item) location.hash = `#/help/article/${item.dataset.article}`;
        });
      } catch (err) { box.innerHTML = emptyState('😥', '搜索失败', err.message); }
    }, 300);

    $('#kbSearch').addEventListener('input', (e) => search(e.target.value.trim()));

    api.get('/api/kb/categories').then((cats) => {
      const wrap = $('#kbCategories');
      if (!cats.length) { wrap.innerHTML = emptyState('📚', '暂无分类'); return; }
      wrap.innerHTML = cats.map((c) => `
        <div class="kb-card" data-cat="${c.id}">
          <div class="kb-card__icon">${c.icon || '📄'}</div>
          <div class="kb-card__title">${escapeHtml(c.name)}</div>
          <div class="kb-card__desc">${escapeHtml(c.description || '')}</div>
          <div class="mt-8"><span class="badge badge--brand">${c.article_count} 篇文章</span></div>
        </div>`).join('');
      wrap.addEventListener('click', (e) => {
        const card = e.target.closest('[data-cat]');
        if (card) location.hash = `#/help?category=${card.dataset.cat}`;
      });
    }).catch(() => {});

    api.get('/api/kb/popular').then((list) => {
      const wrap = $('#kbPopular');
      if (!list.length) return;
      wrap.innerHTML = `<div class="card"><div class="card__head"><span class="card__title">🔥 热门文档</span></div>
        <div class="card__body card__body--flush">
          ${list.map((a) => `<div class="kb-list__item" data-article="${a.id}">
            <div class="kb-list__title">${escapeHtml(a.title)}</div>
            <div class="kb-list__meta">${a.category_icon || '📄'} ${escapeHtml(a.category_name || '')} · ${fmt.number(a.views)} 次浏览</div>
          </div>`).join('')}
        </div></div>`;
      wrap.addEventListener('click', (e) => {
        const item = e.target.closest('[data-article]');
        if (item) location.hash = `#/help/article/${item.dataset.article}`;
      });
    }).catch(() => {});
  }

  async function viewCategory(categoryId, query) {
    const page = Number(query.page) || 1;
    try {
      const [cats, res] = await Promise.all([
        api.get('/api/kb/categories'),
        api.get(`/api/kb/articles${Kefu.qs({ category_id: categoryId, page, pageSize: 20 })}`),
      ]);
      const cat = cats.find((c) => c.id === categoryId);
      $('#view').innerHTML = `
        <div class="section">
          <button class="btn btn--sm mb-14" data-action="go-help">‹ 返回帮助中心</button>
          <div class="flex items-center gap-14 mb-20">
            <div style="font-size:34px">${cat ? cat.icon : '📄'}</div>
            <div>
              <h2 class="section__title" style="text-align:left;font-size:22px">${escapeHtml(cat ? cat.name : '分类')}</h2>
              <p class="text-sm text-muted mt-4">${escapeHtml(cat ? cat.description : '')}</p>
            </div>
          </div>
          <div class="card"><div class="card__body card__body--flush" id="catList">
            ${res.list.length ? res.list.map((a) => `
              <div class="kb-list__item" data-article="${a.id}">
                <div class="kb-list__title">${escapeHtml(a.title)}</div>
                <div class="kb-list__meta">${fmt.number(a.views)} 次浏览 · ${a.helpful} 人觉得有用 · 更新于 ${fmt.date(a.updated_at)}</div>
                <div class="text-sm text-muted mt-4 clamp-2">${escapeHtml(a.summary || '')}</div>
              </div>`).join('') : emptyState('📄', '该分类下暂无文章')}
          </div>${paginationHtml(res.pagination)}</div>
        </div>`;
      const box = $('#catList');
      box.addEventListener('click', (e) => {
        const item = e.target.closest('[data-article]');
        if (item) location.hash = `#/help/article/${item.dataset.article}`;
      });
      bindPagination($('#view'), (p) => { location.hash = `#/help?category=${categoryId}&page=${p}`; });
    } catch (err) {
      $('#view').innerHTML = `<div class="section">${emptyState('😥', '加载失败', err.message)}</div>`;
    }
  }

  async function viewArticle(id) {
    $('#view').innerHTML = `<div class="section"><div class="loading-block"><span class="spinner spinner--lg"></span><span>加载文章…</span></div></div>`;
    try {
      const { article, related, prev, next } = await api.get(`/api/kb/articles/${id}`);
      $('#view').innerHTML = `
        <div class="section">
          <button class="btn btn--sm mb-14" data-action="go-back">‹ 返回</button>
          <div class="article-view">
            <div class="mb-20">
              <div class="text-sm text-muted mb-8">${article.category_icon || '📄'} ${escapeHtml(article.category_name || '未分类')}
                · ${fmt.number(article.views)} 次浏览 · 更新于 ${fmt.date(article.updated_at)}</div>
              <h1 style="font-size:27px;font-weight:700;line-height:1.35">${escapeHtml(article.title)}</h1>
              ${article.summary ? `<p class="text-2 mt-8" style="font-size:15px">${escapeHtml(article.summary)}</p>` : ''}
            </div>
            <div class="card"><div class="card__body">
              <div class="article-view__content">${markdown(article.content)}</div>
            </div></div>

            <div class="card mt-20"><div class="card__body flex items-center gap-14 flex-wrap">
              <span class="fw-500">这篇文章对您有帮助吗？</span>
              <button class="btn btn--sm" id="btnHelpful">👍 有帮助 (${article.helpful})</button>
              <button class="btn btn--sm" id="btnNotHelpful">👎 没帮助 (${article.not_helpful})</button>
              <button class="btn btn--sm ml-auto" id="btnAskAgent">💬 联系在线客服</button>
            </div></div>

            ${related.length ? `<div class="card mt-20"><div class="card__head"><span class="card__title">相关文档</span></div>
              <div class="card__body card__body--flush">
                ${related.map((r) => `<div class="kb-list__item" data-article="${r.id}">
                  <div class="kb-list__title">${escapeHtml(r.title)}</div>
                  <div class="kb-list__meta">${fmt.number(r.views)} 次浏览</div></div>`).join('')}
              </div></div>` : ''}

            <div class="flex justify-between mt-20 gap-10">
              ${prev ? `<button class="btn" data-article="${prev.id}">‹ ${escapeHtml(prev.title.slice(0, 22))}</button>` : '<span></span>'}
              ${next ? `<button class="btn" data-article="${next.id}">${escapeHtml(next.title.slice(0, 22))} ›</button>` : ''}
            </div>
          </div>
        </div>`;

      $('#view').addEventListener('click', (e) => {
        const item = e.target.closest('[data-article]');
        if (item && item.tagName !== 'A') location.hash = `#/help/article/${item.dataset.article}`;
      });
      $('#btnHelpful').addEventListener('click', async (e) => {
        await api.post(`/api/kb/articles/${id}/feedback`, { helpful: true }).catch(() => {});
        e.target.textContent = '👍 感谢反馈';
        e.target.disabled = true;
        toast('感谢您的反馈！', 'success');
      });
      $('#btnNotHelpful').addEventListener('click', async (e) => {
        await api.post(`/api/kb/articles/${id}/feedback`, { helpful: false }).catch(() => {});
        e.target.textContent = '👎 已记录';
        e.target.disabled = true;
        toast('我们会继续完善这篇文章', 'info');
      });
      $('#btnAskAgent').addEventListener('click', () => {
        if (!requireLogin()) return;
        location.hash = '#/chat';
      });
    } catch (err) {
      $('#view').innerHTML = `<div class="section">${emptyState('😥', '文章不存在', err.message)}
        <div class="flex justify-center"><a class="btn btn--primary" href="#/help">返回帮助中心</a></div></div>`;
    }
  }

  /* ============================== 路由 ============================== */

  function parseHash() {
    const hash = location.hash.replace(/^#/, '') || '/home';
    const [path, qs] = hash.split('?');
    return { path: path || '/home', query: Object.fromEntries(new URLSearchParams(qs || '')) };
  }

  function route() {
    const { path, query } = parseHash();

    // 导航高亮
    const navKey = path.startsWith('/help') ? 'help' : path.startsWith('/tickets') ? 'tickets'
      : path.startsWith('/chat') ? 'chat' : 'home';
    $$('.portal-menu__item').forEach((a) => a.classList.toggle('is-active', a.dataset.nav === navKey));

    if (path === '/home' || path === '/') viewHome();
    else if (path === '/chat') viewChat();
    else if (path === '/tickets') viewTickets(query);
    else if (path === '/help') viewHelp(query);
    else if (path.startsWith('/help/article/')) viewArticle(path.split('/').pop());
    else viewHome();

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ============================== 初始化 ============================== */

  document.addEventListener('settings:ready', (e) => {
    settings = e.detail || {};
    const name = $('#siteName');
    if (name && settings.site_name) { name.textContent = settings.site_name; document.title = `${settings.site_name} - 在线咨询 / 帮助中心`; }
    renderTestModeBanner();
  });
  settings = Kefu.state.settings || {};
  renderTestModeBanner();

  on('notification', (n) => {
    if (n) toast(n.title + (n.body ? `：${n.body}` : ''), 'info', 4000);
  });

  $('#floatChat').addEventListener('click', () => {
    if (!requireLogin()) return;
    location.hash = '#/chat';
    if (location.hash === '#/chat') route();
  });

  window.addEventListener('hashchange', route);
  renderUserArea();
  route();

  // 若已有登录态则建立 WS 连接（客户侧接收客服消息）
  if (auth.isLogin) {
    Kefu.connectWS();
    on('message', (msg) => {
      // 当前不在聊天页时提示新消息
      if (!location.hash.startsWith('#/chat') && msg.message && msg.message.sender_role === 'agent') {
        toast(`客服消息：${String(msg.message.content).slice(0, 40)}`, 'info', 3500);
      }
    });
  }
})();
