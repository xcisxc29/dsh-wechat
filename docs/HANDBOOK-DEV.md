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

## 4. 发布阶段：0.32.0 → 0.37.0

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
| ~~0.36.6~~ | **从未发布** | 备好了版本号和首图，下一版直接并进 0.37.0 |
| **0.37.0** | **修：设置改完存了也会丢，重启即重置**；删掉已废弃的工具卡片接口（日志一直在刷错）；会话工作目录可在设置页图形化选择；新增 `/model` 切模型（命令 + 自然语言）；发送被拒时记录服务返回的原始 `ret`/`errcode`/`errmsg` | 见 4.9 |
| **0.38.x** | 回复窗口计数改为持久化；新增命令行 `dsh-wechat-send`，让 agent 的脚本不再直连 iLink | 见 4.10.1 |

### 4.9 手抄的白名单一定会漏

`0.37.0` 修的是一个**存了也会丢**的 bug：设置页改完、保存成功、文件里也确实写对了，**重启就回到默认**。

根因在 `normalizeSettings()`——一个**手抄的设置白名单**，只列了最早那 7 个设置。后来加的
`permissionPreset`、`allowCrossSessionNotify`、`workspacePath` **全都不在里面**。而每次写盘都会先
重新加载并归一化一次，于是这几个键被过滤掉，**下一次写盘把丢失当成了事实写回去**。

**为什么长期没被发现**：单测覆盖的是 `saveSettings` 的写入路径，而破坏发生在**读取路径**上；
而"保存成功"的提示读的是写返回，不是读回来的值。两边都绿，用户却在重启后看到默认值。

**修法**：不再手抄，改成**映射类型上的穷尽校验表**——少写一个键，`typecheck` 直接报错；
再加一条**往返测试**，它列举 `DEFAULT_SETTINGS` 的每一个键并断言数量相等，
以后再加设置却忘了改测试，测试会红。

**教训**：**允许列表（allowlist）是代码里最容易腐烂的东西**——它不报错、不崩溃，只是安静地丢数据。
凡是"每加一个字段就要回来补一行"的设计，都要让**编译器或测试**来兜底，不能靠人记得。

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

## 4.10 回复窗口：每个 token 只能发 10 条（**实测**）

这一条**官方文档里没有**，社区说法互相冲突（有说每天的、有说频率的、有说 5 条的）。
2026-10-12 我们用自己的日志把它钉死了：**每个 `context_token` 10 条**。

### 实测数据

```
01:39:17.327  inbound（用户发消息 —— 窗口打开，下发新 token）
01:39:19.119  第 1 条   ✅
   …… 每条间隔约 2.5 秒 ……
01:40:12.582  第 10 条  ✅
01:40:15.802  第 11 条  ❌ 发送被微信拒绝：ret=-2 errcode=-2 errmsg=prepare failed
从此之后所有发送 → 同样被拒，只能等用户再发消息
```

**两个关键点**：
- **间隔 2.5 秒仍然撞墙**（更早的一次用 5 秒间隔也一样）→ 这是**条数**配额，不是频率
- **错误码是 `prepare failed`，不是 `rate limited`** → **等多久都不会自愈**，重试毫无用处

### 机制

配额挂在 `context_token` 上，而 `context_token` **只有一个签发入口：入站消息**。

```
用户发消息 → 新 token → 新的 10 条
发满 10 条 → 这个 token 就废了 → 之后的推送全部 prepare failed
用户再发一条 → 又是新 token → 又是新的 10 条
```

**"静默久了推不出去"和"连发超过十条就不行"是同一件事** —— 都是窗口没了。

### 为什么绕不过去（调研结论，非推测）

| 手段 | 结论 |
|---|---|
| `prepare` 接口 | ❌ 不存在。官方 endpoint 共 10 个，没有它；8 个实现全仓 grep `prepare` 只命中 SQLite 的 `db.prepare()` |
| 心跳保活 | ❌ 微信不支持编辑消息，**每次心跳都是一条新消息，反而消耗配额** |
| 不带 token 裸发 | ❌ 三方独立复现全部失败 |
| 篡改 token | ❌ 实测服务端**照收**被改坏的 token → 过期判定在服务端 |
| `getconfig` 续期 | ⚠️ 只对"时间将过期"可能有用；**对"10 条耗尽"未验证**（唯一还没被证伪的缝隙） |

**没有任何一个实现做到过"不需要用户发消息就能发超过 10 条"** —— 覆盖腾讯官方、hermes-agent、nanobot、weilink、QwenPaw、openclaw、cc-connect、Lanrenbang。

**顺带**：腾讯官方实现**完全没处理**（缺 token 只打一行 warn 就照发）；hermes-agent 为此开了 4 个 issue，最终也只是"承认绕不过 + 不丢消息"。

### 我们的做法

**在临界点主动请用户续期**（`#noteQuota`）：

- 按会话计数，**token 变了就归零**（新 token 自带新的 10）
- 用到 **8 条**时发一条提醒：**「微信这边一个回复窗口最多连发 10 条，我快到上限了。你随便回我一句，我就能把剩下的接着发过来。」**
- **为什么是 8 而不是 10**：**提醒本身也占配额**。等发满了再提醒，那条提醒自己就发不出去了 —— 这是个很容易踩的循环陷阱
- 提醒走**底层 `#send`**，不走 `#sendText`，否则"计费"会触发"再计费"递归
- 计数**不持久化**：重启丢计数，代价只是"多撞一次墙"，处理方式（被拒→排队）完全一样

**仍然遵守的纪律**：被拒 = 排队等你发消息（不重试，重试无用）；`prepare failed` **绝不**计入任何熔断器（hermes 因为 `threshold=1` 连刷 13 小时 cooldown）。

## 4.11 `/list all` 每次都不一样：时间取自会变的文件属性

**现象**：用户在微信里发 `/list all`，**每次顺序不同**，同一个会话的「上次时间」每次显示也不同。同一份输入，两次输出不一样。

**根因有两层，都在 `session-index.ts`**：

| # | 问题 | 位置 |
|---|---|---|
| 1 | `updatedAt` 取自会话目录里**所有文件的最新 mtime**（`newestMtime()`） | 旧 `session-index.ts:288` 的 `newestMtime`，被两个列表函数调用 |
| 2 | 排序只有**一个键**（`b.updatedAt - a.updatedAt`），**没有第二排序键** | 旧 `session-index.ts:204` 与 `:257` |

**为什么这两条合起来就是"每次都不一样"**：

- **mtime 回答的是错的问题**。它是"这个目录最后一次被写是什么时候"，而*任何*写入都会改它——后台跑一轮、工具碰一下文件、存储自己整理。用户看到的时间因此在两次提问之间凭空变了。
- **时间撞车在真实数据里是常态**。实测这台机器上 `~/.dsh/storages/session_projcache/sessions/` 里**大量条目共享同一个时间戳**（同一次批量导入、同一个秒）。`Array.prototype.sort` 是稳定的，所以时间相等时顺序 = **输入顺序**，而输入顺序来自 `readdir`——一棵目录树给什么顺序就是什么顺序，不是数据的属性。
- 分组列表还有第三个不稳定源：`listAllStoredSessions()` 返回 `Map`，而 `Map` 保持**插入顺序**，插入顺序又来自目录遍历。

**修法**：

1. 时间改读**会话记录里的字段**：`record.rows.sessionListMetadata.val.lastPromptAt`（DSH 自己的会话列表用的就是它），退回 `identity.createdAt`。它只在**这个对话真的动过**时才变。
2. `compareSessionsNewestFirst()`：**主键结束时间倒序，第二键 sessionId 升序**（用 `<`/`>`，不用 `localeCompare`——collation 依赖运行时的 locale 数据，会变成"这台机器确定、那台不确定"）。
3. 分组的 `Map` 按**组内最新时间 + 路径**重排后再插入。
4. 每次都用 `stamp` 记录时间，`relativeTime()` 可注入 `now`，所以**一条消息里每一行对"3 分钟前"的理解一致**。

**回归测试**（都在，且都做过反向验证）：`session-index.test.ts` 里"排序键是会话记录而不是最新写入的文件"（故意把 mtime 设成**相反**顺序）、"时间相等时仍然完全有序，同一份存储列两次结果一致"；`core.test.ts` 里"同一份列表无论存储以什么顺序交出各行，输出逐字节相同"。

> **教训（和 §7.3 同一条）**：**"文件的时间"不是"事情发生的时间"。** 任何用 mtime 当业务时间的排序，都是一份会在用户眼皮底下变化的答案。

### `/list` 重做（同一批需求）

同一批需求里还改了三件事，都记在这里因为**取舍不在代码里**：

| 改动 | 为什么 |
|---|---|
| **短 id 从 8 位缩到 4 位，`0.40.0` 又放宽到 6 位**（`SHORT_ID_LENGTH`）| 手机上要能读、能重打。**代价必须写清楚**：4 位十六进制只有 65 536 种，机器上几百个会话就会撞——实际用下来确实撞了，所以现在是 **6 位（16 777 216 种）**；多打两个字符是免费的，撞一次不是。长度变了，**机制不变**：**歧义是显式失败**——`resolveTarget()` 返回 `{kind:'ambiguous'}`，回复「有多个会话匹配，请用更长的 id」并列出候选（候选开头的 8 位就是"更长的 id"）。**绝不猜**——猜错是把用户的活儿切到别的对话 |
| **`/switch <id>` 用前缀匹配** | 用户想打多长就打多长（`e716f0` → `e716f0a` → 完整 id）。`resolveTarget` 的尝试顺序是**精确优先**（编号 → 完整 id → 精确题目 → 前缀 → 后缀 → 模糊题目），否则一个像十六进制的题目会被前缀规则抢走 |
| **引用锁定（quote pinning）** | 编号是"那份列表里的位置"，而列表拍的是一个还在动的机器。发出的列表按**服务端分配的 message id** 把编号存进 `state.json`（`sessionLists`，每个对话保留最近 5 份），引用那条消息回复编号就按那份解析。**新 state 字段同时改了 `normalize()`**（逐项校验、非法项丢弃）并配了往返测试——§4.9 那个"存了也会丢"的坑就靠这条纪律不再复发 |

> **`/list` 的默认范围没有变**：仍然只列微信工作区，`/list all` 列全部。变的是**排版**（按工作区分组、编号跨组连续、行尾带短 id）和**编号的含义**（按用户看到的那份列表解析，而不是按此刻的实时列表）。

## 4.12 `/list all` 只看得见微信会话：上限是「全局」的

> **这一节的做法已经被 §4.13 推翻。** 它记录的是"分组平铺 + 截断"那一代的问题与修法，那些常量
> （`LIST_ALL_GROUP_LIMIT` / `LIST_ALL_LIMIT`）已经删除。留着它是因为**下面两条教训仍然成立**，
> 而且 §4.13 正是从它的天花板出发的：截断是死路。

**现象**：用户发 `/list all` 想看全部会话，看到的**和 `/list` 几乎一样**——只有微信会话。

**根因**：`groupSessionRows` 先对**全机**会话取最新 10 条，**再**按工作区分组。而微信工作区几乎总是最新的那批（用户刚在用它），于是 10 行全归微信，分组之后**只剩一个组**，`all` 形同虚设。

| 顺序 | 结果 |
|---|---|
| 全局取 10 → 再分组 | 只剩一个组（微信），`/list all` 等于 `/list` |
| **分组各取名额 → 再套总上限** | 每个工作区都有自己的位置，多个工作区成为**必然** |

**修法**（`router.ts`，两个常量都带注释说明为什么是这个数）：

- `LIST_ALL_GROUP_LIMIT = 3`：**组内先截**。这一步是修 bug 的那一步——它让"能看到多个工作区"变成列表的**结构性质**，而不是碰巧。
- `LIST_ALL_LIMIT = 12`：名额本身**不是上限**，十个工作区就是三十行，手机上读不完。按显示顺序（本工作区优先，其余按最新时间）取到 12 行为止；**被挤掉的工作区整组不出现**，只计入末尾那个数字。
- **截断的措辞分两种**。普通按时间截断说「还有 N 个**更早的**对话未显示」；按名额截断只说「还有 N 个对话未显示」——被名额挤掉的行**可能比留在屏幕上的还新**，写"更早的"是假话。标题同理：名额截断时写「共 N 个对话（每个工作区最多显示 3 个）」，因为屏幕上那 12 行**不是全机最新的 12 行**，写「最近 12 个」也是假话。
- **`/list` 一点都不变**：仍是本工作区，仍是 10 行。

**顺带补的一句人话**：列表每行末尾印着 6 位短 id，但提示语只说「/switch 编号或 /switch id 切换」——用户不知道行尾那个东西**就是** id。现在末尾明说是「行尾那个 6 位 id」，并**拿这份列表第 1 行的 id 当例子**（例子从数据里取，不是写死的字符串，所以永远对得上）。`HELP_TEXT` 里 `/switch <id>` 一行也改成同样的说法。

**测试**（三条，全都做过反向验证）：

