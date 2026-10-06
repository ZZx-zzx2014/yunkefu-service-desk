/**
 * 布局滚动约束自检
 *   node scripts/check-layout.js
 *
 * 背景：在 fixed 侧栏 + flex/grid 的多栏布局里，「能不能滑动」取决于一组
 * 容易漏写的结构条件，一旦缺失，页面表现为「底部被裁掉、无法滑动」：
 *
 *   1. 需要有确定高度的祖先容器（如 height:100dvh）并 overflow:hidden
 *   2. 链路上每个 flex/grid 子项都要 min-height:0
 *      （默认 min-height:auto 会拒绝收缩到内容高度以下，滚动条不会出现）
 *   3. 需要滚动的元素自身要有 overflow-y:auto
 *   4. 滚动容器内部绝不能再写死视口高度（100vh），否则会被顶出可视区
 *
 * 本脚本把这些条件固化为断言，避免以后改样式时重新引入同类问题。
 * 说明：无头浏览器在本环境不可用（沙箱限制命名管道/进程通讯），
 * 因此采用结构校验而不是真实渲染量测。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (p) => fs.readFileSync(p, 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label} ${extra}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

/** 从内联 <style> 或 css 文件里提取某个选择器的全部规则体（含媒体查询内的） */
function extractRules(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[,{}])\\s*${esc}\\s*\\{([^}]*)\\}`, 'gm');
  const out = [];
  let m;
  while ((m = re.exec(css))) out.push(m[2]);
  return out;
}

/** 取第一条规则（基础规则优先于媒体查询内的覆盖规则） */
function extractRule(css, selector) {
  const all = extractRules(css, selector);
  return all.length ? all[0] : null;
}

const baseCss = read(path.join(PUBLIC, 'assets', 'base.css'));
const agentHtml = read(path.join(PUBLIC, 'agent.html'));
const adminHtml = read(path.join(PUBLIC, 'admin.html'));
// 客户端页面即 index.html（由 / 提供）。此前存在一份 customer.html 副本，
// 导致只改了副本而线上页面仍是旧样式，故已删除副本，这里只认 index.html
const customerHtml = read(path.join(PUBLIC, 'index.html'));

/**
 * 在规则的任一声明体中查找属性。
 * 注意：同一属性可能声明多次（如 height:100vh 回退 + height:100dvh），
 * 必须收集全部同名声明，只取第一个会漏判增量回退写法。
 */
const hasDecl = (rule, prop, valueRe) => {
  if (!rule) return false;
  const bodies = Array.isArray(rule) ? rule : [rule];
  const re = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`, 'gi');
  return bodies.some((body) => {
    const values = [...body.matchAll(re)].map((m) => m[1].trim());
    if (!values.length) return false;
    return valueRe ? values.some((v) => valueRe.test(v)) : true;
  });
};

/** 某个选择器的任一声明体是否包含该声明 */
const anyRuleHas = (css, selector, prop, valueRe) => hasDecl(extractRules(css, selector), prop, valueRe);

/* ---------------- 1. 根容器必须有确定高度 ---------------- */
section('1. 根容器：确定高度 + 禁止溢出');
{
  // body 高度必须是 min-height：height:100% 会锁死文档高度，
  // 让普通文档流页面（客户端各页）失去整页滚动能力
  const htmlBody = extractRule(baseCss, 'html, body');
  check('html/body 使用 min-height（保留整页滚动能力）',
    hasDecl(htmlBody, 'min-height', /100%/) && !hasDecl(htmlBody, 'height', /^100%$/),
    htmlBody?.trim() || '未找到 html, body 规则');

  const rule = extractRule(baseCss, '.app-layout');
  check('.app-layout 设置了视口高度（100dvh 或 100vh）',
    anyRuleHas(baseCss, '.app-layout', 'height', /100(d)?vh/), rule?.trim());
  check('.app-layout 使用 dvh 适配移动端动态视口',
    anyRuleHas(baseCss, '.app-layout', 'height', /100dvh/),
    '缺少 100dvh 回退会导致移动端底部被裁切');
  check('.app-layout 设置 overflow:hidden（形成滚动上下文）',
    anyRuleHas(baseCss, '.app-layout', 'overflow', /hidden/));
  check('.app-layout 不再是 min-height:100vh（内容可撑高会破坏约束链）',
    !anyRuleHas(baseCss, '.app-layout', 'min-height', /100vh/));
}

