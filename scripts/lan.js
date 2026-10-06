/**
 * 局域网接入助手
 *   npm run lan            检测地址 + 终端二维码 + 生成 PNG/SVG
 *   npm run lan -- --open  额外在浏览器打开扫码接入页
 *
 * 用途：把手机和电脑连到同一网络后，扫码即可访问客服系统的客户端入口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PORT, ROOT } from '../server/config.js';
import { listAccessAddresses, primaryAddress, kindLabel } from '../server/netinfo.js';
import { toTerminal, toPNG, toSVG, encode } from '../server/qrcode.js';

const OPEN = process.argv.includes('--open');
const OUT_DIR = path.join(ROOT, 'data');

const addresses = listAccessAddresses(PORT);
const primary = primaryAddress(PORT);

console.log('\n=== 局域网接入 ===\n');

if (!addresses.length) {
  console.log('✗ 未检测到可用的网络地址（可能未连接网络）。');
  console.log('  服务本身仍在 http://localhost:' + PORT + '/ 可用。\n');
  process.exit(1);
}

console.log('检测到以下可访问地址（按推荐程度排序）：\n');
for (const a of addresses) {
  const mark = a.recommended ? '\x1b[32m▶ 推荐\x1b[0m' : '     ';
  console.log(`  ${mark}  ${a.url.padEnd(34)} ${kindLabel(a.kind)}  ${a.interface}`);
}

const target = primary.url;
console.log(`\n建议手机访问：\x1b[36m${target}\x1b[0m`);
console.log(`扫码接入页（电脑上打开）：\x1b[36mhttp://${primary.address}:${PORT}/lan\x1b[0m`);

// 1) 终端二维码
console.log('\n── 手机扫码接入 ─────────────────────────────────────────────\n');
try {
  const qr = encode(target, { scale: 8, margin: 2 });
  console.log(toTerminal(target, { margin: 2 }).split('\n').map((l) => `  ${l}`).join('\n'));
  console.log(`\n  二维码内容：${target}  （版本 ${qr.version}，纠错等级 ${qr.ecLevel}）`);
} catch (err) {
  console.log(`  终端二维码生成失败：${err.message}`);
}
console.log('\n  提示：终端二维码需要浅色背景。若显示错位或为深色主题，');
console.log('        请直接用下方生成的 PNG 图片扫码。');

// 2) 生成图片文件
const safeName = primary.address.replace(/\./g, '-');
const pngPath = path.join(OUT_DIR, `lan-qr-${safeName}-${PORT}.png`);
const svgPath = path.join(OUT_DIR, `lan-qr-${safeName}-${PORT}.svg`);
try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(pngPath, toPNG(target, { scale: 10, margin: 4 }));
  fs.writeFileSync(svgPath, toSVG(target, { scale: 8, margin: 4 }));
  console.log(`\n  已生成二维码图片：`);
  console.log(`    PNG  ${path.relative(ROOT, pngPath)}`);
  console.log(`    SVG  ${path.relative(ROOT, svgPath)}`);
} catch (err) {
  console.log(`\n  图片写入失败：${err.message}`);
}

// 3) 可选：打开浏览器
if (OPEN) {
  const url = `http://localhost:${PORT}/lan`;
  console.log(`\n正在打开浏览器：${url}`);
  const cmd = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, (err) => {
    if (err) console.log(`  打开失败，请手动访问：${url}`);
  });
}

console.log('\n提示：手机需与电脑处于同一 Wi-Fi / 局域网。');
console.log('      若手机打不开，请检查电脑防火墙是否放行了 ' + PORT + ' 端口。\n');
