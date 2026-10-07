# dsh-wechat-plugin

[![CI](https://github.com/xcisxc29/dsh-wechat/actions/workflows/ci.yml/badge.svg)](https://github.com/xcisxc29/dsh-wechat/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-wechat-plugin.svg)](https://www.npmjs.com/package/dsh-wechat-plugin)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

用微信遥控 DeepSeek Harness：手机上聊天，电脑上的 DSH 干活。

不需要安装 OpenClaw，也不需要公网 IP。

[English](README.md)

## 功能

- **文字双向**：微信消息变成 DSH 提示词，回复发回微信
- **图片、文件、语音、视频**：双向。收到的附件落盘到会话工作区并交给 agent；agent 也能用 `send_to_wechat` 把本机文件发给你
- **一个微信对话，多个 DSH 会话**：`/new` `/list` `/switch` `/current` `/cancel`，或者直接说「换个对话」
- **手机上回答权限与提问**：权限申请和多选提问会发到微信，回一个数字即可。不在电脑旁也不会被卡住
- **设置页**：DSH 的 **设置 → 微信**

## 安装

DSH 需要工作区与工具服务（桌面端的标准组合）。

侧栏点**插件**，选**添加插件**。这个输入框接受包名、Git 地址、压缩包或本地路径。

> ### 要装的名字是 `dsh-wechat-plugin`
>
> **仓库**叫 `dsh-wechat`，但**包名不是**：请**复制 `dsh-wechat-plugin`**，别手打，注意后面那个 `-plugin`。
>
> npm 上另有一位作者的插件就叫 `dsh-wechat`，装那个名字得到的是别人的作品，不是这个。

<details open>
<summary><b>从 npm 装</b> —— 不需要额外配置</summary>

```
dsh-wechat-plugin
```

需要指定版本就带上：`dsh-wechat-plugin@0.35.1`。
</details>

<details>
<summary><b>从 GitHub 装</b> —— 仓库自行构建，适合跟分支或固定提交</summary>

```
https://github.com/xcisxc29/dsh-wechat
```

DSH 会克隆仓库并在本地构建。**pnpm 会拦一次构建、要求你放行**——这是正常的，任何 Git 安装的插件都会这样。DSH 会告诉你该加哪个键，形如这样，写在 `~/.dsh/profiles/desktop/pnpm-workspace.yaml` 里：

```yaml
allowBuilds:
  dsh-wechat-workspace@git+file:///…/dsh-wechat#<commit>: true
```

**大多数人不需要这个。** 想固定到某个提交、跟某个分支，或者连不上 npm 时再用。
</details>

等安装完成，点**立即启用**，然后重启 DSH。

<details>
<summary>也可以从终端装</summary>

图形界面底层是 pnpm，所以同一件事也可以这样：

```bash
dsh plugin --profile desktop add dsh-wechat-plugin
dsh plugin --profile desktop add https://github.com/xcisxc29/dsh-wechat
```

此时要自己确认组合包已启用（**立即启用**做的就是这件事）——在 `~/.dsh/profiles/desktop/package.json` 里：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-wechat-plugin"
      ]
    }
  }
}
```
</details>

<details>
<summary>用本地打好的包装</summary>

```bash
pnpm install && pnpm run dist && pnpm run pack
# 产出 dsh-wechat-plugin-<version>.tgz
```

把这个 `.tgz` 的绝对路径粘进**添加插件**，或者交给命令行：

```bash
dsh plugin --profile desktop add /绝对路径/dsh-wechat-plugin-<version>.tgz
```
</details>

### 开始用

重启 DSH 后打开 **设置 → 微信**，点**重新扫码**，用手机微信扫出现的二维码并确认。之后在微信里发 `你好`，应该收到回复。

### 可选：语音转文字

微信语音是 SILK 格式。装了这个编解码器就能在本地转成 WAV：

```bash
dsh plugin --profile desktop add silk-wasm
```

不装也能用：原始 SILK 会落盘，连同服务端转写一起交给 agent。

## 用法

直接发消息就行，会送到 agent：

```
你好
```

下面这些指令用来控制你在跟哪个 DSH 对话讲话：

| 指令 | 作用 |
|---|---|
| `/new` | 开一个新对话。**后面跟的字会成为标题**：`/new 修复登录` 就是开一个叫「修复登录」的对话。不跟字的话，标题取自你的第一条消息 |
| `/list` | 列出微信工作区的对话，新的在前 |
| `/list all` | 列出全部，含其它工作区 |
| `/switch 3` | 切到那份列表里的第 3 个 |
| `/current` | 当前在哪个对话 |
| `/cancel` | 中断正在跑的任务 |
| `/help` | 这份列表 |

**空格可以省**：`/switch3`、`/switch 3`、`/switch:3` 都一样。

**说大白话也行**：「换个对话」「看下有哪些对话」「停一下」都认。判断意图的是 agent，不是死规则，并且切换成功或失败都会明确告诉你。

## 开始之前请读

**任何能给这个机器人发微信的人，都能驱动这台电脑。** agent 可以执行命令、读写文件，而唯一的凭据就是微信消息本身。

**微信来的对话默认是「完全访问」，agent 不会先问你。** 这是有意的：权限询问会发到微信，然后任务就停在那里等你回答——在手机上，等于每条命令都卡在一段你已经离开的对话里。想恢复和桌面端一样的把关，把设置页的**微信对话的权限**改成「跟随 DSH 设置」。

**这台电脑上任何会话都能主动推送到你微信（默认开启）。** 「做完了告诉我」靠的就是它：干活的会话通常不是微信绑定的那个，没有这个能力它就没法汇报自己的结果。关掉**允许其他会话推送到微信**即可恢复更严的规则——只有绑定会话能发。

所以**机器人的微信号和能加到它的好友列表，就是安全边界**。这里**刻意不做白名单，也没有这个计划**：选择用微信遥控电脑，本身就已经接受了"能给它发消息 = 能操作这台电脑"，在同一个决定前面再加一道门没有意义。如果这不是你想要的边界，就不要装它。

一句话对比：**能给你机器人发消息 = 能操作你的电脑，而且不会问你。**

## 文档

| | |
|---|---|
| [docs/HANDBOOK-USER.md](docs/HANDBOOK-USER.md) | **使用手册**：从安装到排错，不需要技术背景 |
| [docs/HANDBOOK-DEV.md](docs/HANDBOOK-DEV.md) | **开发手册**：开发历程、版本迭代、怎么继续改 |
| [SETTINGS.md](SETTINGS.md) | 每条设置的实际作用 |
| [docs/INTERNALS.md](docs/INTERNALS.md) | 协议依据、架构、两个包的区别 |
| [docs/PROGRESS.md](docs/PROGRESS.md) | 各档功能的完成情况与验证方式 |
| [docs/POSTMORTEM.md](docs/POSTMORTEM.md) | 开发中踩过的坑与根因 |
| [docs/RELEASING.md](docs/RELEASING.md) | 怎么发一个版本 |
| [examples/](examples) | 只用 `core` 的完整例子：回声机器人、主动发文件 |

## 开发

```bash
pnpm install
pnpm build              # 只编译，保留 @dsh-wechat/core 引用（pack 要靠它改写）
pnpm run dist           # build + 内嵌 core，产出可直接加载的形态
pnpm typecheck
pnpm test               # 192 项
pnpm check              # build + typecheck + test
pnpm run pack           # 需要先 dist
pnpm run verify-pack    # 解包、校验清单文件、按 DSH 的方式挂载一次
```

**改完 `core` 要重新 `pnpm build`。** 测试通过 `node_modules` 解析到 `lib/`，源码改了没重建时跑的是旧代码，**通过也不作数**。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