| 测试 | 断言的是什么 |
|---|---|
| `core.test.ts`「/list all gives every workspace a share…」 | **存在多个工作区时至少列出两个**（`groups.size >= 2`）、本工作区也只占 3 行、截断数量写在末尾、提示语里有第 1 行的短 id；同一条测试里再断言 `/list` **仍然只有微信会话**且仍有 10 行 |
| `core.test.ts`「/list all stops at a readable length…」 | 6 个工作区 × 4 行 = 24 行 → 只印 12 行、只留 4 个组、剩下 12 个计入「还有 12 个对话未显示」 |
| `plugin.test.ts`「a spoken full list shows more than one workspace…」 | **说大白话那条路**（`#sessionTable` 自己分组、自己截断）同样给出多个工作区。只修打字那条路，同一个问题就会有两个答案 |

**反向验证**：把 `groupSessionRows` 改回「全局先截 10 条再分组」，上面三条**同时变红**（第一条报的正是 `expected rows from several workspaces`），恢复后全绿。

### 顺手发现、当时没修、之后补上的一处

**说大白话的「看全部对话」（`action: list` + `target: all`）会锁错编号。**

`controlSession` 当初把 `text` 交给路由器时**永远是 `/list`**，所以路由器渲染并回报的 `numbered` 是**本工作区的那份清单**（最多 10 行）；而真正发给用户的消息体是 `#sessionTable(...includeAll)` 自己渲染的**全机清单**。`#rememberListedRows` 冻结的是前者，于是**引用那条消息回编号，编号对不上打印出来的行**。

实测（12 个微信会话 + 1 个别处会话，`target: all`）：

```
打印: 1. e402a4  2. 0011aa  3. 0010aa  4. ffff99     ← ffff99 是别的工作区
锁定: 1. e402a4  2. 0011aa  3. 0010aa  4. 0009aa …   ← 本工作区第 4 个
```

**这不是加分组那次引入的**：从前全局取 10 条时，打印出来的前 10 行几乎总是本工作区的，两份编号恰好一致；本工作区会话很少、别处更活跃时则早就对不上。**但改成按工作区分名额之后，第 4 行起必然对不上**，所以这个老问题从"偶尔"变成了"常见"。因为当次改动被明确要求**不要动引用锁定逻辑**，只先记录在案。

**修法（`host.ts`，一行）**：`action === 'list' && target === 'all'` 时把交给路由器的 `text` 写成 **`/list all`**，让路由器渲染（因而被冻结）的就是实际发出去的那一份。发给用户的消息体本来就由 `#sessionTable` 渲染，所以这条改动**只改「锁哪一份编号」**，用户看到的文案一个字都没变。

**测试**（`plugin.test.ts`「a quoted spoken full list answers with the rows it printed」）：13 个本工作区会话 + 1 个别处会话 → 说大白话列全部 → **引用那条消息**回它自己打印的那个编号 → 必须切到**那行印着的**那个别处会话。

**关键在于两份编号在那行真的不一样。** 测试先断言同一个编号在普通 `/list` 里指的是一个本工作区会话（`本工作区 N`），再断言切过去的**不是**它。两份编号若碰巧一致，这条测试带着 bug 也会绿——"引用测试是弱测试"的教训就在这里，所以这次把"不一样"本身写成了断言。

**反向验证**：把 `text` 改回 `/list`，这条测试立刻变红，报的是 `已切换到「本工作区 9」。` 而不是 `已切换到「别处的工作」`——正是上面那张表里"打印 ffff99、锁定 0009aa"的老 bug；恢复后全绿。

> **教训**：`/list all` 和 `/list` 长得一样，**这本身就是报告**——一个功能没有可见的效果，等于没做。而「存在多个工作区时至少列出两个」这条断言，本该在加分组那次就写下来：它检查的不是某处代码改对了没有，而是**用户能不能看出这个功能存在**。同一件事还有第二层：**同一个功能的两个半边必须问同一份数据**。打印用一份、冻结用另一份，各自都对，合起来是错的。

## 4.13 `/list all` 推翻重做：两层、每屏十条、「查看其余」

**§4.12 的修法是对的，但天花板很低。** 每个工作区 3 行、整条 12 行——这是一把**截断**，而截断是**死路**：掉在第 12 行之后的东西**存在**，数字写在末尾，但**点不到**。工作区一多，别的工作区整组不出现。用户的原话是「使得用户有能力查看所有并且同时显示的会话数可控」。

**所以改成两层分页**：

| 层 | 内容 | 进入方式 |
|---|---|---|
| 第一层 | **会话夹**（= 工作区），每个一行、带会话数 | `/list all` |
| 第二层 | 某个工作区里的会话 | 回**编号**或**名字** |

- **每屏最多 10 条**，回复「**查看其余**」往下翻十条，一直翻到底；到底了明说「只有 N 页，已经到底了」，并且**不再邀请你翻**
- **编号跨屏连续**（第一屏 1–10，第二屏 11–20）。每屏从 1 重来的话，一个浏览过程里同一个数字会有两个含义
- **`/list` 直接进微信工作区那一层**，不显示会话夹列表（既定设计：那才是大多数人要的那份列表）
- **进会话夹只改浏览位置，不改绑定**

### 被删掉的东西（不要留死代码）

`groupSessionRows`、`flattenSessionGroups`、`renderSessionList`、`SessionGroup`、`LIST_ALL_GROUP_LIMIT = 3`、`LIST_ALL_LIMIT = 12`，以及 `host.ts` 里**自己重画一份列表**的 `#sessionTable` / `renderTable`。**说大白话那条路现在把 `/list`、`/list all` 原样交给路由器，再把路由器的渲染发出去**——一个渲染器，一个编号，两条路不可能再分叉（§4.12 最后那条「打印和冻结问的不是同一份数据」在结构上消失了）。留下的只有「另有 N 个对话在其它会话夹」这句提示（`heldNames` / `heldOnlyList`），它不是截断，是一次指路。

### 新的 state 字段：`browsing`

「查看其余」**不带参数**，所以插件必须记住「翻到哪儿了」：`{ level: 'folders' | 'sessions', workspace, page, at }`，**按账号 → 会话**存。

**什么时候清**（理由写在 `host.ts` 的 `BROWSE_IDLE_MS` 与 `#trackBrowse` 旁）：

| 时机 | 为什么 |
|---|---|
| 新的 `/list` 覆盖它 | 新列表就是新的立足点 |
| **任何别的消息**（交给 agent 的、`/switch`、`/new`、`/current`……）清掉 | 用户已经走开了，这句话不该再续上一份列表 |
| **闲置 30 分钟**过期，并从状态文件里删掉 | 隔一夜回来说「查看其余」，翻到莫名其妙的地方比不认这句话更糟 |
| **只有真正发出去的那一屏才推进位置** | 发送被拒时推进，下一句「查看其余」会跳过用户没见过的一页 |

**这里有一处为「不许猜」付的代价**：位置只存页码，**不存列表快照**（§4.11 的纪律是"能确定"，而快照会让每次列表都把整份会话清单写进一个每消息重写的文件）。所以翻页期间如果有会话活动，列表整体位移，第二屏可能与第一屏重叠一行。要彻底消除就得把快照写进 state——**没有做，写在这里当作已知取舍**。

### 引用锁定在新结构下怎么处理（关键）

编号跨屏连续之后，`SessionListMessage` **必须多存一个 `first`**（这一屏第一个编号是几）。否则第二屏印 11–20、冻结的却是 10 个格子，用户引用它回「13」，`resolveTarget` 会去取 `numbered[12]`——**那是一屏根本没印过的第 3 行**。所以：

- `NumberedRows = { sessions, first }` 贯穿「路由器 → 宿主的冻结 → 读回解析」
- `resolveTarget(args, sessions, numbered)` 的第三参从数组改成 `NumberedRows`；编号的读取变成 `index = n - first`，**`index < 0` 不折回第 1 行**（那是用户翻过去的一屏，猜他指哪一行正是 pin 要防的事）
- 每一屏按**自己那条消息的 id** 单独冻结，所以「引用的是哪一条消息的那一屏」是自动成立的
- **会话夹那一层没有编号可冻结**（行是文件夹，不是会话），它的编号按当时的实时顺序解析。文件夹顺序很稳（本工作区第一，其余按最近活动 + 路径），且这一层的位置 30 分钟就作废——**这是已知的、可接受的弱一处**，写在这里而不是假装它不存在

### 验证

新增/改写的测试（都在，且都做过反向验证）：

| 测试 | 断言的是什么 |
|---|---|
| `core.test.ts`「the workspace level pages ten at a time…」 | 第一层每屏 10 条、编号 1–10 / 11–12 连续、最后一屏不写「查看其余」、到底了明说且**位置不动** |
| 「entering a workspace works by number and by name…」 | 按编号、按名字都能进；**绑定没动**；不是步骤的消息落回 agent |
| 「two workspaces with the same folder name are not guessed between」 | 同名文件夹按名字进入时**列出编号**而不是猜 |
| 「the conversation level pages ten at a time…」 | 第二层 25 个会话 → 3 屏，最后一屏 21–25；回「25」切到那一行；**切换后位置被清掉** |
| 「a number on a later screen is read with that screen's offset」 | 第二屏 `first=11` 时「13」是丙、「3」**不折回第 1 行** |
| 「where a conversation is in the listing browser survives a save and a reload」 | **§4.9 纪律**：`browsing` 往返，`forgetBrowse` 收尾 |
| 「a browsing position that cannot be continued is dropped」 | 非法 level/page/workspace/at **逐项丢弃** |
| `plugin.test.ts`「the phrase that pages on is answered by the channel…」 | 「查看其余」**不吵醒 agent**、翻到第二屏、切换后位置失效 |
| 「a quoted spoken listing answers with the rows that message printed」 | 引用第二屏回「14」切到那一行；引用**第一屏**回「14」**什么都不动**（偏移真的在起作用） |
| 「a position left overnight pages nothing…」 | 过期位置被丢弃，那句话当成普通消息 |
| 「a spoken full list shows every workspace…」 | 说大白话的 `all` 也到**同一层**（同一个渲染器） |

**反向验证**（三次，都恢复到全绿）：

1. 把 `resolveTarget` 的偏移去掉（回到 `numbered[n - 1]`）→「a number on a later screen…」与 plugin 的引用测试同时变红（报的是切到了下一屏的行，而不是那一屏印的那一行）
2. 把 `#rowsIn` 的排序去掉（信任网关顺序）→ 第二层分页测试变红（第一行不是最新的那个），并且 `/list` 与 `/switch` 对同一个数字的理解不一致
3. 把 `normalize` 里的 `browsing` 去掉 → 往返测试变红（写进去了，读回来没有）

> **教训（与 §4.9 同一条）**：这次又差点在同一个地方交学费——`normalize()` 是白名单，加字段就必须同时加校验和往返测试。而更要紧的是那条**结构**上的收获：§4.12 的「打印用一份、冻结用另一份」不是靠更小心修好的，是**把第二份删掉**修好的。同一份事实有两个产生者时，先找能不能只留一个。

## 4.14 静默吞消息：会话被归档之后，日志里连一行都没有

> 这一节是**用户报告的 bug**，也是本仓库第三次遇到"失败不带声音"这个形状（§3.6 是**谎报成功**、
> §3.7 是**best effort 静默失败**）。这次更彻底：**连一行日志都没有**，用户和插件都无从下手。

**现象**：微信绑定的会话**被归档**，或者该会话**在磁盘上已经不存在**，之后微信再发消息 ——
消息完全消失：手机收不到回复，电脑上也没有动静，**日志里没有任何错误**。

### 根因：两种死法，都不报错

| 状态 | 为什么消息会消失 | 依据 |
|---|---|---|
| **已归档** | 归档**不是**磁盘上的标记，会话本体还在，`sessionController.prompt` 照常**接受**；随后 `archived-session-gate` 在 `agent/pre-step` 上把它 **reject** 掉，回合以 `blocked` 结束 —— 没有请求、没有异常、没有日志 | `@deepseek-ai/dsh-api-session-controller/lib/types/archived-session-gate.js`：`an archived Session … must not run a model step until it is restored` |
| **磁盘上不存在** | 会话记录没了，prompt 提交给一个不存在的会话，谁都不会回话 | 会话索引里查不到它（`storedSessionWorkspace()` 返回 undefined） |

**归档状态存在哪里**：`ctx.workspaceRegistry.archivedSessionIds`（一个 registry 全局的集合，不是会话上的字段；
实测机器上它的持久副本在 `<home>/storages/workspace.json` 的 `global.archivedSessionIds`）。
**排查时先看这个集合**，因为磁盘上没有任何东西能告诉你一个会话被归档了。

### 修法：**复用 binding 之前先问一句**

`SessionGateway` 增加一个**可选**探针：

```ts
export type SessionState = 'usable' | 'archived' | 'missing'
sessionState?(sessionId: string): Promise<SessionState>
```

| 要点 | 做法与理由 |
|---|---|
| **查询时机** | router **复用既有 binding 之前**。再往后就来不及了：prompt 一旦提交，这一轮是沉默的 |
| **不可用时** | **新建会话 + 改绑**（不是解归档，也不是修复）。对话必须能继续工作，而唯一确定可用的是本渠道自己建的会话；解归档等于替用户在桌面上做决定，磁盘上删掉的会话也没有东西可修。想找回旧对话仍然可以用 `/switch` |
| **同时回一句中文提示** | `RouteDecision.notice`，由宿主在**提交 prompt 之前**发出去。**只改绑不说话是另一种困惑**：用户看到新对话里没有任何上下文 |
| **查询出错按 `usable`** | 探针抛错 → 记一行诊断 → 当可用。**探针坏了不能把用户的消息弄丢**。同理，"记录存在但读不出来"（损坏的 store）也按 `usable`，见 `hasStoredSession()` |
| **探针是可选的** | 网关没有实现它时，行为与从前**逐字一致**：不查询、不改绑、不打日志 |
| **日志由宿主写** | core 不认识日志，路由把诊断交给 `SessionRouterOptions.onDiagnostic`，宿主接到 `boot.log` |

