/**
 * 以「测试模式」启动服务
 *   npm run testmode
 *
 * 测试模式与正常模式的差异：
 *   - 只监听 127.0.0.1（本机），手机无法访问
 *   - 只接受本机与私有网段来源（纵深防御）
 *   - 「一键体验」可用：可免密码以演示账号进入（含管理员）
 *   - 未设置 KEFU_SECRET 时使用进程内随机密钥
 *
 * 适合本地体验与开发调试。要让手机访问请用 npm run start:lan（正常模式）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(ROOT, 'server', 'index.js');

console.log('\n=== 以测试模式启动 ===\n');
console.log('  · 仅监听 127.0.0.1，手机无法访问（要让手机访问请用 npm run start:lan）');
console.log('  · 「一键体验」可用：可免密码以演示账号进入（含管理员）');
console.log('  · 仅限本地体验与开发调试，请勿暴露到公网\n');

const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  env: { ...process.env, KEFU_TEST_MODE: '1' },
});

child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
