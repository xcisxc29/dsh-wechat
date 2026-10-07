# 发布流程

面向维护者。用户安装看 [README](README.md)。

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

## 首次发布前要配的

| 项 | 位置 | 说明 |
|---|---|---|
| **`NPM_TOKEN`** | GitHub 仓库 → Settings → Secrets and variables → Actions | **必须是 npm 的 Automation token**（npmjs.com → Access Tokens → Generate New Token → Automation）。经典 publish token 会失败，因为 CI 里没人能回答一次性验证码 |
| 仓库为 public | 仓库 Settings | `--provenance` 需要公开仓库才能生成可信签名 |

**先干跑一次**：Actions → Publish → Run workflow，`dry-run` 默认 true，会把所有校验跑一遍但不发布。

## 为什么发布这件事要单独一条流程

**npm 的版本号不可复用。** 发错了可以 deprecate，但那个版本号永远回不来——所以这里用 tag 而不是合并来触发，且发布前把 CI 全套再跑一遍。发一个没验证过的产物，等于把一个坏版本永久留在 registry 上。

## 版本号该改哪里

只有 `packages/bundle/package.json` 的 `version` 是权威。其余地方（README、CI）都从它读或与它无关。

> **不要**在根 `package.json` 上加 `version`。它是 private workspace，而 `pnpm pack` 会因此去命中 pnpm 自己的内置命令并报 `ERR_PNPM_PACKAGE_VERSION_NOT_FOUND`——本仓库的脚本一律写 `pnpm run pack` 就是为了避开这个。

## 出问题怎么查

| 现象 | 原因 |
|---|---|
| `ERR_PNPM_PACKAGE_VERSION_NOT_FOUND` | 用了 `pnpm pack` 而不是 `pnpm run pack` |
| `NPM_TOKEN is not set` | secret 没配，或名字不是 `NPM_TOKEN` |
| provenance 报错 | 仓库是 private，或 workflow 缺 `id-token: write` |
| tag 与版本不一致 | 忘了改 `packages/bundle/package.json` 的 `version` |
| 发布成功但用户装不了 | 少了 `files` 条目——`pnpm run verify-pack` 会在本地就拦住 |
