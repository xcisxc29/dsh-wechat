/**
 * `dsh-wechat-send` — the command an agent's own script calls instead of the iLink API.
 *
 * The problem it exists for, in the words of the incident: asked to "send eleven messages, one every
 * three seconds", the agent wrote a script that read the token out of `state.json` and posted to the
 * service directly. Those sends were invisible to the channel, so the log showed one outbound message
 * while the phone got ten and then nothing — no counting, no request for a new window, and no queue
 * for what the platform refused.
 *
 * So the script gets a command to call instead. It shares the state file with the plugin, charges the
 * same reply-window ledger, warns the user at the same point, and queues a refused message for the
 * plugin to deliver when the user next writes. **The protocol is not reimplemented here** — every
 * outbound call is a `@dsh-wechat/core` function, the same one the plugin makes, which is the only
 * way the two can be trusted to behave identically.
 *
 * Exit codes are part of the interface, because a script has to tell the outcomes apart:
 *
 * | code | meaning |
 * |---|---|
 * | 0 | delivered now, possibly together with the "write me back" warning |
 * | 1 | a real failure: missing file, dead network, service error |
 * | 2 | unusable: bad arguments, or no bound conversation on this machine |
 * | 3 | refused by WeChat; **the message is queued**, not lost |
 *
 * @module dsh-wechat-plugin/cli
 */

import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  QUOTA_PER_TOKEN,
  QUOTA_WARNING,
  SendRefusedError,
  StateStore,
  quotaLedgerFor,
  queuePendingNotification,
  sendFile,
  sendImage,
  sendText,
  sendVideo,
  uploadMedia,
  type ChannelState,
  type QuotaLedger,
  type WeixinAccount,
} from '@dsh-wechat/core'

import { MEDIA_TYPE_BY_KIND, mediaKindOf, type MediaKind } from './media-kind.ts'

/** Delivered, or delivered together with the warning about the window. */
export const EXIT_OK = 0
/** A real failure; retrying may help. */
export const EXIT_FAILED = 1
/** Not usable: bad arguments, or nothing to send to. */
export const EXIT_USAGE = 2
/**
 * WeChat refused the send, so it is queued for the next message the user sends.
 *
 * Its own code rather than a failure, because it is not one: the message is kept and will arrive. A
 * script that reads this as an error will retry, and every retry is refused the same way.
 */
export const EXIT_QUEUED = 3

/** The account, peer and reply token a send needs, resolved from the bound conversation. */
export interface CliTarget {
  conversationId: string
  account: WeixinAccount
  peerId: string
  contextToken?: string
}

/**
 * Where the command gets everything it needs from the outside world.
 *
 * Injected so the whole command can be driven in a test without a network, a real state file, or a
 * child process. The counting, the warning and the queue are the parts that matter, and none of them
 * should need a live bot to be checked.
 */
export interface CliProvider {
  /** The state file shared with the plugin. */
  stateFile: string
  /** The conversation to send to, or a reason it cannot be determined. */
  target(): Promise<{ ok: true; target: CliTarget } | { ok: false; message: string }>
  /** Charges the shared reply-window ledger. */
  quota: QuotaLedger
  /** Delivers one already-built message. Defaults to the real iLink sender. */
  deliver?(request: {
    account: WeixinAccount
    to: string
    text: string
    contextToken?: string
    signal?: AbortSignal
  }): Promise<unknown>
  /** Uploads and delivers one attachment. Defaults to the real CDN upload plus item send. */
  attach?(request: {
    target: CliTarget
    path: string
    signal?: AbortSignal
  }): Promise<{ fileName: string; size: number }>
  /** Records one line for later diagnosis. Defaults to the channel's own boot log. */
  log?(line: string): void
}

/** Streams {@link runCli} writes to. */
export interface CliIo {
  out(line: string): void
  err(line: string): void
}

