/**
 * Import the installed bundle exactly the way the DSH loader will.
 *
 * Resolution is anchored to the profile directory, not to this script: the point is
 * to check what the *profile* can resolve, and a `createRequire` based on this file
 * would look in this repository's `node_modules` instead.
 *
 * Usage:
 *   node scripts/probe-installed.mjs [profileDir]
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const profileDir = process.argv[2] ?? 'C:/Users/XCISXC/.dsh/profiles/desktop'
const require = createRequire(pathToFileURL(join(profileDir, 'package.json')).href)

const manifestPath = require.resolve('dsh-wechat/package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
console.log(`profile     : ${profileDir}`)
console.log(`已解析      : ${manifest.name}@${manifest.version}`)
console.log(`入口        : ${manifest.exports['.'].default}`)

// Load by absolute path. The profile's own resolution is what matters here, and an
// ESM `import('dsh-wechat')` from this script would resolve against this repository.
const packageRoot = dirname(manifestPath)
const entryPath = join(packageRoot, manifest.exports['.'].default)
const plugin = await import(pathToFileURL(entryPath).href)
console.log(`import 成功 : name=${plugin.name} apply=${typeof plugin.apply} inject=${JSON.stringify(plugin.inject)}`)

const clientPath = require.resolve('dsh-wechat/client')
const client = readFileSync(clientPath, 'utf8')
const registers = client.includes("id: 'dsh-wechat'") || client.includes('id: "dsh-wechat"')
console.log(`client 包   : ${clientPath}`)
console.log(`注册 id 匹配: ${registers}`)

// The runtime dependencies the host half actually needs.
for (const specifier of ['qrcode']) {
  console.log(`依赖可解析  : ${specifier} -> ${require.resolve(specifier)}`)
}
