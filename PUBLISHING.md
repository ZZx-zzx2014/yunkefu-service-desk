# 发布到 GitHub 前的检查清单

本文件面向项目维护者，帮助你在公开仓库前确认一切就绪。
**它不是给最终用户看的**，用户文档请阅读 [README.md](README.md)。

---

## 一、一键自检（必做）

```bash
npm install
npm run check:security    # 后门 / 认证绕过 / 硬编码凭据 / 测试模式边界
npm test                  # 全部测试套件（含安全自检）
```

两个命令都必须全部通过再推送。

---

## 二、安全自检覆盖了什么

`npm run check:security` 会用断言的方式复核以下几件事，
避免「作者说没有后门」这种无法验证的承诺：

| 维度 | 关键断言 |
| --- | --- |
| 认证 | 每个业务路由都挂了 `requireAuth`/`requireRole`；公开路由必须显式列入白名单；无 `skipAuth`/`bypass`/万能口令/用户模拟 |
| 凭据 | 签名密钥只来自 `process.env.KEFU_SECRET`；无可用固定默认值；正常模式（默认）缺密钥时 `process.exit(1)`；日志不打印密钥 |
| 测试模式 | `/api/auth/demo` 受 `TEST_MODE` 保护；HTTP 与 WebSocket 都经过来源守卫；测试模式只监听 `127.0.0.1`；**默认为正常模式，测试模式必须显式进入** |
| 外联 | 源码中无第三方主机；前端 `fetch` 只访问站内地址；依赖中无埋点/遥测库 |
| 依赖 | 运行时依赖 ≤3；无前端构建依赖；无原生编译依赖；有 lockfile |
| 敏感文件 | `.env`、数据库、上传目录均在 `.gitignore`；仓库根目录无数据库残留 |
| 合规 | 有 LICENSE；`package.json` 声明 license 且未标记 `private` |

---

## 三、不要提交的内容

`.gitignore` 已覆盖以下内容，推送前请再确认一次：

```bash
git status --short          # 应只看到源码与文档
git ls-files | grep -E '\.env|\.db|node_modules'   # 应无输出
```

- `.env` —— 含真实密钥，**绝不能提交**
- `data/kefu.db*`（含 `-wal` / `-shm`）—— 含真实账号与聊天记录
- `data/uploads/` —— 用户上传的文件
- `data/lan-qr-*.png|svg` —— `npm run lan` 生成的二维码（内含本机局域网 IP）
- `node_modules/`、`.npm-cache/`

> 如果你**曾经**误提交过密钥或数据库，仅删除文件是不够的，历史记录里仍然存在。
> 请重置仓库历史（`git filter-repo`）或直接换掉 `KEFU_SECRET`。

---

## 四、首次推送

```bash
git init
git add .
git status                 # 再确认一次文件清单
git commit -m "feat: 云客客服系统首次开源"
git branch -M main
git remote add origin git@github.com:<你的用户名>/<仓库名>.git
git push -u origin main
```

发布后建议开启：

- **Settings → Security → Dependabot alerts** 与 **secret scanning**
- **Settings → Code security → Private vulnerability reporting**（接收安全问题私下上报）
- 若日后加入 CI，可把 `npm test` 与 `npm run check:security` 作为必过检查

---

## 五、README 里需要用户注意的部分

发布前请确认 README 中这几处仍然准确（改动默认值时要同步更新）：

1. **正常模式是默认状态**（`npm start`），监听所有网卡，**必须配置 `KEFU_SECRET`**，`/api/auth/demo` 已禁用
2. **测试模式需显式进入**（`npm run testmode` 或 `KEFU_TEST_MODE=1`），只监听 `127.0.0.1`，一键体验可用
3. **演示账号是弱口令**，对外部署前必须修改或删除
4. **手机扫码接入**直接用正常模式即可（默认监听所有网卡），需要时放行防火墙
5. 请勿在公用网络（咖啡馆 Wi-Fi 等）下使用

---

## 六、日常开发的约定

改动代码后，以下测试能帮你避免回归：

| 改动内容 | 应运行的测试 |
| --- | --- |
| 接口返回结构 | `npm run test:contract` |
| 认证 / 2FA | `npm run test:2fa` |
| 上传相关 | `npm run test:upload` |
| 实时推送 | `npm run test:realtime` |
| 路由或中间件 | `npm run check:security` + `npm run check` |
| 页面布局 / 滚动 | `npm run check:layout` |
| 数据库结构 | `npm run test:migration` |
| 启动模式 / 安全默认值 | `npm run check:security`（含「默认正常模式」断言） |
| 提交前 | `npm test`（需先以测试模式启动服务：`npm run testmode`） |
| 提权 / 免密码接口 | `npm run test:privilege`（自包含双实例动态验证） |

新增**公开**路由时，必须在 `scripts/check-security.js` 的 `PUBLIC_ROUTES`
中显式声明（键为 `文件名 方法 /路径`），否则自检会失败 —— 这是刻意设计，
避免有人无意中把需要鉴权的接口暴露出去。

## 七、站点托管子系统（已接入）

**站点托管**（`server/routes/sites.js`、`server/php.js`、`server/deploy.js`）已完成接入，
由 `scripts/test-sites.js`（61 项）覆盖：权限边界、静态投递、独立端口、PHP 请求语义、
沙箱隔离、静态站安全、GitHub 部署参数校验、清理。

接入时踩到的坑（保留记录，避免回退）：

1. **必须挂在独立端口**（默认 `PORT + 1`）。托管内容来自外部，同源会让托管页 JS 读到
   同源 `localStorage` 里的登录令牌并直接调用 `/api`。不同端口＝不同源。
2. `server/index.js` 中 `app.use('/api/admin/sites', ...)` 必须写在
   `app.use('/api/admin', ...)` **之前**，否则会被管理端自带的兜底路由吞掉。
3. **不要用 `app.use('/:slug/*')` 反推相对路径**：Express 的 `use` 挂载会把通配段
   从 `req.url` 一并剥掉，`req.path` 只剩 `/`，导致任何 URL 都退化成「根目录找 index」
   ——表现为 `.php` 不执行、`.runtime/` 可访问、`%2e%2e` 穿越返回 200。现在访问端
   自己从 `req.originalUrl` 解析路径。
4. **PHP 的 `-d` 参数会被静默丢弃**：当 `QUERY_STRING` 里没有 `=` 时，php-cgi 会走
   「把查询串当命令行参数再解析一遍」的分支，重建 ini 环境并丢弃全部 `-d`，
   `open_basedir` / `disable_functions` 全部失效（等于沙箱消失）。现在 `runPhp`
   会给无等号的查询串补一个空参数（`a` → `a&=`），语义不变。
5. `open_basedir` 与脚本路径比较时不做短名展开，路径里若含 8.3 短名（如
   `C:\ARDUIN~1`）会直接 404。现在统一先 `fs.realpathSync`。

安全取舍：PHP 站点的 `disable_functions` 包含 `fopen / fwrite / file_put_contents /
mkdir / unlink / rename` 等写函数，因此依赖写文件或安装向导的程序会失败。这是有意为之，
需要写文件能力时请评估后自行放开。
