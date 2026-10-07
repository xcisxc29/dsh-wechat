# 发布流程

面向维护者。用户安装看 [README](../README.md)。

## 一次版本发布

```bash
# 1. 改版本号（这是唯一需要手改的地方）
#    packages/bundle/package.json -> version
#    顺便把 README 里的测试数量、进度段落同步一下

# 2. 本地先过一遍 CI 的全部步骤
pnpm check          # build + typecheck + test
pnpm run pack
pnpm run verify-pack

# 3. 提交并打 tag
git add -A && git commit -m "0.33.0：<改了什么>"
git tag v0.33.0
git push origin main --tags
```

推 tag 会触发 `.github/workflows/publish.yml`：它先跑一遍完整校验，**核对 tag 与 manifest 版本一致**，然后发布**那个已经验证过的 tarball**（不是重新打一次包），带 `--provenance` 签名。

## 认证方式：OIDC，不用 token

工作流**不含任何密钥**。它用 GitHub 签发的 OIDC 身份向 npm 证明"我确实是这个仓库的这条工作流"，npm 拿它跟包上配置的 **Trusted Publisher** 核对。

**这是一次性配置**，在 npmjs.com 上：

```
包页面 → Settings → Trusted Publisher → GitHub Actions
```

四个字段**逐字匹配**，填错的表现只是发布时 403：

| 字段 | 值 |
|---|---|
| Organization or user | `xcisxc29` |
| Repository | `dsh-wechat` |
| Workflow filename | **`publish.yml`** ← 是文件名，不是路径 |
| Environment | **留空**（本工作流没有 environment） |

**为什么不用 token**（这段是历史，别再走回去）：

npm 在 2025-12 吊销了**全部经典 token**；替代它们的 granular token 带的"绕过 2FA"能力正在被限制——包页面顶部的横幅写着 direct publishing 到 **2027-01** 就不允许了。**Trusted Publisher 是 npm 自己推荐的替代方案**，而且更彻底：**没有密钥可以泄漏、轮换或过期**。

> 所以：**不需要创建任何 secret。** 如果你看到旧文档说要配 `NPM_TOKEN`，那是过期信息。

## 其他前提

| 项 | 位置 | 说明 |
|---|---|---|
| 仓库为 public | 仓库 Settings | `--provenance` 需要公开仓库才能生成可信签名 |
| `id-token: write` | 已在工作流里 | OIDC 握手用；删了它发布必然失败 |

**先干跑一次**：Actions → Publish → Run workflow，`dry-run` 默认 true，会把所有校验跑一遍但不发布。

## 为什么发布这件事要单独一条流程

**npm 的版本号不可复用。** 发错了可以 deprecate，但那个版本号永远回不来——所以这里用 tag 而不是合并来触发，且发布前把 CI 全套再跑一遍。发一个没验证过的产物，等于把一个坏版本永久留在 registry 上。

## 版本号该改哪里

只有 `packages/bundle/package.json` 的 `version` 是权威。其余地方（README、CI）都从它读或与它无关。

> **不要**在根 `package.json` 上加 `version`。它是 private workspace，而 `pnpm pack` 会因此去命中 pnpm 自己的内置命令并报 `ERR_PNPM_PACKAGE_VERSION_NOT_FOUND`——本仓库的脚本一律写 `pnpm run pack` 就是为了避开这个。

## 出问题怎么查

| 现象 | 原因 |
|---|---|
| 发布时 **403**，且信息提到 trusted publisher | npm 那四个字段有拼写不符（最常见：把 workflow 写成路径 `.github/workflows/publish.yml`） |
| 发布时 403，且提到 2FA | Trusted Publisher 没配上，npm 退回到了"要求 2FA"的老路径 |
| `ERR_PNPM_PACKAGE_VERSION_NOT_FOUND` | 用了 `pnpm pack` 而不是 `pnpm run pack` |
| provenance 报错 | 仓库是 private，或 workflow 缺 `id-token: write` |
| 发布后 npm 页面还是旧版本，且注册表报 404 | **首次发布新版本要人工审核**，几分钟后自动上线。`npm view <包> versions` 里没出现就是还在审 |
| tag 与版本不一致 | 忘了改 `packages/bundle/package.json` 的 `version` |
| 发布成功但用户装不了 | 少了 `files` 条目——`pnpm run verify-pack` 会在本地就拦住 |
| 用户装到旧版本 | profile 的 `package.json` 里**锁了精确版本**。写 `^x.y.z` 才会跟着升 |
