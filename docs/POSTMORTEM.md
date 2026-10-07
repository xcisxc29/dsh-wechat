# 事故档案（Postmortem）

**这不是安装说明** —— 安装看 [README](../README.md)。

这里记录开发过程中**真实踩过的坑**与各自根因。留着的理由很实际：其中几类失败**没有任何报错线索**——插件激活失败只报 `<id>: failed`，流字段名猜错则静默丢弃回复。下次再遇到，这里的路径和判断能省掉几个小时。

## 每次插件让 DSH 起不来时，先看这里

日志会直接给出答案，不用猜：

| 内容 | 路径 |
|---|---|
| **插件自己的失败原因**（含完整堆栈） | `~/.dsh/wechat/boot.log` 里的 `apply: FAILED:` |
| 桌面壳崩溃报告（含渲染进程**错误级** console 尾部） | `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log` |
| 官方插件规范与模板 | `app.asar` 内 `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/` |
| 客户端模块系统说明 | `@deepseek-ai/dsh-client-modules/README.md` |

桌面壳**只采集 error 级 console**（`main.js`：`if (details.level !== "error") return`），所以非 error 级的失败不会进报告。

## 三、工具 schema 用错形态，导致 apply 抛错、应用无法启动（0.2.4 修复）

**现象**：重启后桌面端「暂时无法连接到」。

**根因**：`tools.register()` 抛 `JsonSchemaError`，异常从 `apply` 冒出去，插件激活失败 → 桌面端拒绝启动。

```
apply: FAILED: JsonSchemaError: unsupported JSON schema:
  schema.properties.detail.required is not supported on type "string"
```

**触发原因**：我把 `required` 写在**属性内部**：

```js
// 错：这是 defineTool 的「输入规格」形态
properties: { detail: { type: 'string', required: true } }

// 对：注册表要的是标准 JSON Schema，required 是父级数组
properties: { detail: { type: 'string' } },
required: ['detail'],
```

**为什么会犯**：`@deepseek-ai/dsh-tools` 里 `defineTool(spec)` 负责把规格转成 JSON Schema，而注册表要的是**转换后**的形态。我照抄了 `defineTool` 的调用代码，却跳过了那次转换。又因为 `defineTool` 在应用内部、profile 插件解析不到，我改成手写 schema——于是把输入形态写进了输出位置。

**校验规则**（`checkSchemaNode`，关键字子集 `type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解）：

- `required` 必须是**字符串数组**，且每个名字都要在 `properties` 里
- `properties` / `required` / `additionalProperties` **只能**出现在 `type: 'object'` 上
- `items` 只能出现在 `type: 'array'` 上
- 不能同时声明 `type` 和 `oneOf`

**这次的防护**：`plugin.test.ts` 里的 `assertSupportedSchema()` 复刻了上述规则，并断言注册的工具两个 schema 都合规。**已用错误形态反向验证过**——它会精确报出 `output.schema.properties.detail.required is not supported on type "string"`，也就是应用里那句错。

## 一、启动失败事故（已解决）

**现象**：桌面壳弹出「应用无法启动或已意外停止」：

```
web boot: 1 entry did not activate
dsh-wechat: failed
```

**根因**：`client.js` 的插件导出写的是 `const inject = []`，而它**要用 `ctx.slots`**。

Cordis 的语义是：**插件必须等到 `inject` 列出的服务全部可用才激活**。不声明 `slots`，插件就在 `slots` 注册表还不存在时被激活，`ctx.slots` 是 `undefined`，`ctx.slots.inject(...)` 抛错 → fiber 变 `failed` → 桌面端 web boot 审计判定条目未激活 → **拒绝启动整个应用**。

审计只报 `<id>: failed`，**从不告诉你缺哪个服务**——这是它极难查的原因。官方模板（`templates/decoration/client.js`）写的正是 `return { inject: ['slots'], apply(ctx) {...} }`，这个 `inject` 是**必需声明**，不是可选装饰。

### 前几轮为什么修错

| 改动 | 实际作用 |
|---|---|
| 加 `immediately: true` | **只做 prefetch**（预取脚本、注册工厂），**不物化模块**。源码：`plugins.filter(e => e.immediately).map(e => modules.prefetch(e.id))`，错误还被 `.catch(() => {})` 吞掉 |
| 改 factory 直接返回 exports | 更规范，但不是根因 |
| 去掉顶层 `try/catch` | 消除隐患，也不是根因 |

**教训**：遇到"条目 failed 但无任何线索"时，先核对 `inject`——它是激活前置条件。

## 二、第一阶段成果（0.1.5）

链路已打通：**扫码绑定 → 长轮询收消息 → 建会话 → 交给 agent**。本轮修掉两个问题。

### 问题 1：手机收不到回复

**根因**：`readStreamFrame` 解析的字段名是**猜的**（`frame.text` / `frame.delta`），而真实的 `agent/assistant-stream` 帧结构是：

```js
{ type: 'start' | 'chunk' | 'end', revision, attemptId, turn, step }
// chunk 帧：{ type: 'chunk', chunk: <模型块> }
// 模型块的 type: 'text-delta' | 'reasoning-delta' | 'tool-call-delta'
//              | 'block-start' | 'block-end' | 'usage' | 'finish'
```

文本在 **`frame.chunk.text`**（且仅当 `chunk.type === 'text-delta'`）。字段名对不上 → 回复被**静默丢弃**，任何地方都不会报错。

**修复**：按真实结构解析。同时：
- **`reasoning-delta` 明确排除**——那是模型的私有草稿，泄漏出去等于暴露内部推理
- `block-end` / `finish` / `end` 视为**回合结束**，立即发送，不再干等 1.2 秒静默窗口
- 纯工具调用的回合**不发空消息**

### 问题 2：会话显示在「未分组」

**根因**：桌面端按 **Workspace（工作区）**分组，只给 `cwd` 的会话会落进内置的「未分组」桶，而那个桶**无法命名**。而且 `sessionController.create` **不接受同时传 `workspaceId` 和 `cwd`**：

```js
if (request.workspaceId !== void 0 && request.cwd !== void 0)
  throw new RemoteError("gateway/bad-request", "session.create accepts workspaceId or cwd, not both")
