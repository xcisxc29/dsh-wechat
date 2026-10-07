# 开发手册

面向接手这个仓库的人，以及几个月后的自己。

> 用户文档在 [README](../README.md)，设置说明在 [SETTINGS.md](../SETTINGS.md)。
> 这份讲**为什么是这样**、**踩过什么坑**、**怎么继续改**。

---

## 1. 这是什么

把微信变成 DeepSeek Harness（DSH）的遥控器：手机上发微信，电脑上的 DSH agent 干活。

**不需要 OpenClaw，不需要公网 IP。** 本机主动向外长轮询腾讯 iLink Bot API —— 也就是微信官方 ClawBot 插件背后的那套 HTTP/JSON 接口。

| | |
|---|---|
| npm | `dsh-wechat-plugin` |
| 仓库 | https://github.com/xcisxc29/dsh-wechat |
| 许可证 | MIT |

---

## 2. 仓库结构

```
dsh-wechat/
├── packages/
│   ├── core/            协议层，不 import 任何 DSH 包
│   │   └── src/         login · channel · media · silk · crypto · router · session-index
│   └── bundle/          宿主粘合层
│       ├── src/host.ts      主入口：路由、会话、媒体、审批、设置
│       ├── src/routes.ts    路由契约（主/客两侧共享的路径与类型）
│       ├── src/interactions.ts  权限与提问的文本解析
│       ├── src/media-kind.ts    附件按扩展名分派 image/video/file
│       ├── client.js        设置页（浏览器侧，非 TS）
│       └── cordis.patch.yml 插件身份
├── examples/            只用 core 的完整例子
├── scripts/             打包、校验、冒烟、探针
└── docs/                本手册与其他文档
```

**为什么分两个包**：`core` 只讲协议，可以脱离 DSH 单独测试和复用；`bundle` 负责把协议接到宿主服务上。`core` **不单独发布**，打包时被内嵌进 `dist/core/`。

---

## 3. 开发历程（第一阶段）

以下按**时间顺序**，记录那些改变了做法的事故。每条都问三个问题：**现象是什么、根因是什么、教训是什么**。

### 3.1 起步：先读官方协议，不要猜

早期最快的进展来自一个决定：**所有协议细节以腾讯官方实现为准**。

参照物是 [`@tencent-weixin/openclaw-weixin`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/api/types.ts)（作者 Tencent，MIT），逐条对照它的 `src/api/types.ts`、`src/messaging/send.ts`、`src/cdn/upload.ts`、`src/media/media-download.ts`。

**出站图片花了 6 轮才修好**，全部原因是在没有参照物的情况下猜协议。找到官方源码后一次就对了。

三条最容易踩的坑（都已按官方对齐，改动前务必看）：

1. **`media.aes_key` = base64(hex 文本)**，不是 base64(原始 16 字节)。前者 44 字符、后者 24 字符。**发错形态时服务照收，手机显示灰框**——不报错，最难查。
2. **媒体引用取上传响应的 `x-encrypted-param` 头**。`upload_full_url` 里的长参数是上传授权，拿去读会被 403 拒。
3. **条目不要多发字段**。官方图片条目只有 `media` + `mid_size`；文件条目只有 `media` + `file_name` + `len`。

> **教训**：协议层任何"大概是这个字段名"的想法，都要去官方源码验证。猜对了没奖，猜错了是几小时。

### 3.2 桌面壳拒绝启动：`inject` 是必需声明

**现象**：桌面端弹「应用无法启动」，只报一句 `dsh-wechat: failed`。

**根因**：`client.js` 的插件导出写了 `const inject = []`，但它**要用 `ctx.slots`**。Cordis 的语义是"插件必须等到 `inject` 列出的服务全部可用才激活"——不声明 `slots`，插件就在注册表还不存在时被激活，`ctx.slots` 是 `undefined`，`apply` 抛错 → fiber 变 `failed` → 启动审计判定条目未激活 → **整个应用拒绝启动**。

**为什么难查**：审计**只报 `<id>: failed`，从不告诉你缺哪个服务**。

**教训**：遇到"条目 failed 但无任何线索"，先核对 `inject`。官方模板（`templates/decoration/client.js`）写的正是 `return { inject: ['slots'], apply(ctx) {...} }`。

### 3.3 手机收不到回复：字段名是猜的

**现象**：套件全绿，手机上什么都没有。

