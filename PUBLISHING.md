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
| 凭据 | 签名密钥只来自 `process.env.KEFU_SECRET`；无可用固定默认值；生产模式缺密钥时 `process.exit(1)`；日志不打印密钥 |
| 测试模式 | `/api/auth/demo` 受 `TEST_MODE` 保护；HTTP 与 WebSocket 都经过来源守卫；默认只监听 `127.0.0.1` |
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

1. **测试模式是默认状态**，只监听 `127.0.0.1`，`/api/auth/demo` 免密码可用
2. **对外服务模式**（`KEFU_TEST_MODE=0`）必须提供 `KEFU_SECRET`，否则拒绝启动
3. **演示账号是弱口令**，对外部署前必须修改或删除
4. **手机扫码接入需要先放开监听**（`HOST=0.0.0.0`）并放行防火墙
5. 局域网模式仍然只接受私有网段来源，不应在公用网络使用

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
| 提交前 | `npm test` |

新增**公开**路由时，必须在 `scripts/check-security.js` 的 `PUBLIC_ROUTES`
中显式声明（键为 `文件名 方法 /路径`），否则自检会失败 —— 这是刻意设计，
避免有人无意中把需要鉴权的接口暴露出去。
