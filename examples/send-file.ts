/**
 * Send a file to a WeChat user without being asked.
 *
 * The protocol accepts a message with no `context_token`, which is what makes this possible: a
 * deployment can report that a long job finished instead of waiting for the user to ask. Verified
 * against the live service — see the protocol table in the README.
 *
 * Run it from the repository root, after `pnpm build`:
 *
 *   node --experimental-transform-types examples/send-file.ts <path-to-file> [peerId]
 *
 * The credentials are read from the channel's state file, which is where the plugin keeps them:
 * `$DSH_HOME/wechat/state.json`. `peerId` is the WeChat user to send to; omit it to use the peer of
 * an existing binding, which is the common case — you want to notify the person who has been talking
 * to the bot.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import {
  sendFile,
  uploadMedia,
  UploadMediaType,
  type ChannelState,
  type WeixinAccount,
} from '../packages/core/src/index.ts'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const stateFile = join(home, 'wechat', 'state.json')

const [filePath, peerArgument] = process.argv.slice(2)
if (filePath === undefined) {
  console.error('用法: node --experimental-transform-types examples/send-file.ts <文件> [peerId]')
  process.exit(1)
}

/**
 * Read the account and a peer from the channel's own state.
 *
 * Reusing the plugin's credentials matters: logging in again would issue a new bot identity and
 * unbind the one already on the phone. A second client scanning naively is what causes that, which
 * is why `login` sends `local_token_list` — and why this example piggybacks on what is already bound
 * rather than authenticating from scratch.
 */
const state = JSON.parse(await readFile(stateFile, 'utf8')) as ChannelState

const account: WeixinAccount | undefined = Object.values(state.accounts)[0]
if (account === undefined) {
  console.error(`没有已绑定的账号。先在 DSH 的设置页扫码绑定，或检查 ${stateFile}`)
  process.exit(1)
}

const boundPeer = Object.values(state.bindings)[0]?.peerId
const to = peerArgument ?? boundPeer
if (to === undefined) {
  console.error('没有可用的 peerId：请显式指定，或先在微信里给机器人发一条消息。')
  process.exit(1)
}

/*
 * Two steps, and the split is not incidental: the file goes to the CDN first, and only the resulting
 * reference goes into the message. Sending is then a small JSON call that names that reference — which
 * is also why an upload can succeed while the message that should display it renders as an empty
 * placeholder, if the reference is built wrong.
 *
 * No `contextToken` on purpose — that is the point of this example.
 */
const data = await readFile(filePath)
const uploaded = await uploadMedia({
  account,
  toUserId: to,
  data,
  fileName: basename(filePath),
  mediaType: UploadMediaType.FILE,
})

const result = await sendFile({ account, to, uploaded })

console.log(`已发送 ${basename(filePath)}（${data.length} 字节）给 ${to}`)
console.log(`  clientId: ${result.clientId}`)
if (result.serverMessageId !== undefined) console.log(`  服务端消息 id: ${result.serverMessageId}`)
