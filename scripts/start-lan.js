/**
 * 以「局域网可访问」方式启动服务
 *   npm run start:lan
 *
 * 与 npm start 的区别：显式放开监听（HOST=0.0.0.0），让同一 Wi-Fi 下的手机可访问。
 *
 * 安全性说明：仍然保持测试模式，因此
 *   - 来源守卫会拒绝公网地址（只接受本机与私有网段）
 *   - 「一键体验」可用（这是局域网演示的便利，也意味着同网段的人可拿到管理员）
 * 因此仅建议在**你信得过的局域网**（家里/办公室内网）使用。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAccessAddresses, primaryAddress } from '../server/netinfo.js';
import { PORT } from '../server/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(ROOT, 'server', 'index.js');

const primary = primaryAddress(PORT);

console.log('\n=== 以局域网模式启动 ===\n');
if (primary) {
  console.log(`  本机局域网地址：\x1b[36m${primary.url}\x1b[0m   （${primary.interface}）`);
  console.log(`  扫码接入页：    \x1b[36mhttp://${primary.address}:${PORT}/lan\x1b[0m`);
  console.log('\n  手机与电脑连同一 Wi-Fi 即可访问。若手机打不开，先运行 npm run firewall 放行端口。');
} else {
  console.log('  ⚠️  未检测到局域网地址，可能当前没有连接网络。');
}
console.log('\n  安全提示：仅接受本机与私有网段来源；请勿在公用网络（如咖啡馆 Wi-Fi）下使用。');
console.log('  启动后可用 npm run lan 查看二维码。\n');

const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  env: { ...process.env, HOST: '0.0.0.0' },
});

child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
