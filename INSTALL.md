# 安装记录与事故档案

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

## 四、测试覆盖（56 项）

| 套件 | 数量 | 覆盖 |
|---|---|---|
| core | 24 | 协议、解析、加密、状态 |
| media | 9 | 上传、密钥编码 |
| plugin | 15 | 挂载、路由、指令、持久化、**回程（帧→回复）**、**工作区分组** |
| client | 8 | 加载、注册、`inject`、渲染、清理 |

**新增的回程测试是这次事故的直接产物**：此前套件全绿却漏掉了"帧 → 微信回复"这条路径，所以字段名猜错没被任何测试拦住。

## 五、重启后验证

1. **设置 → 微信** → 「重新扫码」→ 出现**二维码图片** → 手机扫码确认 → 「已连接微信」
2. **重启 DSH**（验证 `autoStart` 的"开机即用"）
3. 微信里发 `你好` → **手机应收到回复**
4. 发 `/new wechat` → 电脑端出现新会话，应归入 **「微信会话」** 文件夹

⚠️ **已有的旧会话不会自动搬家**：它当初是用 `cwd` 建的，仍留在「未分组」。用 `/new` 建的新会话才会进「微信会话」。

## 六、已知盲区

- 旧会话无法自动迁入「微信会话」（需要重建）。
- 设置页**外观**只有装上去看才知道。
- 媒体**入站**下载返回 HTTP 400（上传正常），尚未定位——属第二阶段。
- 点「重新扫码」会触发**重新绑定**（新状态文件没有旧 token，会签发新身份）。