### 踩过的坑：无限新建循环（用户实盘踩出来的）

首版只对 `missing` 换新，实盘**立刻出现无限新建循环**：**新会话在首轮写入之前磁盘上没有任何记录**，
于是每条消息都判 `missing`、每条都新建一个会话。

**修法**：`missing` 需要 **binding 满 2 分钟**（`MISSING_BINDING_GRACE_MS`）才相信；
**`archived` 不受宽限期影响**——归档状态在 registry 里，立刻可答，不存在"还没写完"的竞争。

**为什么用 binding 的年龄而不是会话的年龄**：binding 建在首轮 prompt **之前**，
所以"年轻的 binding 没有记录"是预期状态，而"年老的 binding 仍然没有记录"才说明它真的被删了。
两分钟远长于首轮写入所需，又短到被删的会话能在同一轮对话里被修好。

### 让失败可见（这是本次最要紧的一条）

**静默吞消息且不留日志，才是这个 bug 真正致命的地方。** 所以：

| 位置 | 现在的痕迹 |
|---|---|
| 换绑 | `session-state: binding moved conversation=… from=… to=… state=archived|missing bindingAge=Ns` |
| **拒绝**换绑（宽限期内） | `session-state: <id> reported missing but its binding is only Ns old (grace 120s) — reusing it…`（"它为什么没自愈"必须能从日志里回答） |
| 探针抛错 | `session-state: probe failed conversation=… session=… error="…" — treated as usable` |
| 提示发不出去 | `notice not sent: account … is no longer stored (conversation=…) — the conversation was moved anyway` |

**顺带找出的其它"静默吞消息"路径**（都补了日志；它们都不报错，只是"什么都不做"）：

| 路径 | 原来 | 现在 |
|---|---|---|
| `#handleInbound` / `#deliver` 找不到 account | `return`，用户的消息消失 | `inbound dropped: account … is no longer stored (conversation=… text=N chars)` |
| `onAssistantFrame` 找不到该会话的 binding | `return`，模型答完了没人知道 | `stream: no WeChat conversation is bound to <id> — its answer is not delivered`（**按会话去重**，桌面会话的回合是正常情况，不能刷屏，但必须留痕） |
| `#flushReply` 的 binding / account 没了 | `return`，**整轮答案**丢掉 | `reply dropped: conversation … has no binding (session=… text=N chars)` |
| `提交任务失败: 插话与排队都未成功` | 没有会话 id，定位不了 | 补上 `（会话 <id>）` |

### 验证

新增测试（core 9 条 + session-index 1 条 + plugin 5 条，全套 **278 项全绿**，基线 264）：

| 测试 | 断言的是什么 |
|---|---|
| core「a binding whose session was archived is replaced…」 | 换新会话、**入库的 binding 真的改了**、有中文提示、日志有 `state=archived` 且带上新旧 id；**首条消息不查询** |
| core「an archived session is replaced however young the binding is」 | 归档**不吃宽限期** |
| core「a session that is gone from disk is replaced…」 | 超期 `missing` → 换绑 + 提示 + 日志 |
| core「a session with no record yet is kept, not replaced」 | 宽限期内**不换**，且留下一行 `grace` 诊断 |
| core「a missing verdict inside the grace window cannot multiply sessions」 | 五条消息一个会话（**防无限新建**） |
| core「a burst of messages after an archived session is replaced creates one new session」 | 换一次就够；复用**每次只查一次** |
| core「a probe that throws is treated as usable…」 | 抛错 → 消息照走，且有 `probe failed` 日志 |
| core「a gateway with no probe behaves exactly as it did before」 | 无探针：不换绑、不提示、**连诊断都不写** |
| session-index「a record that exists but cannot be read…」 | `storedSessionWorkspace` 分不出"没有"和"读不出来"，`hasStoredSession` 能 |
| plugin 四条 | 同样的四种情形走**真宿主粘合层**：归档 → 换绑 + 提示 + 日志；磁盘删除（超宽限）→ 同上；记录损坏 / 宽限期内 → **不换**且不打扰用户 |

**反向验证**（两次，都恢复到全绿）：

1. 把宽限期判断改成永不相信（`if (false && …)`）→ core 的「no record yet」与「cannot multiply sessions」
   两条立刻变红，plugin 的同名用例也变红；报的正是"新建了一个不该新建的会话"
2. 把探针的 `catch` 从 `return undefined` 改成 `return 'missing'` →「a probe that throws is treated as usable」变红

### 教训

1. **"接受"不等于"会执行"。** 一个接口返回成功、然后在下游被一道门悄悄拒掉，是最难查的形状：
   调用方拿到的每一步都是"好的"。**凡是"提交给别的东西去做"的路径，都要能回答"它后来做了吗"**——
   这里就是复用 binding 之前问一句。
2. **没有记录 ≠ 被删了。** 新会话在首轮写入之前就是"没有记录"，任何"查不到就重建"的逻辑都必须有
   **年龄闸门**，否则它会把正常的启动窗口当成故障。这条闸门是从实盘的无限循环里换来的。
3. **fail-safe 的方向要选对**：探针坏了当成"不可用"会换掉一个好好的对话；当成"可用"最坏只是这一条
   消息仍然沉默。**能丢的是重试机会，不能丢的是用户的消息。**
4. 又一次印证 §3.6 / §3.7：**一个设计上不报错、不写日志的失败路径，坏了不会有任何声音。**
   这次的做法可以照抄：**每条"什么都不做就返回"的分支，都要问一句"用户会因此收不到东西吗"**，
   会的话就必须留下能定位的痕迹（哪个会话、哪个 binding、判定是什么、做了什么）。

> **给内核侧的建议（本仓库不做，转述）**：`prompt` 对**已归档**的会话应当直接**报错**，而不是
> 接受之后在 `pre-step` 里静默 reject。那样调用方至少能拿到一个可判断的失败，插件也就不需要
> 自己去读 registry 猜。

## 4.15 设置页的按钮死了：`ctx` 在组件里根本不存在

> 这是**用户报告的 bug**，也是本仓库第四次遇到"失败不带声音"这个形状。前三次分别在
> **宿主与服务之间**（§3.6 谎报成功、§3.7 best effort 静默失败、§4.14 连日志都没有），
> 这一次在**浏览器里**：一个按钮按下去，页面不动、宿主不知道、日志没有一行。

**现象**（设置 → 微信 → 「会话工作目录」）：

1. 点「选择文件夹」选完路径（或手输），**界面没有任何反馈**
2. **重启 DSH 后输入框又变回空白**
3. 微信会话始终落在默认目录 `~/.dsh/dsh_wechat`

### 用户的实测证据把范围锁死了（这一条最值得学）

他的原话是：从启动到检查，`state.json` 的 `settings` 里**从未出现过 `workspacePath` 键，连空串都没有**。
而 `curl` 直接 POST 同一个路由能立刻写进去。

**"连空串都没有"就是结论。** 推理链只有三步，每一步都在代码里：

| 步骤 | 依据 |
|---|---|
| 保存时 POST 的是**整个 draft** | `client.js` 的 `saveSettings()`：`body: JSON.stringify(sent)`，而 draft 来自 `GET /settings`，即 `resolveSettings()` 的结果，**每个设置键都在里面**（含 `workspacePath: ''`） |
| 宿主接受空串 | `readSettingsPatch()`：`if (typeof body.workspacePath === 'string') patch.workspacePath = body.workspacePath.trim()` |
| 于是任何一次保存都会让这个键**至少以 `''` 的形式**出现在状态文件里 | `saveSettings()` 里 `state.settings = { ...(state.settings ?? {}), ...patch }` |

键**从未出现** ⇒ **那次保存从来没有发出去**。归一化（§4.9）与持久化都无辜。

### 根因（三条，全是"没有声音"）

| # | 问题 | 位置 |
|---|---|---|
| 1 | **按钮引用了一个不存在的变量。** 处理函数写的是 `pickDirectory(ctx)`，而 `ctx` 是 `apply(ctx)` 的参数；`WechatSettings` 组件由 slot 注册表实例化，**拿不到那个参数**。于是求值实参时就抛 `ReferenceError: ctx is not defined`——**在选择器被调用之前**，也在那个 `try` 之外（`try` 只包住函数体，包不住实参） | `client.js` 旧 `onClick` |
| 2 | **"选文件夹"和"保存"是两件事，页面一句没说。** 选完只写进了 `state.draft`（`edit()`），真正落盘要按「保存设置」。而输入框下面只有一行静态说明，页面顶部那句 `settingsHint` 还写着「改完生效，**不用重启**」——与工作目录自己的说明**正好相反** | `client.js` |
| 3 | **`/status` 只报"正在使用的目录"**，不报"设置里存的目录"。于是"没存上"和"存了没生效"在页面上**长得一模一样**，谁都分不出来 | `host.ts` `status().diagnostics` |

外加一条把 1 变成"完全不可诊断"的：`pickDirectory()` 自己 **`catch {}` 空吞**，调用方又只看返回值
（`if (picked !== undefined)`），所以连一行 `console.error` 都没有。

### 修法

| 位置 | 做法 |
|---|---|
| `client.js` | **把 ctx 留住**：`apply` 里 `clientContext = ctx`，组件用 `pickDirectory(clientContext)`。声明放在组件**外面**——放在组件里会被遮蔽、每次渲染重置（第一版就踩了这个，测试当场报红） |
| `client.js` | `pickDirectory()` **不再吞异常**：错误交给调用方显示 + `console.error` + `reportFailure` 送进 `boot.log`；**`null` 归一成 `undefined`** 表示"用户取消"，两条路都不报错 |
| `client.js` | 选完给一句「**已填进输入框。点「保存设置」才会真正保存——选文件夹本身不保存。**」 |
| `client.js` | 表单和已存值不一致时，按钮旁写「**有改动还没保存。**」——手输、选文件夹、点「恢复默认」都算改动，而这三件事长得都像"已经生效了" |
| `client.js` | 保存反馈挪到**按钮旁边**：失败显示错误；**主机拒收的字段**逐项点名；"存的目录≠生效的目录"时**一直**提示要重启（不是 2.5 秒的过场） |
| `client.js` | 顶部那句自相矛盾的提示改成「改完点「保存设置」。多数设置立即生效；「会话工作目录」要重启 DSH 才生效。」 |
| `host.ts` | 每次保存写**一行 `boot.log`**：`settings: saved workspacePath "" -> "C:\…"; mergeWindowMs 10000 -> 0`；失败写 `settings: save FAILED patch={…} error="…"`。**旧值和新值都要有**，因为状态文件只有"现在是什么"，分不出"没发出来"和"发了没收下" |
| `host.ts` + `routes.ts` | `diagnostics.settingsWorkspace` 单独回报**设置里存的值**，与 `diagnostics.workspace`（**启动时解析、真正在用**的目录）并列显示 |

**"主机拒收"是顺带堵上的同一类洞**：`readSettingsPatch()` 对类型不对或超上限的字段是**静默丢弃**，
返回值又是"实际存下来的值"。页面于是会一边显示「已保存」，一边把字段悄悄恢复原样。
现在页面把**发出去的值**和**主机答回来的值**逐项比对（数字按 `Math.round`、字符串按 `trim`，
因为主机就是这么处理的），不一致就点名。这样"以后再加设置忘了同步"也会当场看得见——
**这是 §4.9 那条"白名单一定会漏"在浏览器这一侧的对应物**。

### 一处**有意不做**的事

DSH 自己的目录选择器插件（`dsh-client-ui-directory-picker-native`）声明的是
`inject = ["slots", "uiWorkspace"]`，并用 `ctx.uiWorkspace.pickDirectory()` 作为
`__DSH_DIRECTORY_PICKER__` 缺失时的兜底。**我们没有把 `uiWorkspace` 加进 `inject`**：
按 §3.2，一个永远等不到注入服务的条目**不会激活**，而启动审计会因此**拒绝启动整个应用**——
为了一个兜底路径去赌服务一定存在，代价是"用户开不了 DSH"。
改成**在点击那一刻从留住的 ctx 上读**：服务在就可用，不在就报一句清楚的错（而不是静默）。

### 验证

新增/改写的测试（core 0 条 + plugin 2 条 + client 10 条，全套 **290 项全绿**，基线 278）：

