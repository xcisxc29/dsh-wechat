# dsh-wechat

把微信变成 DeepSeek Harness 的遥控器：手机上用微信聊天，电脑上的 DSH 干活。

**不需要安装 OpenClaw。** 这个插件直接实现腾讯 iLink Bot API —— 也就是微信官方 ClawBot 插件背后的那套 HTTP/JSON 接口。

## 为什么可行

微信 ClawBot 插件的本地进程**主动向外拨号**长轮询腾讯的服务器，不需要公网 IP、端口映射或内网穿透。电脑开机、进程在跑，手机在任何网络下都能用。

我们对着腾讯官方的渠道实现（`@tencent-weixin/openclaw-weixin`，作者 Tencent，MIT）逐个接口读通了协议，并用独立客户端**实测通过**：

| 验证项 | 结果 |
|---|---|
| 服务端是否只认 OpenClaw | 不认，后端不检查客户端身份 |
| 扫码登录 | 成功签发 `ilink_bot_id`（形如 `xxx@im.bot`） |
| Bearer 认证 | 通过 |
| 长轮询收消息 | 收到真实消息，字段完整 |
| 发送文本 | 手机微信收到 |
| 无 `context_token` 的主动消息 | 服务端接受（可做定时/完成通知） |
| 跨进程复用 token | 通过（重启无需重新扫码） |

## 架构

```
手机微信 ──► 腾讯 iLink 服务 ──► 你在跑的电脑
                                  │
                            dsh-wechat 插件
                                  │
                    ┌─────────────┴─────────────┐
                    │  @dsh-wechat/core         │  协议层，零 DSH 依赖
                    │  登录 / 长轮询 / 发送 / 状态 │
                    └─────────────┬─────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │  dsh-wechat (bundle)      │  宿主粘合层
                    │  会话路由 / 设置页 / 回复回流 │
                    └───────────────────────────┘
```

- **`@dsh-wechat/core`** —— 只讲 iLink 协议，不 import 任何 DSH 包，可单独测试复用。
- **`dsh-wechat`** —— 可安装的 DSH bundle。读宿主服务（`sessionController`、`webServer`），把微信会话映射到 DSH 会话。

## 安装与使用

```bash
pnpm build            # 编译核心包（bundle 依赖它）
pnpm pack             # 产出 dsh-wechat-0.0.0.tgz
```

把 tgz 装进你的 DSH profile，然后：

1. 打开 **设置 → 微信**
2. 点「开始扫码」，用手机微信扫屏幕上出现的二维码
3. 手机上确认授权

之后就可以在微信里直接和 DSH 对话了。

**关于开机自启**：不需要任何额外的自启程序或服务。这个插件一旦装进 profile，DSH 每次启动都会加载它；`cordis.patch.yml` 里的 `autoStart: true` 会让它自动重连已绑定的微信账号。你只需要"开机 → 打开 DSH"，微信那边就能用。关掉 DSH 或电脑休眠时链路断开，这是协议决定的（本机主动外拨），没有绕过的办法。

## 设置页

`dsh.client` 声明了 `platform: 'web'`，浏览器侧包 `client.js` 通过 `window.__ModuleLoader__.load({ id, factory })` 注册自己——这是这套客户端加载客户端插件的标准机制（包括 `dsh-client-ui-renderer` 在内的 75 个包都在用，桌面端同样是这个网页界面）。

设置页提供：

- 通道开关（控制 `autoStart`）
- 已绑定账号列表 + 长轮询状态
- **二维码扫码**（图片直接渲染，无需终端）
- 配对验证码输入（服务端要求时出现）
- 会话绑定列表（微信对话 ↔ DSH session）
- 最近错误

页面通过 `/.dsh-wechat/*` 路由与宿主通信。登录握手放在宿主侧，所以**扫描过程中关掉页面或切走再回来，二维码和进度都还在**。

客户端插件规范要求工厂无副作用、所有资源经 `ctx.effect` 注册并返回清理函数——样式表在插件卸载时会一并移除，有测试覆盖。


这个渠道创建的会话，和你手动开的会话是**同一种东西**，因此会出现在桌面端的会话列表里，也能直接打开继续聊。

它们的 `cwd` 统一钉在 `$DSH_HOME/dsh_wechat`，跟 `dsh-orb` 用 `$DSH_HOME/dsh_orb` 是同一个约定：桌面上好认、好归档。

> **这个路径必须恒定。** 宿主在"采用"一个已存在的会话时会比对 `cwd`，不一致直接抛 `ApiSessionCwdConflict`，那个会话就永远接不回来了。所以代码里它是常量，不是每个对话一个目录。

