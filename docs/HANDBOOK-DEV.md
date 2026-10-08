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

### 3.6 最隐蔽的一次：发送失败被当成成功

**这是本仓库里最坏形状的一个 bug**——它不报错，而是**告诉用户相反的事**。

**发现过程**：用户说"我微信没收到"。日志显示发送成功，还有收件人、字节数、时间。但日志里有一处不对劲：

```
22:38:05  outbound: HANDBOOK-USER.md 15574B -> … id=7513608600672820360   ← 有消息 ID
22:51:58  outbound: HANDBOOK-USER.md 15012B -> … id=(none)                ← 没有 ID
```

**`id=(none)` 就是服务端没接受**，但代码没把"没有 ID"当成失败。

**根因**（两层叠加）：

| # | 问题 |
|---|---|
| 1 | `SendMessageResp` 声明的是 `ret`，**服务端实际返回 `errcode`**——字段名对不上，读不到错误 |
| 2 | `sendText` 和 `sendItem` **完全不检查错误字段**，只取 `message_id` |

直接调 API 拿到真相：

```json
{ "errcode": -14, "errmsg": "session timeout" }
```

**而且服务端两种字段都用**：裸请求返回 `errcode: -14`，带头齐全的请求返回 `ret: -2 / prepare failed`。所以检查必须写 `errcode ?? ret`——这不是多余防御，是必需的。

**修复**：`http.ts` 里加 `assertSendAccepted()`，`sendText` 与 `sendItem` 都调用；`-14` 专门给一句可操作的话（"需要你先在微信里发一条消息"）。

**顺带发现的两条真实限制**（都写进了用户手册）：

| 限制 | 依据 |
|---|---|
| **微信会话会超时** | 实测：最后一条消息后约 6 分钟推送正常，约 13 分钟后被拒。失效后**只能等用户先发消息** |
| **非绑定会话的审批不到手机** | 代码里 `conversationId === undefined → delegate`，提示留在桌面。所以"离开电脑"必须用绑定会话，或把该会话设成完全访问 |

> **教训**：**"我发出了"和"对方收到了"是两件事。** 服务用 HTTP 200 回答一个被拒绝的请求时，任何只检查状态码、只取"成功字段"的代码都在撒谎。公开的发送类接口，**必须检查拒绝字段**。

### 3.7 「对方正在输入」实现了，但从没显示过

**现象**：作者问能不能用微信的"正在输入"提示 agent 已经收到消息——**代码里其实早就有了**，`sendtyping` 调得好好的，收到消息发 `TYPING`、处理完发 `CANCEL`。**但它一次都没出现过。**

**根因**：`getconfig` 需要 `ilink_user_id` 参数，而代码发的是**空 body**：

```
POST ilink/bot/getconfig  {}   →  {"ret":-2,"errmsg":"ilink_user_id required"}
```

拿不到 `typing_ticket`，`setTyping` 就在 `if (!this.#typingTicket) return` 那一行**静默返回**。

**为什么一年都没人发现**：`setTyping` 的注释写着"typing 是装饰性的，失败绝不抛给调用方"——**所以整条链路是设计成沉默的**。而它依赖的 `getconfig` 又返回 HTTP 200 带 `ret: -2`，`apiCall` 不看 `ret`。

**同一个坑的第三次**：`types.ts` 里 `GetConfigResp` 也**没声明 `errcode`**（和 3.6 的 `SendMessageResp` 一样）。现在抽出了一个 `RefusalFields`，所有可能被拒的响应都从它继承——**这样"忘了声明错误字段"就不会再发生一次。**

**顺带修的两件事**：

- **指示器只闪一下没用**。原实现在 `#handleInbound` 的 `finally` 里取消，而 `#deliver` 只是把请求**提交**给 agent 就返回了——所以"正在输入"在 agent 真正开始干活之前就消失了。现在：**交给 agent 的回合由 `#reply` 取消**（回复真正发出的那一刻），**并且每 5 秒重发一次**（客户端几秒就自动停显示，发一次等于没发），**30 分钟硬上限**兜底。
- **测试桩里没有 monitor**，所以 `#startTyping` 在测试中永远早退——**整段逻辑没被覆盖**。这是"桩返回 undefined 导致行为未被测试"的老毛病，和 3.5 那次同源。

> **教训**：**"best effort" 的代码最容易烂掉。** 一个设计上永不抛错、永不记日志的功能，坏了没有任何声音。凡是有意吞掉异常的路径，**至少要在正常路径上留一句可验证的痕迹**——这里就是：测试直接断言 `getconfig` 的请求体里必须有 `ilink_user_id`。