/** Result of one command line. */
export interface CliOutcome {
  code: number
  /** What was written — kept separate from the streams so a test can assert the wording. */
  out: string[]
  err: string[]
}

/** The usage text, shown by `--help` and after an unusable command line. */
export function helpText(): string {
  return [
    'dsh-wechat-send —— 通过微信机器人发一条消息（和插件共用同一份回复窗口计数）',
    '',
    '用法：',
    '  dsh-wechat-send "消息内容"',
    '  dsh-wechat-send "照片来啦" --file C:\\path\\to\\image.png',
    '  dsh-wechat-send --file C:\\path\\to\\report.pdf',
    '  dsh-wechat-send --help',
    '',
    '参数：',
    '  "消息内容"       要发送的文字。可以省略，但这时必须指定 --file。',
    '  --file <路径>    可选，发完文字后附带的文件。按扩展名自动决定发成图片、视频或文件。',
    '  -h, --help       显示这份说明。',
    '',
    '说明：',
    `  微信一个回复窗口最多连发 ${String(QUOTA_PER_TOKEN)} 条，而且只有用户发消息才会重开窗口。`,
    `  本命令与插件共用同一份计数：用到第 ${String(QUOTA_PER_TOKEN - 2)} 条时会先提醒用户回一句话；`,
    '  发不出去的消息会自动排队，等用户下次发消息时由插件补发——不会丢。',
    '  所以脚本里请调用这个命令，不要自己去连 iLink 接口：直连的消息插件看不见，',
    '  既不会计数、也发不出提醒，第 11 条会被微信拒绝并且永久丢失。',
    '',
    '退出码：',
    '  0  已发出（可能同时发了一条「请回我一句」的提醒）',
    '  1  发送失败：文件不存在、网络不通、服务端报错等，重试可能有用',
    '  2  用法不对，或这台机器上还没有绑定的微信对话（先在微信里给机器人发一条消息）',
    '  3  微信拒绝了这次发送（窗口用完了）。消息已排队，等用户下次发消息后自动补发。',
    '     不要重试——窗口关闭期间重试同样会被拒绝，重试也会多占一条配额。',
    '',
    '环境变量：',
    '  DSH_HOME   DSH 主目录，默认是用户目录下的 .dsh。状态文件固定为 <DSH_HOME>/wechat/state.json。',
  ].join('\n')
}

/** One parsed command line. */
interface ParsedArgs {
  help: boolean
  message?: string
  file?: string
  /** Positional arguments beyond the first, which is a usage error rather than something to guess at. */
  extra: string[]
  error?: string
}