## 多对话

微信侧只有一个对话框，这是 ClawBot 插件的形态。所以切换在聊天里做：

| 指令 | 作用 |
|---|---|
| `/new [标题]` | 新建会话并切过去 |
| `/list` | 列出**微信工作区**的会话，标出当前的 |
| `/list all` | 列出**全部**会话，含其它工作区 |
| `/switch <编号 或 短号 或 题目>` | 切换会话 |
| `/current` | 显示当前会话 |
| `/cancel` | 中断当前任务 |
| `/help` | 帮助 |

**空格可以省。** 手机键盘常漏空格，所以 `/switch1` ≡ `/switch 1` ≡ `/switch:1`，`/new我的任务` 也认。但 `/news` 会被当作一个独立词（不是 `/new s`），因为**命令名后面紧跟 ASCII 字母时不拆**——否则一个拼写错误就会静默新建会话。

`/list` **默认只列微信工作区**的会话，并告诉你别的工作区还有多少、叫什么；`/list all` 才列全部。**说大白话走同一套逻辑、同一个渲染器**，所以「看下有哪些对话」和 `/list` 给你的东西是一样的。

**切换可以跨工作区**：`/list all` 列出的会话都能切过去，采纳时用**那个会话自己的工作区**（DSH 固定每个会话的 `cwd`）。数字按**你看到的那份列表**编号，题目和短号则在**所有工作区**里找。

**切换成功或失败都会由通道直接告诉你**，不依赖 agent 转述——切换后 agent 的话会发往你已经离开的会话，到不了手上；而失败时如果没人说，你根本发现不了。

每个微信会话绑定一个 DSH session，映射落盘，Host 重启后仍然指向同一个会话。会话 id 由本插件铸造为 `session-<短号>-<uuid>`，**`/list` 里显示的短号和 `/switch` 接受的是同一个字符串**。

## 只有当前绑定的会话能代表这个对话（重要）

一个微信对话**只把发言权交给它当前绑定的那个会话**。曾经用过、但已被 `/new` 或 `/switch` 换掉的会话，**不能再发消息、不能提问、不能切换**。

**为什么需要这条**：插件原本用"这个会话是否曾属于该对话"来判断——于是**对话换走之后，旧会话仍然永久保有发言权**。这不是理论问题：本插件的开发会话就是这样，`/new` 之后它仍被记录为那个微信对话的归属，结果是**从另一个 DSH 会话里发出的一个提问，被送到了用户手机上**。

| 用途 | 依据 | 说明 |
|---|---|---|
| **行动**（发消息 / 提问 / 切换） | **当前绑定** | 换走的会话立刻失去发言权 |
| 归属记录 `sessionOwners` | 历史 | 只用于追溯"这个会话曾属于谁"，**已经不再授权任何事** |

> `sessionOwners` 目前**只写不读**。它是在修"切换回旧会话后工具找不到对话"时引入的，而那个问题现在由"按绑定查找"解决——绑定在切回去之后本来就指向那个旧会话。

## 绑定是排他的（重要）

一个微信号在同一时刻只能有一个活跃的 ClawBot 绑定。**如果另一个客户端不带本地凭据去扫码，服务端会重新绑定，把原来那个顶掉。**

本插件的做法：

1. 申请二维码时携带 `local_token_list`（本机已持有的所有 bot token），服务端因此回 `binded_redirect` 而不是重新签发 —— 沿用既有绑定，绝不动别人的。
2. token 与游标原子持久化（0600 权限），**永远不"重启就重新扫码"**。
3. `errcode=-14`（token 失效）照搬腾讯官方的一小时熔断，再要求重新扫码。
4. 手机微信里不要主动"解除绑定"。

想在 OpenClaw 和 DSH 之间来回切，就是互相顶 —— 这是服务端设计，不是实现缺陷。要并存只能用两个微信号（插件按多账号设计）。

## 状态文件

默认 `$DSH_HOME/wechat/state.json`（0600，原子写），含：

- `accounts` —— bot token、baseUrl、绑定的微信用户
- `syncBufs` —— 长轮询增量游标，保证进程重启不丢消息
- `contextTokens` —— **按会话**存的回复令牌，多对话下不会串台
- `bindings` —— 微信会话 ↔ DSH session 映射
- `autoStart` —— 是否开机自动重连

## 开发

