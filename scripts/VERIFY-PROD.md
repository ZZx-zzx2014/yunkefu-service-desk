# ============================================================
# 正式（正常）模式安全验证手册
# ============================================================
#
# 目的：以对外部署同款的运行模式，验证提权漏洞的三层修复。
# 请按顺序执行，每步都注明了「预期结果」。
#
# 前提：你已生成过密钥（3d4455500f00b9f56b4bc3145170194585e15163426798362740021ea33b140a）
#       —— 若还没写进 .env，先做第 0 步。

# ------------------------------------------------------------
# 第 0 步（仅首次）：把密钥写入 .env
# ------------------------------------------------------------
#   copy .env.example .env
#   然后编辑 .env，找到 KEFU_SECRET= 那行，替换为：
#   KEFU_SECRET=3d4455500f00b9f56b4bc3145170194585e15163426798362740021ea33b140a
#
#   注意：.env 已被 .gitignore 排除，不会进仓库。

# ------------------------------------------------------------
# 第 1 步：语法检查（全部应无输出）
# ------------------------------------------------------------
node --check server/index.js
node --check server/routes/auth.js
node --check server/auth.js
node --check server/routes/sites.js
node --check scripts/test-privilege.js

# ------------------------------------------------------------
# 第 2 步：启动正式模式
# ------------------------------------------------------------
#   先杀掉旧的测试模式进程（如果还在跑）
#   然后执行：
npm start
#
# 预期：服务启动，横幅显示「── 正常模式（对外服务）──」
#       并且不再出现「拒绝启动」的错误。

# ------------------------------------------------------------
# 第 3 步（新开一个终端）：复现你的攻击场景
# ------------------------------------------------------------
#   把你之前在 Burp 里做的那个请求，对正式模式重放：

# 3a. 伪造请求体拿管理员令牌 —— 这就是你报的漏洞
node -e "fetch('http://localhost:3000/api/auth/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'admin'})}).then(r=>r.json()).then(j=>{console.log('状态数据:', JSON.stringify(j)); console.log(j.data&&j.data.token ? '!! 漏洞仍在：拿到了令牌' : '✓ 已封堵：没有令牌');})"

# 预期：✓ 已封堵（404 接口不存在，或 403），绝不返回 token

# 3b. 即使接口被探测，正常登录不受影响
node -e "fetch('http://localhost:3000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})}).then(r=>r.json()).then(j=>{console.log(j.data&&j.data.token ? '✓ 正常登录可用' : '✗ 正常登录坏了');})"

# 预期：✓ 正常登录可用

# 3c. 客户账号改自己角色 —— 应被 403
#     先登录拿客户令牌，再尝试提权
node -e "(async()=>{const l=await fetch('http://localhost:3000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'user1',password:'user123'})}).then(r=>r.json());const t=l.data.token;const me=await fetch('http://localhost:3000/api/auth/me',{headers:{Authorization:'Bearer '+t}}).then(r=>r.json());const esc=await fetch('http://localhost:3000/api/admin/users/'+me.data.id,{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({role:'admin'})});console.log('客户改自己角色 → HTTP', esc.status, esc.status===403?'✓ 已拦截':'!! 可提权');})()"

# 预期：HTTP 403 ✓ 已拦截

# ------------------------------------------------------------
# 第 4 步：跑完整提权测试套件（双实例自动验证）
# ------------------------------------------------------------
npm run test:privilege

# 预期：全部通过，重点看：
#   ✓（关键）伪造 {role:"admin"} 无法获得管理员令牌
#   ✓（关键）演示令牌在正常模式实例上被拒绝（401）

# ------------------------------------------------------------
# 第 5 步：静态安全自检
# ------------------------------------------------------------
npm run check:security

# 预期：全部通过（含新的三条防线断言）

# ------------------------------------------------------------
# 第 6 步（可选）：全量回归
# ------------------------------------------------------------
#   test-all 会启动测试模式子进程，不影响你正在跑的正式实例
#   但它要求 3000 端口的服务以测试模式运行——先停掉正式实例再跑：
#   （Ctrl+C 停止 npm start，然后）
npm run testmode    # 另一个终端跑测试模式
npm test            # 15 个套件

# ------------------------------------------------------------
# 验证完成后回到正式模式
# ------------------------------------------------------------
#   Ctrl+C 停掉测试模式，重新 npm start