/**
 * Parse the command line.
 *
 * Hand-rolled rather than pulled from a dependency: the whole surface is one positional argument and
 * one option, and the messages have to be Chinese and actionable, which a generic parser's are not.
 *
 * @param argv - Arguments after the executable.
 * @returns The parsed command, or the reason it is unusable.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false, extra: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
      continue
    }
    if (arg === '--file' || arg.startsWith('--file=')) {
      const attached = arg.startsWith('--file=')
      const value = attached ? arg.slice('--file='.length) : (argv[index + 1] ?? '')
      if (!attached) index += 1
      if (value === '') {
        parsed.error = '--file 后面要跟一个文件路径。'
        return parsed
      }
      parsed.file = value
      continue
    }
    // A lone `-` is a positional argument in every command line convention worth following here.
    if (arg.startsWith('-') && arg !== '-') {
      parsed.error = `认不出的参数：${arg}`
      return parsed
    }
    if (parsed.message === undefined) parsed.message = arg
    else parsed.extra.push(arg)
  }
  return parsed
}

/**
 * Run one command line.
 *
 * @param argv - Arguments after the executable.
 * @param io - Where to write. Defaults to the process streams.
 * @param provider - Everything the command needs; the real one comes from {@link defaultCliProvider}.
 * @returns The exit code together with what was written, so a test needs no streams.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  provider?: CliProvider,
): Promise<CliOutcome> {
  const out: string[] = []
  const err: string[] = []
  const record = (line: string): void => {
    out.push(line)
    io.out(line)
  }
  const fail = (line: string): void => {
    err.push(line)
    io.err(line)
  }
  const finish = (code: number): CliOutcome => ({ code, out, err })

  const parsed = parseArgs(argv)
  if (parsed.help) {
    record(helpText())
    return finish(EXIT_OK)
  }
  if (parsed.error !== undefined) {
    fail(parsed.error)
    fail('')
    fail(helpText())
    return finish(EXIT_USAGE)
  }
  if (parsed.extra.length > 0) {
    fail(`只能给一条消息，多出来的是：${parsed.extra.join(' ')}`)
    fail('要发多条请分多次调用这个命令，这样每一条都会被计数。')
    return finish(EXIT_USAGE)
  }
  const message = (parsed.message ?? '').trim()
  if (message === '' && parsed.file === undefined) {
    fail('至少要给一条消息，或者用 --file 指定一个文件。')
    fail('')
    fail(helpText())
    return finish(EXIT_USAGE)
  }

  let resolved: CliProvider
  try {
    resolved = provider ?? defaultCliProvider()
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return finish(EXIT_USAGE)
  }

  let where: Awaited<ReturnType<CliProvider['target']>>
  try {
    where = await resolved.target()
  } catch {
    fail('读不到微信状态文件：' + resolved.stateFile + '；文件可能损坏或被占用。')
    return finish(EXIT_FAILED)
  }
  if (!where.ok) {
    fail(`${where.message}（状态文件：${resolved.stateFile}）`)
    return finish(EXIT_USAGE)
  }
  const target = where.target
  const log = resolved.log ?? ((): void => {})

  try {
    const detail = await deliver({
      provider: resolved,
      target,
      message,
      ...(parsed.file === undefined ? {} : { file: parsed.file }),
      ...(resolved.deliver === undefined ? {} : { deliverText: resolved.deliver }),
      ...(resolved.attach === undefined ? {} : { attach: resolved.attach }),
      log,
    })
    record(detail)
    return finish(EXIT_OK)
  } catch (error) {
    if (error instanceof SendRefusedError) {
      /*
       * Queued rather than failed, and the distinction is the point of the command: the message is
       * kept in the same `pendingNotifications` the plugin flushes when the window reopens, so the
       * user still gets it. Retrying would be refused identically until they write.
       */
      const queued = await enqueue(resolved, target, message, parsed.file, log)
      fail(`微信拒绝了这次发送：${error.message}`)
      if (!queued.ok) {
        fail(queued.reason)
        return finish(EXIT_FAILED)
      }
      fail('已排队，等用户回消息后补发。不要重试——窗口关闭期间重试同样会被拒绝。')
      return finish(EXIT_QUEUED)
    }
    fail(`发送失败：${error instanceof Error ? error.message : String(error)}`)
    return finish(EXIT_FAILED)
  }
}

/**
 * Send the text, then the file, charging each against the shared window.
 *
 * The text goes first because it is usually the caption for the attachment, and the attachment is
 * uploaded before it is announced, so a failed upload spends no quota and queues nothing.
 *
 * @param params.provider - The resolved provider.
 * @param params.target - Where the message goes.
 * @param params.message - Text to send; skipped when empty.
 * @param params.file - Attachment to send after the text; skipped when absent.
 * @param params.log - Where to record what happened.
 * @returns The line the user's script should print.
 */
