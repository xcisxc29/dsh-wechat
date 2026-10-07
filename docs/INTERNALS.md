# 实现说明

给想了解内部构造的人。用户只需要看 [README](../README.md)。

## 为什么不需要公网 IP

微信 ClawBot 插件的本地进程**主动向外拨号**长轮询腾讯的服务器，不需要公网 IP、端口映射或内网穿透。电脑开机、进程在跑，手机在任何网络下都能用。

协议细节以腾讯官方实现为准（[`@tencent-weixin/openclaw-weixin`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/api/types.ts)，作者 Tencent，MIT），并用独立客户端实测：

| 验证项 | 结果 |
|---|---|
| 服务端是否只认 OpenClaw | 不认，后端不检查客户端身份 |
| 扫码登录 | 成功签发 `ilink_bot_id`（形如 `xxx@im.bot`） |
| Bearer 认证 | 通过 |
| 长轮询收消息 | 收到真实消息，字段完整 |
| 发送文本 | 手机微信收到 |
| 无 `context_token` 的主动消息 | 服务端接受 |
| 跨进程复用 token | 通过（重启无需重新扫码） |

## 架构

```
手机微信 ──► 腾讯 iLink 服务 ──► 你在跑的电脑
                                  │
                            dsh-wechat-plugin
                                  │
                    ┌─────────────┴─────────────┐
                    │  @dsh-wechat/core         │  协议层，零 DSH 依赖
                    │  登录 / 长轮询 / 发送 / 状态 │
                    └─────────────┬─────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │  dsh-wechat-plugin        │  宿主粘合层
                    │  会话路由 / 设置页 / 回复回流 │
                    └───────────────────────────┘
```

- **`@dsh-wechat/core`** —— 只讲 iLink 协议，不 import 任何 DSH 包，可单独测试复用。**不单独发布**，打包时被并入 `dist/core`。
- **`dsh-wechat-plugin`** —— 可安装的 DSH bundle。读宿主服务（`sessionController`、`webServer`），把微信对话映射到 DSH 会话。

## 两条安装路径

用户装插件有两种方式，**走的不是同一条产出路径**，这是本项目唯一容易搞混的地方。

| | 从 npm 装 | 从 Git 装 |
|---|---|---|
| 用户填什么 | `dsh-wechat-plugin` | `https://github.com/xcisxc29/dsh-wechat` |
| DSH 做什么 | 下载 tarball | 克隆仓库，跑 `prepare` |
| 产出方式 | `scripts/pack.mjs` 打包 | `pnpm run dist` 就地构建 |
| core 放在哪 | `dist/core/` | 原地 `packages/core/lib/`，靠相对路径引用 |
| 包根 | `packages/bundle` | 仓库根（`dsh-wechat-workspace`） |
| 入口声明 | bundle 自己的 `package.json` | 根 `package.json` 的 `main`/`exports`/`dsh` |
| 额外配置 | 无 | 需在 profile 的 `pnpm-workspace.yaml` 里放行构建 |

> ### 名字为什么不一致（这是有意保留的）
>
> **仓库叫 `dsh-wechat`，包名叫 `dsh-wechat-plugin`。**
>
> 原因是 npm 上 `dsh-wechat` **已经被占用**——而且是**另一位作者做的同类插件**（`pan17/dsh-wechat`）。所以要发布就只能换名，仓库名则保留短的。
>
> **代价是用户可能输错**：在「添加插件」里打 `dsh-wechat` 会装到别人那个。所以安装相关的文字里，**这个名字只能以可复制的形式出现**，并且必须带一句说明。
>
> **另一个相关约束**：包名、`cordis.patch.yml` 的行 id、`client.js` 注册的模块 id **三者必须一致**（都是 `dsh-wechat-plugin`），有测试守着。**仓库名不在这三者之内**，改仓库名不影响它们——但会打断 npm 的 Trusted Publisher（那里填的就是仓库名），所以**改名要连带重建发布配置**，这也是最终没改的原因。

两条路径都要解决**同一个问题**：`@dsh-wechat/core` 是 workspace 依赖，装完之后不存在。区别只在改写目标——npm 包改到内嵌的 `dist/core/lib/index.js`，Git 安装改到同级的 `../../core/lib/index.js`。

所以 import 改写做了两次，各管一条路：

- `scripts/pack.mjs` —— 打包时改写成 `../dist/core/lib/index.js`
- `scripts/inline-core.mjs` —— 构建后就地改写成 `../../core/lib/index.js`，由 `pnpm run dist` 调用