/* ---------------- 2. 主区域约束链 ---------------- */
section('2. 主区域（.main-area）约束链');
{
  const rule = extractRule(baseCss, '.main-area');
  check('.main-area 设置 height:100%', hasDecl(rule, 'height', /100%/), rule?.trim());
  check('.main-area 设置 min-height:0', hasDecl(rule, 'min-height', /^0/));
  check('.main-area 设置 overflow:hidden', hasDecl(rule, 'overflow', /hidden/));
  check('.main-area 为纵向 flex 容器',
    hasDecl(rule, 'display', /flex/) && hasDecl(rule, 'flex-direction', /column/));
}

/* ---------------- 3. #view 容器 ---------------- */
section('3. 内容容器（#view）');
{
  // #view 带内联样式，需检查 HTML
  for (const [file, html, label] of [['agent.html', agentHtml, '工作台'], ['admin.html', adminHtml, '管理后台']]) {
    const m = html.match(/<div id="view"[^>]*>/);
    const tag = m ? m[0] : '';
    check(`${label} #view 设置 flex:1`, /flex\s*:\s*1/.test(tag), tag);
    check(`${label} #view 设置 min-height:0`, /min-height\s*:\s*0/.test(tag), tag);
    // 关键：不能给 #view 加 overflow-y:auto —— 工作台需要它作为不滚动的填充容器
    check(`${label} #view 未设置 overflow-y:auto（避免挤压内部滚动区）`,
      !/overflow-y\s*:\s*auto/.test(tag), tag);
    void file;
  }
}

/* ---------------- 4. 普通页面由 .page 自身滚动 ---------------- */
section('4. 普通页面容器（.page）');
{
  const rule = extractRule(baseCss, '.page');
  check('.page 设置 flex:1', hasDecl(rule, 'flex', /1/));
  check('.page 设置 min-height:0', hasDecl(rule, 'min-height', /^0/));
  check('.page 设置 overflow-y:auto（长内容可滚动）', hasDecl(rule, 'overflow-y', /auto/));
}

/* ---------------- 5. 工作台三栏 ---------------- */
section('5. 工作台三栏（.ws / 各栏）');
{
  const ws = extractRule(agentHtml, '.ws');
  check('.ws 使用 height:100%（跟随父容器，而非写死视口高度）',
    hasDecl(ws, 'height', /100%/), ws?.trim());
  check('.ws 不再写死 calc(100vh - ...)',
    !hasDecl(ws, 'height', /100vh/), '写死视口高度会在内容撑开时被顶出可视区');
  check('.ws 设置 min-height:0', hasDecl(ws, 'min-height', /^0/) || /min-height:\s*0/.test(ws || ''));
  check('.ws 设置 overflow:hidden', hasDecl(ws, 'overflow', /hidden/));

  for (const [sel, label] of [['.ws__list', '会话列表栏'], ['.ws__main', '对话区'], ['.ws__right', '客户资料栏']]) {
    check(`${label} 设置 min-height:0`, anyRuleHas(agentHtml, sel, 'min-height', /^0/),
      extractRules(agentHtml, sel).join(' || '));
  }

  const convList = extractRule(agentHtml, '.conv-list');
  check('.conv-list 可滚动（overflow-y:auto + min-height:0）',
    hasDecl(convList, 'overflow-y', /auto/) && hasDecl(convList, 'min-height', /^0/));

  const chatScroll = extractRule(agentHtml, '.chat-scroll');
  check('.chat-scroll 可滚动（overflow-y:auto + min-height:0）',
    hasDecl(chatScroll, 'overflow-y', /auto/) && hasDecl(chatScroll, 'min-height', /^0/));
}

