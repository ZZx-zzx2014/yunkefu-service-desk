/** 指标合理性检查：所有看板指标应为非负且量级合理 */
const BASE = 'http://127.0.0.1:3000';

const login = async (username, password) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return (await r.json()).data.token;
};

const get = async (path, token) => {
  const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json()).data;
};

const token = await login('admin', 'admin123');
const ov = await get('/api/dashboard/overview?range=7d', token);
const perf = await get('/api/dashboard/agent-performance?range=7d', token);
const trend = await get('/api/dashboard/trend?range=7d', token);
const dist = await get('/api/dashboard/distribution?range=7d', token);
const hourly = await get('/api/dashboard/hourly?range=7d', token);
const realtime = await get('/api/dashboard/realtime', token);

let problems = 0;
const expect = (label, value, ok) => {
  if (!ok) problems++;
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label.padEnd(30)} ${value}`);
};

console.log('\n=== 看板核心指标 ===');
const c = ov.cards;
expect('平均首响（秒）', c.avgResponseSec.value, c.avgResponseSec.value >= 0);
expect('平均处理时长（分钟）', c.avgHandleMin.value, c.avgHandleMin.value >= 0);
expect('平均满意度', c.avgRating.value, c.avgRating.value >= 0 && c.avgRating.value <= 5);
expect('好评率', `${c.satisfactionRate.value}%`, c.satisfactionRate.value >= 0 && c.satisfactionRate.value <= 100);
expect('周期会话量', c.sessions.value, c.sessions.value >= 0);
expect('周期新增工单', c.tickets.value, c.tickets.value >= 0);
expect('工单解决率', `${c.ticketResolveRate.value}%`, c.ticketResolveRate.value >= 0 && c.ticketResolveRate.value <= 100);
expect('进行中会话', c.activeNow.value, c.activeNow.value >= 0);
expect('排队中', c.queue.value, c.queue.value >= 0);
expect('在线坐席/总数', `${c.onlineAgents.value}/${c.totalAgents.value}`, c.onlineAgents.value <= c.totalAgents.value);
expect('客户总数', c.totalCustomers.value, c.totalCustomers.value > 0);

console.log('\n=== 坐席绩效 ===');
for (const p of perf) {
  const ok = (p.sessions >= 0 && p.closed >= 0) &&
    (p.avgResponseSec === null || p.avgResponseSec >= 0) &&
    (p.avgHandleMin === null || p.avgHandleMin >= 0) &&
    (p.rating === null || (p.rating >= 0 && p.rating <= 5));
  expect(`${p.name} (接待${p.sessions}/结束${p.closed}/首响${p.avgResponseSec}s/处理${p.avgHandleMin}min/评${p.rating})`, ok ? '正常' : '异常', ok);
}

console.log('\n=== 趋势数据 ===');
const trendOk = trend.every((d) => d.conversations >= 0 && d.tickets >= 0 && d.closed >= 0 && d.resolved >= 0
  && (d.rating === null || (d.rating >= 0 && d.rating <= 5)));
expect(`${trend.length} 天趋势全部非负`, trendOk ? '正常' : '异常', trendOk);
expect('趋势日期连续', trend.every((d, i) => i === 0 || d.date > trend[i - 1].date), '是');

console.log('\n=== 分布数据 ===');
const distOk = dist.channels.every((x) => x.count >= 0) && dist.ratings.every((x) => x.count >= 0)
  && dist.statuses.every((x) => x.count >= 0) && dist.tags.every((x) => x.count >= 0);
expect('渠道/评分/状态/标签分布', distOk ? '正常' : '异常', distOk);
expect('渠道分布合计=周期会话', `${dist.channels.reduce((s, x) => s + x.count, 0)} / ${c.sessions.value}`,
  dist.channels.reduce((s, x) => s + x.count, 0) === c.sessions.value);
const ratingTotal = dist.ratings.reduce((s, x) => s + x.count, 0);
expect('评分数合计>0', ratingTotal, ratingTotal > 0);

console.log('\n=== 24 小时分布 ===');
expect('返回 24 个时段', hourly.length, hourly.length === 24);
expect('时段计数非负', hourly.every((h) => h.count >= 0) ? '正常' : '异常', hourly.every((h) => h.count >= 0));

console.log('\n=== 实时概览 ===');
expect('排队/进行中/在线坐席/今日会话',
  `${realtime.queue}/${realtime.active}/${realtime.onlineAgents}/${realtime.todaySessions}`,
  realtime.queue >= 0 && realtime.active >= 0 && realtime.onlineAgents >= 0 && realtime.todaySessions >= 0);
expect('今日评分范围', realtime.todayRating, realtime.todayRating >= 0 && realtime.todayRating <= 5);

console.log(`\n${'═'.repeat(50)}`);
console.log(problems === 0 ? '\x1b[32m✓ 所有指标合理，无负值或越界\x1b[0m' : `\x1b[31m✗ 发现 ${problems} 项异常\x1b[0m`);
console.log(`${'═'.repeat(50)}\n`);
// 使用 exitCode 而非 process.exit，避免 node:sqlite 句柄在强制退出时触发 libuv 断言
process.exitCode = problems === 0 ? 0 : 1;