| 测试 | 断言的是什么 |
|---|---|
| client「the folder dialog is reached through the workspace service when the desktop has no global」 | **就是这条能抓住原 bug**：桌面全局不存在时，走 ctx 的兜底路径必须真的把目录填进输入框 |
| client「a folder the dialog returns fills the box and says it is not saved yet」 | 字段拿到路径、页面说明"还没保存"、**且没有发出任何 POST** |
| client「saving posts the chosen directory, so it can reach the state file」 | 点保存后 POST 的 body 里**带着用户选的那个目录** |
| client「a save that fails says so beside the button instead of looking saved」 | 出现"保存失败"+ 主机的原话，**且不出现"已保存"** |
| client「a value the host would not accept is reported, not counted as saved」 | 主机把字段改回旧值时，页面点名那个设置 |
| client「a picker that refuses to open is reported instead of swallowing the failure」 | 错误上页面 + `console.error` + 送到 `/client-error` |
| client「cancelling the dialog is not an error and changes nothing」 | `null`＝取消：不报错、不改字段、不加提示 |
| client「a change that is not stored yet is pointed out while it is not」 | 手输也算"还没保存"（`有改动还没保存`），**输入不发请求**，保存后这句消失 |
| client「a directory that is stored but not in effect says a restart is needed」 | 存了没生效时，重启提示**持续存在** |
| client「the effective directory and the stored one are shown apart」 | 诊断区两行分开：在用哪个、设置里存的哪个 |
| plugin「a directory saved from the settings page reaches state.json and is used after a restart」 | **端到端**：走**真路由 handler** → 类型检查 → 落盘 → 状态回报分开 → **重启后真的用新目录**；`boot.log` 那行含旧值与新值 |
| plugin「a settings save that cannot be written is logged and reported as a failure」 | 写不进去时路由回 500，且日志留下 `settings: save FAILED`（用"状态文件位置上放一个目录"制造失败，**不碰权限**，错误码跨平台不同所以只断言标记与字段名） |

测试的接缝要说清楚：**页面那一半用真 `client.js` 跑，宿主那一半用真路由 + 真状态文件跑，
但两者不在同一条进程里对接**（`client.js` 是 classic script，只能通过 `new Function` 加载，
而它的 `fetch` 桩不会真的转到宿主）。两份断言合起来覆盖了请求的**形状**与宿主对它的**处理**，
剩下的风险是两侧各自改形状而不改另一侧——`ROUTE_PREFIX` 已经有一致性测试，body 形状目前靠这两条。

**反向验证**（四次，都恢复到全绿）：

1. 让 `readSettingsPatch` 丢掉 `workspacePath`（重演 §4.9）→ plugin 的端到端测试立刻红，报的是"主机答回来的值里没有这个目录"
2. 把 `pickDirectory` 的 `catch {}` 空吞改回去 →「a picker that refuses to open…」红
3. 把组件里的 `clientContext` 改回 `ctx`（**原始 bug**）→ 5 条 client 测试同时红（选择器两条路都失效）
4. 去掉保存失败那行 `#recordBoot` →「a settings save that cannot be written…」红

### 教训

1. **"按钮没反应"优先怀疑作用域，而不是怀疑 IPC。** 用户很自然地推断是桌面壳的守卫拒绝了请求
   （守卫确实存在，`assertDesktopSender` 确实会抛），但真正的第一现场更便宜：**处理函数里有一个
   装配期没传进来的名字**。这类 bug 的写法有个共同点——**求值实参就会抛**，所以
   `try { await pick(ctx) } catch {}` 这种"我已经包住了"的防御**根本没生效**。
2. **`catch {}` 之后必须有人说话。** §3.7 的结论在这里第二次成立：设计成永不抛错的路径，
   坏了不会有声音。**UI 侧尤其致命**，因为用户的结论不是"坏了"，而是"这个功能不存在"。
3. **同一个页面上的两句话会互相抵消。** 顶部写"不用重启"，字段下面写"要重启"——用户读到的是
   前者。凡是"改完要不要重启"这种事实，**一个页面只能有一个说法**。
4. **状态文件里"没有这个键"是证据，不是缺失。** 报告里那句话（"连空串都没有"）直接排除了
   归一化与持久化两条路。**能让这种推理成立的代码是好代码**：POST 整个 draft、接受空串、
   合并写回——三条都恰好把"有没有发生过"编码进了文件。
   反过来，**日志要记"变化"，不能只记"结果"**：`settings: saved workspacePath "" -> "C:\…"`
   这一行才是"设了没反应"能一眼定位的东西。
5. **"存了"和"生效了"必须能分开看。** 这两个事实以前共用一个显示、一个字段名，
   于是"重启才生效"这种**正常**行为在用户眼里与"保存失败"完全一样。诊断区现在并列两行，
   这不是冗余信息，是把两种故障分开的最小代价。

## 4.16 重建后的客户端 bundle 永远不生效：classic script 的顶层绑定会被重复求值

> 这是**用户报告的 bug**（issue #3），也是同一形状的第五次：**失败不带声音**。前四次分别在宿主与服务
> 之间（§3.6 谎报成功、§3.7 best effort、§4.14 连日志都没有）和浏览器里（§4.15 按钮没反应），
> 这一次在**加载器**里 —— 连一行日志都留不下，因为抛出它的是**解析器**，而解析发生在文件的第一句之前。

**现象**：应用开着的时候重新构建客户端 bundle，壳推 `rebuilt` 帧并重新求值入口，控制台报：

```
Uncaught SyntaxError: Identifier 'PREFIX' has already been declared
```

**症状的另一半更重要**：**重建后的 bundle 永远不生效**，页面继续跑旧副本，直到整页刷新。报错只解释
了原因，静默才是伤害。

### 根因：两个顶层 `const`

`client.js` 在**文件顶层**（loader factory 之外）声明了两个绑定（行号是修复前的位置）：

| 位置 | 绑定 | 第二次求值会怎样 |
|---|---|---|
| `client.js:20` | `const PREFIX = '/.dsh-wechat-plugin'` | **SyntaxError** |
| `client.js:31` | `const HANDBOOK_URL = 'https://github.com/…'` | **SyntaxError** |
| `client.js:34` | `function reportFailure` | 无事 —— 函数声明可以重复声明，`var` 同理 |

**页面里所有 classic script 共用一个全局词法作用域**（global lexical environment 属于 realm，不属于
单个 script），所以同一个文件被求值第二次时，`const` 就是重复声明。顶层还有一句
`window.__ModuleLoader__.load(…)`，那一句**必须**每次都跑 —— 它不是问题，是机制。

### 为什么"重建过但什么都没发生"（每条都有出处）

| 事实 | 出处（`app.asar` 内，用 `scripts/asar-extract.mjs --grep` 可复核） |
|---|---|
| 每个 revision 是**一个新的外链 classic script** | `@deepseek-ai/dsh-client-modules/lib/client.js`：`defaultLoadBundle` = `document.createElement("script")` + `document.head.append(el)`；URL 由 `atRevision()` 换掉 `rev=` 的值 |
| `rebuilt` 帧会**重新求值整个文件** | `@deepseek-ai/dsh-client-hmr/lib/client.js`：`entries.reload(frame.id, frame.rev)` |
| 重新求值 = 先作废旧工厂，再 import 新的 | `dsh-client-modules` 的 `reload()` → `replace()`：`invalidateForReplacement(id, rev)` → `modules.import(id, "", {})` |
| **解析失败等于什么都没发生** | 同文件 `arrive()` 的注释原文：`a script that loaded without registering this row (a parse error registered nothing, …) is never re-executed` |
| 旧条目继续服务，直到刷新 | 用户报告 |

**关键在第四行**：语法错误发生在**第一句之前**，`window.__ModuleLoader__.load(…)` 根本没执行 ⇒ 没有新
工厂注册 ⇒ 没有东西替换旧条目。

### 修法：整个文件包一层 IIFE（而不是把那两个 `const` 搬进 factory）

两种都能修，选了前者：

| 理由 | 说明 |
|---|---|
| **结构上成立** | 把两个名字搬进 factory 只修了**这两个名字**；下次有人在顶层加一个 `const`（照抄官方模板很容易）就复发。给文件一个自己的作用域，**这一类**就不存在了 —— 与 §4.13「把第二份删掉」同一条思路 |
| **零行为变化** | 与用户在本机的临时方案一致（两处各插一行）。不加 `'use strict'`，不改任何表达式 |
| **diff 只有两行代码** | 不重排缩进：`scripts/preview.mjs` 是按**源码里 6 空格缩进**定位语言包的，而整文件重排会把这两行实质改动埋进 1600 行 diff。文件末尾留了一句注释说明为什么 body 停在 0 缩进 |

### 验证

| 测试 | 断言的是什么 |
|---|---|
| `client.test.ts`「the bundle can be evaluated again after a rebuild, in the page's own scope」 | 用 `node:vm` 在**同一个 context** 里把 `client.js` **连续求值两次**：两次都不抛；两次都注册（`id` 各一次）；求值后 `typeof PREFIX` / `typeof HANDBOOK_URL` / `typeof reportFailure` 全是 `undefined` |

**为什么必须断言"注册了两次"，不能只断言"不抛错"**：一个"第二次跳过注册"的守卫也能让"不抛错"成立，
而那恰好重现要修的症状 —— **重建不生效**。

**反向验证**：只删掉那两行 wrapper（其余一字不动）→ 这条测试立刻变红，报的正是
`Identifier 'PREFIX' has already been declared`，其余 27 条 client 测试仍全绿；恢复后 28/28 全绿。

**等价性核对**（比"测试通过"更硬的那句话）：把两行 wrapper 从新文件里剥掉，再与 `HEAD` 逐行比对 ——
差异只剩头部注释（纯文档）。**功能改动就是那两行。**

全套 **291 项全绿**（基线 290）。

### 同类检查：结论是只有 `client.js` 需要改

| 产物 | 会被重复求值吗 | 判断依据 |
|---|---|---|
| `packages/bundle/client.js` | **会** | 壳按 revision 用 `<script src>` 加载（见上） |
| `packages/bundle/cli.js`（`dsh-wechat-send`） | **不会，不改** | ① `packages/bundle/package.json` 是 `"type": "module"`（它还用了顶层 `await`），ESM 的顶层绑定在**模块作用域**，不进入全局词法作用域；② ESM 的模块表按 URL 缓存，同一个 realm 里第二次 `import()` 不再执行模块体；③ 它是 `bin`，由 Node 起**新进程**跑，末尾 `process.exit(code)` |
| `lib/**`、`dist/core/**` 等构建产物 | 不会 | 都是 ESM，只被 `import` |
| `scripts/preview.mjs` 产出的 `preview-*.html` | 不会 | 纯 HTML：只内联样式与标记，**没有脚本** |
| pack 出来的 tarball | 不会 | 不是被求值的东西 |

全仓 grep `__ModuleLoader__` **只命中 `client.js`** —— 它是本仓库唯一的 classic script 产物。

> **顺带记录（不在本次改动范围）**：`packages/bundle/cli.js` 那 19 行启动器**没有任何测试** ——
> `cli.test.ts` 直接 import 的是 `src/cli.ts` 的 `runCli`。它的结论靠配置与加载方式，不靠测试。

### 教训

1. **"同一个文件"不等于"同一个脚本"。** 壳每次换的是 **URL**，不是**作用域**；URL 一变就重新求值，
   而全局词法作用域**每个 realm 只有一份，不随脚本重建**。
2. **解析期的失败没有现场。** 这次连一行 `boot.log` 都留不下：语法错误发生在第一句之前，
   `reportFailure` 还没来得及存在。**凡是"整份产物能在解析阶段失败"的加载方式，回归测试就必须真的
   把产物求值两次。**
3. **测试的接缝选错，等于没测。** 本仓库原有的 `client.test.ts` 用 `new Function(source)` 装载文件 ——
   那层函数作用域**恰好把这个问题藏住了**，所以 27 条测试全绿而 bug 照样出门。用户的复现
   （`vm.runInContext` 两次）之所以有效，是因为它复刻了壳的求值方式：**在同一个作用域里**。
   **测试要按运行时的装载方式来装，不要按方便的方式来装。**
4. **结构性的修法优于点状的修法**（同 §4.13）：搬两个名字只修两个名字；给文件一个作用域，这一类没了。
   而"以后不要在顶层声明"这种纪律**不该靠人记**。
5. **把结论落成"判断依据"，不要落成"我觉得不用改"。** `cli.js` 不改，是因为能列出三条可核对的依据
   （模块作用域 / 模块缓存 / bin 新进程）；`preview.mjs` 不改，是因为去读了它写出来的 HTML。

---

## 4.17 每次启动都报一次错：看门狗在等一件用户可能永远不做的事

> 这是**用户报告的 bug**（issue #2）。它不丢消息、不影响功能——**它撒谎**：每次**正常启动**都在
> `boot.log` 里留一条 `客户端错误[mount]`，说设置页坏了，而设置页其实是好的。
> 形状上和 §3.6「发送被拒却谎报成功」同源，只是方向相反：那次是**失败说成成功**，这次是**正常说成失败**。

**现象**（用户的原话：**每次启动**约 20 秒后）：

```
dsh-wechat-plugin: 客户端错误[mount]: 插件已加载，但设置页在 20 秒内没有渲染（看门狗触发）
```

他的 boot 日志时间线（中间**没有任何用户操作**）就是结论本身：

```
[supervisor 21:20:23] 内核 pid=15816 spawn: node.exe --require wer-unmask.cjs
[supervisor 21:20:28] web| dsh web: http://127.0.0.1:3080/?token=…
[supervisor 21:20:49] web-err| dsh-wechat-plugin: 客户端错误[mount]: 插件已加载，但设置页在 20 秒内没有渲染
```

