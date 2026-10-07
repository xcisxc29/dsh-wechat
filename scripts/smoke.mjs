#!/usr/bin/env node
/**
 * Live smoke test for the `dsh-wechat` channel stack.
 *
 * It exercises the real modules against the real service — the same
 * `ChannelMonitor`, `SessionRouter`, and `StateStore` the plugin uses — with only
 * the DSH host replaced by a stub. That is the closest verification available
 * without booting a full DSH composition, and it is what proves the pieces fit
 * together rather than merely compile.
 *
 * What it covers:
 *   - credentials and cursor load from a persisted channel state file
 *   - the long-poll loop runs through the shipped client
 *   - the cursor is persisted between batches
 *   - an inbound message routes into a session id through the shipped router
 *   - an outbound reply goes through the shipped sender
 *
 * Usage:
 *   node scripts/smoke.mjs                 # listen for 120s, reply with the routing result
 *   node scripts/smoke.mjs --seconds 300   # listen longer
 *   node scripts/smoke.mjs --seconds 0     # run forever (Ctrl+C to stop)
 *   node scripts/smoke.mjs --hello         # also send one proactive message first
 *   node scripts/smoke.mjs --state <file>  # use another state file
 *
 * `--hello` answers a design question worth knowing: whether the service accepts an
 * outbound message that carries no `context_token`, which is what any proactive or
 * asynchronous notification from DSH would have to do.
 *
 * The state file is seeded automatically from the probe credentials when it does
 * not exist yet, so this can run right after `ilink-probe/probe.mjs`.
 */

import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ChannelMonitor,
  SessionRouter,
  StateStore,
  downloadItemMedia,
  isMediaItem,
  sendImage,
  sendText,
  uploadMedia,
} from '../packages/core/lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const seconds = Number(argValue('--seconds', '120'))
const stateFile = resolve(argValue('--state', join(repoRoot, '.smoke', 'state.json')))
/** Where the probe saved its credentials. */
const probeAccount = resolve(repoRoot, '..', 'ilink-probe', '.probe-state', 'account.json')
const probeSync = resolve(repoRoot, '..', 'ilink-probe', '.probe-state', 'sync-buf.txt')

const log = (...args) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...args)

/**
 * Identify a decrypted blob from its magic bytes.
 *
 * A wrong AES key does not fail loudly — it yields plausible-looking garbage — so
 * naming the format is the check that the whole download-and-decrypt path worked.
 */