---

## 4. 发布阶段：0.32.0 → 0.36.0

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
| **0.34.0** | 新增：任何会话都能推送到微信 | —— |
| **0.34.1** | 修：发送被拒却谎报成功；修 pnpm 配置失效 | 见 4.6 |
| **0.35.0** | 新增：被拒的推送排队，等窗口重开时补发 | 见 4.7 |
| **0.35.1** | 名称说明（仓库名 ≠ 包名）；README 顶部声明面向桌面端 | —— |
| **0.35.2** | 声明针对 DSH `0.2.0-rc.2` 实测，并持续跟进 | —— |
| **0.36.0** | **更正安全模型**：原句"任何人发消息都能控制你电脑"是错的 | 见「已知的取舍」 |
| **0.36.1** | 修：「对方正在输入」从未显示过；设置页加「帮助」分组可打开用户手册 | 见 3.7 |
| **0.36.2** | 「帮助」分组从最下面移到最上面 | —— |
| **0.36.3** | 修：路径比较在 Linux 上会混淆大小写不同的目录 | 见 7.6 |
| **0.36.4** | 新增 README 配图六张（手机/锁屏/推送/文件/语音/设置） | —— |
| **0.36.5** | 修正配图：同一句话出现在多张图时，选它是最新一条的那张 | —— |

**发布节奏的转折点在 `0.33.1`**：那之前每个版本都是手动 `npm publish`（要按指纹、要等审核）；那之后打 tag 就自动发布，人不再碰 npm。

### 4.1 包名冲突：`dsh-wechat` 已被占用

**而且功能相同**（`github.com/pan17/dsh-wechat`，2026-08 创建，描述是 "Bridge WeChat iLink bot to DeepSeek Harness"）。`dsh-weixin`、`dsh-plugin-wechat` 同样已被占用。

改为 **`dsh-wechat-plugin`**。

**一条约定**：包名、`cordis.patch.yml` 的行 id、`client.js` 注册的模块 id **三者必须一致**。有测试守着（`client.test.ts`）。

**仓库名保留 `dsh-wechat`，包名多一个 `plugin`** —— 这个不一致是**有意的**，也**考虑过统一，最后决定不改**：

| | |
|---|---|
| **改名能解决什么** | 用户从仓库名猜安装名时不会装错 |
| **为什么没改** | npm 的 **Trusted Publisher 里填的是仓库名**（`dsh-wechat`），而**那个配置不能编辑，只能删掉重建**。为了一个名字去动发布链路，风险大于收益 |
| **怎么弥补** | 安装相关的文字里，**包名只以可复制的形式出现**，并且必须带一句"`dsh-wechat` 是别人的插件"。README 中英两版、用户手册的安装章节都有 |

**残余风险**：总有人不读文档、凭印象输 `dsh-wechat`，装到别人的插件。**接受这个风险**——那也是个功能类似的插件，不是坏东西，而且用户发现名字对不上会回来。**不要再提议改仓库名**：代价是重建发布凭证，已经权衡过了。

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

### 4.5 0.34.0：干活的会话没法汇报自己的结果

**现象**：用户想的是"我在这边让 DSH 干活，然后出门，做完了发我微信"。做不到。

**根因**：`send_to_wechat` 只认**当前绑定微信的那个会话**（那是 4.2 那次安全修复的结果）。于是**干活的会话做完时没有资格往微信发东西**——答案随回合一起消失。

**用户提了三条路，两条是错的**：

| 思路 | 为什么不做 |
|---|---|
| ① 让它"主动连接微信、成为绑定会话" | **会改 `bindings`**，于是用户手机上的消息会跑到那个会话，原来的微信会话失去身份。**代价远大于收益** |
| ② 通过微信会话转发（`prompt` 中继） | 要**消耗另一个会话的模型轮次**，而且结果取决于那个 agent 会不会照做 |
| ③ **直接投递到当前绑定的对话**（采用） | 直接调协议层，**确定性**、不消耗别的会话、不动绑定 |

**一个关键认知**：真正的发送（`#conveyFile` / `#sendText`）**只要 account + 收件人**——"必须是绑定会话"**只是工具层的一道授权检查**，不是协议要求。所以 ③ 不需要改绑定，也不需要中继。

**设计要点**：