`21:20:49` 是客户端**首次能加载 bundle 之后的第 21 秒**——是计时器走完了，不是渲染失败。

### 根因：两个不同的事件被当成了一个

| # | 事实 | 位置（修复前） |
|---|---|---|
| 1 | **计时从"bundle 被求值"开始**，而本包声明了 `dsh.client.immediately = true`，所以那是**应用启动**，不是"用户打开了设置页" | `client.js` 工厂里 `setTimeout(…, 20_000)` |
| 2 | **成功标志只在组件体里设置**，而 `WechatSettings` 只在用户打开 **设置 → 微信** 时才挂载 | `client.js` 旧 `mountedOnce = true`（在 `WechatSettings` 里） |

两条合起来：**"用户没有在启动后 20 秒内打开微信设置页"被报成了"设置页从未渲染"**。
而"启动后 20 秒内不打开设置页"正是这个插件最正常的使用方式——用户在看对话。

### 修法：把健康信号换成**注册成功**

```js
const disposeSection = ctx.slots.inject('settings.section', () => {
  const dispose = ctx.slots.register({ name: 'settings.section', id: 'wechat', … }, WechatSettings)
  sectionRegistered = true   // 到这一行 ⇒ 注册表收下了这个设置段
  return dispose
})
```

**为什么这仍然是有效的健康检查**（而不是把看门狗变成一句空话）：

| | 覆盖情况 |
|---|---|
| 注册成功 ⇒ | 工厂跑了、`apply` 跑了、`ctx.slots` 存在、壳收下了这一段——**壳会在该段被打开时渲染它** |
| 壳**从未声明** `settings.section` ⇒ | 注册表的贡献者**根本不会被调用**，标志保持 false，**看门狗照旧报错**（这正是它存在的理由） |
| 页面打开但路由读不出来 ⇒ | 走既有的 `reportFailure('load', …)`，**与看门狗是两条路**，`boot.log` 里的 scope 分得开 |

**为什么"注册成功"是可证的**：`ui-renderer` 的 `ctx.slots.inject` 文档原文是 *the callback runs
synchronously when the declaration already exists; otherwise it runs inside the declaring `register()`
call after the declaration is committed*。也就是说，壳一旦声明了这个槽，贡献者**立刻**被调用——
不是在用户打开页面的那一刻。

用户可见的两处跟着改了（这条消息出现在 `boot.log` 和设置页的「最近错误」里）：

| | 旧 | 新 |
|---|---|---|
| scope | `mount`——描述的是"组件挂载"，而看门狗**从来没盯过这一步** | `register`，也就是**真正失败的那一步** |
| 文案 | `插件已加载，但设置页在 20 秒内没有渲染（看门狗触发）` | `插件已加载，但没能把「微信」设置页注册到 DSH（20 秒看门狗触发）` |

**scope 一起改，是因为过期的标签和过期的成功条件一样会误导人**：日志里写着 `[mount]`，读的人就会去查渲染。

### 边界：**"注册成功但渲染白屏"插件观察不到**（如实记录，不假装覆盖）

这一条是用户自己指出来的，代码注释里也照原话写着。补一点：**能补的那一半补了，补不了的写清楚**。

| 情形 | 插件能看到吗 |
|---|---|
| 组件**渲染时抛异常** | **能**——见下面那一段 |
| 组件**渲染成功但页面是空的/不对** | **不能**。它不抛错、不发事件、不留下任何这个插件能收到的信号。**没有任何一处声称看门狗等于渲染检查** |

**能补的那一半**：壳给每个 slot 条目套了一层错误边界，崩溃会经 `ctx.slots.onEntryError` 报出来
（签名 `(slotKey, entry, error, { abdicated })`，失败条目的身份就在 `entry.component` 上）。
这不是猜的——**壳自己的** cordis 客户端运行器就是这么订阅的，而且用的正是同一个 `entry.component` 判定。
所以 `apply` 现在订阅这个通道，**按组件身份过滤**（同一个 `settings.section` 槽里还有别的插件的设置段，
不筛就会把别人的 bug 记到我们头上），把崩溃以 `scope: 'render'` 送进 `boot.log`。

**这条缝是核对过的，不是猜的**：`onEntryError` 在**本机安装的** DSH `0.2.0-rc.2`（`app.asar` 里的
`dsh-client-ui-slots`）里在，手边另外三个构建产物（`0.2.0-rc.2` / `0.1.5-rc.1` / `0.1.0-rc.7`）里也都在。
**没有核对的是 issue 报告者那台机器上的桌面端 0.4.9 / 内核 0.2.1-alpha.2** —— 所以这一层做成了**可选**：
方法不在就跳过，看门狗与从前逐字一致（`typeof` 判断），这样"没核对过的版本"最多是**少一层覆盖**，
不会变成启动失败。

订阅是**可选**的：壳没有这个方法就跳过（看门狗强度与从前一致），订阅本身抛错也**绝不能**让 `apply` 失败——
按 §3.2，一个被记为 `failed` 的条目会让壳**拒绝启动整个应用**。

### 验证

新增 3 条 client 测试（`client.test.ts` 28 → **31**），全套 **294 项全绿**（基线 291）：

| 测试 | 断言的是什么 |
|---|---|
| 「a launch that never opens the settings page reports no error」 | 加载 + 注册 + **从不渲染** → 放掉 20 秒（注入的时钟）→ **一条错误都没有**。**这就是本 bug** |
| 「a bundle that loads but never registers its section is still reported」 | 壳从未声明槽位 → 贡献者不被调用 → 看门狗**照旧报** `scope: 'register'`；同时这条也守着"没有 `onEntryError` 的壳照样能激活" |
| 「a section that throws while rendering is reported, and another plugin's crash is not」 | 同一通道上**别人的**崩溃不记账；**自己的**崩溃进 `boot.log`，带 `scope: 'render'` 与原异常文本 |

页面加载失败那条路也补了断言：既有的「a failing status route…」现在**顺手断言 `scope === 'load'`**——
原来它只断言页面渲染出错误态，没有任何测试盯着这个 scope。

**反向验证**（两次，都恢复到全绿）：

1. 把健康信号改回"**打开页面才算成功**"（组件体里置位）→ **恰好**「a launch that never opens…」变红，
   报的就是那条误报本身（`scope: register`，消息即上面那条新文案）；其余 30 条仍绿——包括"从不注册
   仍然报"，说明修复没有把看门狗弄哑
2. 去掉 `onEntryError` 订阅 → **恰好**「a section that throws…」变红

**顺带修好的测试基建**：`client.test.ts` 以前每加载一次 bundle 就**真的**排一个 20 秒定时器，
所以这个文件要跑 **20.5 秒**（进程被定时器吊着）。现在测试把看门狗定时器**捕获下来**、由
`fireWatchdog()` 手动放行（比 10 秒长的定时器才可能是它），文件降到 **3.5 秒**。
这里有个刻意的设计：`fireWatchdog()` 先断言**只捕获到一个**定时器——否则"抓不到就什么都不发生"会让
所有"不报错"的测试**因为没放炮而通过**。

### 教训

1. **健康信号必须与它真正能观察到的事件对齐。** 一个"成功"条件如果描述的是**用户可能永远不做的事**，
   它就不是健康检查，是**定时的噪音**——而且它会训练所有人忽略这个日志，等到真出故障时没人看。
   问法很简单：**这件事在正常运行下一定会发生吗？** "用户打开了某个页面"的答案是否定的。
2. **"加载了"、"注册了"、"渲染了"是三件事，不要用一个标志代表它们。** 原代码把后两件混成了一个
   布尔值，于是"没打开页面"和"页面坏了"共用一个结论。**能观察到的层级越高越好**，但**每一层都要
   说清它证明了什么、没证明什么**，而不是让读者以为看门狗覆盖了渲染。
3. **用户指出来的边界要写进代码，不要只写进讨论。** 这一条（注册成功 ≠ 渲染成功）如果只留在
   issue 里，下一个人会照旧以为看门狗盯着页面。注释里现在写着"能收到什么、收不到什么"。
4. **补覆盖之前先找有没有现成的缝。** 这里补上的那一半靠的是壳**已经存在**的 `onEntryError` 通道，
   而且壳自己的运行器就在用——**不是新机制，是同一个机制的第二位使用者**。找缝的方法是可核对的：
   去 DSH 自己的包里读它怎么订阅、签名是什么（签名是 `(slotKey, entry, error, { abdicated })`，
   身份在 `entry.component` 上）。
5. **看门狗此前一条测试都没有——这就是误报能出门的原因。** 一套 291 条的测试里没有一条碰过它。
   **凡是"只在异常时才说话"的代码，必须有一条测试让它真的说话**；否则它坏掉的表现（沉默 **或** 乱叫）
   与正常工作无法区分。反向验证在这里尤其值钱：它同时证明了"误报会变红"和"真失败仍然会报"。
6. **测试里的定时器要注入，不要等。** §7.5 说的是"不要睡固定时间"，这条是它的另一面：
   一个 20 秒的窗口**不该由测试去等**，也不该让整个测试进程被它吊 20 秒。**捕获 + 手动放行**，
   顺带要求捕获确实是有效的（见上）。

---

## 4.18 推理等级：`reasoningEffort`，模型选择里的第三个字段

**需求**：用户说「现在切换模型不能换推理等级，加上这个功能」。所以先把机制查清（**依据全部来自
`app.asar` 里的 DSH `0.2.0-rc.2`，与仓库 `_dsh-src` 解包一致**），再动手。

### 机制（不是猜的，逐条给出处）

**推理等级 = `reasoningEffort`，是「模型选择」三元组里的第三个字段**，不是模型 id 的一部分，也不是
一个独立的全局设置：

```ts
// dsh-api-session-controller/lib/types/model-selection-projection.js
const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
})
```

| 问题 | 答案 | 出处 |
|---|---|---|
| 有哪些合法取值 | **由 provider 适配器按「确切模型」公布**：`llm.resolveModelInfo(provider, model).reasoning = { efforts: [{id, name, description?}], defaultEffort? }` | `dsh-api-session-controller/lib/types/catalog.js`（`buildModelCatalog` 就是把它照搬给前端的）；`dsh-llm/lib/index.js` 的 `normalizeModelInfo` 校验（空集合、重复 id、未知 default 都会抛） |
| 内置适配器给的是什么 | `off` / `low` / `high` / `max`，名字就是 `Off/Low/High/Max`；`thinking: disabled` 时**只公布 `off`** | `dsh-llm-deepseek/lib/index.js`：`REASONING_EFFORTS` / `OFF_ONLY_REASONING_EFFORTS`，以及 `modelInfo()` 里的 `reasoning:` |
| 谁是权威 | 适配器。插件**不认识任何取值**——它只把列表里印过的 id 原样送回去 | 同上 |
| 怎么读当前值 | `sessionController.projections({ sessionId })` → `values.modelSelection` = `{ lastUsed, next }`，三个字段就是上面那个 schema。**冷读**：不激活 agent；会话不存在时返回 `null` | `dsh-api-session-controller/lib/types/index.js` 的 `projections()`；投影本身在 `model-selection-projection.js`（`next = pending ?? lastUsed`，`lastUsed` 由 `request/header` 事件推进） |
| 怎么设置 | `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })` → 校验后装给**下一次请求**，并在后台把整份选择存成部署默认 | `.../lib/types/commands.js` 的 `SessionCommandHandler.selectModel()` |
| 取值不合法会怎样 | `llm.resolveCallConfig` 在**任何网络 I/O 之前**抛 `UNSUPPORTED_REASONING_EFFORT`；`selectModel` 把它包成 `session/model-unavailable`，`message` 就是原话 | `dsh-llm/lib/index.js` 的 `resolveCallWithInfo()`；`commands.js` 的 `catch` |
| 省略等级时呢 | 适配器默认值**被显式填上**（`effective = requested ?? reasoning.defaultEffort`，不同才写回），所以 `selectModel` 的返回值里总是有个具体等级 | 同上。桌面选择器读的就是这个值：`dsh-client-ui-model-selection/lib/client.js`（`state.current?.reasoningEffort ?? reasoning?.defaultEffort`） |
| 只改等级、不改模型 | 同一个 provider/model 再调一次 `selectModel`，只是 `reasoningEffort` 变了。**路由没变，不会追加「model changed」的历史提示**；只改等级本来也不该有 | `dsh-agent/lib/types/model-selection.js`（只在 provider/model 变化时 `modelSwitchNotice`），并写明「An absent selected effort clears any inherited effort」 |

**一句话**：换等级 = 拿当前 `{provider, model}` 再调一次 `selectModel`，把 `reasoningEffort` 换成
目标等级。所以这个功能完全不需要新的宿主服务。

### 我们的做法

