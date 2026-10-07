#!/usr/bin/env node
/**
 * Capture the raw inbound `image_item` the service sends us.
 *
 * The service's own image is one that renders correctly in WeChat, so its `media`
 * reference is the authoritative example of the shape this client must produce. An
 * outbound item built from a differently-shaped reference is what produces a grey
 * placeholder in the chat: the message arrives, the media never resolves.
 *
 * Writes the captured item to `.inbound-image-item.json`.
 *
 * Usage:
 *   node scripts/capture-inbound-media.mjs [--seconds 25]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const core = pathToFileURL(join(repoRoot, 'packages/core/lib/index.js')).href
const { apiCall } = await import(core)

const stateFile = 'C:/Users/XCISXC/.dsh/wechat/state.json'
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
const account = Object.values(state.accounts)[0]
const cursor = state.syncBufs?.[account.accountId] ?? ''
console.log(`账号: ${account.accountId}`)

const seconds = Number(
  process.argv.includes('--seconds') ? process.argv[process.argv.indexOf('--seconds') + 1] : '25',
)

// Poll without advancing the stored cursor, so this observes without consuming.
const deadline = Date.now() + seconds * 1000
const seen = []
let buf = cursor

while (Date.now() < deadline) {
  let response
  try {
    response = await apiCall({
      baseUrl: account.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: { sync_buffer: buf, timeout: 20 },
      token: account.token,
      timeoutMs: 25_000,
    })
  } catch (error) {
    console.log(`轮询出错: ${error instanceof Error ? error.message : String(error)}`)
    break
  }
  if (response.sync_buffer) buf = response.sync_buffer
  for (const message of response.msg_list ?? []) {
    for (const item of message.item_list ?? []) {
      if (item.type === 2 && item.image_item) seen.push(item)
    }
  }
  if (seen.length > 0) break
}

if (seen.length === 0) {
  console.log(
    `\n${String(seconds)} 秒内没有收到新图片。请在微信里发一张图，然后重跑本脚本。`,
  )
  process.exit(0)
}

const item = seen[seen.length - 1]
writeFileSync(join(repoRoot, '.inbound-image-item.json'), JSON.stringify(item, null, 2))

const image = item.image_item
console.log('\n=== 服务发来的 image_item（权威参照）===')
console.log(`字段: ${Object.keys(image).join(', ')}`)
console.log(`\nmedia 字段: ${Object.keys(image.media ?? {}).join(', ')}`)
for (const [key, value] of Object.entries(image.media ?? {})) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  console.log(`  ${key} = ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`)
}
console.log('\n=== 与我们发出的结构对比 ===')
console.log(`  服务: aes_key 长度=${String(image.media?.aes_key?.length ?? 0)}  encrypt_type=${String(image.media?.encrypt_type ?? '(无)')}`)
console.log(`  服务: aeskey(hex) ${image.aeskey ? `长度=${String(image.aeskey.length)}` : '(无)'}`)
console.log(`  服务: full_url ${image.media?.full_url ? '有' : '(无)'}`)
console.log(`  服务: encrypt_query_param ${image.media?.encrypt_query_param ? `长度=${String(image.media.encrypt_query_param.length)}` : '(无)'}`)
console.log(`  服务: mid_size=${String(image.mid_size ?? '(无)')} hd_size=${String(image.hd_size ?? '(无)')} thumb_size=${String(image.thumb_size ?? '(无)')}`)
console.log(`  服务: thumb_media ${image.thumb_media ? '有' : '(无)'}`)
console.log('\n已写入 .inbound-image-item.json')
