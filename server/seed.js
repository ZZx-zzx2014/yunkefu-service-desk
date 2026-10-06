/**
 * 演示数据初始化 / 重置
 *   node server/seed.js          首次运行且数据库为空时写入演示数据
 *   node server/seed.js --reset  清空全部数据并重建演示数据
 */
import { db, run, get, all, tx, setSetting, DEFAULT_SETTINGS } from './db.js';
import { hashPassword } from './auth.js';

const RESET = process.argv.includes('--reset');

/* ------------------------------ 建库 & 初始设置 ------------------------------ */
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting(k, v);

const userCount = get('SELECT COUNT(*) AS c FROM users').c;
if (userCount > 0 && !RESET) {
  console.log(`[seed] 数据库已有 ${userCount} 个用户，跳过演示数据写入。（如需重置：npm run reset）`);
  process.exit(0);
}

if (RESET) {
  console.log('[seed] --reset：清空现有数据…');
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM notifications; DELETE FROM audit_logs; DELETE FROM settings;
    DELETE FROM kb_articles; DELETE FROM kb_categories; DELETE FROM ticket_comments;
    DELETE FROM tickets; DELETE FROM quick_replies; DELETE FROM messages;
    DELETE FROM conversations; DELETE FROM users; DELETE FROM departments;
    DELETE FROM sqlite_sequence;
    PRAGMA foreign_keys = ON;
  `);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting(k, v);
}

/** 本地时间格式化：SQLite 中统一以本地时间字符串存储，避免 UTC/本地混用导致时长计算为负 */
const pad = (n) => String(n).padStart(2, '0');
const fmtLocal = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const now = () => fmtLocal(new Date());

const daysAgo = (n, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, Math.floor(Math.random() * 60), 0, 0);
  // 演示数据生成时间不得晚于当前时刻，否则会污染「首响时长 / SLA / 趋势」等指标
  if (d.getTime() > Date.now()) {
    d.setTime(Date.now() - Math.floor(Math.random() * 90 + 10) * 60 * 1000);
  }
  return fmtLocal(d);
};

const createUser = ({ username, password, name, role, email = '', phone = '', deptId = null, level = '初级', skills = [], max = 5, status = 'offline' }) => {
  const { hash, salt } = hashPassword(password);
  const r = run(
    `INSERT INTO users (username, password_hash, password_salt, name, role, email, phone, department_id, level, skills, max_concurrent, status, active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    [username, hash, salt, name, role, email, phone, deptId, level, JSON.stringify(skills), max, status],
  );
  return Number(r.lastInsertRowid);
};