- **不接受"发给谁"这个参数**——目标从状态里的绑定解析。agent **没有搞错目标的可能**。
- 绑定了**多个**对话时**直接拒绝**，不猜。（今天只绑一个，这是防未来的账户功能。）
- **默认开启**，而且这是功能成立的**前提**而非疏忽：关掉的话"做完了告诉我"这句话就不成立。
- 设置关掉时**回退到旧的严格规则**（只有绑定会话能发），**而不是仅仅禁用便利**——旧的安全姿态仍然可达。

**它和 4.2 那个事故的区别**（这条写进了提交信息，免得以后有人看到"放开限制"就以为退回去了）：

| | 4.2 的事故 | 0.34.0 |
|---|---|---|
| 目标 | **已失效**的旧绑定仍在代表对话 | **当前有效**的绑定 |
| 语义 | 会话**假冒**对话 | 会话**投递到**对话 |

**验证方式**：反向验证——把默认值改成 `false`，**恰好**失败那两条依赖它的测试，其余全过。这条比"测试通过"更能说明默认值真的被读取。

### 4.6 0.34.1：发送被拒却谎报成功，以及一个死掉的 pnpm 配置

两件不相干的事，因为修第一件才暴露第二件。

**第一件**（详见 3.6）：`sendText` 和 `sendItem` 只读 `message_id`，从不检查错误字段，而类型里的字段名（`ret`）和服务端实际用的（`errcode`）还不一致。于是**被拒绝的发送和成功送达在代码里长得一样**，`notify_wechat` 报"已通过微信发送"而手机什么都没收到。

**第二件**：升版本号后 `pnpm run build` 突然中止，并把 `node_modules` 删到只剩 3 个条目（原本几百个）。

```
ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
```

**根因**：pnpm 10 把项目配置从 `.npmrc` 搬到了 `pnpm-workspace.yaml`，而 `.npmrc` 里的 `node-linker=hoisted` 和 `confirm-modules-purge=false` **早就失效了**——

```
$ pnpm config get node-linker
undefined
```

hoisted 布局只是靠旧安装留下的 `node_modules/.modules.yaml` 在维持，所以**看起来一直是好的**。直到某次 pnpm 决定"依赖过期了，我要重建"，那一刻没有任何东西能拦住它，而它又没有终端可以询问，于是删到一半中止。

**修复**：两个设置移到 `pnpm-workspace.yaml`（`nodeLinker` / `verifyDepsBeforeRun` / `confirmModulesPurge`），`.npmrc` 留说明防止有人改回去。

> **诊断教训**：我先把键加进 `.npmrc` 试了一轮，**毫无效果**——因为问题就是"pnpm 不读这个文件"。**一条 `pnpm config get` 就能立刻定位，我却在后面才想到。** 怀疑配置没生效时，先问工具它读到了什么，而不是继续改配置。

### 4.7 0.35.0：被拒的推送排队，等窗口重开时补发

**背景**：3.6 修好之后，失败至少是可见的了。但可见只是第一步——**消息还是丢了**。

**为什么不能根治**：官方类型定义写得很清楚：

```ts
/** Issued per inbound message and required verbatim on the reply. */
context_token?: string
```

token 由**用户那条消息**签发，回信时必须原样带回。它过期后服务返回 `-14 session timeout`。**这是平台的回信模型**（与微信公众号的客服消息窗口同源）：机器人不能凭空发起对话，客户端没有任何技巧能绕过。

**所以做的是"不丢"，不是"不限"**：

| 环节 | 做法 |
|---|---|
| 被拒时 | 存进 `pendingNotifications`（状态文件里，重启不丢） |
| 补发时机 | **入站消息刷新 token 之后、处理这条消息之前**——积压先出现，才读得出是积压而不是对你刚那句话的回答 |
| 只对"被拒"排队 | 网络断了、文件不存在**直接抛错**：那些重试也不会成功，变成队列只是把错误藏在延迟后面 |
| 边界 | 最多 20 条、最长 24 小时，都是常量，注释说明为什么 |
| 文件 | **存路径不存字节**——否则每次漏发一张截图，状态文件就长一截。代价是文件可能已被删除，那就**明确告诉用户哪个文件没了**，而不是悄悄跳过或无限重试 |

**两处设计是被自己的第一次实现教出来的**：

- 一开始先读队列**再**清理过期项 → 会把刚判定为过期的条目发出去。改成先清理再读。
- 一开始文件不存在时只 `continue` 不删条目 → 下次会把文件**前面那段文字重发一遍**。改成丢弃并告知。

**入口 id 是必要的**：原本用「时间 + 文字 + 路径」当身份删除，同一毫秒入队的相同消息会被一起删掉。加了 `id` 之后，补发循环读一次队列、并发入队也不会错位。

