/**
 * A minimal WeChat bot, built on `@dsh-wechat/core` alone.
 *
 * This is the whole protocol in about forty lines: log in, pump inbound messages, send a reply. No
 * DSH, no agent, no session routing — `core` knows nothing about any of that, which is what makes it
 * testable on its own and what makes this example possible.
 *
 * Run it from the repository root, after `pnpm build`:
 *
 *   node --experimental-transform-types examples/echo-bot.ts
 *
 * Scan the QR code with WeChat, then send the bot any message and it echoes back.
 */

import { ChannelMonitor, login, sendText, type WeixinAccount } from '../packages/core/src/index.ts'

/** Log in, reusing nothing — a fresh binding. */
async function authenticate(): Promise<WeixinAccount> {
  for await (const event of login()) {
    switch (event.kind) {
      case 'qr':
        // In WeChat's own client this string is rendered as a QR image.
        console.log('\n用微信扫描这个链接生成的二维码：\n')
        console.log(event.qrUrl)
        console.log('\n（扫码并在手机上确认后，脚本会继续）')
        break
      case 'scanned':
        console.log('已扫码，请在手机上确认…')
        break
      case 'expired':
        console.log(`二维码过期（第 ${event.refreshCount} 次），正在刷新…`)
        break
      case 'confirmed':
        console.log('登录成功。')
        return event.account
      case 'failed':
        throw new Error(`登录失败: ${event.reason}`)
      default:
        // scanned / redirected / verifycode-required / already-bound all need no action here.
        break
    }
  }
  throw new Error('登录流程结束但没有拿到账号')
}

const account = await authenticate()

/*
 * The pump. `onMessage` is awaited one message at a time, so a slow handler cannot interleave with
 * the next message's reply.
 */
const monitor = new ChannelMonitor({
  account,
  onMessage: async (message) => {
    console.log(`收到 ${message.peerId}: ${message.text}`)
    await sendText({
      account,
      to: message.peerId,
      text: `你说的是：${message.text}`,
      // Passing the token back keeps the reply in the same conversation thread.
      ...(message.contextToken === undefined ? {} : { contextToken: message.contextToken }),
    })
  },
  onError: (error) => console.error('轮询出错（会自动重试）:', error),
  onStop: (reason, detail) => console.log(`停止: ${reason}${detail === undefined ? '' : ` — ${detail}`}`),
})

const abort = new AbortController()
process.on('SIGINT', () => abort.abort())

console.log('开始收消息，Ctrl+C 退出。')
await monitor.run(abort.signal)