| 决定 | 为什么 |
|---|---|
| 命令做成 `/model 等级 <等级>`，以及 `/model <模型> 等级 <等级>` | 一个**关键字**切开两半，不做位置猜测。`/model 2 等级 high` 里「哪一段是模型名」不需要判断，而模型名可以带空格。按**后缀**认 `等级`（所以 `推理等级`、`思考等级` 一并可用），英文认 `level`/`effort`/`reasoning` |
| 为什么不做成 `/model 2 high`（按位置） | `Max` 是真实存在的模型名后缀（`Qwen2.5-Max`）。按位置切会让 `/model Qwen Max` 变成「切到 Qwen、等级 max」，而用户说的是模型叫 `Qwen Max`。显式关键字没有这个歧义 |
| 列表里**同时**印出每个模型的等级，并标出「当前」 | 等级在手机上**没有别的地方能看到**。`（当前）` 只给会话真正在用的那个模型；别的模型标 `（默认）`，因为那是切过去会落到的等级——把别人的默认叫「当前」是假话 |
| 普通 `/model 2` 仍然使用**目标模型自己的默认等级** | 与桌面选择器一致（那里的 `select(...)` 也是 `reasoningEffort ?? 该模型 defaultEffort`）。而且**回复里现在会明说等级**，所以这个决定不再是不可见的：`已把「X」切换到 Y（Z）。\n推理等级：中\n<id>` |
| `/model` 的「当前」从**会话自己的投影**读 | 目录是部署级的，而选择是会话级的。此前标的是部署默认，桌面里给某个会话单独选的模型会被标错——用户会照着错的那一行读等级。**可选**：`projections?` 用 `?.()` 调用，方法不在、返回 `null`、或抛错时一律退回部署默认（旧行为），抛错额外写一行 `boot.log`。绝不因为读不到而让 `/model` 失败 |
| 工具沿用 `model_control`，新增 `set_level`，`switch` 多一个可选 `level` | 与既有形状一致（`action` + 参数）。分成两个动作而不是一个，因为「换模型」和「只换等级」是两件不同的事，一个动作兼顾两者就得猜用户要哪个 |
| 失败必须**读回复文本**才算数 | 命令以「给建议」而不是抛错来回答，所以工具结果不能假定成功。`MODEL_FAILURE_PATTERN` 扩到 `/^(找不到模型|找不到等级|当前|切换模型失败|切换推理等级失败)/`，与命令里的失败开头**同名常量**（`NOT_FOUND_LEVEL` 等）保持一处定义 |

### 验证

新增 21 条测试（core 12 + plugin 9），全套 **315 项全绿**（基线 294）：

| 测试 | 断言的是什么 |
|---|---|
| core「/model shows each model's reasoning levels…」 | 标题带当前模型**和**当前等级；当前模型标 `（当前）`、别的模型标 `（默认）`；提示里的例子取自目录数据 |
| core「/model asks the host about the session…」 | `listModels` 拿到的是**绑定的那个会话 id**（标错模型就是从这条漏出去的） |
| core「/model 等级 names the levels…」 | 只列等级、**什么都不改** |
| core「/model 等级 low changes only the level…」 | `selectModel` 收到的是同一个 provider/model + 新等级，回复说的是「推理等级切到」 |
| core「/model <模型> 等级 <等级>…」 | 一步同时换模型和等级；等级按**名字**匹配（`MAX` → `max`）；id 照旧印出来 |
| core「…lists the ones it does」 | 未知等级 → `找不到等级「…」` + 该模型**全部**合法等级，且没有发生选择 |
| core「…on a model with no levels says so…」 | `/model 等级 high` 与 `/model 1 等级 high` 两条路都答 `当前模型不支持推理等级` |
| core「a level switch the host refuses is reported…」 | 宿主抛错 → `切换推理等级失败：<原话>`，且没有记录成成功 |
| core「a gateway with no catalog, and one that cannot select…」 | 没有目录 / 没有 `selectModel` 各自的降级话术 |
| core「a level is named explicitly…」/「matched by id or by name…」 | 解析规则（关键字、多词模型名、`等级`后缀、英文关键字）与等级匹配（不partial） |
| plugin「/model marks the session's own model and level…」 | **端到端**：会话切到 reasoner 后，`/model` 标的是 reasoner · 中，而不是部署默认的 V3.2 |
| plugin「a host that cannot report the session's model…」 | `projections` **不在**和**抛错**两种组合：清单照常发出、标部署默认、等级照样能切 |
| plugin「a failed session-model read is recorded…」 | 退化的那一行日志真的写了（会话 id + 宿主原话）——§3.7/§4.14 的纪律 |
| plugin「a level switch the host refuses…」 | 工具返回 `ok:false`、原因里带命令的失败话术，**用户被直接告知** |
| plugin「the model tool changes the level on its own…」/「switches model and level together…」 | 自然语言那条路：`set_level`/`switch`+`level` 都落到对的 `sessionId`、`provider`、`model`、`reasoningEffort` |
| plugin「the model tool refuses a level action with no level…」 | `set_level` 不带 `level` 直接失败，不变成「列个等级然后报成功」 |

**反向验证**（两次，都恢复到全绿）：

1. 把 `MODEL_FAILURE_PATTERN` 里的 `切换推理等级失败` 去掉 → plugin「a level switch the host refuses…」与
   core 的同名用例**同时变红**：工具把一次被拒的切换报成了 `ok:true` —— 正是这个模式存在的原因。
2. 去掉 `#modelInUse` 里的 `try/catch`（让 `projections` 抛出去）→ plugin「a host that cannot report…」
   与「a failed session-model read is recorded…」**同时变红**，日志里那行是
   `处理消息失败: session query unavailable`：用户拿到的是失败，而不是标着部署默认的清单。恢复后全绿。

### 没把握的地方（如实记录）

- **只在 `0.2.0-rc.2` 上核对**：`projections` 这个读法在本机 `app.asar` 与仓库里解包的 `_dsh-src`
  里都在，但**没有在别的桌面端/内核版本上核对过**。所以它做成了可选：方法不在就只有「标部署默认」
  这一个损失，不会变成启动失败或命令失败（§4.17 的同一条做法）。
- **等级的中文名不在我们手里**：内置适配器公布的是 `Off/Low/High/Max`，列表里印的就是这些。用户
  想打「高」得先看列表里写的是 `High`。**没有做别名表**——那会是我们替适配器决定什么叫「高」。
- `/model 2 high`（按位置给等级）**没有实现**，理由见上表；如果用户觉得别扭，这是要改的第一处。

---

## 4.19 v0.43.0 发布失败：两条测试挂在 ubuntu 上，而它们跟平台无关

> 这一条记的是**诊断方法**上的坑：CI 红在 ubuntu、绿在 windows，**不等于**平台差异。
> 两个 ubuntu job 挂的是**两条不同的测试**——这一条事实就足以判定是竞态，而不是"Linux 的
> errno 和 Windows 不同"。**先看两个 job 挂的是不是同一条，比读任何 errno 都值钱。**

**现象**：`v0.43.0` 打 tag 后 `publish` 的 `pnpm test` 挂了；同一个 commit 的 CI 在
`ubuntu-latest` 上 Node 22.19 与 24 都失败，`windows-latest` 上两个都通过。

### 先被怀疑的那条是无辜的

`plugin.test.ts` 里「用空目录顶替状态文件」制造保存失败的那条，**自己的注释就写着平台差异**
（`EPERM` vs `EISDIR`/`ENOTDIR`），所以首先被怀疑。**它不是原因**：它在 Ubuntu 22.04 与
**Ubuntu 24.04**（chroot，Node 22.19）上各跑多轮全绿。原因是 `rename` 一个文件覆盖一个目录在
两种平台上虽然 errno 不同，但**路由对任何异常都回 500 并写 `settings: save FAILED`**，
两种 errno 走的是同一条断言。

**怎么拿到日志**：job 日志接口要认证，但本机 git 凭据管理器里的凭据**就是仓库的**
（`git credential fill`）——拿它 `GET /actions/jobs/<id>/logs` 就能读自己仓库的日志。
日志给出两条不同的失败，各自只挂一条、其余全过：

| job | 挂的测试 | 断言 |
|---|---|---|
| ubuntu / 22.19 | `the eighth reply asks the user for a new window, once` | `the eighth send carries the ask` → `actual: 0, expected: 1` |
| ubuntu / 24 | `a switch to something unknown reports failure instead of a phantom move` | `actual: true, expected: false` |

### 两条根因都是"测试在赌"，不是平台

| # | 测试 | 为什么可能在**任何**平台上挂 |
|---|---|---|
| 1 | 「第八条回复要带上续期提醒」 | `deliverReply` 发完两帧后**睡固定 80 ms** 再断言提醒已发出。充值与提醒都要落盘，CI runner 上这 80 ms 不够 → 提醒计数 0 |
| 2 | 「切到不存在的目标要报失败」 | 目标写的是 `99`，而这是**合法的十六进制前缀**：某个会话的短 id 恰好以 `99` 开头时，这次切换**真的成功了**（约 1/256） |

> **`99` 那一条其实已经被修过一次**：§7.3 记着"换成一个含非十六进制字符的目标"，而同文件里
> **打字**那条路（`/switch zzzzzzz`）改了、**说大白话**那条路（`control(harness,'switch','99')`）
> 漏了。**同一个行为有两个入口时，修一处不算修完**（与 §4.12 同源）。

### 修法

| 位置 | 做法 |
|---|---|
| `deliverReply` | 不再睡时长，改为**等回复自己的记录**——那是发送路径写的**最后**一件东西（先发文本、再充值并在该提醒时发提醒、最后才按服务给的 id 记录消息），等到它等于前面都发生了。慢机器只是多等一会儿；真没发生仍然会红，且报出在等哪条回复 |
| 配额测试 | 用注入的 `RecordingStore` **报告自己写成功了什么**，而不是去读状态文件 |
| 「切到不存在的目标」 | 目标改成含非十六进制字符的 `zzzzzzz`：任何 id 都匹配不上，失败路径**每次都走到** |
| 设置保存那两条 | **注入**一个写入必失败的 store 来钉契约（500 + `settings: save FAILED` + 文件没动）；真实文件系统那条（空目录顶替状态文件）保留，但**只断言"没有被报成成功"**——具体哪个 errno、在哪一步抛出属于操作系统，不属于我们 |

`stateStore` 接缝加在 `apply()` **已有**的 `internals` 参数上（那个参数本来就写着
"Test seams. The loader never sets this."），生产代码只有一行默认值：

```ts
this.#store = options.stateStore ?? new StateStore(options.stateFile)
```

### 自己踩进去的坑（本轮最贵的一条）

第一版的等待是**轮询读 `state.json`**。在 Linux 上没问题，在 Windows 上**把被测的写入搞挂了**：
`rename` 覆盖一个正被读取的文件会返回 `EPERM`——实测**2000 次里失败 790 次**。于是插件把这次
发送记成失败、记录永远不落盘、轮询超时：**测试失败在它自己制造的故障上。**

> **教训**：**测试不能扰动被测对象。** 要等一件事做完，就等**代码自己**报出来的完成信号
> （这里是 store 的 `update()` 返回），不要去戳它正在写的文件。**观察**与**干涉**的区别，
> 在文件系统这一层就是一次 `open`。

### 验证

**反向验证**（两次，都恢复到全绿）：

1. 人为在发送与充值之间加 250 ms（冒充慢 runner），并把等待换回固定 80 ms →「第八条」立刻报出
   **与 CI 完全一样的** `the eighth send carries the ask`（`actual: 0, expected: 1`）；
   **只把等待换回新写法**（延迟保留）→ 相关三条测试全绿，耗时约 570 ms——**说明它在等事，不是睡觉**。
2. 让 `saveSettings` 把"写入失败"当成成功（去掉 rethrow）→ 两条设置测试同时变红，报的正是
   `the page is told the save failed` 与 `a save that did not happen must not look saved`。

**目标不可命中的证明**（纯函数，`packages/core/src/router.ts`）：

```
shortId('session-99ab12cd-…') = '99ab12'
resolveTarget('99',      …) → { kind: 'found' }   ← 旧目标**可能**命中
resolveTarget('zzzzzzz', …) → { kind: 'none'  }   ← 新目标**不可能**命中
```

**平台矩阵**（全套 **316 项**，0 失败）：

| 平台 | 结果 |
|---|---|
| Windows（本机） | 全套 exit 0；plugin 文件另跑 4 轮，120/120 |
| Ubuntu 22.04 / Node 22.19（WSL） | 全套 ×2，exit 0 |
| **Ubuntu 24.04** / Node 22.19（chroot，= CI 当时的 ubuntu-latest） | 全套 ×2，exit 0；plugin 文件 ×5，120/120 |
| **Ubuntu 24.04** / Node 24（chroot，= 挂掉的那个矩阵格） | 全套 316 通过 0 失败，exit 0 |

**教训**：

1. **"只在 ubuntu 上挂"是数据，不是结论。** 两个 job 挂的是**不同**的测试 → 竞态；相同 → 才值得
   去查平台差异。这一条把排查方向整个从 errno 挪开了。
2. **固定睡眠只在"负向断言"里是安全的。** 断言"某件事**没有**发生"，慢机器只会让它更成立；
   断言"某件事**发生了**"，睡多久都是赌。§7.5 的纪律要按这个标准逐条过一遍。
3. **两个入口的行为要一起改**（§4.12 的老账）：概率失败修在打字那条路上，说话那条路留着，
   于是它以 1/256 的概率挡住一次发布。
4. **测试替身的失败要"注入"，不要"诱发"。** 让文件系统拒绝写入，等于把操作系统拉进契约；
   注入一个写入必失败的 store，测的才是我们的代码。