function sniff(data) {
  if (data.length < 12) return `过短(${data.length}B)`
  const hex = data.subarray(0, 12).toString('hex')
  if (hex.startsWith('ffd8ff')) return 'JPEG'
  if (hex.startsWith('89504e47')) return 'PNG'
  if (hex.startsWith('47494638')) return 'GIF'
  if (hex.startsWith('52494646') && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'WebP'
  if (data.subarray(4, 8).toString('ascii') === 'ftyp') return 'MP4/MOV'
  if (hex.startsWith('25504446')) return 'PDF'
  if (hex.startsWith('504b0304')) return 'ZIP/Office'
  if (hex.startsWith('1a45dfa3')) return 'Matroska/WebM'
  if (data.subarray(0, 3).toString('ascii') === 'ID3') return 'MP3'
  if (hex.startsWith('4f676753')) return 'OGG'
  if (hex.startsWith('020000')) return 'SILK(疑似)'
  return `未知 (前 12 字节 ${hex})`
}

/** Seed the channel state from the probe artifacts on first run. */
function seedState() {
  if (existsSync(stateFile)) return false
  if (!existsSync(probeAccount)) {
    console.error(`缺少凭据：${probeAccount}`)
    console.error('请先在 ilink-probe 目录运行: node probe.mjs')
    process.exit(1)
  }
  const probe = JSON.parse(readFileSync(probeAccount, 'utf-8'))
  const syncBuf = existsSync(probeSync) ? readFileSync(probeSync, 'utf-8').trim() : ''
  const state = {
    version: 1,
    accounts: {
      [probe.accountId]: {
        accountId: probe.accountId,
        token: probe.token,
        baseUrl: probe.baseUrl,
        userId: probe.userId,
        savedAt: probe.savedAt ?? new Date().toISOString(),
      },
    },
    syncBufs: syncBuf ? { [probe.accountId]: syncBuf } : {},
    contextTokens: {},
    bindings: {},
    autoStart: true,
  }
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  log(`已从探针凭据播种状态文件: ${stateFile}`)
  return true
}

/**
 * Stub host: records every call the channel makes so the smoke run can show that
 * routing and prompting happen where they should.
 */
function stubGateway() {
  const calls = []
  const prompts = []
  const sessions = new Map()
  let counter = 0
  return {
    calls,
    prompts,
    gateway: {
      ensureSession: async (sessionId, title) => {
        calls.push(`ensureSession(${sessionId})`)
        if (!sessions.has(sessionId)) sessions.set(sessionId, { title, updatedAt: Date.now() })
      },
      prompt: async (sessionId, text) => {
        calls.push(`prompt(${sessionId})`)
        prompts.push({ sessionId, text })
      },
      listSessions: async () =>
        [...sessions.entries()].map(([sessionId, value]) => ({
          sessionId,
          title: value.title,
          updatedAt: value.updatedAt + counter++,
        })),
      cancel: async (sessionId) => {
        calls.push(`cancel(${sessionId})`)
      },
    },
  }
}

/**
 * Build a small valid PNG without an image library.
 *
 * Used by `--send-test-image` to exercise the outbound media path: upload slot,
 * AES-128-ECB encryption, CDN POST, and the message item. Hand-rolling the encoder
 * keeps the dependency list honest for a file that exists only to be uploaded.
 */
function makeTestPng(width = 64, height = 64) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset++] = 0 // filter type: none
    for (let x = 0; x < width; x += 1) {
      // A diagonal gradient, so the result is visibly not a blank rectangle.
      raw[offset++] = Math.floor((x / width) * 255)
      raw[offset++] = Math.floor((y / height) * 255)
      raw[offset++] = 0x80
    }
  }

  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  chunks.push(pngChunk('IHDR', ihdr))
  chunks.push(pngChunk('IDAT', deflateSync(raw)))
  chunks.push(pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([length, body, crc])
}

let crcTable
function crc32(buffer) {
  if (crcTable === undefined) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc ^ -1
}

