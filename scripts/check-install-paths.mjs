#!/usr/bin/env node
/**
 * Check the invariants that keep both install paths working.
 *
 * Two ways to install exist, and each depends on something that is easy to break without noticing:
 *
 *   - npm: `pack.mjs` rewrites `@dsh-wechat/core` into the vendored `dist/core`. It needs `build` to
 *     leave that import alone. Folding the inlining into `build` looks tidier and breaks packing with
 *     an exception about a rewrite that found nothing.
 *   - Git: pnpm installs the repository root, so the root manifest has to declare the entry points and
 *     the DSH identity, and `.npmignore` has to exist so the pack step does not fall back to
 *     `.gitignore` and discard the freshly built `lib/`.
 *
 * Every one of these has been broken during development, and each failure appears only on a user's
 * machine: a plugin that installs and then cannot be loaded. So they are asserted here, cheaply, on
 * every `pnpm run check`.
 *
 * Usage: `node scripts/check-install-paths.mjs`
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const problems = []
const check = (condition, message) => {
  if (!condition) problems.push(message)
}

const root = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
const bundle = JSON.parse(await readFile(join(repoRoot, 'packages', 'bundle', 'package.json'), 'utf8'))

// --- The npm path -------------------------------------------------------------------------------

// `pack.mjs` looks for this specifier. If the build already replaced it, packing throws.
const hostSource = await readFile(join(repoRoot, 'packages', 'bundle', 'src', 'host.ts'), 'utf8')
check(
  hostSource.includes("from '@dsh-wechat/core'"),
  'packages/bundle/src/host.ts 不再引用 @dsh-wechat/core：pack.mjs 的改写步骤会找不到目标',
)
check(
  bundle.dependencies?.['@dsh-wechat/core'] !== undefined,
  'packages/bundle/package.json 缺少 @dsh-wechat/core 依赖：构建与测试解析不到 core',
)
check(
  bundle.files?.includes('dist'),
  'packages/bundle/package.json 的 files 没有 dist：内嵌的 core 会被漏掉',
)
for (const doc of ['README.md', 'LICENSE']) {
  check(bundle.files?.includes(doc), `packages/bundle/package.json 的 files 没有 ${doc}：npm 页面会缺它`)
}

// --- The Git path -------------------------------------------------------------------------------

check(
  root.scripts?.prepare !== undefined,
  '根 package.json 没有 prepare 脚本：git 安装不会构建，装完没有入口',
)
check(
  (root.scripts?.prepare ?? '').includes('dist'),
  'prepare 没有走 pnpm run dist：git 装出来的产物仍会引用 @dsh-wechat/core',
)
check(
  (root.scripts?.build ?? '').includes('inline-core') === false,
  'build 里出现了 inline-core：pack.mjs 依赖未改写的引用，打包会失败',
)
check(
  (root.scripts?.dist ?? '').includes('inline-core'),
  'pnpm run dist 没有调用 inline-core：Git 安装会缺少内嵌步骤',
)

// A Git install resolves the plugin from the repository root, not from packages/bundle.
check(root.main === 'packages/bundle/lib/host.js', `根 main 应指向 bundle 产物，实际是 ${root.main}`)
check(
  root.exports?.['.']?.default === './packages/bundle/lib/host.js',
  '根 exports 没有把 "." 指向 bundle 产物：git 安装解析不到入口',
)
check(
  root.exports?.['./client'] === './packages/bundle/client.js',
  '根 exports 没有 "./client"：git 安装后设置页加载不了',
)
check(
  root.dsh?.bundle?.patch === './packages/bundle/cordis.patch.yml',
  '根 dsh.bundle.patch 没有指向 bundle 的 patch：git 安装后插件不会挂载',
)
check(
  root.dsh?.client?.immediately === true,
  '根 dsh.client.immediately 不是 true：桌面端启动审计会判定条目未激活',
)

// pnpm's pack step for a git dependency falls back to `.gitignore` when this file is absent, and
// `.gitignore` excludes `lib/` — so the build output would be discarded.
const npmignorePath = join(repoRoot, '.npmignore')
check(existsSync(npmignorePath), '缺少 .npmignore：git 安装时 pnpm 会沿用 .gitignore 并丢掉 lib/')
if (existsSync(npmignorePath)) {
  const ignore = await readFile(npmignorePath, 'utf8')
  const excluded = ignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  check(
    !excluded.some((line) => line === 'lib/' || line === 'packages/*/lib/'),
    '.npmignore 排除了 lib/：git 安装拿不到构建产物',
  )
}

if (problems.length > 0) {
  console.error('安装路径的约束被破坏：\n')
  for (const problem of problems) console.error(`  ✖ ${problem}`)
  console.error('\n两条安装路径（npm 与 Git）依赖这些约定，改动前请看 docs/INTERNALS.md。')
  process.exit(1)
}

console.log('✅ 两条安装路径的约束都成立（npm 打包改写 / Git 根入口与内嵌）')