**根因**：`agent/assistant-stream` 的帧结构是**猜的**（`frame.text` / `frame.delta`），真实结构是 `frame.chunk.text`（且仅当 `chunk.type === 'text-delta'`）。字段名对不上 → 回复被**静默丢弃**，任何地方都不报错。

**修复时顺带定的两条规则**：

- **`reasoning-delta` 明确排除**——那是模型的私有草稿，泄漏出去等于暴露内部推理
- `block-end` / `finish` / `end` 视为回合结束，立即发送，不再干等静默窗口

**教训**：测试全绿不等于功能可用。**新增的回程测试**（帧 → 微信回复）就是这次事故的直接产物。

### 3.4 最严重的一次：把"曾属于"当成了授权

**现象**：开发会话的提问，跑到了用户的手机上。

**根因**：状态里有个 `sessionOwners` 映射，记录"某会话曾经代表某个微信对话"。授权检查读的是它——于是**对话换走之后，旧会话永久保有发言权**。

**修复**：授权只读**当前绑定**，`sessionOwners` 整个删掉。三处授权点（会话操作、审批、提问）统一走一个严格函数。

**教训**：**"曾经"不是"现在"。** 授权判断必须问"此刻谁代表这个对话"，而不是"谁曾经代表过"。

### 3.5 移动端无法回答审批：fail-closed 会把人卡死

**现象**：不在电脑旁的用户，被永久卡住。

**根因**：权限申请与多选提问原本只在桌面会话面板出现，而框架的应答者**失败即拒绝**（fail closed）。手机用户看不到、答不了。

**机制**：`approval/request` 与 `user-questions/request` 都是 **waterfall** 事件——认领微信绑定会话，其余 `next()` 交给桌面，所以桌面行为完全不受影响。

**两条安全原则**（写在 `interactions.ts` 里）：

- **拒绝优先判定**——`不允许` 含 `允许`，子串匹配会把**拒绝当成同意**，所以先查否定词
- **看不懂就不猜**——无法识别的回复**不当作决定**，提示重发并保持挂起。在权限上猜错等于**批准了用户没同意的事**

---

## 4. 发布阶段：0.32.0 → 0.33.1

这一段几乎全是"发布才暴露"的问题。**公开的版本历史本身就是一个教材**。

| 版本 | 出了什么事 | 根因 |
|---|---|---|
| `0.0.0-stage` | npm 给新包自动建的占位版本 | 首次发布要人工审核 |
| **0.32.0** | 设置页显示「读取设置失败」 | 改包名时**漏了 `routes.ts`** |
| ~~0.32.1~~ | **从未发布** | 只是 README 措辞修正 |
| **0.32.2** | 在干净环境**收消息就失败** | 会话工作目录从来没人创建 |
| **0.32.3** | 修好工作目录 | —— |
| **0.33.0** | 新增：微信对话默认完全权限 | —— |
| **0.33.1** | 验证 OIDC 自动发布 | —— |

### 4.1 包名冲突：`dsh-wechat` 已被占用

**而且功能相同**（`github.com/pan17/dsh-wechat`，2026-08 创建，描述是 "Bridge WeChat iLink bot to DeepSeek Harness"）。`dsh-weixin`、`dsh-plugin-wechat` 同样已被占用。

改为 **`dsh-wechat-plugin`**。

**一条约定**：包名、`cordis.patch.yml` 的行 id、`client.js` 注册的模块 id **三者必须一致**。有测试守着（`client.test.ts`）。

### 4.2 0.32.0：设置页全空 —— 改名漏了一个文件

**现象**：侧栏「微信」入口出现了，但内容区显示「读取设置失败: status unavailable」。

**根因**：路由前缀有**三处**，改包名时只改了两处：

| 位置 | 作用 | 结果 |
|---|---|---|
| `host.ts` | **注册**路由前缀 | ✅ 改成了 `/.dsh-wechat-plugin` |
| `client.js` | **请求**用的前缀 | ✅ 改了 |
| **`routes.ts`** | **handler 比对**用的路径 | ❌ **漏改，还是 `/.dsh-wechat`** |

宿主注册在 `/.dsh-wechat-plugin`，而每个 handler 都在**精确比对** `/.dsh-wechat/status` → **永不相等 → 全部落到 404**。

**为什么测试没拦住**：那条测试只比对"注册前缀 vs 客户端前缀"——**恰好是我改对的两处**。

**现在的守护**：测试**从 `routes.ts` 里读出 `ROUTE_PREFIX`** 一起比。三处必须一致，一个断言。