5. **观察不等于干涉**：轮询读文件会让 Windows 上的 `rename` 失败，而那个 `rename` 正是被测代码
   的写入。

---

## 4.20 适配内核 `0.2.1-rc.2`：`create` 不再是「create or adopt」

**背景**：桌面端更新后，安装目录里的内核从 **`0.2.0-rc.2` 变成 `0.2.1-rc.2`**（`app.asar` 里的
`@deepseek-ai/dsh`、`dsh-api-session-controller`、`dsh-client-modules`、`dsh-client-hmr`、`dsh-llm` 等全部
是 `0.2.1-rc.2`）。**`app.asar` 不再是可读目录**：它是 182 MB 的归档（`app.asar.unpacked` 里只剩三个原生依赖），
所以核对方式是**现场按 asar 格式只读解包**（旧的可读目录 `app.asar\dsh\...` 不再存在），并另外从 npm 取了
`0.2.0-rc.2` 的同名包做逐文件 diff。

> **`_dsh-src` 不在这个仓库里**（从未被 git 跟踪，本次核对时目录已不存在）。所以**不能**拿它当新版的真相；
> 本节所有结论都来自安装目录的 `app.asar` 现场解包。

### 逐条核对：只有一处变了

| 面 | 结论 | 依据（新版 `0.2.1-rc.2`） |
|---|---|---|
| `sessionController.create` | ⚠️ **变了，已修** | `lib/types/commands.js`：注释改成 "reusing the named blank Session"；`lib/types/agent.js#claim`：`reusable = request.reusable(sessionId) && !observed.events.some(e => e.type === 'turn/start')`，**已跑过一轮的会话不再被采纳，而是 `createMinted` 出一个新会话** |
| `prompt` / `cancel` / `list` | ✅ 没变 | `index.js#prompt` 仍是 `(request, signal)`、`signal.throwIfAborted()`、`mode: 'queue' \| 'steer'`；`cancel({sessionId})` 未改 |
| `projections({sessionId})` | ✅ 没变（多一个 `kind` 字段） | `index.js` 返回 `{ kind: 'sequenced' \| 'migration-required', asOfSeq, values }`；`values.modelSelection` 形状不变，插件读的就是 `.values`；`signal` 仍必传（旧版也必传，插件一直传） |
| `selectModel` / `UNSUPPORTED_REASONING_EFFORT` | ✅ 没变 | `lib/types/commands.js#selectModel` 在 `llm.resolveCallConfig` 之后才装选择；`dsh-llm` 的 `resolveCallWithInfo` 与旧版逐字一致：**任何网络 I/O 之前**抛 `UNSUPPORTED_REASONING_EFFORT` |
| `modelCatalog()` | ✅ 没变 | `lib/types/catalog.js` 与旧版 `diff` 为空：`{default, routableProviders, groups, failures}` |
| `workspaceRegistry`（`resolveByPath`/`create`/`get`/`list`/`archivedSessionIds`/`setTitle`） | ✅ 没变 | `dsh-workspace/lib/index.js` 的改动只在 `candidateMatches`/`missingSessionPaths`（启动索引容错），公开方法与 `archivedSessionIds` getter 未变 |
| `inject` 名单（`sessionController`/`sessions`/`workspaceRegistry`/`tools`） | ✅ 没变 | 四个服务名在新 composition 里都还在：`dsh-web-app/cordis.patch.yml` 挂了 `dsh-workspace`、`dsh-api-session-controller`；`dsh-base` 挂了 `dsh-session`、`dsh-tools` |
| `webServer.register({kind:'prefix', …})` | ✅ 没变 | `dsh-host-webserver/lib/index.js#register` 逐字未动（新版只加了 TLS/绑定地址校验） |
| `tools.register` / `execute(args, exec)` | ✅ 没变 | `dsh-tools/lib/index.js#register` 与旧版逐字一致；`dispatchToolBody` 仍 `tool.execute(exec.arguments, exec)`，`exec.agent`/`exec.signal` 都在 |
| `agent/assistant-stream`（`agent.session.id`、`frame.chunk.text`、`text-delta`、`end`） | ✅ 没变 | `dsh-agent-loop` 仍 `dispatch.emit("agent/assistant-stream", { frame })`，`agentEvents` 仍把 `agent` 融进 payload；`AssistantStreamAttempt` 的 `start/chunk/end` 帧结构与旧版相同 |
| `approval/request` / `user-questions/request` | ✅ 没变 | `dsh-user-approval/lib/index.js` 与旧版**逐字相同**；`dsh-user-questions` 的 `questionSchema`/`answerSchema`（`{id, selected, custom?}`）未变 |
| `permissionPresets.set(session, name)` | ✅ 没变 | `dsh-permission-presets` 的签名与 `set` 未变（改动在 typert 生成层） |
| `ctx.get('homePaths')` | ✅ 从来不是服务（旧版也不是） | 新旧 `dsh-home-paths` 都只导出纯函数；插件一直走 `DSH_HOME` → `homedir()/.dsh` 的回退 |
| 客户端 `slots.inject` / `register` / `onEntryError` | ✅ 没变 | `@deepseek-ai/dsh-client-ui-slots` **0.2.1-rc.2 与 0.2.0-rc.2 字节相同**（`index.js` 同为 23461 B，`diff` 为空）；`inject` 文档仍是「声明已存在时同步调用」；`onEntryError(fn)` 签名仍是 `(key, registration, error, { abdicated })` |
| `settings.section` 槽位 | ✅ 没变 | `dsh-client-ui-settings-general` 仍在 `apply` 时注册 `sidebar.settings` 条目，并在 `children` 里声明 `settings.section`；`registerOptions` 仍是 `{id(required), order, label(可 thunk)}` |
| 客户端 classic script / `dsh.client.immediately` | ✅ 没变 | `dsh-client-modules/lib/client.js` 仍 `document.createElement("script")` 外链加载；`parseDshClient` 仍读 `dsh.client.platform/immediately`；`client.js` 的 IIFE 外壳**必须保留** |
| 磁盘：`storages/workspace.json` 的 `global.archivedSessionIds` | ✅ 没变 | 本机实际文件仍有 `global.archivedSessionIds`（3 条） |
| 磁盘：`storages/session_projcache/sessions/*.json` 的 `rows.sessionListMetadata.val.lastPromptAt` 与 `identity.createdAt` | ✅ 没变 | 实测 191 个条目，字段路径不变（另有 `rows.title.val`、`identity.cwd`） |
| 磁盘：会话目录 `sessions/<encoded-cwd>/<session-id>/` | ✅ 没变 | 实测目录仍是 `--C-...--/session-<uuid>`（workspace 注册创建的仍有裸 uuid 形态，插件两种都试） |
| `~/.dsh/wechat/state.json` | ✅ 自己的格式，未受影响 | 插件的 `normalize()`/往返测试全绿 |

### 变的是什么：`create` 只复用「还空着的」会话

旧版 `ApiSessionAgentController.ensureSession(sessionId, cwd, true, preset)` 的语义是 **create or adopt**：
只要磁盘上有这个 id，就 `agents.resume` 它，返回**同一个**会话。新版 `createSession` → `claim` 改成：

```js
reusable = request.reusable(sessionId) && !observed.events.some(e => e.type === 'turn/start')
if (!reusable) return this.createMinted(request.cwd, composition)   // ← 新的 id
```

也就是说：**已经跑过一轮的会话不会被采纳**，`create` 会**另造一个空会话**并把新 id 作为返回值。
插件的 `ensureSession` 原来在**每条消息**之前调用 `create` 来「确保会话活着」（旧版这就是 adopt），
并且**丢弃返回值**、继续用原 id `prompt`。在新版上这会变成：

- 用户的消息仍然进原会话（`prompt` 自己会 `resume`，所以聊天看起来正常）；
- 但**每条消息都留下一个空会话**（还被 `attachSession` 到工作区）。

### 修法：存在就什么都不做

`packages/bundle/src/host.ts` 的 `#gateway().ensureSession` 开头加一行：

```ts
if (await hasStoredSession(this.#home, sessionId)) return
```

- **有记录 = `prompt` 能自己 resume**，不需要 `create`；**没有记录**（`#bind` 刚 mint 的 id、或记录被删）
  才 `create` —— 而且此时 `create` 的 `claim` 走 `SESSION_QUERY_SESSION_NOT_FOUND` → `createAgent(sessionId)`，
  **仍按请求的 id 创建**，不会改名。
- 顺带删掉了为「adopt 到别的项目工作区」服务的那段分支：它只在 `create` 会 resume 旧会话时才有意义；
  现在既有会话根本不进 `create`，`storedSessionWorkspace` 在这条路径上恒为 `undefined`。
- **没有做新旧双形状兼容**：判定只看「会话是否存在」，与宿主版本无关。

### 验证

- 更新/新增的断言（`plugin.test.ts`）：
  | 测试 | 断言 |
  |---|---|
  | a second message continues in the same session without creating another | 两条消息只 `create` 一次，两条 prompt 都指向它 |
  | the session folder is registered once and titled 微信会话 | 标题只设一次、只创建一个会话 |
  | a session with no record yet is kept… | 记录被删后**只重建同一个 id**，此后不再 create；三条 prompt 同一会话 |
  | a session from another workspace is resumed in place, not re-created | 切到外部会话**不**调 `create`，下一条 prompt 落在那个 id |
  | routing survives a remount… | 重启后**不** create，`prompt` 直接 resume 原会话 |
  | the workspace override is honoured and stays constant | 自定义工作区只解析、只创建一次 |
- **反向验证**：把那一行守卫改成 `if (false) return` → 上面 6 条**全部变红**（其余 114 条仍绿）；恢复后
  `test:plugin` 120/120，全套 **316 通过 0 失败**，`build` / `typecheck` 均 exit 0。

### 没把握的地方（如实记录）

- **没有真机验证**（装插件 → 扫码 → 发消息）。本轮只能证明代码与契约；宿主升级改的是服务行为，
  这一步按 §7.8 仍然欠着。
- **只核对了内核 `0.2.1-rc.2`**，桌面壳版本（`app.asar/package.json` 里 `@deepseek-ai/dsh-desktop-runtime`
  也是 `0.2.1-rc.2`）没有独立核对。
- **一个边角**：`hasStoredSession()` 把「有 projcache 行」也算存在。若某台机器出现**行还在、会话目录没了**
  的损坏状态，现在会跳过 `create`，于是 `prompt` 报 `session/not-found`（旧版会顺手重建）。检测到这种状态
  需要额外的目录探测，**本次没有做**——它属于损坏存储，不是正常路径。

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
pnpm test               # 328 项
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

**三条纪律**：

1. **能失败才算测试。** 每修一个 bug，先**反向验证**：把修复还原，确认测试变红且报出的原因正确。
2. **不假设环境。** 干净环境（没装可选依赖、目录不存在、没有历史状态）才是用户的环境。
3. **不能靠概率通过，也不能靠概率失败。** 一条"失败路径"的测试，它的输入必须**不可能**命中成功路径。`plugin.test.ts` 里那条「切换失败要告诉用户」原本发 `/switch 99`，而 `99` 是**合法十六进制前缀**，短 id 有约 1/256 的概率以它开头——那一跑切换真的成功了，测试红得毫无道理，且没法复现。现在它发的是 `unmatchedSwitchTarget()` 生成的目标（§7.10），**同样的断言，从"大多数时候成立"变成"每次成立"**。

   > **这条修过两次，都没修到根上**：`v0.43.0` 为"另一个入口仍是 `'99'`"付了账（§4.19）；
   > 后来又出现了第三次——`/switch 14` 撞上短 id `14c71a`，因为**解析器本身**允许数字在
   > 这一屏找不到时回落当成 id 前缀。**只换测试里的字面量永远补不完：要改的是解析器那条规则**
   > （§7.10）。同一个行为有两个入口时，改一处不算改完；同一个歧义有一个解析器在猜，改多少个
   > 字面量都不算改完。

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

> **这条规则在 `v0.43.0` 又被违反了一次**（配额测试里的固定 80 ms），而且**第一版修法本身踩了另一个坑**：
> 轮询去读状态文件，会在 Windows 上把被测的 `rename` 搞挂。**等，要等代码自己报出来的完成信号**——
> 两次的来龙去脉都在 §4.19。

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

### 7.9 工具描述：每轮都付费，规则一条都不能丢

四个工具（`send_to_wechat` / `notify_wechat` / `session_control` / `model_control`）的 `description`
**随每一次模型请求一起送出**，在 API 的独立 `tools` 字段里。它们不是文档，是**每个回合的固定开销**：
四个描述合计 4354 字符 ≈ 1244 tokens，占全部 39 个工具 schema 的 17.1%（2026-10-20 实测）。

**所以描述要短**，但短不能靠删规则。这些句子是唯一能约束 agent 行为的地方——工具代码只能执行，
拦不住"agent 自己另写一个脚本直连 iLink"，也拦不住"agent 在工具返回 `ok: false` 之后仍告诉用户切换成功"。

**不能压掉的规则**（`plugin.test.ts` 里有专门断言，删掉任何一条都会变红）：