async function deliver(params: {
  provider: CliProvider
  target: CliTarget
  message: string
  file?: string
  deliverText?: (request: {
    account: WeixinAccount
    to: string
    text: string
    contextToken?: string
    signal?: AbortSignal
  }) => Promise<unknown>
  attach?: (request: {
    target: CliTarget
    path: string
    signal?: AbortSignal
  }) => Promise<{ fileName: string; size: number }>
  log(line: string): void
}): Promise<string> {
  const { provider, target } = params
  const sent: string[] = []
  let warning = false

  if (params.message !== '') {
    const charge = await sendOne({
      provider,
      target,
      text: params.message,
      ...(params.deliverText === undefined ? {} : { deliver: params.deliverText }),
    })
    warning = charge.warned
    sent.push('消息')
    params.log(`cli send: text -> ${target.conversationId}`)
  }

  if (params.file !== undefined) {
    /*
     * Readable first, capability second.
     *
     * A path that is wrong and a deployment that cannot upload are different problems with different
     * fixes, and only the first is the caller's to correct. Checking the capability first reported
     * "this deployment cannot upload files" for a path that simply had a typo in it, which sends the
     * reader looking in the wrong place — and made a test about a missing file depend on whether the
     * machine running it happened to be able to upload at all.
     */
    if (!existsSync(params.file)) throw new Error(`读不到文件：${params.file}`)
    if (params.attach === undefined) throw new Error('这个部署没有文件上传能力。')
    const attached = await params.attach({ target, path: params.file })
    /*
     * Charged after it went out, unlike text. The upload is the expensive half and happens first, so
     * a refusal here queues the message without having spent a slot on it.
     *
     * This is also the one path that never carries the ask: the message the user has to reply to is
     * the caption, and a file sent on its own is not something to interrupt with a second message.
     */
    await provider.quota.charge(target.conversationId, target.contextToken, { warned: true })
    params.log(`cli send: ${attached.fileName} ${String(attached.size)}B -> ${target.conversationId}`)
    sent.push(`文件 ${attached.fileName}`)
  }

  const summary = `已通过微信发送：${sent.join('、')}`
  return warning ? `${summary}\n${QUOTA_WARNING}` : summary
}

/**
 * Deliver one text message through the ledger.
 *
 * The core senders throw {@link SendRefusedError} when the service refuses — the check lives in the
 * transport, where the response body is — so nothing here looks at a response at all.
 *
 * @param params.provider - The resolved provider.
 * @param params.target - Where the message goes.
 * @param params.text - Body.
 * @param params.deliver - Override for the sender, used by tests.
 * @returns Whether this send is the one that had to carry the request for a new window.
 */