**验证方式**：两次反向验证——去掉补发钩子 → 补发测试红；去掉入队判断 → 入队测试红。恢复后全绿。

### 4.8 发布流程本身的坑

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
pnpm test               # 195 项
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

### 7.5 永远不要"睡固定时间"

**规则：等一个"迟早会发生"的效果，就用 `waitFor(条件, 说明)` 轮询，不要 `setTimeout` 一个猜出来的时长。**

**这条是被发布事故换来的。** 有两个测试这样写：

```ts
await new Promise((resolve) => setTimeout(resolve, 10_600))   // 合并窗口是 10 秒
assert.equal(harness.prompted.length, 1)
```

**只比被等的定时器多 600 毫秒。** 本地一直过，CI 上 ubuntu 那次**慢了 600 毫秒就挂**，而**同一个提交在 CI 的四个矩阵组合里全过**——于是它挡住了一次发布，看起来还像"偶发"。

**两个修法一起用**：

1. **把窗口调短**——测试要验的是"窗口关闭后附件被释放"，不是窗口有多长。`withSettings(..., { mergeWindowMs: 200 })`。光这一步就把那两个测试从 21 秒降到 0.9 秒。
2. **轮询到条件成立**——`waitFor`（文件里已有）每 5 毫秒查一次，3 秒超时。**慢机器只是慢，不会假失败**；真挂了也照样快速失败。

> **判断标准**：如果你的等待时间**是从另一个时间常量推算出来的**（"窗口 10 秒，那我等 10.6 秒"），**那就是错的**。两个数字会各自漂移，而它们之间的距离就是你的假失败率。

### 7.6 换一台电脑还能用吗（可移植性）

**这不是理论问题**：别人装 DSH 的位置、用户名、工作区目录都和作者不同，插件必须**全部从环境推导**，不能有任何一处硬编码。

**已经核对过的（2026-10-08）**：

| 项 | 结论 |
|---|---|
| 硬编码绝对路径 | ✅ 一个都没有（命中的都是测试里的假路径、GitHub URL、注释） |
| DSH 主目录 | ✅ `ctx.get('homePaths')` → `DSH_HOME` → `homedir()/.dsh`，三级回退 |
| 工作区目录 | ✅ `join(home, 'dsh_wechat')`——跟着主目录走 |
| 路径拼接 | ✅ 全部用 `join`/`resolve`；**唯一的手写斜杠是 URL**（`${cdnBaseUrl}/download?...`），那本来就该是 `/` |
| Git 安装时跑的 `inline-core.mjs` | ✅ 用 `fileURLToPath` + `resolve`，纯相对路径 |
| CI 覆盖 | ✅ ubuntu + windows × Node 22.19/24 四个组合都跑测试 |

**发现并修掉的一处**：`isSameWorkspace` **在任何平台都把路径转小写**。

- Windows / macOS 默认不区分大小写 → 转小写正确
- **Linux 区分大小写** → `/home/me/Projects` 和 `/home/me/projects` 是**两个目录**，转小写会把陌生人的会话算成渠道自己的，并试图在错误的工作区下收养它

现在按平台判断（`CASE_INSENSITIVE_PATHS`），并把大小写策略做成**可传参**，这样两种行为都能测。

> **教训**：`toLowerCase()` 出现在路径比较里，就是一个跨平台 bug 的候选。**"同一个路径的两种写法"和"两个不同的路径"在 Windows 上无法区分，在 Linux 上必须区分。**

**仍然没有验证的一处（诚实记录）**：

DSH 会话存储的**目录编码**（`C:\Users\me\.dsh\dsh_wechat` → `--C-Users-me-.dsh-dsh_wechat--`）是在 **Windows 上对着真实目录核对出来的**。我们复刻的算法没有平台分支，纯函数测试也覆盖了 POSIX 路径（`/home/me/my_app` → `--home-me-my_app--`），但**没有在 macOS / Linux 的真实 DSH 上核对过**。

**要验证它**：在一台非 Windows 机器上装好 DSH，跑起插件，然后看 `~/.dsh/sessions/` 下的目录名是否等于 `encodeWorkspaceDir(工作区路径)` 的输出。如果不等，会话列表和切换就会找不到自己的会话。

### 7.7 注释与提交信息

**注释讲"为什么"，不讲"是什么"。** 代码已经说了是什么。

