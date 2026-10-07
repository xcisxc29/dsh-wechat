#!/usr/bin/env node
/**
 * Pack `dsh-wechat` into a single installable tarball.
 *
 * The bundle has to be self-contained. DSH's loader resolves plugin names from the
 * profile root, so sub-packages nested under this package's own `node_modules` are
 * invisible to it. Everything therefore ships inside one package and is reached
 * through the export map.
 *
 * Two workspace-only things are rewritten on the way out:
 *
 *   - `@dsh-wechat/core` is built and copied into `dist/core/`, and the dependency
 *     is dropped, because `workspace:*` means nothing to a plain `npm install`.
 *     The built `lib/` is used rather than the sources: Node refuses to strip
 *     TypeScript types for files under `node_modules`, so an installed bundle must
 *     ship JavaScript.
 *   - `@deepseek-ai/dsh-home-paths` stays a peer dependency: the host provides it,
 *     and an installed bundle must never pin a second copy of a host package.
 *
 * Usage:
 *   node scripts/pack.mjs            # writes dsh-wechat-<version>.tgz in the repo root
 *   node scripts/pack.mjs --out DIR  # write somewhere else
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const bundleDir = join(repoRoot, 'packages', 'bundle')
const coreDir = join(repoRoot, 'packages', 'core')

// The bundle imports the core package by name, so both built halves must exist: the
// core for the vendored copy, and the bundle's own `lib/` for the shippable entry.
const coreEntry = join(coreDir, 'lib', 'index.js')
if (!existsSync(coreEntry)) {
  console.error(`缺少核心构建产物: ${coreEntry}`)
  console.error('请先运行: pnpm build')
  process.exit(1)
}
if (!existsSync(join(bundleDir, 'lib', 'host.js'))) {
  console.error('缺少宿主构建产物: packages/bundle/lib/host.js')
  console.error('请先运行: pnpm build')
  process.exit(1)
}

const outIndex = process.argv.indexOf('--out')
const outDir = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : repoRoot

const manifest = JSON.parse(await readFile(join(bundleDir, 'package.json'), 'utf8'))
const stage = await mkdtemp(join(tmpdir(), 'dsh-wechat-pack-'))
const pkgDir = join(stage, 'package')

try {
  // Host half, built. It must be JavaScript: Node refuses to strip TypeScript types
  // for files under `node_modules`, so a shipped `.ts` entry cannot load at all.
  const libOut = join(pkgDir, 'lib')
  await mkdir(libOut, { recursive: true })
  for (const entry of await readdir(join(bundleDir, 'lib'))) {
    // Source maps point at paths that do not ship; skip them to keep the tarball lean.
    if (entry.endsWith('.map')) continue
    await cp(join(bundleDir, 'lib', entry), join(libOut, entry))
  }
  await cp(join(bundleDir, 'cordis.patch.yml'), join(pkgDir, 'cordis.patch.yml'))

  // The browser half. Listed as `./client` in the export map and declared through
  // `dsh.client`, so leaving it out silently ships a bundle with no settings page.
  await cp(join(bundleDir, 'client.js'), join(pkgDir, 'client.js'))

  // Core client, vendored as built JavaScript so the tarball has no workspace
  // dependencies and needs no type stripping at load time.
  const coreOut = join(pkgDir, 'dist', 'core')
  await mkdir(coreOut, { recursive: true })
  await cp(join(coreDir, 'lib'), join(coreOut, 'lib'), { recursive: true })

  // Point every `@dsh-wechat/core` import at the vendored copy. The built host half
  // is what actually runs, so the rewrite has to happen there.
  const rewritten = []
  for (const entry of await readdir(libOut)) {
    if (!entry.endsWith('.js')) continue
    const file = join(libOut, entry)
    const text = await readFile(file, 'utf8')
    if (!text.includes("'@dsh-wechat/core'")) continue
    await writeFile(file, text.replaceAll("'@dsh-wechat/core'", "'../dist/core/lib/index.js'"))
    rewritten.push(entry)
  }
  if (rewritten.length === 0) {
    throw new Error('打包未重写任何 @dsh-wechat/core 引用：宿主产物可能不是预期的形态')
  }
  for (const required of ['lib/host.js', 'client.js', 'cordis.patch.yml', 'dist/core/lib/index.js']) {
    if (!existsSync(join(pkgDir, required))) {
      throw new Error(`打包缺少必需文件: ${required}`)
    }
  }

  // A packed bundle carries no devDependencies and no workspace protocols.
  delete manifest.scripts
  delete manifest.devDependencies
  // `@dsh-wechat/core` is vendored into `dist/core`, so its workspace protocol is
  // dropped — but the remaining runtime dependencies must survive. Deleting the
  // whole object here would silently ship a bundle that cannot `import 'qrcode'`.
  delete manifest.dependencies['@dsh-wechat/core']
  if (Object.keys(manifest.dependencies).length === 0) {
    throw new Error('打包后没有任何运行时依赖：检查是否误删了 dependencies')
  }
  // The vendored core lands in `dist/core`, so it must be in the file list. Leaving
  // it out makes `npm pack` silently drop the directory the rewritten imports point at.
  manifest.files = [...new Set([...(manifest.files ?? []), 'src', 'dist', 'client.js', 'cordis.patch.yml'])]
  await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  await mkdir(outDir, { recursive: true })
  // Keep npm's cache inside the staging directory. A confined build environment may
  // deny writes to the machine-wide npm cache, and the cache is irrelevant here.
  const packed = spawnSync('npm', ['pack', '--pack-destination', outDir], {
    cwd: pkgDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_cache: join(stage, 'npm-cache') },
  })
  if (packed.status !== 0) throw new Error(`npm pack exited with ${packed.status}`)

  const produced = (await readdir(outDir))
    .filter((name) => name.startsWith(`${manifest.name}-`) && name.endsWith('.tgz'))
    .sort()
    .at(-1)
  if (produced === undefined) throw new Error('npm pack produced no tarball')
  const size = (await stat(join(outDir, produced))).size

  console.log(`\n打包完成: ${join(outDir, produced)}`)
  console.log(`  大小        : ${(size / 1024).toFixed(1)} KiB`)
  console.log(`  重写 import : ${rewritten.join(', ') || '(无)'}`)
  console.log(`  dependencies: ${Object.keys(manifest.dependencies ?? {}).join(', ') || '(无)'}`)
  console.log(`\n安装到某个 DSH profile:`)
  console.log(`  cd <profile 目录> && pnpm add <上面的 tgz 路径>`)
} finally {
  await rm(stage, { recursive: true, force: true })
}