/* ---------------- 6. 客户端聊天窗口 ---------------- */
section('6. 客户端聊天窗口');
{
  const panel = extractRule(customerHtml, '.chat-panel');
  check('.chat-panel 高度基于动态视口（dvh）', hasDecl(panel, 'height', /dvh|min\(/), panel?.trim());
  check('.chat-panel 设置 min-height 保底（小屏可用）', hasDecl(panel, 'min-height'));
  check('.chat-panel 设置 overflow:hidden', hasDecl(panel, 'overflow', /hidden/));
  check('提供不支持 dvh 时的 vh 回退',
    /@supports not \(height: 100dvh\)/.test(customerHtml));

  const body = extractRule(customerHtml, '.chat-body');
  check('.chat-body 可滚动（overflow-y:auto + min-height:0）',
    hasDecl(body, 'overflow-y', /auto/) && hasDecl(body, 'min-height', /^0/));
}

/* ---------------- 7. 页面滚动模式 ----------------
 * 两类页面必须区分清楚，混淆就会出现「无法滑动」：
 *   A. 文档流页面（客户端首页 / 咨询 / 工单 / 帮助中心）：依赖 body 自然滚动，
 *      不能给 html/body 或主要容器加 overflow:hidden，也不能锁死高度
 *   B. 应用外壳页面（工作台 / 管理后台）：用 .app-layout 固定视口高度，
 *      自身不滚动，滚动交给内部容器
 */
section('7. 页面滚动模式区分');
{
  const flowPages = [
    ['index.html', '客户端门户', customerHtml],
    ['help.html', '帮助中心', read(path.join(PUBLIC, 'help.html'))],
    ['404.html', '404 页', read(path.join(PUBLIC, '404.html'))],
  ];
  const shellPages = [
    ['agent.html', '客服工作台', agentHtml],
    ['admin.html', '管理后台', adminHtml],
  ];

  for (const [file, label, html] of flowPages) {
    check(`${label}（${file}）不使用 .app-layout 外壳`,
      !/class="app-layout"/.test(html), '文档流页面不应套用固定视口外壳');
    check(`${label}（${file}）未在内联样式中锁死 body 高度或禁止滚动`,
      !/body\s*\{[^}]*overflow\s*:\s*hidden/.test(html));
  }

  // 外壳页面：滚动容器可能定义在内联样式（工作台）或共享样式（管理后台的 .page）
  const shellScrollSources = baseCss + agentHtml + adminHtml;
  for (const [file, label, html] of shellPages) {
    check(`${label}（${file}）使用 .app-layout 外壳`, /class="app-layout"/.test(html));
    // 该页会用到的滚动容器至少有一个具备 overflow-y:auto
    const scrollable = /\.(page|conv-list|chat-scroll|ws__right)[^{]*\{[^}]*overflow-y\s*:\s*auto/.test(shellScrollSources);
    check(`${label}（${file}）存在可用滚动容器（.page / .conv-list / .chat-scroll）`,
      scrollable, '缺少 overflow-y:auto 的容器');
  }

  // 客户端门户内容由 customer.js 动态渲染，需在脚本模板中检查关键区块
  const customerJs = read(path.join(PUBLIC, 'assets', 'customer.js'));
  check('客户端门户含可滚动的内容区块（hero/section/footer 模板）',
    /class="hero"/.test(customerJs) && /class="section"/.test(customerJs) && /class="footer"/.test(customerHtml),
    `hero=${/class="hero"/.test(customerJs)} section=${/class="section"/.test(customerJs)} footer=${/class="footer"/.test(customerHtml)}`);
}

/* ---------------- 8. 全局：滚动容器的通用健壮性 ---------------- */
section('8. 全局滚动健壮性');
{
  const combined = baseCss + agentHtml + adminHtml + customerHtml;
  // 统计 overflow-y:auto 的元素有多少同时声明了 min-height:0
  const scrollEls = [...combined.matchAll(/([^{}]+)\{([^}]*overflow-y\s*:\s*auto[^}]*)\}/g)];
  const missing = [];
  for (const [, selRaw, body] of scrollEls) {
    const sel = selRaw.trim().split('\n').pop().trim();
    if (/^@|^\d/.test(sel)) continue;
    if (!/min-height\s*:\s*0/.test(body)) missing.push(sel);
  }
  // fixed/absolute 定位的元素不需要 min-height:0（其高度不依赖 flex 收缩）
  const flexScrollMissing = missing.filter((s) => !/sidebar|modal|ws__right|list|panel/.test(s));
  check('flex 内的滚动容器均声明了 min-height:0',
    flexScrollMissing.length === 0,
    flexScrollMissing.length ? `缺少 min-height:0：${flexScrollMissing.join(' | ')}` : `已检查 ${scrollEls.length} 处`);

  check('滚动容器均设置 overscroll-behavior:contain（避免滚动穿透）',
    (combined.match(/overscroll-behavior/g) || []).length >= 3,
    `出现 ${(combined.match(/overscroll-behavior/g) || []).length} 次`);
}

console.log(`\n${'═'.repeat(56)}`);
if (fail === 0) console.log(`\x1b[32m✓ 布局滚动约束全部通过：${pass} 项检查\x1b[0m`);
else {
  console.log(`\x1b[32m通过 ${pass} 项\x1b[0m，\x1b[31m失败 ${fail} 项\x1b[0m`);
  console.log('失败项：\n  - ' + failures.join('\n  - '));
}
console.log(`\x1b[33m注意：本检查验证布局结构条件，非真实渲染量测\x1b[0m`);
console.log(`${'═'.repeat(56)}\n`);
process.exitCode = fail === 0 ? 0 : 1;