**两者都建立在 `build` 保留原始引用的前提上**，所以 `build` 与 `dist` 必须分开：`build` 只编译，`dist` = `build` + 内嵌。若把内嵌并进 `build`，`pack.mjs` 就找不到可改写的引用而直接报错。

Git 路径还有两个前提，缺一不可：

1. **根清单要有入口**。`pnpm add git+…` 装的是仓库根，加载器从根解析，所以 `main`/`exports`/`dsh` 都在根上声明，指向 `packages/bundle/`。
2. **`.npmignore` 要存在**。pnpm 打包克隆内容时，没有 `.npmignore` 就回退到 `.gitignore`——而后者排除 `lib/` 与 `dist/`，于是 `prepare` 刚构建的产物被丢掉，装完没有入口。

## npm 包的变换步骤

发布包由 `pnpm run pack` 从源码变换而来：

1. **编译 TS → JS**。用户装完后代码在 `node_modules` 下，而 **Node 拒绝对 `node_modules` 里的文件做类型剥离**——发 TS 源码的包装上后第一次 import 就会失败。
2. **内嵌 core**。`@dsh-wechat/core` 是 private workspace 包，npm 上不存在，留着引用会 `ERR_MODULE_NOT_FOUND`。所以编译好的 core 复制进 `dist/core/`，并把 `from '@dsh-wechat/core'` 改写成相对路径。
3. **精简清单**。删掉 `scripts` / `devDependencies`；`workspace:*` 协议 npm 不认识，那条依赖一并删除。
4. **补文档**。npm 只按 `files` 字段打包，**不会因为目录里有 README 就破例**，所以 README 与 LICENSE 由 `scripts/pack.mjs` 显式加入。

## 桌面上会话的归属

这个渠道创建的会话和你手动开的会话是同一种东西，因此出现在桌面端的会话列表里，也能直接打开继续聊。

它们的 `cwd` 统一钉在 `$DSH_HOME/dsh_wechat`，跟 `dsh-orb` 用 `$DSH_HOME/dsh_orb` 是同一个约定：桌面上好认、好归档。

> **这个路径必须恒定。** 宿主在「采用」一个已存在的会话时会比对 `cwd`，不一致直接抛 `ApiSessionCwdConflict`，那个会话就永远接不回来了。所以代码里它是常量，不是每个对话一个目录。

## 会话列表与切换的实现

- **列表默认只列微信工作区的会话**，并告知别的工作区还有多少、叫什么。`/list all` 列全部。
- **每个会话带一个短 id**。同一工作区的会话共享工作区名，光看名字分不清；短 id 也能直接回给 `/switch`。
- **切换由通道直接告知结果**（成功与失败都发），不依赖 agent 转述——切换后 agent 的话会发往已离开的会话，到不了手上。
- **可切换到任何工作区的会话**。数字按用户看到的那份列表编号，题目与短 id 在所有工作区里搜；采纳时用**那个会话自己的工作区**（DSH 固定 `cwd`）。

## 状态文件

默认 `$DSH_HOME/wechat/state.json`（0600，原子写），含：

- `accounts` —— bot token、baseUrl、绑定的微信用户
- `syncBufs` —— 长轮询增量游标，保证进程重启不丢消息
- `contextTokens` —— **按会话**存的回复令牌，多对话下不会串台
- `bindings` —— 微信对话 ↔ DSH session 映射
- `autoStart` —— 是否开机自动重连

## 协议依据

**所有 iLink 协议细节都以腾讯官方实现为准，不要靠猜：**

| 内容 | 来源 |
|---|---|
| 类型定义 | [`src/api/types.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/api/types.ts) |
| 出站条目构造 | [`src/messaging/send.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/messaging/send.ts) |
| 出站上传流程 | [`src/cdn/upload.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/cdn/upload.ts) |
| 入站下载与解密 | [`src/media/media-download.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/media/media-download.ts) |
| CDN URL 构造 | [`src/cdn/cdn-url.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/cdn/cdn-url.ts) |

三条最容易踩的坑（都已按官方对齐）：

1. **`media.aes_key` = base64(hex 文本)**，不是 base64(原始 16 字节)。发错形态时服务照收、手机显示灰框。
2. **媒体引用取上传响应的 `x-encrypted-param` 头**；`upload_full_url` 里的长参数是上传授权，拿去读会被 403 拒。
3. **条目不要多发字段**：官方图片条目只有 `media` + `mid_size`，文件条目只有 `media` + `file_name` + `len`。

**代价**：出站图片花了 6 轮才修好，全部原因都是在没有参照物的情况下猜协议。找到官方源码后一次就对了。
