#!/usr/bin/env node
/**
 * Verify a packed tarball the way an install would see it.
 *
 * `npm pack` reporting success proves nothing: a missing `files` entry silently
 * drops the directory a rewritten import points at, and the failure only appears
 * when the host loads the plugin. This script extracts the tarball, gives it a
 * resolvable `qrcode`, imports the entry point, and mounts the plugin against a stub
 * host — which is exactly what DSH does at startup.
 *
 * Usage:
 *   node scripts/verify-pack.mjs [tarball]
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const explicit = process.argv[2]
const bundleManifest = JSON.parse(
  await (await import('node:fs/promises')).readFile(join(repoRoot, 'packages/bundle/package.json'), 'utf8'),
)
/*
 * Derived from the manifest rather than written here.
 *
 * The package was renamed once already (`dsh-wechat` was taken on npm by an unrelated plugin of the
 * same purpose), and a hardcoded name here would have gone on checking the old tarball while
 * reporting success.
 */
const tarball =
  explicit ??
  (await readdir(repoRoot))
    .filter((name) => name.startsWith(`${bundleManifest.name}-`) && name.endsWith('.tgz'))
    .sort()
    .at(-1)

if (tarball === undefined) {
  console.error('找不到 tarball，请先运行: node scripts/pack.mjs')
  process.exit(1)
}

const archive = resolve(repoRoot, tarball)
const verifyRoot = join(repoRoot, '.verify')
await rm(verifyRoot, { recursive: true, force: true })
await mkdir(verifyRoot, { recursive: true })

// Extract with tar, which every supported platform has.
const extracted = spawnSync('tar', ['-xzf', archive, '-C', verifyRoot], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (extracted.status !== 0) {
  console.error('解包失败')
  process.exit(1)
}

const pkgDir = join(verifyRoot, 'package')
const manifest = JSON.parse(
  await (await import('node:fs/promises')).readFile(join(pkgDir, 'package.json'), 'utf8'),
)
console.log(`包名    : ${manifest.name}@${manifest.version}`)
console.log(`入口    : ${manifest.exports['.']}`)

// Every artifact the manifest advertises must actually be in the tarball. A missing
// `files` entry or a pack step that forgets to copy something produces a package
// that installs cleanly and then fails at load time, so assert it here.
const entryExport = manifest.exports['.']
const entryRelative = typeof entryExport === 'string' ? entryExport : entryExport.default
const advertised = [entryRelative, manifest.exports['./client'], manifest.exports['./cordis.patch.yml']]
const missing = advertised.filter((relative) => !existsSync(join(pkgDir, relative)))
if (missing.length > 0) {
  console.error(`❌ 打包产物缺少清单声明的文件: ${missing.join(', ')}`)
  process.exit(1)
}
console.log(`产物齐全: ${advertised.join(', ')}`)

// The entry must be JavaScript. Node refuses to strip TypeScript types for files
// under `node_modules`, so shipping a `.ts` entry yields a package that installs and
// then fails on the very first import.
if (!entryRelative.endsWith('.js')) {
  console.error(`❌ 入口不是 JavaScript: ${entryRelative}（node_modules 下无法剥离类型）`)
  process.exit(1)
}

/*
 * Give the extracted package the runtime dependencies an install would give it.
 *
 * Resolved with Node's own resolver from an anchor that can see them, rather than by copying the
 * workspace root's `node_modules`. That root does not necessarily hold anything: pnpm's hoisted
 * layout puts a workspace package's dependencies under that package, so `qrcode` lives in
 * `packages/core/node_modules` — and asking the root for it made this check fail with "run pnpm
 * install" on a fully installed tree.
 *
 * Only the packages actually reachable from the dependency are copied, which is what npm would
 * install: the lockfile has no say in the tarball's shape, so everything the bundle imports at runtime
 * has to be present and resolvable by name.
 */
const anchor = join(repoRoot, 'packages', 'core', 'package.json')
const copied = new Set()

/**
 * Copy one package and everything it depends on into the extracted bundle.
 *
 * @param specifier - Package name to place.
 * @param from - Directory to resolve it from, so nested dependencies are found where they live.
 */
async function place(specifier, from) {
  const resolve = createRequire(join(from, 'package.json'))
  const manifestPath = resolve.resolve(`${specifier}/package.json`)
  const source = dirname(manifestPath)
  const name = JSON.parse(await readFile(manifestPath, 'utf8')).name ?? specifier
  if (copied.has(name)) return
  copied.add(name)

  await cp(source, join(pkgDir, 'node_modules', name), { recursive: true })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await place(dependency, source)
  }
}

const runtimeDependencies = Object.keys(manifest.dependencies ?? {})
if (runtimeDependencies.length === 0) {
  console.error('清单没有运行时依赖：打包步骤可能误删了 dependencies')
  process.exit(1)
}
await mkdir(join(pkgDir, 'node_modules'), { recursive: true })
for (const dependency of runtimeDependencies) {
  await place(dependency, dirname(anchor))
}
console.log(`已就位依赖: ${[...copied].sort().join(', ')}`)

const entry = pathToFileURL(join(pkgDir, manifest.exports['.'].default ?? manifest.exports['.'])).href
const plugin = await import(entry)

const problems = []
if (typeof plugin.apply !== 'function') problems.push('缺少 apply 导出')
if (typeof plugin.name !== 'string') problems.push('缺少 name 导出')
if (!Array.isArray(plugin.inject)) problems.push('缺少 inject 导出')
if (problems.length > 0) {
  console.error(`导出检查失败: ${problems.join('; ')}`)
  process.exit(1)
}
console.log(`插件名  : ${plugin.name}`)
console.log(`依赖服务: ${plugin.inject.join(', ')}`)

// Mount against a stub host built from the documented service shapes.
const stateFile = join(verifyRoot, 'state.json')
const calls = []
const ctx = {
  sessionController: {
    create: async (request) => {
      calls.push(`create:${request.sessionId}`)
      return { sessionId: request.sessionId }
    },
    prompt: async (request) => {
      calls.push(`prompt:${request.sessionId}`)
      return { accepted: true }
    },
    list: async () => [],
    cancel: async () => ({}),
  },
  sessions: { get: () => undefined },
  effect(execute) {
    this._dispose = execute()
  },
  get: (name) => (name === 'webServer' ? { port: 0, register: () => () => {} } : undefined),
  provide: (name, value) => {
    if (name === 'wechatChannel') ctx._runtime = value
  },
  on: (event) => {
    calls.push(`on:${event}`)
    return () => {}
  },
}

plugin.apply(ctx, { stateFile, autoStart: false })
if (ctx._runtime === undefined) {
  console.error('apply 没有提供 wechatChannel 服务')
  process.exit(1)
}

const status = await ctx._runtime.status()
console.log(`挂载成功: enabled=${status.enabled} accounts=${status.accounts.length} needsLogin=${status.needsLogin}`)
console.log(`注册的宿主事件: ${calls.filter((call) => call.startsWith('on:')).join(', ')}`)

// The login state must be reachable, which is what the settings page polls.
const loginState = ctx._runtime.loginState()
console.log(`登录状态接口: phase=${loginState.phase}`)

const size = (await stat(archive)).size
console.log(`\n✅ 打包产物可加载、可挂载。tarball ${(size / 1024).toFixed(1)} KiB`)

await rm(verifyRoot, { recursive: true, force: true })