tx(() => {
  /* ------------------------------ 部门 ------------------------------ */
  const depts = [
    ['售前咨询部', '负责产品咨询、报价与试用引导'],
    ['技术支持部', '负责故障排查、接口对接与系统集成'],
    ['售后服务部', '负责退换货、账务与投诉处理'],
  ];
  const deptIds = {};
  for (const [name, description] of depts) {
    const r = run('INSERT INTO departments (name, description) VALUES (?,?)', [name, description]);
    deptIds[name] = Number(r.lastInsertRowid);
  }

  /* ------------------------------ 用户 ------------------------------ */
  const adminId = createUser({
    username: 'admin', password: 'admin123', name: '系统管理员', role: 'admin',
    email: 'admin@yunkefu.com', phone: '13800000000', deptId: deptIds['售前咨询部'],
    level: '资深', skills: ['管理'], max: 99, status: 'online',
  });

  const agents = [
    ['agent1', '林晓', '售前咨询部', '金牌', ['产品咨询', '报价'], 'online'],
    ['agent2', '陈昊', '技术支持部', '资深', ['技术支持', '接口对接'], 'online'],
    ['agent3', '王梦琪', '售后服务部', '高级', ['退换货', '账务'], 'busy'],
    ['agent4', '赵子轩', '技术支持部', '初级', ['技术支持'], 'away'],
    ['agent5', '刘雨桐', '售前咨询部', '中级', ['产品咨询'], 'offline'],
  ];
  const agentIds = [];
  for (const [username, name, dept, level, skills, status] of agents) {
    agentIds.push(createUser({
      username, password: 'agent123', name, role: 'agent',
      email: `${username}@yunkefu.com`, phone: '139' + Math.floor(10000000 + Math.random() * 89999999),
      deptId: deptIds[dept], level, skills, max: 5, status,
    }));
  }

  const customers = [
    ['user1', '张伟', 'zhangwei@example.com', '13812345678'],
    ['user2', '李静', 'lijing@example.com', '13887654321'],
    ['user3', '孙一鸣', 'sunym@example.com', '13711112222'],
    ['user4', '周慧', 'zhouhui@example.com', '13633334444'],
    ['user5', '吴强', 'wuqiang@example.com', '13555556666'],
    ['user6', '郑爽', 'zhengshuang@example.com', '13477778888'],
    ['user7', '冯磊', 'fenglei@example.com', '13399990000'],
    ['user8', '许晴', 'xuqing@example.com', '13212341234'],
  ];
  const customerIds = [];
  for (const [username, name, email, phone] of customers) {
    customerIds.push(createUser({
      username, password: 'user123', name, role: 'customer', email, phone,
    }));
  }
  // 客户 1 保留一个便捷登录账号
  run("UPDATE users SET email='customer@yunkefu.com' WHERE id=?", [customerIds[0]]);

  /* ------------------------------ 快捷话术 ------------------------------ */
  const quickReplies = [
    ['欢迎语', '您好，很高兴为您服务！请问有什么可以帮您？', '开场', 1],
    ['请稍等', '好的，请您稍等，我马上为您核实，预计 1-2 分钟。', '沟通', 1],
    ['需要更多信息', '为了更快帮您定位问题，能否提供一下账号信息和操作截图？', '沟通', 0],
    ['转技术', '这个问题需要技术同事协助，我这就为您转接技术支持，请稍候。', '转接', 1],
    ['升级处理', '非常抱歉给您带来不便，我已将您的问题升级为高优先级工单，会专人跟进。', '售后', 0],
    ['结束语', '请问还有其他可以帮您的吗？如果没有，我先为您结束本次会话，祝您生活愉快！', '结束', 1],
    ['退款说明', '退款将在审核通过后 3-5 个工作日原路退回，请您留意账户变动。', '售后', 0],
    ['工单已建', '已为您创建工单，工单号 {code}，我们会通过短信和邮件同步处理进度。', '工单', 0],
  ];
  for (const [title, content, category, isFavorite] of quickReplies) {
    run('INSERT INTO quick_replies (title, content, category, scope, use_count, is_favorite, favorite_at) VALUES (?,?,?,?,?,?,?)',
      [title, content, category, 'all', Math.floor(Math.random() * 60) + 5,
        isFavorite, isFavorite ? now() : null]);
  }

  /* ------------------------------ 知识库 ------------------------------ */
  const categories = [
    ['新手入门', '🚀', '快速了解产品与基础操作'],
    ['账号安全', '🔐', '账号注册、登录与安全设置'],
    ['计费与发票', '💳', '套餐、续费、发票开具说明'],
    ['技术对接', '🔧', 'API 文档、SDK 与常见故障'],
    ['售后政策', '📦', '退换货、保修与投诉流程'],
  ];
  const catIds = {};
  categories.forEach(([name, icon, description], i) => {
    const r = run('INSERT INTO kb_categories (name, icon, description, sort_order) VALUES (?,?,?,?)',
      [name, icon, description, i]);
    catIds[name] = Number(r.lastInsertRowid);
  });

  const articles = [
    ['新手入门', '如何注册并登录云客账号', '3 分钟完成注册，开启您的第一次使用体验',
      '## 一、注册账号\n1. 打开官网首页，点击右上角「免费注册」。\n2. 输入手机号并获取验证码，设置登录密码。\n3. 阅读并同意《用户服务协议》，点击提交。\n\n## 二、登录方式\n- 账号密码登录\n- 手机验证码登录\n- 企业微信 / 钉钉扫码登录\n\n> 温馨提示：一个手机号最多可绑定 3 个企业账号。'],
    ['新手入门', '产品功能全景导览', '一张图看懂云客客服系统的全部能力',
      '## 核心模块\n| 模块 | 说明 |\n| --- | --- |\n| 在线会话 | 网页、APP、公众号多渠道统一接待 |\n| 工单 | 跨部门流转与 SLA 督办 |\n| 知识库 | 对内辅助 + 对外帮助中心 |\n| 数据看板 | 会话量、满意度、坐席绩效 |\n\n## 推荐上手路径\n先配置部门与坐席 → 再设置欢迎语与分配规则 → 最后接入渠道。'],
    ['账号安全', '忘记密码如何找回', '自助找回密码的完整流程',
      '## 自助找回\n1. 登录页点击「忘记密码」。\n2. 输入注册手机号，获取验证码。\n3. 设置新密码（8-20 位，需包含字母和数字）。\n\n## 无法自助找回\n如原手机号已停用，请提交工单并上传身份证明，人工审核一般 1 个工作日内完成。'],
    ['账号安全', '如何开启两步验证（2FA）', '为账号增加一道安全防线',
      '进入「个人设置 - 安全中心」，开启两步验证并绑定验证器 App。\n之后每次登录除密码外还需输入 6 位动态码。\n\n> 建议管理员账号强制开启。'],
    ['计费与发票', '套餐与计费方式说明', '按坐席数计费，支持月付与年付',
      '我们按**坐席数**计费：\n- 标准版：¥199 / 坐席 / 月\n- 专业版：¥399 / 坐席 / 月（含工单 + 知识库）\n- 旗舰版：定制报价\n\n年付享 8.5 折。'],
    ['计费与发票', '如何申请开具发票', '增值税普通发票与专用发票',
      '路径：「企业管理 - 账单中心 - 申请开票」。\n\n需要提供：\n1. 开票主体名称与税号\n2. 收票邮箱\n3. 开票金额（单笔需 ≥ ¥100）\n\n电子发票一般在 3 个工作日内发送至邮箱。'],
    ['技术对接', 'API 鉴权与调用示例', '使用 Token 调用开放接口',
      '## 获取 Token\n```http\nPOST /api/v1/auth/token\nContent-Type: application/json\n\n{ "appId": "xxx", "appSecret": "yyy" }\n```\n\n## 调用示例\n```bash\ncurl -H "Authorization: Bearer <token>" \\\n  https://api.yunkefu.com/api/v1/conversations\n```\n\nToken 有效期 2 小时，过期需重新获取。'],
    ['技术对接', 'Webhook 事件回调配置', '实时接收会话与工单事件',
      '在「渠道设置 - Webhook」中填写回调地址。\n\n支持事件：\n- `conversation.created`\n- `message.created`\n- `ticket.updated`\n\n> 回调需在 5 秒内返回 HTTP 200，否则会重试 3 次。'],
    ['售后政策', '退换货与退款政策', '7 天无理由，30 天质量保障',
      '1. 自签收之日起 7 天内，产品未使用可无理由退货。\n2. 30 天内出现质量问题的，可免费换新。\n3. 退款将在审核通过后 3-5 个工作日原路退回。\n\n虚拟商品一经开通不支持退款。'],
    ['售后政策', '投诉与建议处理流程', '我们重视每一条反馈',
      '提交渠道：在线客服 / 工单 / 邮箱 support@yunkefu.com。\n\n处理时效：\n- 一般投诉：24 小时内响应\n- 重大投诉：2 小时内响应，由客服主管跟进\n\n处理完成后我们会电话回访确认。'],
  ];
  let articleIdx = 0;
  for (const [cat, title, summary, content] of articles) {
    run(`INSERT INTO kb_articles (category_id, title, summary, content, tags, status, visibility, author_id, views, helpful, not_helpful, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [catIds[cat], title, summary, content, JSON.stringify([cat]), 'published', 'public',
        adminId, Math.floor(Math.random() * 800) + 50, Math.floor(Math.random() * 90) + 5,
        Math.floor(Math.random() * 8), daysAgo(30 - articleIdx), daysAgo(Math.max(0, 10 - articleIdx))]);
    articleIdx++;
  }
  run(`INSERT INTO kb_articles (category_id, title, summary, content, tags, status, visibility, author_id, views)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    [catIds['技术对接'], '【内部】常见故障排查手册', '仅坐席可见的排障清单',
      '1. 客户反馈无法登录 → 先查账号状态是否被冻结。\n2. 接口返回 401 → 检查 Token 是否过期。\n3. 消息不实时 → 检查 WebSocket 连接与网络代理。\n4. 上传失败 → 检查文件大小是否超过 10MB。',
      '["内部"]', 'published', 'internal', adminId, 32]);

  /* ------------------------------ 会话与消息 ------------------------------ */
  const sampleDialogs = [
    {
      customerIdx: 0, agentIdx: 0, status: 'closed', channel: 'web', tag: '产品咨询', priority: 'normal',
      subject: '咨询企业版套餐价格', rating: 5, ratingComment: '响应很快，讲解很清楚！', day: 6,
      msgs: [
        ['customer', '你好，我想了解一下企业版的价格'],
        ['agent', '您好，很高兴为您服务！企业版是按坐席数计费的，标准版 ¥199/坐席/月，专业版 ¥399/坐席/月，请问您大概需要多少个坐席呢？'],
        ['customer', '我们大概 30 个人'],
        ['agent', '30 个坐席的话推荐专业版，年付可享 8.5 折，折合下来每月约 ¥10175。包含工单系统、知识库和数据看板，需要我帮您申请 14 天免费试用吗？'],
        ['customer', '好的，麻烦申请一下'],
        ['agent', '已为您提交试用申请，稍后会有专属顾问与您联系。还有其他可以帮您的吗？'],
        ['customer', '没有了，谢谢'],
        ['agent', '感谢您的咨询，祝您工作顺利！'],
      ],
    },
    {
      customerIdx: 1, agentIdx: 1, status: 'active', channel: 'app', tag: '技术支持', priority: 'high',
      subject: '接口调用返回 401', day: 0,
      msgs: [
        ['customer', '我们的系统调用你们接口一直返回 401，是什么问题？'],
        ['agent', '您好，401 一般有两种原因：Token 过期或鉴权头格式不对。方便把请求的 Header 截图发我看看吗？'],
        ['customer', '稍等，我截图给你'],
        ['system', '客户上传了文件：请求日志.txt'],
        ['agent', '看到了，您的 Authorization 少了 Bearer 前缀，改成 `Bearer <token>` 即可。'],
        ['customer', '改好了，现在可以了，非常感谢！'],
        ['agent', '不客气～如果后续还有问题随时找我。'],
      ],
    },
    {
      customerIdx: 2, agentIdx: 2, status: 'closed', channel: 'wechat', tag: '账务问题', priority: 'urgent',
      subject: '发票抬头开错了', rating: 3, ratingComment: '处理有点慢，但最终解决了', day: 3,
      msgs: [
        ['customer', '我上周申请的发票抬头写错了，怎么改？'],
        ['agent', '非常抱歉给您添麻烦了。请问工单号是多少？我帮您查一下。'],
        ['customer', 'GD20240115 那个'],
        ['agent', '已查到，我帮您作废原发票并重新开具，预计 3 个工作日发送到您邮箱。'],
        ['customer', '好的'],
      ],
    },
    {
      customerIdx: 3, agentIdx: 0, status: 'active', channel: 'web', tag: '售前咨询', priority: 'normal',
      subject: '想了解数据看板功能', day: 0,
      msgs: [
        ['customer', '数据看板能看到哪些指标？'],
        ['agent', '看板包含会话量趋势、平均响应时长、满意度评分、工单处理时效和坐席绩效排行，支持按天/周/月切换。'],
      ],
    },
    {
      customerIdx: 4, agentIdx: null, status: 'queued', channel: 'web', tag: '', priority: 'normal',
      subject: '登录不上账号', day: 0,
      msgs: [
        ['customer', '我账号登录不上，提示密码错误，但是我确定密码是对的'],
      ],
    },
    {
      customerIdx: 5, agentIdx: null, status: 'queued', channel: 'app', tag: '', priority: 'high',
      subject: '申请退款', day: 0,
      msgs: [
        ['customer', '我要退款，订单号 202401180023'],
        ['customer', '在吗？'],
      ],
    },
    {
      customerIdx: 6, agentIdx: 3, status: 'closed', channel: 'web', tag: '投诉建议', priority: 'high',
      subject: '客服响应太慢', rating: 2, ratingComment: '等了好久才有人回复', day: 9,
      msgs: [
        ['customer', '你们的客服响应也太慢了吧，我排了半个小时'],
        ['agent', '非常抱歉给您带来不好的体验，高峰期排队确实比较久，我们正在增加坐席。请问您遇到的具体问题是什么？我马上帮您处理。'],
        ['customer', '我要查我的订单进度'],
        ['agent', '请提供订单号，我立即为您查询。'],
      ],
    },
  ];

  const usedCodes = new Set();
  const makeCode = (prefix, day) => {
    const d = new Date();
    d.setDate(d.getDate() - day);
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    let seq = 1;
    while (usedCodes.has(`${prefix}${ymd}-${String(seq).padStart(4, '0')}`)) seq++;
    const code = `${prefix}${ymd}-${String(seq).padStart(4, '0')}`;
    usedCodes.add(code);
    return code;
  };

  const convIds = [];
  for (const d of sampleDialogs) {
    const customerId = customerIds[d.customerIdx];
    const agentId = d.agentIdx === null ? null : agentIds[d.agentIdx];
    const base = daysAgo(d.day, 9 + Math.floor(Math.random() * 9));
    const code = makeCode('KH', d.day);
    const r = run(
      `INSERT INTO conversations (code, customer_id, agent_id, channel, subject, status, priority, tag,
        rating, rating_comment, queued_at, started_at, closed_at, last_message_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [code, customerId, agentId, d.channel, d.subject, d.status, d.priority, d.tag,
        d.rating ?? null, d.ratingComment ?? '',
        base, agentId ? base : null,
        d.status === 'closed' ? base : null, base, base],
    );
    const convId = Number(r.lastInsertRowid);
    convIds.push(convId);

    // 消息时间从「排队时间」开始严格递增，保证首响时长等指标为正值
    const stepMs = Math.floor((60 * 60 * 1000) / Math.max(1, d.msgs.length + 1));
    let t = new Date(base.replace(' ', 'T'));
    for (const [role, content] of d.msgs) {
      t = new Date(t.getTime() + Math.floor(stepMs * (0.2 + Math.random() * 0.5)));
      const ts = fmtLocal(t);
      const senderId = role === 'customer' ? customerId : role === 'agent' ? agentId : null;
      const senderName = role === 'customer' ? get('SELECT name FROM users WHERE id=?', [customerId]).name
        : role === 'agent' ? get('SELECT name FROM users WHERE id=?', [agentId]).name : '系统';
      run(`INSERT INTO messages (conversation_id, sender_id, sender_role, sender_name, type, content, is_read, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        [convId, senderId, role, senderName, role === 'system' ? 'system' : 'text', content, 1, ts]);
    }
    run('UPDATE conversations SET last_message_at = (SELECT MAX(created_at) FROM messages WHERE conversation_id = ?) WHERE id = ?', [convId, convId]);

    // 已结束会话：结束时间取最后一条消息之后，使「处理时长」指标有真实值
    if (d.status === 'closed') {
      const last = get('SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ?', [convId]).t;
      const closedAt = fmtLocal(new Date(new Date(String(last).replace(' ', 'T')).getTime() + (5 + Math.floor(Math.random() * 15)) * 60 * 1000));
      run('UPDATE conversations SET closed_at = ? WHERE id = ?', [closedAt, convId]);
    }
  }

  /* ------------------------------ 工单 ------------------------------ */
  const tickets = [
    ['支付成功后会员未到账', '客户反馈支付成功后会员权益未开通，需要财务与技术协同核查订单流水。', '账务问题', 'urgent', 'processing', 1, 2, 0],
    ['API 接口频繁超时', '在高峰期调用订单查询接口平均响应超过 5 秒，影响下单流程。', '技术支持', 'high', 'processing', 2, 1, 1],
    ['申请开具增值税专用发票', '需要开具 12000 元增值税专用发票，抬头资料已发送至邮箱。', '账务问题', 'normal', 'resolved', 3, 2, 3],
    ['希望增加批量导出会话记录功能', '每月需要导出会话记录做质检，目前只能逐条导出，希望支持批量导出。', '功能申请', 'low', 'pending', 5, null, 2],
    ['客户端崩溃闪退', 'iOS 客户端在查看图片消息时偶发闪退，已收集 3 份崩溃日志。', '技术支持', 'high', 'reopened', 0, 1, 5],
    ['对客服态度不满意', '客户投诉坐席回复语气生硬，要求主管致电道歉。', '投诉建议', 'urgent', 'processing', 6, 2, 1],
    ['产品咨询：是否支持钉钉集成', '客户希望了解是否支持钉钉单点登录与消息推送。', '产品咨询', 'normal', 'closed', 7, 0, 12],
    ['退款申请未处理', '订单 202401180023 于 5 个工作日前提交退款申请，至今未处理。', '账务问题', 'high', 'pending', 5, null, 1],
    ['批量导入客户名单失败', '上传 2000 行 CSV 时提示格式错误，但文件格式符合模板要求。', '技术支持', 'normal', 'resolved', 4, 3, 6],
    ['优化建议：增加快捷话术分组', '建议快捷话术支持按部门分组并支持变量替换。', '功能申请', 'low', 'closed', 1, 0, 15],
  ];

  const ticketIds = [];
  let tIdx = 0;
  for (const [title, description, category, priority, status, creatorIdx, assigneeIdx, day] of tickets) {
    const created = daysAgo(day, 9 + (tIdx % 8));
    const slaDue = fmtLocal(new Date(new Date(created.replace(' ', 'T')).getTime() + 24 * 3600 * 1000));
    const rating = status === 'closed' ? [4, 5, 3, 5][tIdx % 4] : null;
    const r = run(
      `INSERT INTO tickets (code, title, description, category, priority, status, creator_id, assignee_id,
        department_id, sla_due_at, resolved_at, closed_at, rating, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [makeCode('GD', day), title, description, category, priority, status,
        customerIds[creatorIdx], assigneeIdx === null ? null : agentIds[assigneeIdx],
        assigneeIdx === null ? null : get('SELECT department_id FROM users WHERE id=?', [agentIds[assigneeIdx]])?.department_id ?? null,
        slaDue,
        ['resolved', 'closed'].includes(status) ? created : null,
        status === 'closed' ? created : null,
        rating, created, created],
    );
    const ticketId = Number(r.lastInsertRowid);
    ticketIds.push(ticketId);

    run('INSERT INTO ticket_comments (ticket_id, user_id, user_name, action, content, created_at) VALUES (?,?,?,?,?,?)',
      [ticketId, customerIds[creatorIdx], get('SELECT name FROM users WHERE id=?', [customerIds[creatorIdx]]).name, 'create', description, created]);
    if (assigneeIdx !== null) {
      run('INSERT INTO ticket_comments (ticket_id, user_id, user_name, action, content, internal, created_at) VALUES (?,?,?,?,?,?,?)',
        [ticketId, adminId, '系统管理员', 'assign', `已指派给 ${get('SELECT name FROM users WHERE id=?', [agentIds[assigneeIdx]]).name} 跟进。`, 1, created]);
    }
    if (['resolved', 'closed'].includes(status)) {
      run('INSERT INTO ticket_comments (ticket_id, user_id, user_name, action, content, created_at) VALUES (?,?,?,?,?,?)',
        [ticketId, agentIds[assigneeIdx ?? 0], get('SELECT name FROM users WHERE id=?', [agentIds[assigneeIdx ?? 0]]).name,
          'resolve', '问题已处理完成，请确认是否恢复正常。', created]);
    }
    tIdx++;
  }

  /* ------------------------------ 通知 & 日志 ------------------------------ */
  const notices = [
    ['新的排队会话', '客户「吴强」正在等待接待', 'warning'],
    ['工单即将超时', '工单「退款申请未处理」距离 SLA 到期不足 2 小时', 'danger'],
    ['客户评价已更新', '张伟对会话 KH' + ' 给出了 5 星好评', 'success'],
  ];
  for (const [title, body, type] of notices) {
    run('INSERT INTO notifications (user_id, title, body, type, is_read) VALUES (?,?,?,?,0)',
      [agentIds[0], title, body, type]);
    run('INSERT INTO notifications (user_id, title, body, type, is_read) VALUES (?,?,?,?,0)',
      [adminId, title, body, type]);
  }

  for (const [action, target, detail] of [
    ['登录系统', 'admin', '管理员登录成功'],
    ['接待会话', 'KH' + '0001', '林晓接入客户会话'],
    ['关闭工单', 'GD' + '0007', '工单处理完成并关闭'],
    ['新增知识库文章', '如何注册并登录云客账号', '发布到「新手入门」'],
  ]) {
    run('INSERT INTO audit_logs (user_id, user_name, action, target, detail, ip) VALUES (?,?,?,?,?,?)',
      [adminId, '系统管理员', action, target, detail, '127.0.0.1']);
  }
});

const stat = (t) => get(`SELECT COUNT(*) AS c FROM ${t}`).c;
console.log(`[seed] 演示数据写入完成：
  部门 ${stat('departments')} 个 | 用户 ${stat('users')} 个（含 ${get("SELECT COUNT(*) AS c FROM users WHERE role='agent'").c} 名坐席）
  会话 ${stat('conversations')} 个 | 消息 ${stat('messages')} 条
  工单 ${stat('tickets')} 个 | 知识库文章 ${stat('kb_articles')} 篇 | 快捷话术 ${stat('quick_replies')} 条

  登录账号：
    管理后台  admin  / admin123
    客服工作台 agent1 / agent123   （agent1 ~ agent5）
    客户中心  user1  / user123     （user1 ~ user8）`);