**提交信息一句话说清改了什么。** 设计讨论、走过的弯路、验证过程属于 `docs/`，不属于 `git log`——早期 16 条提交每条 30 多行、还引用了对话记录，后来整体重写成 6 条。

### 7.8 我们对外声明了"跟着 DSH 更新"，就得真的跟

README 中英两版、用户手册、以及 Hub 的提交，都写了这句话：

> 针对 DSH **`0.2.0-rc.2`** 开发和实测，**并会随桌面端的更新持续跟进**。

**这句话的价值恰恰建立在"很多插件已经过期"上面**——所以它同时是一份**必须兑现的义务**：一旦我们自己落后了，这句话就从卖点变成把柄。

**DSH 桌面端更新时要做的事**：

1. 在这台机器上升级 DSH，确认 `@deepseek-ai/dsh-base` 的版本号变了
2. 跑一遍 `pnpm build && pnpm test && pnpm run pack && pnpm run verify-pack`
3. **至少真机验证一次**：装插件 → 扫码 → 发一条消息 → 收到回复（自动化测试覆盖不到宿主服务的变化）
4. 把上面那四处声明里的版本号改成新的

**第 3 步不能省。** 测试跑的是我们的代码，而 DSH 升级改的是**我们依赖的服务契约**——`inject` 里的 `sessionController`、`sessions`、`workspaceRegistry`、`tools` 任何一个变了，测试都可能还是绿的。

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
| **`@deepseek-ai/dsh-schedule`** | **定时任务**：`after` / `at` / `every` / `daily` / `weekly`；agent 工具 `createSchedule`、`listSchedules`、`updateSchedule`、`deleteSchedule` |

### 一个我写错过、后来改口的结论

**我早先在本仓库里断言过"DSH 没有调度服务"**，依据是搜 `dsh-cron` / `dsh-scheduler` / `dsh-task` 都没有结果。

**那是错的**——服务叫 `@deepseek-ai/dsh-schedule`。**我搜的是名字，不是能力。**

这件事的教训和前面那条一样：**否定结论必须建立在"我搜对了地方"之上。** 后来是因为在别的代码里瞥见 `scheduledAt` 才回头查清。

**定时任务对我们这个插件很重要**：定时任务**建在哪个会话，就在哪个会话被唤醒**。所以"每小时通过微信叫我"是这么成立的——在会话里建 `every` 任务 → 每小时那个会话被唤醒 → 它用 `notify_wechat` 投递到微信。

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
2. **多语言** —— 插件与设置页目前是中文为主、英文为辅
3. **Nim/其它语言的重写** —— 不必要，现在是纯 JS/TS，无原生依赖

**已知的取舍**（不是 bug）：

- **没有白名单，因为协议层已经有一道**：iLink 机器人**在发凭证时就和扫码的那个微信号密码学绑定**，`bot_token` 里嵌着 `ilink_user_id`，服务端**只投递这一个账号的消息**（`from_user_id` 永远是扫码者）；机器人也**不是微信联系人**——没有名片、搜不到、加不了。所以**不存在"别人能给它发消息"这条路**，在应用层再挡一次没有意义。

  > ### 一段该留着的错误（0.36.0 更正）
  >
  > 这个项目**长期在 README 和用户手册里写着"任何能给机器人发微信的人都能驱动这台电脑"**，还配套讨论了要不要做白名单。**那句话是错的。**
  >
  > **源头**：`host.ts` 里一句残留注释——`The allow list is checked before anything else is read or downloaded`。**代码里从来没有白名单**，而它描述的那个"风险"在协议层压根不存在。作者两次说"加了白名单也没意义"，我两次把它当成一个**取舍**记进文档，**却始终没去核实协议层的账号模型**。
  >
  > **教训**：**涉及安全的结论，不能从自己代码里的注释推断**——注释可能过时、可能描述一个已删除的功能。要去官方协议或权威实现里确认模型本身。这次是别的项目的 issue 里一句 `the bot is protocol-level 1:1` 才把真相带出来的。
- **权限默认完全访问**：手机上反复点「允许」不可用。可在设置里改。
- **跨会话推送默认开启**：这台电脑上**任何会话**都能主动发消息/文件到用户微信。这是"做完了告诉我"成立的前提，关掉该功能即失效。**关掉设置可恢复**只允许绑定会话发送的旧规则。
- **绑定是排他的**：同一个微信号只能绑一台电脑。
- **旧会话无法自动迁入「微信会话」工作区**：需要重建。
- **定时任务不是固定文本**：每次投递都会真的跑一轮模型，所以有 token 消耗、内容也可能不同。