> **教训（本条最重要）**：改名/改路径这类操作，**先全局搜所有出现位置**，不是改一处补一处。而且测试要验证**不变量**（"三处必须一致"），不是验证"我改过的地方一致"——后者只能证明自己没犯错，前者才能发现遗漏。

### 4.3 0.32.2：干净环境收消息就炸 —— 目录从来没人建

**现象**：新电脑上能扫码、能收消息，但**一收到就报「处理这条消息时出错了」**。

**根因**：

```
处理消息失败: ENOENT: no such file or directory,
realpath 'C:\Users\Administrator\.dsh\dsh_wechat'
```

宿主用 `realpath` 解析会话的 `cwd`，**目录不存在就失败**。而代码里**唯一创建 `dsh_wechat` 的地方是"存媒体附件"那段**——用的是 `recursive: true`，会连父目录一起建。

所以：收到过附件的机器 → 目录存在 → 正常；从没收到过附件的机器 → **第一条消息就炸**。

**为什么开发中永远看不到**：开发机的目录早就被某次测试建出来了。**这是"只在干净安装上出现"的典型**。

**修复**：移到 `resolvePaths()` 里创建（`apply` 阶段跑，任何消息到达之前）。

> **教训**：**必须在干净环境做一次完整安装测试**。本地开发机的状态会掩盖一整类 bug。

### 4.4 0.33.0：手机上反复点「允许」

**这不是 bug，是设计缺陷。**

**现象**：用户说"很多时候需要反复要求权限太麻烦了"。

**根因**：会话的审批策略是 `ask` 时，权限申请会**发到微信**，然后任务**停在那里等回答**。手机上，等于每条命令都卡在一段你已经离开的对话里。

**修复**：新增设置「微信对话的权限」，**默认「完全访问」**，在 `ensureSession` 里应用。

**关键约束**：DSH 在会话**第一轮开始后锁定权限**（`agent-preset/locked`），所以只能在首轮之前设——`ensureSession` 正好是那个时机（router 在建会话和切换时都会调它，都在首轮之前）。

**失败处理是有意的**：服务缺失或会话已开始 → 只记日志、不抛错。**为了权限设置弄丢用户的消息，比让会话保持原策略更糟。**

### 4.5 发布流程本身的坑

| 坑 | 现象 | 原因 |
|---|---|---|
| `pnpm pack` 失败 | `ERR_PNPM_PACKAGE_VERSION_NOT_FOUND` | `pnpm pack` 命中的是 **pnpm 内置命令**，它要根 `package.json` 有 `version`。本仓库一律写 `pnpm run pack` |
| `dist` 后 `pack` 失败 | `打包未重写任何 @dsh-wechat/core 引用` | `pnpm run dist` 会**内嵌** core；`pack.mjs` 依赖未改写的引用。**顺序必须是 `build` → `pack`** |
| 镜像没有新版本 | 用户装到旧版 | 国内镜像（`registry.npmmirror.com`）同步有延迟 |
| 装到旧版 | `package.json` 里锁了**精确版本** | profile 里写 `^x.y.z`，插件管理器会沿用这个约束 |
| npm 版本不出现 | 首次发布新版本要**人工审核** | 等几分钟自动上线，不是失败 |
| `--test-isolation=none` 在 Node 22 报 `bad option` | CI 全红 | 该稳定名字是 **Node 24 才有**；22.19 只认 `--experimental-test-isolation`。**用老名字，24 也接受**（是别名） |
| tarball 断言失败但文件明明在 | CI 红 | `set -o pipefail` + `tar \| grep -q`：`grep -q` 一匹配就退出，`tar` 收到 SIGPIPE（141），pipefail 把**成功判成失败** |

---

## 5. 认证：OIDC，不要用 token

**工作流里没有任何密钥。** 用 GitHub 签发的 OIDC 身份向 npm 证明"我确实是这个仓库的这条工作流"。

**为什么不能用 token**（这段是历史，别走回去）：

- npm 在 **2025-12 吊销了全部经典 token**
- 替代的 granular token 带的"绕过 2FA"能力**正在被限制**——包页面横幅写着 direct publishing 到 **2027-01** 就不允许了
- **Trusted Publisher 是 npm 自己推荐的替代方案**

**一次性配置**（npmjs.com → 包 → Settings → Trusted Publisher → GitHub Actions）：