```bash
pnpm install        # hoisted node_modules 布局，见 .npmrc
pnpm build          # 编译核心包到 lib/（bundle 依赖它）
pnpm typecheck
pnpm test           # 69 个测试：27 协议/路由 + 9 媒体 + 25 插件集成 + 8 设置页

pnpm pack           # 打成可安装的 tgz
pnpm verify-pack    # 解包、校验清单声明的文件都在、并当作已安装插件挂载一次
```

两个容易踩的坑，已在代码里解决：

- **核心包必须构建成 JS。** Node 拒绝对 `node_modules` 下的文件做类型剥离，所以"直接发布 TS"的方案在装进 profile 后必然失败。
- **pnpm 默认的隔离布局会让 `qrcode` 找不到自己的依赖。** 见 `.npmrc` 里的 `node-linker=hoisted`。

冒烟测试（走真实服务，用探针存的凭据）：

```bash
node --experimental-transform-types scripts/smoke.mjs --seconds 180 --hello
```

## 协议依据（重要）

**所有 iLink 协议细节都以腾讯官方实现为准，不要靠猜：**

| 内容 | 来源 |
|---|---|
| 类型定义（`CDNMedia` / `ImageItem` / `FileItem` / `GetUploadUrlReq`…） | [`@tencent-weixin/openclaw-weixin/src/api/types.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/api/types.ts) |
| 出站条目构造（图片/文件/视频） | [`src/messaging/send.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/messaging/send.ts) |
| 出站上传流程 | [`src/cdn/upload.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/cdn/upload.ts)、[`cdn-upload.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/cdn/cdn-upload.ts) |
| 入站下载与解密 | [`src/media/media-download.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/media/media-download.ts)、[`src/cdn/pic-decrypt.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/cdn/pic-decrypt.ts) |
| CDN URL 构造 | [`src/cdn/cdn-url.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/cdn/cdn-url.ts) |

**代价**：出站图片花了 6 轮才修好，全部原因都是我在没有参照物的情况下猜协议。找到官方源码后一次就对了。

三条最容易踩的坑（都已按官方对齐）：

1. **`media.aes_key` = base64(hex 文本)**，不是 base64(原始 16 字节)。发错形态时服务照收、手机显示灰框。
2. **媒体引用取上传响应的 `x-encrypted-param` 头**；`upload_full_url` 里的长参数是上传授权，拿去读会被 403 拒。
3. **条目不要多发字段**：官方图片条目只有 `media` + `mid_size`，文件条目只有 `media` + `file_name` + `len`。

## 进度

- ✅ **第一档**：纯文本打通 —— 协议层、扫码登录、长轮询、发送、状态持久化、会话路由与多对话、桌面端可见的工作区、GUI 设置页、可安装 bundle
- ✅ **第二档**（已完成）：媒体双向 + 会话控制
  - ✅ **入站媒体**：图片/文件/语音/视频的下载与解密，落盘到会话工作区的 `媒体/`（保留原文件名），并把路径与大小交给 agent。**真实微信图片已验证端到端跑通**。大小上限提升到 **100MB**（对齐官方）
  - ✅ **附件合并窗口（覆盖所有非文本消息）**：**任何带附件的消息**——图片、文件、语音、视频，**无论有没有配文字**——都先停放 10 秒。
    - 窗口内来了文字 → 合并成一条 prompt，附件与所有 caption 一起交给 agent
    - 窗口内没有后续 → 超时后单独把附件交给 agent
    - 连续多条（如「文件 + 图片 + 一句要求」）会**累积成一个 prompt**，而不是三次调用
    - **为什么带文字也要等**：用户常常先发附件、再补一句说明。若带文字就立即送出，那句补充就变成了第二次、互不相关的调用——这正是这个窗口要消除的多余回复
  - ✅ **出站媒体**：`send_to_wechat` 工具，agent 可把本机文件发回微信（图片走图片通道，其他走文件通道）。caption 作为**先发的文本条目**，与官方一致
  - ✅ **语音转码（SILK → WAV）**：`packages/core/src/silk.ts`，照官方 [`silk-transcode.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/media/silk-transcode.ts) 实现。
    - 用 `silk-wasm` 解码为 `pcm_s16le` @ **24 kHz 单声道**，套 WAV 容器；失败则**回退原始 SILK**，不会丢语音
    - `silk-wasm` 不是硬依赖：运行时按包根解析，缺失时优雅降级
    - prompt 里带上**服务端转写**与**时长**，agent 常常不必打开音频就能回答
    - **验证方式**：`node scripts/probe-silk.mjs` 做真实往返（PCM → SILK → 解码 → WAV），校验全部头部字段与时长；1 秒源音频解出 1.000 秒
  - ✅ **视频**：入站下载解密 + 出站发送。
    - **出站本来完全不存在**——`.mp4` 会被当成普通文件走 `UploadMediaType.FILE`，手机收到的是不可播的下载而非视频。现在 `packages/bundle/src/media-kind.ts` 按扩展名分派 image / video / file 三种通道
    - 条目照官方 `sendVideoMessageWeixin`：`video_item: { media, video_size: <密文大小> }`，**不发缩略图、不发 md5**
    - 入站同样要求"引用 + `aes_key` 齐"才下载；prompt 里带上**时长**（`play_length`）与 md5
    - 分类规则有独立测试（`media-kind.test.ts`），因为**类型错了不会报错**，只是手机那头拿到错的东西
  - ✅ **出站图片（已实机验证成功）**：根因是 `media.aes_key` 编码，见上文「协议依据」
  - 🔍 **出站图片可见性**：症状演进"完全看不到" → "**灰框**"。灰框意味着消息被服务接受、只是客户端**解密不了媒体**。
    - 🔑 **根因（已找到权威依据）**：`media.aes_key` 必须是 **base64(hex 文本)**，不是 base64(原始 16 字节)。前者 44 字符、后者 24 字符，只有前者能解密——发错形态时服务照收，手机显示灰框。
      参考：[腾讯官方 openclaw-weixin 的 send.ts](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/messaging/send.ts) 里 `aes_key: Buffer.from(uploaded.aeskey).toString("base64")`，其中 `aeskey` 已是 hex 字符串。
    - **完全对齐官方 `sendImageMessageWeixin` 的条目构造**：
      ```ts
      image_item: {
        media: { encrypt_query_param, aes_key: base64(hex), encrypt_type: 1 },
        mid_size: <原图密文大小>,
      }
      ```
      因此**移除**了此前自行添加的 `image_item.aeskey`、`hd_size`、`thumb_media` 等字段——官方条目里没有它们，而多余的密钥声明正是客户端不认的形态。
    - `encrypt_type` 回到 **1**（官方对图片/文件都用 1）。
    - `file_item` 也对齐官方：只有 `media` / `file_name` / `len`，**移除** `md5`。
    - 媒体引用取**上传响应的 `x-encrypted-param` 头**（官方做法）。此前一轮曾误改为 `upload_full_url` 里的参数，那是上传授权、只读会被拒（403）。
    - `thumbnail.ts`（用应用自带 `sharp`）保留：它对入站/后续视频路径仍有用，但官方图片条目并不发送缩略图引用。
  - 🔍 **工具调用卡片（结构已对齐，可见性待定位）**：用微信客户端**原生渲染**的工具卡片显示 agent 正在做什么（`type=11` 开始 / `type=12` 结果）。
    - **实机测试显示卡片没有出现**（2026-10-06 12:22 的截图里全是普通文字气泡）。单元测试全绿，说明问题在真实链路，不在结构。
    - **首要嫌疑**：`tool-call-delta` 帧里**是否真有 `name` 字段**。这是我从未观测过的假设——如果实际用的是别的字段名（如 `tool_name`），代码会静默丢弃每一帧，**卡片全部消失且无任何错误**。
    - 因此 0.9.1 加入诊断：无法转成调用的帧会把**字段名列表**写进 `boot.log`（`tool-call frame fields (no call made): …`），并且**成功发送也会记录**（`tool card: start/end …`）——此前只记失败，导致"发了但看不到"与"没发"在日志里无法区分
    - 照官方 `reply-progress-sender.ts`：卡片带 `tool_call_id` **配对**、`create_time_ms` 定序、结果是四态之一（`completed` / `failed` / `blocked` / `unknown`）
    - **两个事件源的可靠性不同，这是设计的核心**：
      | 来源 | 拿到什么 | 可靠性 |
      |---|---|---|
      | `tool-call-delta` 帧（助手流） | 工具名 + 调用 ID | **确定**——插件在宿主作用域必然收到 |
      | `tools/result` 事件 | 真实状态（含失败） | **可能收不到**——它按调用者 agent 作用域分发 |
    - 所以**开始卡片**从流里发（必然出现）；**结果卡片**在真收到 `tools/result` 时发；若收不到，**回合结束时补发**，且**留 1.5 秒宽限**让真实状态先到，避免把失败的调用报成完成
    - **宁可少一张卡片，也不谎报成功**——这是这条设计的取舍
  - ✅ **引用消息缓存**：用户长按引用 DSH 的某条消息再追问时，把被引用的内容还原给 agent。
    - **协议事实（实测样本）**：引用到达时 `ref_msg.message_item` 只有 `type: 0` + `msg_id` + 时间戳，**正文完全不在里面**（样本 188 字节）。所以被引用内容除非自己存，否则无处可寻。
    - **ID 格式对得上**：我们发出的消息是裸数字（`7513221606025264904`），引用指向的也是裸数字；而用户自己发来的消息带 `v1:` 前缀。所以 `msg_id` 可用作主键。
    - 实现：`state.sentMessages`（按账号 → 会话两层键，每会话上限 40 条，超出丢最旧）+ `#resolveQuote`
    - 引用内容**放在 prompt 最前面**——用户的要求是*关于*它的，先看到被引用内容才读得懂「这个再展开说说」
    - 查不到时**明说**：`[引用了一条我发出的消息，但内容已不在缓存中（id …）]`。让 agent 知道"有引用但读不到"，好过它对着一个没头没尾的追问瞎猜
  - ✅ `reasoning-delta` 明确排除；纯工具回合不发空消息；**一个回合只发一条消息**（`finish` 按步骤触发，不能当回合结束）
  - ❌ **流式刷新（`message_state`）—— 不可实现，已放弃**。查证：[OpenClaw 官方文档](https://docs.openclaw.ai/zh-CN/concepts/streaming) 明确「**并不提供真正的 token 增量流式传输**」，且"预览流式传输"（更新预览消息）**只支持** Telegram / Discord / Slack / Matrix / Mattermost / MS Teams，**没有微信**。
    - 根因：预览流式传输需要**编辑消息**能力（如 Telegram 的 `editMessageText`），而 iLink 的 `SendMessageResp` **不返回消息 ID**，也没有任何编辑接口——**没有凭据，就没有"刷新"可言**
    - 官方对本渠道显式 `disableBlockStreaming: true`
    - **但"分块流式传输"已经在工作**：助手每写完一段就作为**普通消息**发出（实测截图里一轮出现三条独立气泡，就是它）。这不是编辑同一条消息，而是发多条——**已经是当前行为，无需再做**
  - ✅ **插话（`steer`）**：微信会话里后一条消息**打断**进行中的工作，而不是排在它后面。
    - DSH 的 `sessionController.prompt` 有 `mode: 'queue' | 'steer'`，编译产物里对应 `agent.followup(message)` 与 `agent.steer(message)`——**`steer` 注入正在跑的回合**
    - 关键性质：`this.running ? (mode === 'steer' ? 'steering' : 'queued') : 'transcript'`——**空闲时两种模式等价**，所以微信会话一律用 `steer` 是安全的，不必自己判断忙闲
    - **降级保底**：`steer` 可能被拒（目标回合已结束）。拒绝时自动改投 `queue`——**排队只是慢一点，丢消息无法补救**
    - **消息绝不静默丢失**：若插话与排队**都**失败，把用户原话**回发给用户**并提示重发，因为那是唯一的副本
  - ✅ **渠道身份注入**：告诉 agent 对方在手机上、**看不到这台电脑的屏幕和文件系统**、需要看东西就直接发。此前 agent 会让人"打开某个路径"，而对方根本够不到
    - **新会话的第一条消息里它单独发**。DSH 用第一条 prompt 给会话起名，而它看的是**整段文本**——提示词在里面，题目就变成「微信渠道对话支持」这类样板话。把提示词挪到末尾**不够**（实测新会话仍叫「微信渠道协助对话」），只有让它**不在那段文本里**才行
    - 之后的消息仍是完整一条，提示词附在末尾
  - ❌ **Markdown 过滤 —— 无需实现**。原计划照官方 `StreamingMarkdownFilter` 剥掉 `##`、删除 `![图](url)` 等。**实测微信客户端自带 Markdown 过滤**，这些符号本来就不会显示成噪声，因此这项取消
  - ✅ **手机端可回答交互提示（关键在于"只有手机"的用户不再被卡死）**：权限申请与多选提问原本只在桌面会话面板出现，而框架的应答者**失败即拒绝**（fail closed），所以不在电脑旁的用户会被永久卡住。
    - **机制（DSH 原生扩展点）**：`approval/request` 与 `user-questions/request` 都是 **waterfall** 事件——`Return an outcome to claim the request or call next() to delegate`。**认领微信绑定会话，其余 `next()` 交给桌面**，所以桌面行为完全不受影响
    - 事件载荷与应答（照官方实现）：`approval/request` 的 `agent` / `toolName` / `reason` / `signal` → 返回 `'allowed-once' | 'rejected' | 'cancelled'`；`user-questions/request` 的 `questions[{id,question,options[{label,description}],multiSelect}]` → 返回 `{ answers:[{id, selected:[label], custom?}] }`
    - 提示以**编号**发出，手机上按一个数字即可回答；也接受直接回文字。**权限**回复 `允许` / `拒绝`
    - **投递链最前面拦截答复**（`#settleInteraction`）：`1` / `允许` 是回答提示，**不能当新请求发给 agent**，否则既打扰 agent 又让提示永远悬着
    - **两条安全原则**：
      - **拒绝优先判定**——`不允许` 含 `允许`，子串匹配会把**拒绝当成同意**，所以先查否定词
      - **看不懂就不猜**——无法识别的回复**不当作决定**，提示重发并保持挂起；在权限上猜错等于**批准了用户没同意的事**
    - 同一会话的新提示会替换旧的（用户看的是最新那条，同时挂两个会让回复无法归属）
- ⏳ **第三档**：多账号、白名单鉴权、文档、发布

### 会话列表与切换（已实机验证）

- ✅ **列表由通道直接发**，不靠 agent 转述。日志里出过：工具跑了、行也回来了，agent 却回**「已为你列出对话列表，请看上面的消息」**——指向一条**从未存在的消息**，因为工具结果只有 agent 看得到
- ✅ **默认只列微信会话 + 告知别处还有**，并**列出工作区名**（`另有 56 个对话在别的工作区（workplace、dsh_orb）`）。`/list` 与说大白话**走同一个渲染器**，同问同答
- ✅ **每个会话一个短 id**。同一工作区的会话共享工作区名，光看名字分不清；短 id 也能直接回给 `/switch`
- ✅ **切换失败也明确告知**（由通道发）。日志里：工具返回 `ok: false`，agent 却告诉用户**「已切过去了」**——失败时微信这边什么都没变，用户不发现不了。工具描述现在**明确禁止** agent 声称切换成功
- ✅ **可切换到任何工作区的会话**。早期 `/list all` 列出别的项目的会话，但按名字切换**只在微信工作区里搜**——列得出、点不动。现在：数字按**用户看到的那份列表**编号，题目与短 id 搜**全部工作区**（采纳时用**那个会话自己的工作区**，因为 DSH 固定 `cwd`）

验证状态（全部是真实链路跑出来的）：

| 验证项 | 方式 |
|---|---|
| 扫码登录、收消息、发消息 | 真实微信往返 |
| 无 `context_token` 的主动推送 | 真实发送，服务端接受 |
| 跨进程复用 token 与游标 | 重启进程后继续长轮询 |
| 普通消息路由到会话 | `你好` → 复用既有会话（新建=否） |
| 会话在重启后复用 | 重新挂载后仍指向同一 session |
| `/new` `/list` `/switch` `/current` | 真实微信往返，标记与切换均正确 |
| 无空格指令（`/switch1`） | 真实微信往返 |
| 出站图片 | 真实上传+发送，手机收到 |
| **入站图片** | 真实微信发图 → 87527 字节落盘 → **JPEG 有效、960×1280、EOI 完整** → agent 收到路径并产出第 3 回合回复 |
| 桌面端会话文件夹 | 工作区 `微信会话` 注册成功（`~/.dsh/storages/workspace.json`） |
| 设置页 | 单元测试覆盖加载、渲染、清理；**并按 DSH 真实设计令牌渲染截图，浅色/深色都确认过** |
| **跨工作区切换** | 真实微信往返：`switch target=微信或手机如何联系AI ok=true`，会话在 `workplace` 工作区 |
| **会话题目** | 真实微信新建会话 → 题目为**用户所问**（「北京今天天气如何」），非渠道样板话 |
| **渠道提示词的拆分** | 真实微信收到提示词**作为独立一条消息**到达 |

设置页外观的验证方式：样式取自 `client.js`，**设计令牌取自 DSH 自己的主题**（`@deepseek-ai/dsh-client-ui-theme`），渲染成 HTML 后截图比对。早先用 `color-mix(currentColor …)` 调灰阶，看着接近但**永远对不上**——app 的灰阶是**令牌**，不是透明度。


## 许可证

MIT。协议行为参照腾讯官方渠道实现（MIT）独立实现，未复制其代码。