```

**修复**：注册一个真实工作区（目录仍是 `$DSH_HOME/dsh_wechat`），标题设为 **「微信会话」**，并改用 `workspaceId` 建会话。`resolveByPath` 保证重启后复用同一个 id，会话不会失去归属。

## 三、关键位置（下次不必再猜）

| 内容 | 路径 |
|---|---|
| 桌面壳崩溃报告（含渲染进程**错误级** console 尾部） | `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log` |
| 插件自身日志（宿主侧） | `~/.dsh/wechat/boot.log` |
| 官方插件规范与模板 | `app.asar` 内 `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/` |
| 客户端模块系统说明 | `@deepseek-ai/dsh-client-modules/README.md` |

桌面壳**只采集 error 级 console**（`main.js`：`if (details.level !== "error") return`），所以非 error 级的失败原因不会进报告。

## 四、测试覆盖

早期只有 56 项时，套件**全绿却漏掉了"帧 → 微信回复"整条路径**——流字段名是猜的，回复被静默丢弃，没有任何测试拦住。

**那一课的直接产物**是回程测试与"测试必须能失败"的纪律：此后每修一个缺陷，都先验证新测试在**还原修复后确实变红**。

当前为 **171 项**，分布见 `README`。

## 五、这一路还踩过的坑

| 坑 | 教训 |
|---|---|
| **改完 `core` 忘记重建 `lib/`** | 测试通过 `node_modules` 解析到构建产物，源码改了没重建时，**跑的是旧代码，通过也不作数** |
| **打包前删掉所有 `.tgz`** | profile 的 `package.json` 引用着旧包，删掉它 pnpm 直接解析失败。`pack.mjs` 自己会清理，不该再手动删 |
| **误读工具退出码** | 插件往 stderr 打日志，PowerShell 把它当错误，`[exit code: 1]` 是假的。**重定向到文件再读**才是真的 |
| **用 `String.Replace` 改源码** | 曾把两行合并、切断一个测试，而它**仍然通过**。源码改动一律用编辑工具 |
| **`files` 不写文档** | npm 只按 `files` 打包，**不为目录里的 README 破例**——补了复制逻辑但没进 `files`，包里依然没有 |
| **非交互环境 `pnpm test` 中止** | pnpm 认为依赖过期就清空重装，但无 TTY 时拒绝执行，`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` |

## 六、历史盲区（多已解决）

| 项 | 现状 |
|---|---|
| 旧会话无法自动迁入「微信会话」 | 仍需重建 |
| 媒体入站下载返回 HTTP 400 | **已解决**（根因是 `media.aes_key` 编码，见 README「协议依据」） |
| 设置页外观只有装上去才知道 | **已解决**：用真实设计令牌渲染截图并比对 |
| 点「重新扫码」触发重新绑定 | 属服务端设计（见 README「绑定是排他的」） |
