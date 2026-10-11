/**
 * 站点部署器：从 GitHub 拉取代码并落到站点目录
 *
 * 支持两种来源：
 *   - github：下载 codeload tarball（无需 git 与认证，公开仓库直接可用）
 *   - manual：管理员上传 zip / 直接把文件放进目录
 *
 * 安全要点：
 *   - 只接受 https://github.com/<owner>/<repo> 严格格式，拒绝任意 URL（防 SSRF）
 *   - 解包时逐条校验路径：拒绝绝对路径、.. 穿越符号链接（防 zip-slip）
 *   - GitHub 的 tarball 里固定有一层 <repo>-<ref>/ 前缀，自动剥掉
 *   - 部署采用「先解到临时目录，成功后原子切换」，失败不影响旧版本
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';

/** 允许的仓库地址：https://github.com/<owner>/<repo>（可带 .git 后缀） */
const REPO_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** ref 只允许安全字符（防注入到 URL 路径） */
const REF_RE = /^[A-Za-z0-9._\/-]{1,100}$/;

/**
 * 解析仓库 URL 为 owner/repo
 * @returns {{ owner: string, repo: string }}
 */
export function parseRepoUrl(url) {
  const m = String(url || '').trim().match(REPO_RE);
  if (!m) throw new Error('仓库地址格式不正确，应为 https://github.com/<所有者>/<仓库>');
  const owner = m[1];
  const repo = m[2];
  if (owner.length === 0 || repo.length === 0) throw new Error('仓库地址不完整');
  return { owner, repo };
}

/** 校验 ref（分支/tag/commit） */
export function validateRef(ref) {
  const r = String(ref || 'main').trim();
  if (!REF_RE.test(r)) throw new Error('分支名含有不支持的字符');
  return r;
}

/**
 * 从 GitHub 下载 tarball 并解包。
 *
 * tar 解包为极简 GNU/USTAR 只读实现（只处理我们要的：普通文件 + 目录），
 * 不引入 tar-fs 依赖。GitHub 的 tarball 不会出现硬链接/设备文件等罕见类型，
 * 遇到不认识的条目直接跳过。
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.ref
 * @param {string} opts.destDir   解包目标目录（须已存在且为空）
 * @param {string} [opts.subDir] 仓库内的站点根（如 "docs" 或 ""）
 * @returns {Promise<{ files: number, bytes: number, rootPrefix: string }>}
 */
export async function deployFromGitHub({ owner, repo, ref, destDir, subDir = '' }) {
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
    headers: { 'User-Agent': 'yunkefu-deployer' },
  });
  if (!res.ok) {
    throw new Error(`下载失败：GitHub 返回 ${res.status}${res.status === 404 ? '（仓库不存在或分支/Tag 不存在；私有仓库暂不支持）' : ''}`);
  }

  // tar.gz = gzip 解压 + tar 解包。gzip 用 zlib 流，tar 按字节偏移解析。
  const zlib = await import('node:zlib');
  const gunzip = zlib.createGunzip();
  const collector = [];          // 收集解压后的 tar 字节
  await pipeline(res.body, gunzip, async function* (source) {
    for await (const chunk of source) collector.push(chunk);
  });
  const tar = Buffer.concat(collector);

  // ---- 解析 tar ----
  const files = [];
  const dirs = new Set();
  let offset = 0;
  let rootPrefix = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // 全零块 = 结束
    if (header.every((b) => b === 0)) break;

    const name = header.subarray(0, 100).toString('utf8').replace(/\0+$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0+$/, '').trim();
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    const typeFlag = header[156] ? String.fromCharCode(header[156]) : '0';
    // USTAR 长名前缀
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0+$/, '');
    let fullName = prefix ? `${prefix}/${name}` : name;

    // 记录 tarball 的顶层目录（repo-ref/），后续剥掉
    if (rootPrefix === null && fullName) {
      const slash = fullName.indexOf('/');
      rootPrefix = slash > 0 ? fullName.slice(0, slash + 1) : '';
    }
    if (rootPrefix && fullName.startsWith(rootPrefix)) {
      fullName = fullName.slice(rootPrefix.length);
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if (fullName && !fullName.endsWith('/')) {
      // 类型 '0' 或 '\0' = 普通文件；'5' = 目录（上面已带 / 结尾）
      if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '7') {
        files.push({ name: fullName, data: tar.subarray(dataStart, dataEnd) });
      }
      // 其它类型（软链接 '2'、硬链接 '1' 等）直接忽略 —— 站点托管不需要，
      // 且跳过软链接能避免「链接指向站点外文件」的逃逸风险
    } else if (fullName) {
      dirs.add(fullName.replace(/\/$/, ''));
    }

    // tar 条目按 512 对齐
    const padded = Math.ceil(size / 512) * 512;
    offset = dataStart + padded;
    if (offset >= tar.length) break;
  }

  if (!files.length) throw new Error('tarball 内没有可用文件（可能是空仓库）');

  // ---- 落盘（带穿越校验）----
  const destRoot = path.resolve(destDir);
  let bytes = 0;
  let written = 0;
  for (const d of dirs) {
    const target = safeJoin(destRoot, d);
    if (target) fs.mkdirSync(target, { recursive: true });
  }
  for (const f of files) {
    const target = safeJoin(destRoot, f.name);
    if (!target) continue; // 非法路径直接丢弃
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
    bytes += f.data.length;
    written++;
  }

  // ---- 处理 subDir：把 <destDir>/<subDir> 提升为站点根 ----
  let finalRoot = destRoot;
  const sub = String(subDir || '').trim().replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
  if (sub) {
    const subPath = path.resolve(destRoot, sub);
    if (!subPath.toLowerCase().startsWith(destRoot.toLowerCase())) {
      throw new Error('子目录路径非法');
    }
    if (!fs.existsSync(subPath)) throw new Error(`仓库内不存在子目录：${sub}`);
    finalRoot = subPath;
  }

  return { files: written, bytes, rootPrefix, finalRoot };
}

/**
 * 安全拼接：确保 join 结果仍在 root 内（防 ../ 与绝对路径逃逸）。
 * 返回 null 表示非法。
 */
function safeJoin(root, rel) {
  if (!rel) return null;
  if (rel.includes('\0')) return null;
  const target = path.resolve(root, '.' + path.sep + rel);
  const rootRes = path.resolve(root);
  if (!target.toLowerCase().startsWith(rootRes.toLowerCase() + path.sep)
    && target.toLowerCase() !== rootRes.toLowerCase()) return null;
  return target;
}

/** 计算目录总大小（字节），供站点列表展示 */
export function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try { total += fs.statSync(p).size; } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return total;
}

/** 删除目录（递归，容忍部分失败） */
export function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}

/** 生成站点目录名（避免猜 ID 即可删库） */
export function siteDirName(slug) {
  return `${slug}-${crypto.randomBytes(4).toString('hex')}`;
}