async function main() {
  log('dsh-wechat 冒烟测试（真实服务 + 真实模块）')
  const seeded = seedState()
  if (seeded) log('（首次运行，已播种）')

  const store = new StateStore(stateFile)
  const state = await store.read()
  const accounts = Object.values(state.accounts)
  if (accounts.length === 0) {
    console.error('状态文件里没有账号，无法测试。')
    process.exit(1)
  }
  const account = accounts[0]
  log(`账号     : ${account.accountId}`)
  log(`微信用户 : ${account.userId ?? '(未知)'}`)
  log(`baseUrl  : ${account.baseUrl}`)
  log(`游标     : ${state.syncBufs[account.accountId] ? '已恢复' : '(空)'}`)

  const stub = stubGateway()
  const router = new SessionRouter({
    gateway: stub.gateway,
    store: {
      load: async () => (await store.read()).bindings,
      save: async (next) => {
        await store.update((s) => {
          s.bindings = next
        })
      },
    },
  })

  const abort = new AbortController()
  if (seconds > 0) {
    const timer = setTimeout(() => abort.abort(), seconds * 1000)
    timer.unref?.()
  }
  process.on('SIGINT', () => abort.abort())

  const monitor = new ChannelMonitor({
    account,
    botAgent: 'dsh-wechat-smoke/0.0.0',
    onSyncBuf: async (buf) => {
      await store.update((s) => {
        s.syncBufs[account.accountId] = buf
      })
    },
    onError: (error) => log(`错误: ${error.message}`),
    onStop: (reason) => log(`停止: ${reason}`),
    onMessage: async (message) => {
      log('──────── 收到消息 ────────')
      log(`  来自    : ${message.peerId}`)
      log(`  会话键  : ${message.conversationId}`)
      log(`  正文    : ${message.text || '(无文本)'}`)
      log(`  回复令牌: ${message.contextToken ? '已捕获' : '(无)'}`)

      // Fetch and decrypt anything media-bearing before routing, so a media
      // failure is visible without disturbing the text pipeline.
      const items = message.raw.item_list ?? []
      for (const item of items) {
        if (!isMediaItem(item)) continue
        log(`  媒体    : type=${item.type} 开始下载…`)
        try {
          const media = await downloadItemMedia({ item })
          if (media === undefined) {
            log('  媒体    : 消息里没有可用引用')
            continue
          }
          const dir = join(repoRoot, '.smoke', 'media')
          mkdirSync(dir, { recursive: true })
          const saved = join(dir, media.fileName)
          writeFileSync(saved, media.data)
          const md5 = createHash('md5').update(media.data).digest('hex')
          log(`  媒体    : ✅ ${media.kind} 解密成功`)
          log(`            ${media.data.length} 字节, md5=${md5.slice(0, 16)}…`)
          log(`            类型推测: ${sniff(media.data)}`)
          if (media.transcript) log(`            服务端转写: ${media.transcript}`)
          if (media.declaredSize !== undefined) {
            log(`            声明大小: ${media.declaredSize}`)
          }
          log(`            已保存: ${saved}`)
        } catch (error) {
          log(`  媒体    : ❌ 失败: ${error.message}`)
        }
      }

      // Persist the reply token exactly as the plugin does, keyed by conversation.
      await store.update((s) => {
        const perAccount = (s.contextTokens[account.accountId] ??= {})
        if (message.contextToken) perAccount[message.conversationId] = message.contextToken
      })

      const routed = await router.route({
        conversationId: message.conversationId,
        accountId: message.accountId,
        peerId: message.peerId,
        text: message.text,
      })

      let reply
      if (routed.kind === 'reply') {
        // A command the router answered itself. Print it verbatim: this is the text
        // the user sees in WeChat, and the clearest evidence of how routing decided.
        log(`  路由结果: 指令（未惊动 agent）`)
        for (const line of routed.text.split('\n')) log(`    │ ${line}`)
        reply = routed.text
      } else {
        await stub.gateway.prompt(routed.decision.sessionId, routed.decision.prompt)
        log(`  路由结果: 交给会话（新建=${routed.decision.created ? '是' : '否'}）`)
        log(`    │ sessionId = ${routed.decision.sessionId}`)
        reply = `已路由到会话 ${routed.decision.sessionId}\n新建: ${routed.decision.created ? '是' : '否'}\n正文: ${routed.decision.prompt}`
      }

      const fresh = await store.read()
      const token = fresh.contextTokens[account.accountId]?.[message.conversationId]
      const sent = await sendText({
        account,
        to: message.peerId,
        text: reply,
        ...(token ? { contextToken: token } : {}),
      })
      log(`  已回复  : server_id=${sent.serverMessageId ?? '?'}`)
      log('──────────────────────────')
    },
  })

  const saved = state.syncBufs[account.accountId]
  if (saved) monitor.restoreSyncBuf(saved)

  if (process.argv.includes('--hello') && account.userId) {
    log('发送一条不带 context_token 的主动消息，验证服务端是否接受…')
    try {
      const sent = await sendText({
        account,
        to: account.userId,
        text: 'dsh-wechat 冒烟测试：这是一条主动消息（未携带 context_token）。',
      })
      log(`  接受，server_id=${sent.serverMessageId ?? '?'}`)
    } catch (error) {
      log(`  被拒绝: ${error.message}`)
    }
  }

  if (process.argv.includes('--roundtrip') && account.userId) {
    log('══ 媒体往返自证：上传 → CDN → 下载 → 解密 → 比对 ══')
    try {
      const png = makeTestPng(96, 96)
      const before = createHash('md5').update(png).digest('hex')
      log(`  源文件      : ${png.length} 字节, md5=${before}`)

      const uploaded = await uploadMedia({
        account,
        toUserId: account.userId,
        data: png,
        fileName: 'dsh-wechat-roundtrip.png',
        mediaType: 1, // IMAGE
      })
      log(`  上传        : 密文 ${uploaded.ciphertextSize} 字节, 明文 ${uploaded.size} 字节`)
      log(`  CDN 引用    : ${(uploaded.media.encrypt_query_param ?? '').slice(0, 28)}…`)

      // Now walk the inbound path over that same reference, exactly as an arriving
      // message would: build the item the wire would carry and download it.
      const item = {
        type: 2, // IMAGE
        image_item: {
          media: {
            encrypt_query_param: uploaded.media.encrypt_query_param,
            aes_key: uploaded.media.aes_key,
          },
        },
      }
      const media = await downloadItemMedia({ item })
      if (media === undefined) throw new Error('下载返回空结果')

      const after = createHash('md5').update(media.data).digest('hex')
      log(`  下载解密    : ${media.data.length} 字节, md5=${after}`)
      log(`  格式嗅探    : ${sniff(media.data)}`)
      log(`  MD5 一致    : ${before === after ? '✅ 是' : '❌ 否'}`)
      const identical = Buffer.compare(png, media.data) === 0
      log(`  逐字节相同  : ${identical ? '✅ 是' : '❌ 否'}`)
      if (!identical) throw new Error('往返后的字节与源文件不一致')

      // Send it so the recipient sees the same image the round trip carried.
      const sent = await sendImage({ account, to: account.userId, uploaded })
      log(`  已发送      : server_id=${sent.serverMessageId ?? '?'}`)
      log('  ✅ 入站与出站媒体链路均验证通过')
    } catch (error) {
      log(`  ❌ 媒体往返失败: ${error.message}`)
    }
  }

  if (process.argv.includes('--send-test-image') && account.userId) {
    log('上传并发送一张自测图片，验证出站媒体链路…')
    try {
      const png = makeTestPng()
      log(`  本地字节: ${png.length}, md5=${createHash('md5').update(png).digest('hex').slice(0, 16)}…`)
      const uploaded = await uploadMedia({
        account,
        toUserId: account.userId,
        data: png,
        fileName: 'dsh-wechat-test.png',
        mediaType: 1, // IMAGE
      })
      log(`  上传成功: 密文 ${uploaded.ciphertextSize} 字节（明文 ${uploaded.size} 字节）`)
      const sent = await sendImage({ account, to: account.userId, uploaded })
      log(`  发送成功: server_id=${sent.serverMessageId ?? '?'}`)
      writeFileSync(join(repoRoot, '.smoke', 'sent-test.png'), png)
      log('  （手机上应能看到一张紫绿色渐变方块）')
    } catch (error) {
      log(`  ❌ 出站媒体失败: ${error.message}`)
    }
  }

  log(seconds > 0 ? `\n开始长轮询，${seconds} 秒后自动停止…\n` : '\n开始长轮询，Ctrl+C 停止…\n')
  const reason = await monitor.run(abort.signal)
  log(`监听结束（${reason}）`)

  const final = await store.read()
  log(`游标已持久化: ${final.syncBufs[account.accountId] ? '是' : '否'}`)
  log(`会话绑定数  : ${Object.keys(final.bindings).length}`)
  for (const binding of Object.values(final.bindings)) {
    log(`  ${binding.conversationId} -> ${binding.sessionId} (${binding.title})`)
  }
  await monitor.notifyStop()
}

main().catch((error) => {
  console.error('冒烟测试异常:', error)
  process.exit(1)
})
