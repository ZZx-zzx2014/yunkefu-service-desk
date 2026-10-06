# 云客客服系统（YunKe Service Desk）

一套完整的多端客服系统，包含 **在线客服工作台、客户咨询中心、工单系统、知识库/帮助中心、数据看板、管理后台** 六大子系统。
后端 Node.js + Express + SQLite + WebSocket，前端为原生 HTML/CSS/JS（无需构建步骤），开箱即用。

> **安全默认值**：本项目**默认以「测试模式」启动** —— 只监听本机 `127.0.0.1`，
> 且只接受本机与私有网段（局域网）来源。这样可以避免有人把演示环境误暴露到公网。
> 对外提供服务前请务必阅读 [测试模式与对外部署](#二测试模式与对外部署)。

---

## 一、快速开始

```bash
# 1) 安装依赖（仅 3 个：express / multer / ws）
npm install

# 2) 初始化演示数据（首次运行会自动写入）
npm run seed

# 3) 启动服务（默认：测试模式，仅本机可访问）
npm start
```

启动后访问：

| 端 | 地址 | 说明 |
| --- | --- | --- |
| 客户咨询中心 | http://localhost:3000/ | 在线咨询、我的工单、帮助中心 |
| 客服工作台 | http://localhost:3000/agent | 坐席接待、工单处理、知识库、绩效 |
| 管理后台 | http://localhost:3000/admin | 数据看板、组织管理、系统设置 |
| 帮助中心 | http://localhost:3000/help | 知识库公开站 |
| **扫码接入页** | http://localhost:3000/lan | 展示二维码，手机扫码即用 |

**测试模式下的演示账号**（可用密码登录，也可用登录弹窗里的「一键体验」免密码进入）：

| 角色 | 账号 | 密码 |
| --- | --- | --- |
| 管理员 | `admin` | `admin123` |
| 客服坐席 | `agent1` ~ `agent5` | `agent123` |
| 客户 | `user1` ~ `user8` | `user123` |

> 这些是**仅供试用**的弱口令。对外部署时请立即修改，或直接删除演示账号。

---

## 二、测试模式与对外部署

这是本项目最重要的一节。**模式由环境变量 `KEFU_TEST_MODE` 决定**。

### 两种模式的差异

| | 测试模式（默认） | 对外服务模式 |
| --- | --- | --- |
| 触发条件 | 不设置 `KEFU_TEST_MODE`，或设为 `1` | `KEFU_TEST_MODE=0` |
| 监听地址 | `127.0.0.1`（仅本机） | `0.0.0.0`（所有网卡） |
| 来源限制 | 只接受本机与私有网段（局域网） | 不限制 |
| 「一键体验」接口 | **可用**（可免密码进入，含管理员） | **禁用**（返回 403） |
| `KEFU_SECRET` | 未设置时用进程内随机密钥 | **必须提供**，否则拒绝启动 |
| 适用场景 | 本地体验、开发调试、局域网演示 | 真实使用、公网/内网正式部署 |

### 为什么要有测试模式

`POST /api/auth/demo` 会**免密码签发账号令牌**，其中包含管理员账号。
如果直接把它暴露到公网，等于给所有人开了管理员权限。
测试模式通过三重措施把这个接口限制在安全范围内：

1. **只监听 `127.0.0.1`** —— 外部设备根本连不上
2. **来源守卫** —— 即使显式放开了监听（`HOST=0.0.0.0`），也拒绝公网来源的请求
3. **接口级开关** —— 非测试模式下该接口直接返回 403

### 场景一：本地体验（默认）

```bash
npm start
# 只能通过 http://localhost:3000 访问
```

### 场景二：让手机在同一局域网访问

```bash
# 一条命令即可（自动放开监听并提示局域网地址）
npm run start:lan

# 或手动指定
HOST=0.0.0.0 npm start          # macOS / Linux
$env:HOST='0.0.0.0'; npm start  # Windows PowerShell

# 查看局域网地址与二维码
npm run lan
```

Windows 上手机连不上时，最常见原因是防火墙（详见[第三节](#三局域网访问与手机扫码)）：

```bash
npm run firewall          # 放行 Windows 防火墙 3000 端口（会自动请求管理员权限）
npm run firewall:remove   # 需要时撤销
```

### 场景三：对外提供服务（生产）

```bash
# 1) 生成一个强随机密钥
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2) 写入 .env（复制自 .env.example）
cp .env.example .env      # Windows: copy .env.example .env
# 编辑 .env：
#   KEFU_TEST_MODE=0
#   KEFU_SECRET=<上一步生成的随机串>

# 3) 启动
npm start
```

启动时会自动读取 `.env`（零依赖实现，见 `server/env.js`）。
若忘记配置 `KEFU_SECRET`，服务会**拒绝启动**并给出提示，而不是用不安全的默认值运行。

上线检查清单：

- [ ] 已设置 `KEFU_TEST_MODE=0`
- [ ] 已设置足够随机的 `KEFU_SECRET`（≥32 字节）
- [ ] 已删除或修改演示账号（`admin` / `agent1~5` / `user1~8`）
- [ ] 已通过 Nginx / Caddy 反向代理启用 HTTPS（WebSocket 会自动切换 `wss://`）
- [ ] 已定期备份 `data/kefu.db`（WAL 模式，建议连同 `-wal` / `-shm` 一起复制）
- [ ] 已确认不需要将 `data/` 目录纳入版本控制（`.gitignore` 已排除）

> 反向代理注意：如需读取真实客户端 IP，请在**确认代理可信且已剥离客户端伪造头**的前提下设置
> `KEFU_TRUST_PROXY=1`；否则来源守卫会以直连地址为准（这是更安全的默认行为）。

### 安全自检（可自行复核）

「这个仓库里没有后门」不应该只靠作者的一句话。项目自带一个可复核的安全审计脚本：

```bash
npm run check:security
```

它会扫描全部服务端与前端源码，逐项断言：

| 检查维度 | 内容 |
| --- | --- |
| **A. 无认证绕过** | 无 `skipAuth`/`bypass`/万能口令/用户模拟等关键字；**每个业务路由都挂了 `requireAuth`/`requireRole`**（公开路由必须显式列入白名单）；无隐藏调试端点 |
| **B. 无硬编码凭据** | 签名密钥只来自环境变量，不存在可用的固定默认值；生产模式缺密钥时拒绝启动；日志不打印密钥/口令 |
| **C. 测试模式边界** | 免密码的「一键体验」受 `TEST_MODE` 保护；HTTP 与 **WebSocket 都经过来源守卫**；测试模式默认只监听本机 |
| **D. 无隐蔽外联** | 代码中无向第三方主机发送请求；前端 `fetch` 只访问站内地址；依赖中无埋点/遥测库 |
| **E. 依赖面** | 运行时依赖 ≤3 个、无前端构建依赖、无原生编译依赖、有 lockfile |
| **F. 敏感文件** | `.env` / 数据库 / 上传目录均在 `.gitignore` 中；仓库根目录无数据库残留 |
| **G. 开源合规** | 存在 LICENSE、`package.json` 声明 license 且未标记 private |

审计脚本本身也是开源代码，欢迎审查或补充检查项。


---

## 三、局域网访问与手机扫码

测试模式默认只监听 `127.0.0.1`，**手机无法直接访问**。
让同一 Wi-Fi 下的手机接入，只需放开监听（仍然只接受私有网段来源）：

```bash
# 方式一：一条命令搞定（会自动提示局域网地址）
npm run start:lan

# 方式二：手动指定
HOST=0.0.0.0 npm start          # macOS / Linux
$env:HOST='0.0.0.0'; npm start  # Windows PowerShell

# 然后查看局域网地址与二维码
npm run lan
```

放开监听后的启动横幅会显示推荐地址，例如：

```
  ── 局域网访问 ──────────────────────────────────────────────

     http://172.16.250.15:3000/   （WLAN）
     扫码接入页：http://172.16.250.15:3000/lan
```

> 若你已切换到对外服务模式（`KEFU_TEST_MODE=0`），服务本身就会监听所有网卡，无需再设 `HOST`。

### 三种扫码方式

| 方式 | 做法 |
| --- | --- |
| 扫码接入页 | 电脑浏览器打开 `http://<局域网IP>:3000/lan`，页面显示二维码，手机扫码即进入客户端 |
| 终端二维码 | `npm run lan` 会直接在终端画出二维码（半块字符绘制），手机对着终端扫即可 |
| 二维码图片 | `npm run lan -- --open` 生成 PNG/SVG 到 `data/` 并自动打开浏览器 |

二维码接口也可直接调用：

```bash
# 默认生成「推荐局域网地址」的二维码
GET /api/qr                      # PNG
GET /api/qr?format=svg           # SVG
GET /api/qr?data=<任意文本>&scale=10
GET /api/lan                     # JSON：所有可访问地址与推荐地址
```

### 地址是如何挑选的
一台机器常有多个网卡（VMware、WSL、VPN、Tailscale 等）。`/api/lan` 会按
「真实局域网 > 其它私有地址 > 公网 > 虚拟网卡/VPN > 链路本地」排序，
把最可能可用的地址标为 `recommended`，避免让人对着七八个 IP 猜。

### 手机连不上？按顺序排查

1. **是否放开了监听**：测试模式默认只监听 `127.0.0.1`，必须以 `HOST=0.0.0.0` 启动
2. **防火墙**：Windows 默认拦截入站连接
   ```bash
   npm run firewall          # 放行 3000 端口（会自动请求管理员权限）
   npm run firewall:remove   # 需要时撤销
   ```
3. **网络类型**：若电脑网络被识别为「公用网络」，上述防火墙规则不生效。到
   `设置 → 网络和 Internet → 属性` 把网络配置文件改为「专用」
4. **同一个局域网**：确认手机与电脑连的是同一 Wi-Fi（5G / 2.4G 若是不同 SSID 可能隔离）
5. **AP 隔离**：部分路由器/访客网络开启了「AP 隔离」，会阻止设备互访，需在路由器关闭
6. **地址是否用对**：要用启动横幅里 `172.16.x.x` 之类的局域网地址，而不是 `localhost`

> macOS / Linux 一般无需改防火墙；若启用了 ufw 或 firewalld，放行 3000 端口即可。

### 安全提示
局域网内任何设备都能访问该端口，请仅在可信网络使用。
对外提供服务请切换到「对外服务模式」并配置 `KEFU_SECRET`，同时通过反向代理启用 HTTPS。

### 测试模式的可见提示
测试模式下，客户端页面底部会常驻一条提示条，登录弹窗中的「一键体验」入口也只在测试模式显示。
切换到对外服务模式后二者都会自动消失。

---

## 四、功能总览
### 1. 客户咨询中心（`/`）
- 首页：品牌展示、服务能力介绍、热门帮助文档、实时在线坐席数
- 在线咨询：实时对话、图片/文件发送、**会话文件库（查看并重发历史附件）**、排队状态提示、客服接入提醒、消息实时推送
- 会话评价：会话结束后 1–5 星评分 + 文字评价
- 历史会话：查看全部历史咨询记录，可切回未结束的会话
- 我的工单：提交工单、查看处理进度与处理记录、追加回复、工单评价
- 帮助中心：分类浏览、关键词搜索、文章 Markdown 渲染、有用性反馈

### 2. 客服工作台（`/agent`）
- 三栏布局：会话列表 / 对话区 / 客户资料侧栏
- 会话队列：排队中、我的会话、全部会话三种视图 + 搜索
- **实时消息感知**：客户发消息时无需手动刷新 —— 列表实时更新、未读角标、弹窗与声音提醒（即使该会话由其他坐席负责）
- 接待操作：接入会话、转接给其他坐席、结束会话、设置标签与优先级
- 快捷话术：★ 标记「常用」并置顶、分类话术面板、变量 `{code}` 自动替换、使用次数统计
- **会话文件库**：集中查看本会话收发过的图片与附件，支持预览、下载、一键重发（无需重复上传）
- 知识库辅助：输入时自动推荐相关文章，一键引用发送给客户
- 客户画像：联系方式、历史会话、历史工单、未完成工单、会话评分
- 工单处理：我的工单 / 待认领 / 全部工单，认领、流转状态、优先级、指派、内部备注
- 客户列表、知识库管理、快捷话术管理
- 我的绩效：个人指标卡 + 团队排行 + 趋势与渠道图表
- 在线状态：在线 / 忙碌 / 离开，WebSocket 实时同步（多标签页下最后一条连接断开才置为离线）

### 3. 管理后台（`/admin`）
- 数据看板：12 项核心 KPI、会话与工单趋势、渠道分布、24 小时咨询热力图、满意度分布、坐席排行、工单分类分布、标签分布、状态构成
- 统计分析：逐日明细报表、坐席服务排行、渠道与工单构成、CSV 报表导出
- 会话记录：全量会话查询（状态/渠道/日期/关键词筛选）、完整聊天记录回放
- 工单中心：全局工单管理、SLA 超时督办、指派与流转、删除
- 知识库管理：文章增删改查、分类管理、内部/公开可见性、热门文章统计
- 快捷话术管理：公共话术与个人话术
- 坐席管理：账号增删改查、角色、部门、等级、技能标签、并发上限、启用/停用、重置密码
- 客户管理：客户档案与活跃度
- 部门管理：组织架构、成员统计、在线人数
- 系统设置：站点名称、欢迎语、排队提示、自动分配、自动关闭、SLA 基准、评价开关
- 操作日志：全量审计记录（操作人、动作、对象、详情、IP）
- 通知广播：向在线或全体坐席推送系统通知

---

## 五、核心机制

### 自动分配引擎
会话进入排队后，系统按 **技能标签匹配 → 坐席负载 → 在线状态** 打分派单：

```
得分 = 技能匹配 × 100 − 当前接待数 × 10
```

- 仅分配给状态为「在线」且未达并发上限的坐席
- 定时任务每 8 秒重试未分配的排队会话
- 排队超过 3 分钟自动提醒全体在线坐席

### 工单 SLA
创建工单时按优先级折算截止时间（基准由系统设置中的「工单 SLA 基准」控制）：

| 优先级 | 折算系数 |
| --- | --- |
| 紧急 | ×0.1（且不少于 1 小时） |
| 高 | ×0.4 |
| 中 | ×1 |
| 低 | ×3 |

- 按问题类型自动指派到对应部门负载最低的坐席
- 列表与详情页显示「剩余 / 已超时」倒计时
- 客户回复已解决工单时自动重新打开并通知处理人

### 实时通信
WebSocket 网关（`/ws`）承担：

| 事件 | 方向 | 说明 |
| --- | --- | --- |
| `auth` / `auth:ok` | 客户端 → 服务端 | Token 鉴权 |
| `message` | 双向 | 新消息实时推送（会话双方） |
| `queue:update` | 服务端 → 全体坐席 | 客户新消息通知（携带消息与会话摘要，未打开会话也能看到） |
| `queue:refresh` | 服务端 → 全体坐席 | 会话列表刷新信号 |
| `conversation:new` | 服务端 → 全体坐席 | 新会话创建 / 会话被分配 |
| `conversation:assigned` | 服务端 → 全体坐席 | 会话转接（明确告知新负责坐席） |
| `conversation:update` | 服务端 → 客户端 | 会话状态、标签、优先级、结束、评价 |
| `ticket:update` | 服务端 → 客户端 | 工单变更提醒 |
| `ticket:stats` | 服务端 → 全体坐席 | 工单统计变更（列表统计卡自动刷新） |
| `kb:update` | 服务端 → 全体坐席 | 知识库增删改（管理后台自动同步，无需刷新页面） |
| `notification` | 服务端 → 客户端 | 站内通知 |
| `agent:status` | 双向 | 坐席在线状态同步 |
| `typing` | 双向 | 正在输入提示 |
| `ping` / `pong` | 双向 | 心跳保活（30 秒） |

断线自动重连（指数退避，最长 15 秒）。

**关键设计说明**：客户消息会推送给**全体坐席**，而不只是该会话的负责坐席。
因为会话归属由自动分配或历史轮次决定，其他坐席在「全部 / 排队」视图下同样需要
实时看到消息内容与未读提醒；否则坐席只能靠手动刷新页面才能发现新消息。

调试实时链路可开启详细日志：

```bash
# macOS / Linux
KEFU_WS_DEBUG=1 npm start
# Windows PowerShell
$env:KEFU_WS_DEBUG='1'; npm start
```

### 权限模型
三种角色，服务端强制校验（`requireAuth` / `requireRole`）：

| 角色 | 权限范围 |
| --- | --- |
| `customer` | 自己的会话、自己的工单、公开知识库 |
| `agent` | 会话接待与转接、工单处理、内部知识库、个人绩效 |
| `admin` | 全部功能，含账号、部门、设置、日志与删除操作 |

数据隔离示例：客户无法读取他人会话（403）、看不到工单内部备注、看不到内部知识库文章。

### 双因素认证（2FA / TOTP）
支持标准 TOTP（RFC 6238），兼容 Google Authenticator、Microsoft Authenticator、1Password 等验证器应用，仅用 Node 内置 `crypto` 实现，无额外依赖。

**登录流程（两步）**：

```
POST /api/auth/login        { username, password }
  ├─ 未启用 2FA → { token, user }                            直接登录
  └─ 已启用 2FA → { twoFactorRequired: true, twoFactorToken }  短期待验证令牌（5 分钟）
       ↓
POST /api/auth/2fa/verify   { twoFactorToken, code }
  └─ → { token, user }                                      访问令牌
```

**安全设计要点**：

| 机制 | 说明 |
| --- | --- |
| 令牌用途隔离 | 待验证令牌带 `purpose: '2fa'`，**不能访问任何业务接口，也不能建立 WebSocket**，服务端强制校验用途 |
| 防重放 | 记录最近通过的时间步，**更早时间步**的验证码会被拒绝；同一时间步内允许重试（符合真实验证器体验） |
| 时钟偏差容忍 | 校验窗口为当前时间步 ±1（共 90 秒） |
| 备份码 | 启用时下发 8 个一次性备份码，仅存 SHA-256 散列，用后立即失效 |
| 常数时间比较 | 验证码与备份码比对均使用 `timingSafeEqual`，避免时序侧信道 |
| 暴力破解防护 | 登录 15 次/分钟；2FA 验证 10 次/分钟；关闭 2FA 与重置备份码各 10 次/分钟 |
| 关闭需双重确认 | 必须同时提供登录密码与当前验证码（或未使用的备份码） |
| 密钥只存服务端 | TOTP 密钥不随接口下发，仅在绑定流程中展示一次 |

**相关接口**：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 登录第一步（口令） |
| POST | `/api/auth/2fa/verify` | 登录第二步（动态验证码或备份码） |
| GET | `/api/auth/2fa/status` | 当前账号 2FA 状态与剩余备份码数 |
| POST | `/api/auth/2fa/setup` | 生成密钥与 `otpauth://` 配置链接 |
| POST | `/api/auth/2fa/enable` | 校验验证码后启用，返回备份码 |
| POST | `/api/auth/2fa/disable` | 关闭（需密码 + 验证码） |
| POST | `/api/auth/2fa/backup-codes/regenerate` | 重新生成备份码（需验证码） |
| POST | `/api/admin/users/:id/2fa/reset` | **管理员重置**：用户丢失验证器且备份码用尽时的找回途径 |

**界面入口**：登录弹窗会在口令校验通过后自动切到验证码界面（支持倒计时提示与备份码）；登录后右上角用户菜单 →「账号安全（两步验证）」可启用、保存备份码、关闭。

### 文件上传安全
上传是最容易被拿来做后门的入口，因此采用**白名单 + 服务端决定文件名**的策略（见 `server/upload-security.js`）：

1. **先收内存再校验**：文件先进入内存缓冲区，校验通过才写入磁盘，不合法内容不会落盘
2. **类型白名单**：仅允许 PNG/JPEG/GIF/WebP/BMP 图片与 PDF、Office、TXT/CSV/MD/JSON、ZIP/GZ/TAR 等常见文档
3. **文件名由服务端生成**：`<时间戳>-<随机串><服务端决定的扩展名>`，绝不采用用户的扩展名
4. **魔数校验**：图片必须通过文件头识别；PDF/ZIP/Office 等二进制格式校验签名，防止 HTML 冒充 PDF
5. **内容特征检测**：拒绝含 `<?php`、`<script`、`<%`、shebang、`MZ`、`ELF` 等特征的文件
6. **危险扩展名拦截**：含 php/phtml/phar/jsp/asp/aspx/jspx/htaccess/user.ini/web.config/exe/dll/sh/ps1/vbs 等（含双扩展名如 `shell.php.jpg`）
7. **原名清洗**：展示用的原始文件名去掉控制字符与 HTML 元字符，限长 120
8. **投递加固**：图片 inline 返回并附 `nosniff` + 严格 CSP；**其他文件一律 `Content-Disposition: attachment` 强制下载**并加 `sandbox`，杜绝浏览器执行上传内容

同时全站响应头包含 `X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy`、`Permissions-Policy` 与 CSP。

**CSP 策略**（`script-src 'self'`，不含 `unsafe-inline`）：
前端已移除全部内联 `<script>`、内联事件属性（`onclick` 等改为 `data-action` 事件委托）与 `javascript:` 链接，
因此即使存在注入点，注入的 `<script>` 与事件属性也无法执行。Markdown 渲染还会在解析阶段拦掉
`javascript:` / `data:` 等危险协议链接。`style-src` 仍保留 `'unsafe-inline'`（页面模板大量使用内联样式属性，风险远低于脚本）。

> 设计取舍：这里没有使用「禁止所有脚本扩展名」的黑名单作为主要防线（黑名单天然容易被绕过），
> 而是让**落盘扩展名完全由服务端根据校验后的类型决定**——即使某个危险类型没被列举到，
> 它也无法以脚本扩展名落盘。

### 静态资源缓存
页面、脚本与样式表使用**协商缓存**（`Cache-Control: no-cache, must-revalidate` + ETag），
浏览器每次都会发请求校验，仅在内容未变时复用本地副本。

这样做是为了避免一类难以定位的故障：接口契约变更后，浏览器若继续执行旧版 JS，
会出现「旧前端调用新接口」的错乱（典型表现是 `xxx.slice is not a function` 这类
与真实原因毫无关联的报错）。图片等非代码资源仍允许 1 小时缓存。

### 布局与滚动约束
多栏布局（固定侧栏 + flex/grid 主区）中「能否滑动」依赖一组容易漏写的条件，
漏掉任何一条都会表现为**底部被裁掉且无法滚动**：

1. 根容器需要确定高度（`height: 100dvh`）并 `overflow: hidden`，形成滚动上下文
2. 链路上每个 flex/grid 子项都要显式 `min-height: 0`
   —— 默认的 `min-height: auto` 会拒绝收缩到内容高度以下，滚动条不会出现
3. 需要滚动的元素自身要有 `overflow-y: auto`
4. **滚动容器内部不得再写死视口高度**（如 `calc(100vh - 60px)`），否则内容撑开时会被顶出可视区

用 `dvh` 而非 `vh`：移动端浏览器地址栏显隐时 `100vh` 大于实际可视高度，会导致底部输入框被裁切。

这些条件已由 `npm run check:layout` 固化为 33 项断言。

---

## 六、API 接口

统一响应格式：

```json
{ "success": true, "code": 0, "message": "ok", "data": {} }
```

鉴权方式：请求头 `Authorization: Bearer <token>`。

### 认证 `/api/auth`
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/login` | 登录（限流：15 次/分钟） |
| POST | `/register` | 客户注册 |
| POST | `/2fa/verify` | 2FA 登录第二步 |
| POST | `/demo` | 一键体验（**仅测试模式**，非测试模式返回 403） |
| GET | `/me` | 当前用户 |
| PUT | `/profile` | 更新资料 |
| PUT | `/password` | 修改密码 |
| GET | `/settings` | 公开站点配置（含 `test_mode` 标志） |

### 会话 `/api/conversations`
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 会话列表（scope/keyword/status/channel/日期筛选） |
| GET | `/stats` | 工作台概览统计 |
| GET | `/agents/online` | 可选坐席（转接用） |
| GET | `/quick-replies/list` | 可用快捷话术（**返回数组**，常用项置顶，每项含 `is_favorite`） |
| POST | `/quick-replies/:id/use` | 记一次话术使用 |
| POST | `/quick-replies/:id/favorite` | **设为 / 取消常用话术（置顶）** |
| GET | `/:id` | 会话详情 + 客户画像 |
| GET | `/:id/messages` | 消息列表（支持 `after` 增量拉取） |
| GET | `/:id/files` | **会话文件库**：本会话收发过的图片与附件（合并重复文件、含发送次数） |
| POST | `/` | 创建会话（已有未结束会话则复用） |
| POST | `/:id/messages` | 发送消息 |
| POST | `/:id/assign` | 接入 / 转接 |
| POST | `/:id/close` | 结束会话 |
| POST | `/:id/rating` | 服务评价 |
| PUT | `/:id` | 更新标签 / 优先级 / 主题 |
| POST | `/upload` | 文件上传（≤10MB，白名单类型 + 魔数校验，服务端生成文件名，屏蔽可执行脚本与网页） |

### 工单 `/api/tickets`
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/meta` | 分类、优先级、状态、坐席、部门 |
| GET | `/stats` | 工单统计 |
| GET | `/` | 工单列表（scope=mine/unassigned） |
| GET | `/:id` | 工单详情 + 处理记录 |
| POST | `/` | 创建工单（自动指派 + SLA） |
| PUT | `/:id` | 状态 / 优先级 / 指派 / 分类流转 |
| POST | `/:id/comments` | 回复或内部备注 |
| POST | `/:id/rating` | 评价并关闭 |
| DELETE | `/:id` | 删除（仅管理员） |

### 知识库 `/api/kb`
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/categories` | 分类列表 |
| POST/PUT/DELETE | `/categories[/:id]` | 分类管理（仅管理员） |
| GET | `/articles` | 文章列表（游客仅见公开文章） |
| GET | `/articles/:id` | 文章详情 + 相关推荐 |
| POST/PUT | `/articles[/:id]` | 新建 / 编辑（坐席及以上） |
| DELETE | `/articles/:id` | 删除（仅管理员） |
| POST | `/articles/:id/feedback` | 有用 / 没用反馈 |
| GET | `/popular` | 热门文章 |
| GET | `/suggest?q=` | 会话中智能推荐 |
| GET | `/stats` | 知识库统计 |

### 数据看板 `/api/dashboard`
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/overview?range=7d` | 核心指标卡（15+ 项） |
| GET | `/trend?range=7d` | 会话 / 工单 / 评分趋势 |
| GET | `/agent-performance?range=7d` | 坐席绩效排行 |
| GET | `/distribution?range=7d` | 渠道 / 标签 / 评分 / 状态分布 |
| GET | `/hourly?range=7d` | 24 小时时段分布 |
| GET | `/realtime` | 实时概览 |
| GET | `/export?range=7d` | CSV 报表导出 |

`range` 支持 `1d` / `7d` / `30d` / `90d`。

### 管理 `/api/admin`
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/overview` | 管理概览 |
| GET/POST/PUT/DELETE | `/users[/:id]` | 账号管理 |
| POST | `/users/:id/toggle` | 启用 / 停用 |
| GET/POST/PUT/DELETE | `/departments[/:id]` | 部门管理 |
| GET/POST/PUT/DELETE | `/quick-replies[/:id]` | 快捷话术管理（支持 `is_favorite` 常用标记） |
| POST | `/quick-replies/:id/favorite` | 设为 / 取消常用 |
| GET/PUT | `/settings` | 系统设置 |
| GET | `/audit-logs` | 操作日志 |
| GET | `/notifications` | 我的通知 |
| POST | `/notifications/read` | 标记已读 |
| POST | `/broadcast` | 全员 / 在线坐席广播 |

---

## 七、项目结构

```
kefu/
├── package.json
├── data/                        # 运行时数据（自动创建，已 gitignore）
│   ├── kefu.db                  # SQLite 数据库（WAL 模式）
│   └── uploads/                 # 上传文件
├── server/
│   ├── index.js                 # 服务入口、路由挂载、静态资源
│   ├── config.js                # 配置常量（端口、目录、枚举、密钥）
│   ├── db.js                    # 数据访问层、建表 DDL、轻量迁移、设置读写、审计
│   ├── auth.js                  # PBKDF2 口令散列 + HMAC 签名令牌
│   ├── security.js              # 安全响应头（CSP/nosniff/XFO）与上传文件安全投递
│   ├── upload-security.js       # 上传白名单、魔数校验、文件名清洗与安全命名
│   ├── middleware.js            # 鉴权、角色校验、统一响应与错误处理
│   ├── utils.js                 # 编号生成、分页、时间基准、限流
│   ├── realtime.js              # WebSocket 网关、自动分配引擎、定时任务
│   ├── seed.js                  # 演示数据初始化 / 重置
│   └── routes/
│       ├── auth.js              # 认证
│       ├── conversations.js     # 会话与消息
│       ├── tickets.js           # 工单
│       ├── kb.js                # 知识库
│       ├── dashboard.js         # 数据看板
│       └── admin.js             # 管理后台
├── public/
│   ├── index.html               # 客户咨询中心（由 / 提供服务）
│   ├── agent.html               # 客服工作台
│   ├── admin.html               # 管理后台
│   ├── help.html / 404.html
│   └── assets/
│       ├── base.css             # 设计系统与全部基础样式
│       ├── common.js            # API 客户端、鉴权、WebSocket、UI 组件、图表
│       ├── customer.js          # 客户端逻辑
│       ├── agent.js             # 工作台逻辑
│       └── admin.js             # 管理后台逻辑
└── scripts/                     # 测试与自检脚本
    ├── test-all.js              # 统一测试入口
    ├── test-contract.js         # 接口返回结构契约测试（43 项）
    ├── test-upload-security.js  # 文件上传安全测试（40 项）
    ├── test-api.js              # 接口端到端测试（103 项）
    ├── test-realtime.js         # 实时通信测试（26 项）
    ├── test-notify.js           # 客户消息通知场景回归（4 个场景）
    ├── test-features.js         # 常用话术与文件库测试（23 项）
    ├── test-migration.js        # 数据库自动迁移测试（11 项）
    ├── check-layout.js          # 布局滚动约束检查（33 项）
    ├── check-metrics.js         # 看板指标合理性检查
    ├── check-consistency.js     # 前后端一致性与 CSP 兼容性检查
    └── normalize-path.js        # 路径归一化单元测试
```

---

## 八、数据库设计

| 表 | 说明 |
| --- | --- |
| `users` | 统一账号体系（管理员 / 坐席 / 客户），含部门、等级、技能、并发上限、在线状态 |
| `departments` | 部门 |
| `conversations` | 会话（编号、渠道、状态、优先级、标签、评分、未读数） |
| `messages` | 消息（文本 / 图片 / 文件 / 系统） |
| `quick_replies` | 快捷话术（公共 / 部门 / 个人，含 `is_favorite` 常用置顶标记） |
| `tickets` | 工单（编号、分类、优先级、状态、SLA、评分） |
| `ticket_comments` | 工单处理记录（含内部备注） |
| `kb_categories` / `kb_articles` | 知识库分类与文章（公开 / 内部） |
| `settings` | 系统设置（键值） |
| `audit_logs` | 操作审计日志 |
| `notifications` | 站内通知 |

时间统一以 **本地时间字符串** 存储，与 SQLite 的 `datetime('now','localtime')` 保持同一基准，
避免 UTC 与本地时间混用导致时长类指标出现负值。

### 轻量迁移
`server/db.js` 在启动时会执行幂等的字段补齐（`PRAGMA table_info` 检查后用 `ALTER TABLE` 添加），
因此升级代码后无需手动改库，也无需删除 `data/kefu.db`：

- `quick_replies.is_favorite` / `quick_replies.favorite_at` —— 快捷话术「常用」功能
- 首次引入时会自动把使用次数最高的 3 条话术标记为常用，便于直接体验

---

## 九、测试

```bash
npm start          # 先启动服务（另一个终端）
npm test           # 运行全部 14 个测试套件
npm run check:security   # 单独跑开源安全自检
```

单独运行：

```bash
npm run check:security     # 开源安全自检（后门 / 认证绕过 / 硬编码凭据 / 测试模式边界）
npm run check              # 前后端一致性（DOM 引用、接口、字段、CSS 类、严格 CSP 兼容性）
npm run check:layout       # 布局滚动约束（高度约束链、min-height:0、滚动容器）
npm run test:contract      # 接口返回结构契约（数组/对象形状、字段名、缓存策略）
npm run test:2fa           # 双因素认证（TOTP 算法、两步登录、防重放、限流）
npm run test:qr            # 二维码生成与独立解码验证
npm run test:upload        # 文件上传安全（恶意类型、伪装、投递头、路径穿越）
npm run test:api           # 接口端到端（认证、会话、工单、知识库、看板、管理、上传、页面）
npm run test:realtime      # WebSocket 实时推送与知识库同步
npm run test:notify        # 客户消息通知场景（回归测试）
npm run test:features      # 常用话术收藏 + 会话文件库
npm run test:migration     # 旧数据库字段自动补齐
npm run test:metrics       # 看板指标无负值 / 不越界
```

覆盖范围摘要：

- **开源安全自检（35 项）**：业务路由鉴权覆盖（公开路由必须显式白名单）、无认证绕过关键字、无硬编码可用密钥、生产模式强制要求 `KEFU_SECRET`、测试模式边界（HTTP 与 WebSocket 双重来源守卫）、无第三方外联、依赖面、敏感文件忽略、开源合规
- **接口契约（43 项）**：所有「返回数组」与「返回 {list, pagination}」的接口形状、字段名、分页字段、错误响应结构、静态资源缓存策略；含「旧前端写法 res.slice().map() 不报错」的兼容性断言
- **二维码（38 项）**：RFC 规范表不变量、格式/版本信息对照标准表、**独立解码器还原原文**、PNG 像素级解码（模拟扫码）、抗污损纠错、版本 1~10 全量往返、局域网接口与 `/lan` 页面
- **双因素认证（50 项）**：RFC 6238 测试向量、启用/关闭流程、两步登录、待验证令牌越权探测、防重放、备份码一次性、登录与 2FA 验证限流
- **布局滚动约束（45 项）**：根容器视口高度（dvh）、主区域约束链、`min-height:0` 覆盖、各滚动容器可滚动性、工作台三栏不再写死视口高度
- **上传安全（40 项）**：30 种恶意类型拦截（PHP/phtml/phar/jsp/asp/aspx/perl/python/sh/exe/bat/ps1/vbs/jar/.htaccess/.user.ini/web.config/nginx.conf/html/xhtml/svg/xml/xslt/swf）、伪装与多态文件、落盘名与展示名清洗、路径穿越、静态投递响应头、大小上限、未登录拒绝，以及 10 种正常文件的回归可用性
- **接口测试（103 项）**：三种角色登录、越权拦截、会话全生命周期（创建→接入→消息→转接→评价→结束→幂等）、工单全流程（自动指派→回复→内部备注→流转→重开→评价→关闭）、知识库权限隔离、看板 7 个接口、管理后台 CRUD、文件上传与访问、WebSocket 鉴权、页面与静态资源可达性
- **实时测试（26 项）**：鉴权、心跳、双向消息推送、会话状态通知、正在输入、坐席状态持久化、工单变更与统计广播、**知识库增删改实时同步**、多标签页在线状态
- **消息通知回归（4 个场景）**：客服已打开会话、客服未打开会话、会话排队中连发消息、客户先发消息客服后登录 —— 确保任何情况下坐席都能实时感知客户消息
- **新增功能测试（23 项）**：常用话术收藏/取消/置顶排序/管理端操作/越权拦截、文件库空态、图片与文档识别、统计口径、文件名与大小、一键重发、重复文件合并计数、客户与坐席可见性、跨客户越权拦截、附件 URL 可达
- **迁移测试（11 项）**：旧库自动补列、数据不丢失、常用标记自动初始化、幂等性
- **一致性检查**：浏览器脚本语法、服务端模块加载、68+75+84 个 DOM 引用、75 个前端接口调用与后端路由比对、24 个关键 CSS 类、绩效字段命名、**严格 CSP 兼容性（无内联脚本/事件/javascript: 链接）**、路由注册顺序

> 接口契约测试是为一类特定事故加的：早期把 `quick-replies/list` 的返回从**数组**改成
> **`{list, favorites}` 对象**，导致浏览器里缓存着旧版 JS 的页面在运行时抛出
> `res.slice is not a function`。现在该接口固定返回数组（常用标记由每项的 `is_favorite` 表达），
> 且契约测试会锁住所有接口的形状，静态资源也改为**协商缓存**以避免浏览器继续执行旧版代码。
>
> 安全自检的存在理由类似：它把「这个仓库没有后门」变成可复核的断言，
> 而不是只能相信作者的说明。新增公开路由时必须显式登记，否则自检会失败。

---

## 十、运维与配置

### 环境变量

配置可直接写在 `.env`（复制 `.env.example` 后修改），也可用系统环境变量；
**系统环境变量优先于 `.env`**。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `KEFU_TEST_MODE` | `1`（开启） | 测试模式开关。`0` 为对外服务模式，详见[第二节](#二测试模式与对外部署) |
| `KEFU_SECRET` | 测试模式随机生成 | 令牌签名密钥。**对外服务模式必填**，否则拒绝启动 |
| `PORT` | `3000` | 监听端口 |
| `HOST` | 测试模式 `127.0.0.1`，否则 `0.0.0.0` | 监听地址 |
| `KEFU_DB_FILE` | `data/kefu.db` | 数据库文件路径（便于测试或多库切换） |
| `KEFU_TRUST_PROXY` | 关闭 | 设为 `1` 时信任 `X-Forwarded-For`（仅在可信代理后开启） |
| `KEFU_LOGIN_RATE_LIMIT` | `15` | 登录尝试上限（次/分钟/IP+账号） |
| `KEFU_2FA_RATE_LIMIT` | `10` | 2FA 验证尝试上限（次/分钟） |
| `KEFU_2FA_ADMIN_RATE_LIMIT` | `10` | 关闭 2FA / 重置备份码的尝试上限 |
| `KEFU_WS_DEBUG` | 关闭 | 设为 `1` 输出 WebSocket 连接与在线状态日志 |
| `KEFU_SHOW_QR` | 关闭 | 设为 `1` 启动时在终端打印可扫描二维码 |

```bash
# macOS / Linux
KEFU_TEST_MODE=0 KEFU_SECRET=<强密钥> PORT=8080 npm start

# Windows PowerShell
$env:KEFU_TEST_MODE='0'; $env:KEFU_SECRET='<强密钥>'; npm start
```

### 数据维护
```bash
npm run seed      # 首次运行且库为空时写入演示数据；已有数据则跳过
npm run reset     # 清空全部数据并重建演示数据（不可恢复，会删除自建账号）
npm run cleanup   # 只清理测试残留数据，保留自建账号（先预览，加 --apply 执行）
```

### 依赖说明
仅两个运行时依赖：
- `express` — HTTP 框架
- `ws` — WebSocket 服务端
- `multer` — 文件上传（v2.x）

数据库使用 Node.js 内置的 `node:sqlite`，**无需原生编译**，安装依赖不会触发 node-gyp。
要求 Node.js **≥ 22.5.0**（推荐 24.x）。

### 生产部署要点
1. 使用 `KEFU_SECRET` 设置强随机密钥
2. 通过 Nginx / Caddy 反向代理并启用 HTTPS（WebSocket 会自动切换为 `wss://`）
3. 定期备份 `data/kefu.db`（WAL 模式，备份时建议同时复制 `-wal` 与 `-shm`）
4. 如部署多实例，需改用共享数据库并将自动分配定时任务改为单实例执行

---

## 十一、界面预览要点

- **设计系统**：`public/assets/base.css` 集中定义色板、间距、圆角、阴影与全部组件，三个端共用
- **图表**：折线图、环形图、横向条形图、24 小时热力图均为纯 CSS/SVG 实现，无第三方图表库
- **响应式**：工作台在窄屏下自动折叠右侧资料栏，客户端聊天页在移动端改为单列
- **交互细节**：消息气泡动画、Toast 提示、模态框、下拉菜单、骨架屏与空状态

---

## 十二、常见问题

**Q：启动报 `Cannot find package 'multer'`？**
执行 `npm install` 安装依赖。

**Q：报 `Cannot find module 'node:sqlite'`？**
Node.js 版本过低，需 ≥ 22.5.0（`node -v` 查看）。

**Q：端口被占用？**
设置 `PORT` 环境变量改用其他端口。

**Q：客服工作台打不开 / 一直跳回首页？**
工作台需要坐席或管理员账号。请用 `agent1 / agent123` 或 `admin / admin123` 登录。

**Q：实时消息不推送？**
检查浏览器控制台 WebSocket 连接状态，以及代理服务器是否放行了 `/ws` 路径的升级请求。

**Q：哪些文件可以上传？**
图片（PNG/JPEG/GIF/WebP/BMP）与常见文档（PDF、Word/Excel/PPT、TXT/CSV/MD/JSON、ZIP/GZ/TAR 等），单个文件最大 10MB。
出于安全考虑，**可执行脚本（php/jsp/asp/sh/exe 等）、网页文件（html/svg/xml）与服务器配置文件（.htaccess/.user.ini/web.config）一律拒绝**。

**Q：CSP 会不会影响自定义扩展？**
如果后续要给页面添加内联 `<script>` 或内联事件属性（`onclick=`），会被 CSP 拦截。
请改为在 `public/assets/` 下新增脚本文件，或使用 `Kefu.registerAction('名称', 处理函数)` + `data-action="名称"` 的声明式绑定。
`npm run check` 会扫描并报告此类违规。

**Q：页面报 `xxx.slice is not a function` / 行为与代码不一致？**
通常是浏览器仍在执行缓存的旧版 JS。项目已把页面与脚本改为协商缓存，一般刷新即可；
若仍异常，请强制刷新（Windows：`Ctrl+F5`；macOS：`Cmd+Shift+R`）。
如果是接口返回结构发生了变更，请同步更新前端并运行 `npm run test:contract` 锁住形状。

**Q：为什么默认是测试模式，而不是直接可用？**
因为测试模式允许「一键体验」免密码登录（包含管理员）。把它作为默认状态并限制在本机，
能避免有人克隆后直接部署到公网、留下一个谁都能进的管理后台。
对外使用只需设置 `KEFU_TEST_MODE=0` 与 `KEFU_SECRET`，见[第二节](#二测试模式与对外部署)。

**Q：如何确认这个项目里没有后门？**
运行 `npm run check:security`。它会扫描全部源码并逐项断言：没有认证绕过、
没有硬编码可用密钥、免密码接口受测试模式保护、没有向第三方发送数据等。
脚本本身也是开源的，欢迎审查或补充检查项。

---

## 十三、参与贡献

- 提交前请运行 `npm test` 与 `npm run check:security`，两者都必须通过
- 新增**公开**接口时，必须在 `scripts/check-security.js` 的 `PUBLIC_ROUTES` 中显式登记
  （键为 `文件名 方法 /路径`），否则安全自检会失败 —— 这是刻意设计，
  以防无意中把需要鉴权的接口暴露出去
- 界面改动请保持「严格 CSP」约束：不使用内联 `<script>`、内联事件属性或 `javascript:` 链接，
  改用 `Kefu.registerAction('名称', 处理函数)` 配合 `data-action="名称"`
- 布局改动请保持滚动约束链：固定视口容器 + 每层 `min-height:0` + 滚动区 `overflow-y:auto`，
  改完运行 `npm run check:layout`

维护者发布到 GitHub 前的检查清单见 [PUBLISHING.md](PUBLISHING.md)。

## 十四、许可

[MIT License](LICENSE) —— 可自由用于商业项目，请保留版权声明。

> 本项目为通用客服系统骨架，**默认配置面向本地试用**。
> 投入生产前请务必完成[第二节](#二测试模式与对外部署)的上线检查清单
> （设置密钥、修改演示账号、启用 HTTPS）。

