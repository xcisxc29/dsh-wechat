#!/usr/bin/env node
/**
 * Inline the workspace dependency into the built bundle, in place.
 *
 * `packages/bundle/src/host.ts` imports `@dsh-wechat/core`. That resolves through a workspace link
 * while developing, and `scripts/pack.mjs` rewrites it when producing the npm tarball — but a Git
 * install never runs `pack.mjs`. It clones the monorepo and runs `prepare`, and what it ends up with is
 * the raw build output: a bundle whose entry point imports a name that no installed package provides.
 * Loading it fails with `ERR_MODULE_NOT_FOUND`, which is exactly what happened before this script
 * existed.
 *
 * So the rewrite happens as part of the build instead of only on the way into a tarball. Both halves
 * stay built where they are; only the import specifier changes, from a package name to the relative
 * path of the sibling build. `pack.mjs` still performs its own rewrite into `dist/core`, because the
 * npm tarball has a flatter layout.
 *
 * Idempotent: re-running it leaves already-rewritten files alone.
 *
 * Usage: `node scripts/inline-core.mjs`
 */

import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const bundleLib = join(repoRoot, 'packages', 'bundle', 'lib')
const coreEntry = join(repoRoot, 'packages', 'core', 'lib', 'index.js')

if (!existsSync(coreEntry)) {
  console.error(`缺少核心构建产物: ${coreEntry}`)
  console.error('请先运行: pnpm build')
  process.exit(1)
}
if (!existsSync(bundleLib)) {
  console.error(`缺少宿主构建产物: ${bundleLib}`)
  console.error('请先运行: pnpm build')
  process.exit(1)
}

const specifier = '@dsh-wechat/core'

const rewritten = []
for (const entry of await readdir(bundleLib)) {
  if (!entry.endsWith('.js')) continue
  const file = join(bundleLib, entry)
  const text = await readFile(file, 'utf8')
  if (!text.includes(`'${specifier}'`)) continue
  // A relative specifier, because the two builds are siblings inside the repository either way.
  const target = relative(dirname(file), coreEntry).replaceAll('\\', '/')
  const withRelative = target.startsWith('.') ? target : `./${target}`
  await writeFile(file, text.replaceAll(`'${specifier}'`, `'${withRelative}'`))
  rewritten.push(`${entry} -> ${withRelative}`)
}

if (rewritten.length > 0) {
  console.log(`已内嵌 ${specifier}:`)
  for (const line of rewritten) console.log(`  ${line}`)
} else {
  /*
   * No file mentioned the specifier. That is not automatically fine: it is also what a silently broken
   * build looks like, where the import moved and this step quietly stopped doing anything — and the
   * failure would only appear later, on a user's machine, as a module that cannot be found.
   */
  const anyImport = (await Promise.all(
    (await readdir(bundleLib))
      .filter((name) => name.endsWith('.js'))
      .map((name) => readFile(join(bundleLib, name), 'utf8')),
  )).some((text) => text.includes(`'${specifier}'`))
  if (anyImport) throw new Error('内嵌未生效：仍存在 @dsh-wechat/core 引用')
  console.log(`${specifier} 已经内嵌过，无需改动`)
}