async function sendOne(params: {
  provider: CliProvider
  target: CliTarget
  text: string
  deliver?: (request: {
    account: WeixinAccount
    to: string
    text: string
    contextToken?: string
    signal?: AbortSignal
  }) => Promise<unknown>
  signal?: AbortSignal
}): Promise<{ warned: boolean; used: number }> {
  const { provider, target } = params
  const deliver =
    params.deliver ??
    (async (request: {
      account: WeixinAccount
      to: string
      text: string
      contextToken?: string
      signal?: AbortSignal
    }) =>
      await sendText({
        account: request.account,
        to: request.to,
        text: request.text,
        ...(request.contextToken === undefined ? {} : { contextToken: request.contextToken }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }))
  await deliver({
    account: target.account,
    to: target.peerId,
    text: params.text,
    ...(target.contextToken === undefined ? {} : { contextToken: target.contextToken }),
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })

  const charge = await provider.quota.charge(target.conversationId, target.contextToken)
  if (!charge.warn) return { warned: false, used: charge.used }
  /*
   * The warning was already charged by the call above — in one write, which is the whole reason the
   * ledger takes the count in a single step: charging a send must not be able to charge another one
   * and recurse. What is left for this command to do is deliver it.
   *
   * A warning that cannot be delivered is not an error. The message it warned about has already
   * arrived, and the next send is refused and queued exactly as it would have been anyway.
   */
  try {
    await deliver({
      account: target.account,
      to: target.peerId,
      text: QUOTA_WARNING,
      ...(target.contextToken === undefined ? {} : { contextToken: target.contextToken }),
    })
    provider.log?.(
      `quota: 窗口已用 ${String(charge.used)}/${String(QUOTA_PER_TOKEN)}，已提醒续期（dsh-wechat-send）`,
    )
    return { warned: true, used: charge.used }
  } catch (error) {
    provider.log?.(
      `quota: 窗口已用 ${String(charge.used)}/${String(QUOTA_PER_TOKEN)}，提醒未能发出（dsh-wechat-send）：` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
    return { warned: false, used: charge.used }
  }
}

/**
 * Keep a refused message for the plugin to deliver.
 *
 * Written into the same queue the plugin creates, in the same shape, because the plugin is what will
 * send it: the user's next message reopens the window, and the backlog goes out before their own turn
 * is handled.
 *
 * @param provider - The resolved provider.
 * @param target - Conversation the message was meant for.
 * @param text - Text to keep; may be empty when only a file was owed.
 * @param file - Attachment to keep, by path.
 * @param log - Where to record what happened.
 */
async function enqueue(
  provider: CliProvider,
  target: CliTarget,
  text: string,
  file: string | undefined,
  log: (line: string) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const store = new StateStore(provider.stateFile)
    await store.update((state) => {
      // Only the file's path is kept, never its bytes: the queue is rewritten on every change, and
      // embedding attachments would grow the state file with every missed screenshot.
      const dropped = queuePendingNotification(state, {
        conversationId: target.conversationId,
        text,
        ...(file === undefined ? {} : { path: file }),
      })
      if (dropped > 0) log(`cli send: 队列已满，丢弃了 ${String(dropped)} 条最旧的待发消息`)
    })
    log(`cli send: 被拒，已排队（会话 ${target.conversationId}）`)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: `排队也失败了，这条消息没能保住：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Resolve the conversation to send to.
 *
 * Read from the state file rather than taken as an argument, for the same reason `notify_wechat` takes
 * no target: the command runs inside a script whose author is guessing, and the one thing it must not
 * be able to do is reach a different conversation than the user is in.
 *
 * @param state - Persisted state.
 * @returns The target, or a reason it cannot be determined.
 */
export function boundTarget(
  state: ChannelState,
): { ok: true; target: CliTarget } | { ok: false; message: string } {
  const bindings = Object.values(state.bindings)
  if (bindings.length === 0) {
    return {
      ok: false,
      message: '这台电脑上还没有绑定的微信对话。请先在微信里给机器人发一条消息。',
    }
  }
  if (bindings.length > 1) {
    return {
      ok: false,
      message: `当前绑定了 ${String(bindings.length)} 个微信对话，无法确定发给哪一个，请先解绑多余的。`,
    }
  }
  const binding = bindings[0]
  if (binding === undefined) {
    return { ok: false, message: '绑定的微信对话已经失效，请重新扫码绑定。' }
  }
  const account = state.accounts[binding.accountId]
  if (account === undefined) {
    return {
      ok: false,
      message: `绑定的微信账号 ${binding.accountId} 已经不在状态里了，请重新扫码绑定。`,
    }
  }
  const contextToken = state.contextTokens[binding.accountId]?.[binding.conversationId]
  return {
    ok: true,
    target: {
      conversationId: binding.conversationId,
      account,
      peerId: binding.peerId,
      ...(contextToken === undefined ? {} : { contextToken }),
    },
  }
}

/** Resolve the DSH home directory the way the plugin does, so both read one state file. */
export function resolveHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/**
 * Append one line to the channel's boot log.
 *
 * The same file the plugin writes. A refusal and a lost file are the two things a later diagnosis
 * needs, and once the script has exited this log is the only place they can still be read.
 *
 * @param stateFile - The state file, whose directory holds the log.
 * @param line - Text to record.
 */
export function appendBootLog(stateFile: string, line: string): void {
  try {
    const dir = join(stateFile, '..')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'boot.log'), `${new Date().toISOString()} ${line}\n`, 'utf-8')
  } catch {
    // Diagnostics must never be the reason a message fails to send.
  }
}

/** Upload media type per outbound kind, matching what the plugin sends for the same file. */
const UPLOAD_TYPE_BY_KIND = MEDIA_TYPE_BY_KIND

/** Sender per outbound kind: each item type has its own shape on the wire. */
const SENDER_BY_KIND: Record<
  MediaKind,
  (params: {
    account: WeixinAccount
    to: string
    uploaded: Awaited<ReturnType<typeof uploadMedia>>
    contextToken?: string
    signal?: AbortSignal
  }) => Promise<{ clientId: string; serverMessageId?: string }>
> = {
  image: sendImage,
  video: sendVideo,
  file: sendFile,
}

/**
 * Read a file, naming the path when it is missing.
 *
 * A bare `ENOENT` does not say which file, and in a script that sends several this is the one detail
 * that decides whether the failure can be acted on.
 *
 * @param path - File to read.
 */
async function readFileOrThrow(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    throw new Error(`读不到文件 ${path}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The real provider: the state file under `DSH_HOME`, the shared quota, and the core senders.
 *
 * Nothing here reaches the service on its own — every outbound call is a `@dsh-wechat/core` function,
 * which is what keeps this command and the plugin one implementation of the protocol.
 *
 * @param stateFile - Override for the state file. Absent in normal use.
 * @returns A provider ready to be driven.
 */
export function defaultCliProvider(stateFile?: string): CliProvider {
  const file = stateFile ?? join(resolveHome(), 'wechat', 'state.json')
  const store = new StateStore(file)
  const log = (line: string): void => {
    appendBootLog(file, line)
  }
  return {
    stateFile: file,
    quota: quotaLedgerFor(store),
    log,
    target: async () => boundTarget(await store.read()),
    deliver: async (request) =>
      await sendText({
        account: request.account,
        to: request.to,
        text: request.text,
        ...(request.contextToken === undefined ? {} : { contextToken: request.contextToken }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }),
    attach: async ({ target, path, signal }) => {
      const fileName = basename(path)
      const data = await readFileOrThrow(path)
      const kind = mediaKindOf(fileName)
      const uploaded = await uploadMedia({
        account: target.account,
        toUserId: target.peerId,
        data,
        fileName,
        // The kind decides how the service stores the object: a video uploaded as a plain file arrives
        // as an opaque download instead of a playable clip.
        mediaType: UPLOAD_TYPE_BY_KIND[kind],
        ...(signal === undefined ? {} : { signal }),
      })
      await SENDER_BY_KIND[kind]({
        account: target.account,
        to: target.peerId,
        uploaded,
        ...(target.contextToken === undefined ? {} : { contextToken: target.contextToken }),
        ...(signal === undefined ? {} : { signal }),
      })
      return { fileName, size: data.length }
    },
  }
}

/**
 * Whether this module was started as a program, rather than imported by the launcher or a test.
 *
 * @param entry - `process.argv[1]`, injectable so the comparison itself can be tested.
 */
export function isDirectRun(entry: string | undefined = process.argv[1]): boolean {
  if (entry === undefined) return false
  if (import.meta.url === pathToFileURL(entry).href) return true
  /*
   * A package manager installs `bin` entries as symlinks on Unix, so `argv[1]` is the link while
   * `import.meta.url` is the file it points at. Comparing the two directly answers "not the program"
   * and the command exits having done nothing — which is exactly what happened on the CI runner
   * while passing on Windows, where the entry is a `.cmd` shim whose path happens to match.
   */
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    // An entry that cannot be resolved is not this module.
    return false
  }
}

/**
 * Entry point, kept for a direct `node lib/cli.js` invocation.
 *
 * @param argv - Arguments after the executable.
 * @param io - Where to write.
 * @param provider - Override for tests.
 * @returns The exit code; a queued message is `3`, which is documented and not a failure.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io?: CliIo,
  provider?: CliProvider,
): Promise<number> {
  const outcome = io === undefined ? await runCli(argv, undefined, provider) : await runCli(argv, io, provider)
  return outcome.code
}
