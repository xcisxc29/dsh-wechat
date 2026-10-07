#!/usr/bin/env node
/**
 * Find the download URL the CDN actually serves for an uploaded object.
 *
 * This is the one thing standing between "the message is accepted" and "the recipient can
 * display it". The service's own inbound images carry an `encrypt_query_param` of 600+
 * characters, while the value this client takes from the upload response header is
 * shorter — so either the value or the URL shape is wrong, and only a real request can
 * tell which.
 *
 * Usage:
 *   node scripts/probe-cdn-url.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const core = pathToFileURL(join(repoRoot, 'packages/core/lib/index.js')).href
const { uploadMedia, UploadMediaType, decryptAesEcb, parseAesKey } = await import(core)

const account = Object.values(
  JSON.parse(readFileSync('C:/Users/XCISXC/.dsh/wechat/state.json', 'utf8')).accounts,
)[0]

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
  'base64',
)

let response
const uploaded = await uploadMedia({
  account,
  toUserId: account.userId,
  data: PNG,
  fileName: 'probe.png',
  mediaType: UploadMediaType.IMAGE,
  onDiagnostic: (detail) => {
    response = detail.response
  },
})

const full = response?.upload_full_url ?? ''
const longParam = decodeURIComponent(/encrypted_query_param=([^&]+)/.exec(full)?.[1] ?? '')
const filekey = /filekey=([^&]+)/.exec(full)?.[1] ?? ''
const headerParam = uploaded.media.encrypt_query_param ?? ''
const key = parseAesKey(uploaded.media.aes_key ?? '', '图片')

console.log('同一个上传，两个候选引用：')
console.log(`  x-encrypted-param 头部           : ${String(headerParam.length)} 字符`)
console.log(`  upload_full_url 的 encrypted... : ${String(longParam.length)} 字符`)
console.log(`  filekey                          : ${filekey}`)

// Reference length the service itself uses on an inbound photo (truncated measurement).
const INBOUND_MIN = 636
console.log(`\n服务自己发出的入站引用至少 ${String(INBOUND_MIN)} 字符`)

const enc = value => encodeURIComponent(value)
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c'
const ROOT = 'https://novac2c.cdn.weixin.qq.com'

const shapes = [
  [`${CDN}/download?encrypt_query_param=`, 'c2c/download + encrypt_query_param'],
  [`${CDN}/download?encrypted_query_param=`, 'c2c/download + encrypted_query_param'],
  [`${ROOT}/c2c/download?encrypt_query_param=`, 'root/c2c/download + encrypt_query_param'],
  [`${CDN}/download/${''}`, 'c2c/download/ 路径段'],
]
const values = [
  ['长引用', longParam],
  ['头部值', headerParam],
]

console.log('\n=== 取回尝试 ===')
let winner
for (const [valueLabel, value] of values) {
  for (const [prefix, shapeLabel] of shapes) {
    const url =
      shapeLabel.includes('路径段')
        ? `${CDN}/download/${enc(value)}`
        : `${prefix}${enc(value)}`
    try {
      const res = await fetch(url)
      const body = Buffer.from(await res.arrayBuffer())
      let note = ''
      if (res.ok && body.length > 0) {
        try {
          const plain = decryptAesEcb(body, key)
          note = plain.length === PNG.length ? '  ✅ 解密后长度一致' : `  ⚠️ 长度 ${String(plain.length)}`
          if (note.startsWith('  ✅')) winner = { url, valueLabel, shapeLabel }
        } catch (error) {
          note = `  ⚠️ 解密失败: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      console.log(`  ${String(res.status).padEnd(4)} ${String(body.length).padStart(7)}B  ${valueLabel} · ${shapeLabel}${note}`)
    } catch (error) {
      console.log(`  ERR  ${valueLabel} · ${shapeLabel}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

console.log('')
if (winner === undefined) {
  console.log('❌ 没有任何形态能取回对象。')
  console.log(`   测得的最小入站引用长度是 ${String(INBOUND_MIN)} 字符，`)
  console.log('   而上传只给出 480（头部）与 ' + String(longParam.length) + '（响应）——两者都短于它。')
  console.log('   这指向"上传响应没有交付可下载的引用"，而不是 URL 拼接问题。')
} else {
  console.log(`✅ 可用形态: ${winner.valueLabel} · ${winner.shapeLabel}`)
  console.log(`   ${winner.url.slice(0, 120)}…`)
}