| 字段 | 值 |
|---|---|
| Organization or user | `xcisxc29` |
| Repository | `dsh-wechat` |
| Workflow filename | **`publish.yml`**（文件名，不是路径） |
| Environment | **留空** |
| **Allowed actions** | **必须勾 `Allow npm publish`** |

**这四个字段逐字匹配**，填错的表现只是发布时 403。**不勾 `Allow npm publish` 的话，只允许暂存发布，直接发布会失败。**

---

## 6. 怎么发一个新版本

```powershell
# 1. 改版本号（唯一权威来源）
#    packages/bundle/package.json → version
#    建议同时更新 README 里的测试数量与进度段落

# 2. 本地过一遍 CI 的全部步骤
pnpm install
pnpm run build
pnpm run typecheck
pnpm run check:install
pnpm test
pnpm run pack
pnpm run verify-pack

# 3. 提交并打 tag
git add -A
git commit -m "0.34.0: <改了什么>"
git tag v0.34.0
git push origin main --tags
```

**推 tag 后 CI 自动**：跑完整校验 → 核对 tag 与 manifest 版本一致 → 发布**那个已经验证过的 tarball**（不是重新打包）→ 带 `--provenance` 签名。

**先干跑**（可选，但**测不到 OIDC 认证**——dry-run 会跳过发布那一步）：Actions → Publish → Run workflow。

**发布后确认**（首次要等几分钟审核）：

```powershell
npm view dsh-wechat-plugin versions --registry=https://registry.npmjs.org
```

### 版本号怎么定

| 变更 | 版本 |
|---|---|
| 修 bug | `0.33.1` |
| 加功能 | `0.34.0` |
| 破坏性变更 | `1.0.0`（目前还没到） |

**npm 的版本号不可复用**——发错了可以 deprecate，但那个版本号永远回不来。**这是发布用 tag 而不是合并触发的原因。**

---

## 7. 开发规范

### 7.1 命令

```bash
pnpm build              # 只编译，保留 @dsh-wechat/core 引用（pack 要靠它改写）
pnpm run dist           # build + 内嵌 core：Git 安装要的可直接加载形态
pnpm typecheck          # 含 examples/
pnpm test               # 177 项
pnpm run check:install  # 两条安装路径的约束
pnpm run pack           # 需要先 build，不能先 dist
pnpm run verify-pack    # 解包、校验清单、按 DSH 的方式挂载一次
```

> **改完 `core` 一定要重新 `pnpm build`。** 测试通过 `node_modules` 解析到 `lib/`——源码改了没重建时，**跑的是旧代码，通过也不作数**。

### 7.2 两条安装路径

用户有两条路，**走的不是同一条产出路径**。详见 [INTERNALS.md](INTERNALS.md)，维护要点：

| | 从 npm | 从 Git |
|---|---|---|
| 产出 | `scripts/pack.mjs` 打包 | `pnpm run dist` 就地构建 |
| core 在哪 | 内嵌 `dist/core/` | 原地，靠相对路径 |
| 包根 | `packages/bundle` | **仓库根** |
| 额外配置 | 无 | 需放行构建（`allowBuilds`） |

**`scripts/check-install-paths.mjs` 守着两条路的前提**，在 CI 里 `pack` 之前跑。它断言的都是"破坏了只在用户机器上才显形"的约定。

**它抓到过一个真实缺口**：`packages/bundle/package.json` 的 `files` 里没有 `README.md` 与 `LICENSE`——此前只靠 `pack.mjs` 打包时补，源码里看不到这个要求。

### 7.3 测试怎么写

**验证不变量，不是证明自己没犯错。**

| 做法 | 问题 |
|---|---|
| 断言"我改过的两处一致" | 漏改的第三处不会被发现（0.32.0 就是这么发的） |
| 断言 `sharp` 可用 | 测的是**我的机器**，CI 上没装它，必然红 |
| 断言"关掉开关后编解码器回来" | 同上：`sharp` 不是本包依赖，有没有取决于环境 |

**两条纪律**：

1. **能失败才算测试。** 每修一个 bug，先**反向验证**：把修复还原，确认测试变红且报出的原因正确。
2. **不假设环境。** 干净环境（没装可选依赖、目录不存在、没有历史状态）才是用户的环境。

### 7.4 干净环境验证（重要）

**本地开发机会掩盖一整类 bug**——目录已存在、编解码器已安装、缓存在、历史状态在。

**发布前**至少做一次：