| 工具 | 规则 | 删掉会怎样 |
|---|---|---|
| `notify_wechat` | **一个回复窗口只有十条**，窗口只在用户发消息时重开；多件事并成一条 | agent 连发到第十一条，之后全部被拒 |
| `notify_wechat` | 定时/脚本发送必须走 `dsh-wechat-send`，**不要直连 iLink API** | 插件看不到这些发送，无法计数、提醒、排队，第十一条丢失 |
| `session_control` / `model_control` | **渠道自己会公告切换结果**（含失败），不要重复；读结果里的 `ok`，为 `false` 时什么都别说 | 失败时 agent 仍说"切换成功"，用户下一条消息落到别处 |
| `model_control` | 切换**从下一轮生效**，不能说成已应用到正在跑的工作 | agent 把正在跑的回合说成已经换了模型 |

**怎么压**：只留「干什么 / 什么时候用 / 行为约束 / 参数含义」；例子最多两三个；长解释放
`--help`、用户手册或代码注释。`session_control` 与 `model_control` 里原本几乎逐字重复的公告规则，
现在各留最短的必要版本（以各自的动作名收尾：switching/creating 与 listing/switching）。
"用户在手机上"不再写进描述——`presenceNote` 每一轮都已经注入了这个上下文。

**实测（2026-10-20）**：四个描述 4354 → 1997 字符（−54.1%，1244 → 571 tokens）；
参数 schema 未动（2498 字符），因为工具名、参数结构、枚举、行为都不允许改。
`dsh-wechat-send --help` 已完整列出 `--file` 与退出码，所以描述里不再重复这些细节。

> **教训**：给模型看的每个字都是**每个请求都要付的钱**。压描述时先问"这条规则删掉后，有没有代码
> 能兜住"——`notify_wechat` 的十条窗口和 CLI 路线，答案都是"没有"。

### 7.10 编号就是编号：一个数字不许被拿去猜 id

**同一个病咬了三次，每次只贴了创可贴。**

| 次数 | 测试怎么写的 | 那次为什么红 |
|---|---|---|
| 1 | `/switch 99` 期望"切换失败" | `99` 是合法十六进制前缀，短 id 有约 1/256 的概率以它开头；那一跑切换真的成功了 |
| 2 | 同样的 `'99'`，在"说大白话"那条路上 | 只改了打字那条入口，另一个入口还在（§4.19） |
| 3 | `/switch 14` 想撞"第一屏没印过 14" | 解析器对超出钉住屏的数字**回落**做短 id 前缀匹配；当次会话短 id 恰好 `14c71a`（1/256），又成功了 |

**病根不在测试字面量，在 `resolveTarget` 的解析顺序。** 修之前（`v0.45.0`）纯数字是这样走的：

```ts
if (/^\d+$/.test(value)) {
  const byIndex = index < 0 ? undefined : numbered.sessions[index]
  if (byIndex !== undefined) return { kind: 'found', session: byIndex }
  /*
   * Fall through: a numeric string can still be a title or an id.
   */
}
// 之后依次尝试：完整 id → 精确标题 → 十六进制前缀 → id 后缀 → 标题片段
```

那句 `Fall through` 就是病根：**它允许一个数字在"这一屏没有这一行"之后被重新解释成别的东西**。
而纯数字在语法上同时是合法十六进制前缀，短 id 又是 6 位随机十六进制——于是"这一屏没有第 14 行"
可以变成"切到短 id 以 `14` 开头的那个会话"。自动生成的标题还会重复这 6 位（`微信 14c71a`），
所以**就算只删掉前缀匹配，标题片段匹配仍然会把同一个数字救回来**——这正是"一次只补一处"
永远补不干净的原因。

**这是产品缺陷，不是测试太挑剔。** 用户定的规则是：**歧义必须显式失败，不许猜。**
列表上印着 1..10，用户回 `14`，合理预期是"第 14 项"；第 14 项不在这屏，正确答案是
`找不到编号 14：这一屏只有 10 项（1–10）。`——而不是悄悄把他切到某个 id 以 `14` 开头的会话，
那会把对话搬到他从没指过的地方，而他只会看到一句"已切换"。

#### 改了什么（改实现，同时改测试）

- **`resolveTarget`**：纯数字先且只先当编号读。读不到时只接受一种其他读法——
  **行尾原样印出的 6 位短 id 的精确相等**；再读不到就是明确失败（`kind: 'unprinted'`），
  不再回落到前缀、后缀、标题片段、精确标题。
  - 为什么保留"6 位精确短 id"：短 id 是列表叫用户抄的另一种写法，而 `123456` 这种
    **全是数字的短 id 约占 1/17**。若一律当编号，这一批行就再也不能按列表教的写法切换——
    那会换来一个**新的、约 1/17 的概率失败**。这一版实现第一次跑测试就撞上了：一条
    `/switch <行尾 id>` 的老测试直接红。它和旧回落不是一回事：长度必须正好 6，值必须
    **等于**行尾印的那串，不是前缀。
- **`unprintedTargetMessage()`**：`找不到编号 14：这一屏只有 10 项（1–10）。` /
  `要用 id 请回行尾那 6 位；回复 /list 能再看一次清单。` 第一行必须带 `找不到`——
  `host.ts` 的 `controlSession` 就是靠 `/找不到|未知指令/` 判断这次切换失败，否则工具会回
  `ok: true`，把一次没发生的切换播报给用户（那条规则是 §4.5 换来的）。
- **同一规则收口另外两处"数字回落"**：`resolveFolder`（否则一个名叫 `9` 的会话夹会顶替第 9 项）
  和 `resolveModelOption`（否则数字会被当成模型名或 id 的一部分）。会话夹的编号是整张表连续的
  （不是每屏），所以那边只拒绝"超出整张表"的数字，没有动分页语义。
- **`#switchTo` 两种模式都回答 `unprinted`**：在列表里回一个不存在的编号也是一步"操作"，
  交给 agent 只会把 `14` 变成一句 prompt；并且保留 `browse` 位置——用户还在看那一屏，
  「查看其余」得能接着翻。读不到编号不是"列表结束了"。

#### 防复发机制

1. **规则层面**：数字不再是 id 前缀。`/switch 14` 在任何随机短 id 下都**不可能**命中——
   2 位数字连"6 位精确短 id"都够不着，结构上就没有那条路。测试不再靠概率，靠规则。
2. **`unmatchedSwitchTarget()`**（`packages/core/tests/support.ts`）：生成 `#<uuid>`——
   不是数字、含 `#`（任何 id 都不含）、不是精确标题、也不是这套测试里任何标题的子串。
   **"必须失败"的切换测试一律用它**，下一个人没有理由再手写一个字面量。它自己也有一条测试：
   拿一台故意敌对的机器（id 以数字/十六进制开头、标题带这些数字、标题就是个数字）去解析它的
   输出，必须 `none`。
3. **敌对夹具**：真正要验证"数字不被误读"的地方，夹具里放上**旧代码一定会命中**的会话——
   `session-3aaa…`（数字 3 的前缀）、`session-25bb…`、`session-14c71a00…`（第三次事故的原样 id），
   被引用的列表里也放了 `14aaaa00`。把旧逻辑放回去，这些测试**每次都红**（不是 1/256 才红一次）。

**本轮改到的测试**（"数字/短串作切换目标"的一次性清查）：

| 文件 | 位置 | 原来 | 现在 |
|---|---|---|---|
| `plugin.test.ts` | 「切换失败要告诉用户」 | `'zzzzzzz'` | `unmatchedSwitchTarget()` |
| `plugin.test.ts` | 「切到不认识的东西要报失败」 | `'zzzzzzz'` | `unmatchedSwitchTarget()` |
| `plugin.test.ts` | 「引用大白话列表按那屏的编号回答」 | 动态搜一个"没有 id 撞得上"的数字（20 行） | 直接用 `14`，并**故意**把 `14aaaa00` 放进夹具 |
| `plugin.test.ts` | 新增：口语路径的"编号不存在" | — | `'9'`（这一屏只有 1 行）+ 断言用户被告知 |
| `core.test.ts` | 「第二屏的编号带偏移读」 | 无害夹具，`'3'`/`'25'` 断言 `none` | 夹具故意含 `3aaa…`/`25bb…`，断言 `unprinted` + 消息 |
| `core.test.ts` | 新增：数字永远不是 id/标题 | — | `14c71a` + 标题 `2024` 的敌对机器 |
| `core.test.ts` | 新增：模型编号不回落 | — | 模型 id 就是 `'3'` 的敌对目录 |
| `core.test.ts` | 「会话夹按编号和名字进入」 | 名为 `9` 的夹能顶替第 9 项 | 断言 `unprinted`，并证明第 5 项能进它 |
| `core.test.ts` | 新增：在列表里回一个不存在的会话编号 | — | 敌对 id `5aaa…`；断言 `unprinted`、绑定不动、`browse` 保留 |
| `core.test.ts` | 新增：在会话夹里回一个不存在的编号 | — | 名为 `9` 的会话夹；断言 `unprinted`、位置还在、`2` 仍能进 |

**反向验证**：把上面三处解析回落到旧行为，`core` 有 **8 条**、`plugin` 有 **2 条**测试变红；
其中「引用大白话列表」红的原因是 `已切换到「本工作区 0」。\n14aaaa`——第三次事故原样复现，
且是**每次**，不是 1/256；「会话夹」那条红成了 `【9】会话（1/1）`（进了名叫 9 的夹），
「会话编号」那条红成了 `已切换到「另一件事」。\n5aaa00`（切到了 id 以 5 开头的会话）。
恢复修复后全绿。全量连跑 5 轮：每轮 **324 项、0 失败**。

**边界（如实记录）**：

- 编号只对"用户看得见的那一屏"有效。没有任何列表时，`/switch <编号>` 按**当前工作区的实时顺序**
  编号（`first: 1`）——这是原有语义，没变。
- 会话夹的编号是**全局**的（不分屏，因为那张表短），所以只拒绝超出整张表的数字。这个差异是分页
  结构决定的，本轮没有动（§4.13 的两层分页是硬约束）。
- 纯数字的**标题**不再能按名字切换（`/new 2024` 之后再 `/switch 2024` 会明确报错）。它可以按
  编号到达——每个会话都是某一屏的一行，所以没有"够不着"的会话。
- 6 位纯数字的**精确短 id** 认；**前缀一律不认**——`1234` 不会命中 `123456`，7 位以上的纯数字串
  也不会被当成 id 前缀。所以短 id 撞车时那条"请用更长的 id"，必须回含字母的十六进制或完整 id。
  这是有意的：长度一放宽，"数字不当前缀"就破了。两种读法同时成立（一屏真的印到第 100000 行，
  而某个会话的短 id 又正好是 `100000`）时，**编号优先**：那一屏确实印了这个号。

> **教训**：**"测试里那个字符串会不会撞上随机 id"不是测试问题，是解析器问题。**
> 只要解析器允许"这个数字读不到就当 id 前缀"，任何测试、任何用户输入都可能撞；
> 把规则写死（并让越界的那一屏**说出自己的范围**），才是一劳永逸。三次补丁之所以不够，
> 是因为它们都在赌下一次的随机值，而没有动"允许赌"的那条规则。

---

## 8. 出问题怎么查

| 现象 | 先看哪里 |
|---|---|
| 插件让 DSH 起不来 | `~/.dsh/wechat/boot.log` 里的 `apply: FAILED:`（**含完整堆栈**） |
| 桌面端崩溃 | `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`（**只采集 error 级 console**） |
| 设置页空白 / 报错 | 那个路由的 HTTP 状态 + `boot.log` |
| **设置改了没反应** | `boot.log` 里的 `settings:` 行：有 `saved … 旧值 -> 新值` 说明保存到了（再看**新旧值是否相同**，相同就是主机没收下）；**一行都没有**说明那次保存没发出来，问题在页面（见 §4.15） |
| **设置存了但没生效** | 「会话工作目录」是启动时解析的：`/status` 的 `diagnostics.settingsWorkspace`（设置里存的）与 `diagnostics.workspace`（正在用的）不一致，就是**缺一次重启** |
| **每次启动都固定报一条 `客户端错误[register]`（看门狗）** | 读那条消息**说的是哪件事**：现在它只会为"设置页**没能注册**"而报（见 §4.17）。真的注册失败 ⇒ 壳没有声明 `settings.section`，或 `apply` 没跑。如果看到的是 `[mount]`＋"设置页没有渲染"，那台机器上的插件还是**旧版**（那正是 issue #2 的误报） |
| **设置了页面点开也没内容／打开就报错** | 看是不是 `客户端错误[render]`（组件渲染时抛了异常，消息里带原始错误与堆栈）；**空页面但不抛错，插件这边看不到**（§4.17 已写明的边界） |
| 收不到回复 | `boot.log` 的 `outbound` 行；没有就是流解析问题 |
| **改完插件、重建后设置页还用旧代码**（控制台报 `Identifier '…' has already been declared`） | 客户端 bundle 是不是又在**顶层**声明了 `let`/`const`/`class`：壳每个 revision 都把它当新脚本重新求值（见 §4.16） |
| **发消息完全没有回复，而且日志里一行错都没有** | **绑定会话是不是被归档了**（`workspaceRegistry.archivedSessionIds`，持久副本在 `storages/workspace.json`）或磁盘上已经不存在；`boot.log` 里的 `session-state:` 行说的就是这件事（见 §4.14） |
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

