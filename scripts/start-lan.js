/**
 * 以「局域网可访问」方式启动服务
 *   npm run start:lan
 *
 * 即正常模式 + HOST=0.0.0.0：手机与电脑连同一 Wi-Fi 即可访问。
 *
 * 前提：正常模式必须已配置 KEFU_SECRET（写进 .env 或系统环境变量）。
 * 若尚未配置，请先运行 npm run new-secret 生成密钥并写入 .env。
 *
 * 安全提示：正常模式下「一键体验」已禁用，但局域网内任何设备都能访问，
 * 请勿在公用网络（如咖啡馆 Wi-Fi）使用。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAccessAddresses, primaryAddress } from '../server/netinfo.js';
import { PORT, SECRET_IS_EPHEMERAL } from '../server/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(ROOT, 'server', 'index.js');

const primary = primaryAddress(PORT);

console.log('\n=== 以局域网模式启动（正常模式，监听所有网卡）===\n');
if (primary) {
  console.log(`  本机局域网地址：\x1b[36m${primary.url}\x1b[0m   （${primary.interface}）`);
  console.log(`  扫码接入页：    \x1b[36mhttp://${primary.address}:${PORT}/lan\x1b[0m`);
  console.log('\n  手机与电脑连同一 Wi-Fi 即可访问。若手机打不开，先运行 npm run firewall 放行端口。');
} else {
  console.log('  ⚠️  未检测到局域网地址，可能当前没有连接网络。');
}
if (SECRET_IS_EPHEMERAL) {
  console.log('\n  提示：本次未设置 KEFU_SECRET，使用了进程内随机密钥 —— 服务重启后所有人需重新登录。');
  console.log('  正式使用请运行 npm run new-secret 并写入 .env。');
}
console.log('\n  安全提示：局域网内任何设备都能访问，请勿在公用网络（如咖啡馆 Wi-Fi）使用。\n');

const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  env: { ...process.env, HOST: '0.0.0.0', KEFU_TEST_MODE: '0' },
});

child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