```powershell
# 全新克隆，全新安装
git clone <repo> /tmp/fresh && cd /tmp/fresh
pnpm install --frozen-lockfile && pnpm run build && pnpm test
pnpm run pack && pnpm run verify-pack

# 再从 npm 真装一遍（不是本地 tarball）
mkdir /tmp/consumer && cd /tmp/consumer
npm install dsh-wechat-plugin
node -e "import('dsh-wechat-plugin').then(p => console.log(p.name, typeof p.apply))"
```

**0.32.2 那个 bug 只要做这一步就会暴露。**

**Linux 也要试**：WSL 里跑一遍 CI 全序列（Docker 也可以）。`0.32.0` 的 `--test-isolation` 坑只在 Node 22 + Linux/Windows 组合上出现。

### 7.5 注释与提交信息

**注释讲"为什么"，不讲"是什么"。** 代码已经说了是什么。

**提交信息一句话说清改了什么。** 设计讨论、走过的弯路、验证过程属于 `docs/`，不属于 `git log`——早期 16 条提交每条 30 多行、还引用了对话记录，后来整体重写成 6 条。

---

## 8. 出问题怎么查

| 现象 | 先看哪里 |
|---|---|
| 插件让 DSH 起不来 | `~/.dsh/wechat/boot.log` 里的 `apply: FAILED:`（**含完整堆栈**） |
| 桌面端崩溃 | `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`（**只采集 error 级 console**） |
| 设置页空白 / 报错 | 那个路由的 HTTP 状态 + `boot.log` |
| 收不到回复 | `boot.log` 的 `outbound` 行；没有就是流解析问题 |
| 装完不生效 | profile 的 `bundles` 里有没有它；`dsh.profile.bundles` |
| 用户装到旧版 | profile 里锁的版本；锁文件；pnpm 缓存 |

**更多事故细节见 [POSTMORTEM.md](POSTMORTEM.md)。**

---

## 9. 相关的 DSH 内部机制

查这些要读 DSH 自己的实现，**不要猜**。`app.asar` 里的关键包：

| 包 | 提供什么 |
|---|---|
| `@deepseek-ai/dsh-client-ui-plugin-manager` | 「插件」入口、「添加插件」、安装/启用/卸载 |
| `@deepseek-ai/dsh-plugin-manager` | 宿主侧：`installBundle`（带 `enabled` 参数）、`list_bundles` |
| `@deepseek-ai/dsh-permission-presets` | `ctx.permissionPresets`：`set(session, 'danger-full-access')` |
| `@deepseek-ai/dsh-sandbox-policy` | `SANDBOX_MODES`、`setSandboxMode` |
| `@deepseek-ai/dsh-user-approval` | `APPROVAL_POLICIES`（`'ask'` / `'never'`）、`setApprovalPolicy` |

**取这些文件的可靠做法**——直接搜 `app.asar` 的字节，不要靠解包工具（大文件会错位）：

```javascript
import fs from 'node:fs'
const buf = fs.readFileSync('.../app.asar')
const n = Buffer.from('permissionPresets', 'utf8')
const i = buf.indexOf(n)
console.log(buf.subarray(i - 300, i + 500).toString('utf8').replace(/\s+/g, ' '))
```

`scripts/asar-extract.mjs` 支持 `--grep` 做**内容**搜索（小文件可靠）。

> **一个价值很高的教训**：早期我用这个脚本搜 `marketplace`、`添加插件` 得到 0 匹配，就**断言 DSH 没有图形化的插件管理器**。实际上那个脚本**当时只匹配文件名、从不搜内容**——那个搜索本来就不可能匹配到界面文案。**搜索不到 ≠ 不存在。给出否定结论前，先怀疑工具。**

---

## 10. 未来可以做的事

按价值排序：

1. **CI 里加一条"从 npm 真装一遍"的验证** —— 目前只验证本地 tarball，`0.32.2` 那类"干净环境才暴露"的 bug 仍可能漏过
2. **白名单** —— 用户明确说不做（"意义不大"），但如果有第三方使用者，这是最该补的安全项
3. **多语言** —— 插件与设置页目前是中文为主、英文为辅
4. **Nim/其它语言的重写** —— 不必要，现在是纯 JS/TS，无原生依赖

**已知的取舍**（不是 bug）：

- **没有白名单**：任何能给机器人发微信的人都能驱动这台电脑。用户知情并接受。
- **权限默认完全访问**：手机上反复点「允许」不可用。可在设置里改。
- **绑定是排他的**：同一个微信号只能绑一台电脑。
- **旧会话无法自动迁入「微信会话」工作区**：需要重建。

