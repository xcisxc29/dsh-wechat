/**
 * Reproduce the profile-load failure for the installed plugin.
 *
 * The plugin broke profile startup, and DSH writes no log file, so the only way to
 * see the error is to load the installed copy the way the loader does and let it
 * throw. Run from anywhere; resolution is anchored to the profile directory.
 *
 * Usage:
 *   node scripts/diagnose-load.mjs [profileDir]
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const profileDir = process.argv[2] ?? 'C:/Users/XCISXC/.dsh/profiles/desktop'
const require = createRequire(pathToFileURL(join(profileDir, 'package.json')).href)

const manifest = require('dsh-wechat/package.json')
const packageRoot = dirname(require.resolve('dsh-wechat/package.json'))
console.log(`插件    : ${manifest.name}@${manifest.version}`)
console.log(`根目录  : ${packageRoot}`)
console.log(`dsh 声明: ${JSON.stringify(manifest.dsh)}`)

// 1. Import the entry exactly as the loader would.
let plugin
try {
  plugin = await import(pathToFileURL(join(packageRoot, manifest.exports['.'].default)).href)
  console.log(`\n[1] import 入口        : OK  (name=${plugin.name}, apply=${typeof plugin.apply}, inject=${JSON.stringify(plugin.inject)})`)
} catch (error) {
  console.error('\n[1] import 入口        : ❌ 抛错')
  console.error(error)
  process.exit(1)
}

// 2. Validate the declaration shape the loader depends on.
const problems = []
if (typeof plugin.name !== 'string' || plugin.name === '') problems.push('name 必须是字符串')
if (typeof plugin.apply !== 'function') problems.push('apply 必须是函数')
if (!Array.isArray(plugin.inject)) problems.push('inject 必须是数组')
if (plugin.name !== manifest.name) problems.push(`name(${plugin.name}) 与包名(${manifest.name}) 不一致`)
if (manifest.dsh?.client && manifest.dsh.client.platform !== 'web') problems.push('dsh.client.platform 必须是 web')
console.log(`[2] 声明形状           : ${problems.length === 0 ? 'OK' : '❌ ' + problems.join('; ')}`)

// 3. Call apply() against a minimal but honest host context.
const calls = []
const ctx = {
  sessionController: {
    create: async (r) => (calls.push('create'), { sessionId: r.sessionId }),
    prompt: async () => (calls.push('prompt'), { accepted: true }),
    list: async () => (calls.push('list'), []),
    cancel: async () => (calls.push('cancel'), {}),
  },
  sessions: { get: () => undefined },
  effect(execute) {
    calls.push('effect')
    const cleanup = execute()
    ctx.__disposers ??= []
    if (typeof cleanup === 'function') ctx.__disposers.push(cleanup)
  },
  get(name) {
    calls.push(`get:${name}`)
    if (name === 'webServer') return { port: 1, register: () => () => {} }
    if (name === 'homePaths') return { home: 'C:/Users/XCISXC/.dsh' }
    return undefined
  },
  provide(name) {
    calls.push(`provide:${name}`)
  },
  on(name) {
    calls.push(`on:${name}`)
    return () => {}
  },
}
try {
  plugin.apply(ctx, { autoStart: false })
  console.log(`[3] apply(ctx, config) : OK`)
  console.log(`    宿主调用序列        : ${calls.join(', ')}`)
} catch (error) {
  console.error('\n[3] apply(ctx, config) : ❌ 抛错')
  console.error(error)
  process.exit(1)
}

// 4. Dispose, which is where a cleanup bug would surface at shutdown.
try {
  for (const dispose of ctx.__disposers ?? []) dispose()
  console.log(`[4] 清理               : OK`)
} catch (error) {
  console.error('\n[4] 清理               : ❌ 抛错')
  console.error(error)
  process.exit(1)
}

console.log('\n本脚本未复现出错误。若 profile 仍在启动时失败，问题不在插件的加载/挂载路径，')
console.log('而在它与真实组合的交互（见下方候选清单）。')
