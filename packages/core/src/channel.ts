/**
 * The channel itself: long-poll inbound, send outbound, and the session guard.
 *
 * The loop mirrors Tencent's own monitor:
 *
 * - one long poll at a time, with the client timeout slightly longer than the
 *   server's suggestion so the server always wins the race and nothing is lost;
 * - the cursor is persisted before the messages in that batch are handled, so a
 *   crash mid-handling replays rather than drops;
 * - `errcode -14` pauses every call for this account for an hour instead of
 *   hammering an endpoint that cannot succeed;
 * - other failures retry, then back off.
 *
 * @module @dsh-wechat/core/channel
 */

import {
  BACKOFF_DELAY_MS,
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_BOT_AGENT,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  RETRY_DELAY_MS,
  SESSION_PAUSE_MS,
  STALE_TOKEN_ERRCODE,
} from './constants.ts'
import { TypingStatus } from './types.ts'
import { apiCall, assertSendAccepted, baseInfo, newClientId } from './http.ts'
import { isMediaItem } from './media.ts'
import type {
  GetConfigResp,
  GetUpdatesResp,
  MessageItem,
  SendMessageResp,
  SendTypingResp,
  WeixinAccount,
  WeixinMessage,
} from './types.ts'

/** A message ready to be delivered to the agent. */
export interface InboundMessage {
  accountId: string
  /** Counterparty: the WeChat user id. */
  peerId: string
  /** Group id when the message came from a group conversation. */
  groupId?: string
  /** Stable conversation key: account plus peer (plus group when present). */
  conversationId: string
  messageId?: string
  /** Required verbatim on the reply. */
  contextToken?: string
  text: string
  /**
   * Attachments the message carried, in wire order.
   *
   * Absent for text-only messages. A media-only message has empty `text` and this
   * populated, which is why `toInbound` cannot filter on text alone.
   */
  media?: MessageItem[]
  /** The untouched wire message, for features that need more than text. */
  raw: WeixinMessage
  receivedAt: number
}

/** Why the loop stopped, when it did. */
export type MonitorStopReason = 'stale-token' | 'aborted' | 'fatal'

export interface MonitorOptions {
  account: WeixinAccount
  /** Invoked once per inbound text message, sequentially. */
  onMessage: (message: InboundMessage) => Promise<void>
  /** Cursor restored from disk. */
  initialSyncBuf?: string
  /** Called whenever the server hands back a new cursor, so the caller can persist it. */
  onSyncBuf?: (buf: string) => Promise<void> | void
  /** Called on every loop error, for logging. */
  onError?: (error: unknown) => void
  /** Called when the loop decides to stop. */
  onStop?: (reason: MonitorStopReason, detail?: string) => void
  /** Identity hint reported in `base_info.bot_agent`. */
  botAgent?: string
  /** Injectable sleep, for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * One account's inbound pump.
 *
 * Construct, then `run(signal)`; the promise settles when the loop stops.
 */
export class ChannelMonitor {
  readonly #options: MonitorOptions
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  #syncBuf: string
  #longPollTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS
  #consecutiveFailures = 0
  /** Set when the account is inside the stale-token cooldown. */
  #pausedUntil = 0
  #typingTicket: string | undefined

  constructor(options: MonitorOptions) {
    this.#options = options
    this.#syncBuf = options.initialSyncBuf ?? ''
    this.#sleep = options.sleep ?? defaultSleep
  }

  /** Current cursor, for persistence by the caller. */
  get syncBuf(): string {
    return this.#syncBuf
  }

  /**
   * Restore a persisted cursor before the first poll.
   *
   * Must be called before {@link run}: the server treats the cursor as incremental,
   * so starting from empty would replay or drop whatever the account received while
   * the process was down.
   */
  restoreSyncBuf(buf: string): void {
    if (this.#syncBuf === '') this.#syncBuf = buf
  }

  /** True while the stale-token cooldown is active. */
  get paused(): boolean {
    return Date.now() < this.#pausedUntil
  }

  /** Milliseconds left in the cooldown, or zero. */
  get remainingPauseMs(): number {
    return Math.max(0, this.#pausedUntil - Date.now())
  }

  /**
   * Run until aborted, the token goes stale, or a fatal error occurs.
   *
   * @param signal - Abort to stop promptly, including an in-flight long poll.
   */
  async run(signal: AbortSignal): Promise<MonitorStopReason> {
    const { account } = this.#options

    while (!signal.aborted) {
      if (this.paused) {
        // Reproduce Tencent's own one-hour cooldown rather than retrying a call
        // that cannot succeed until the user re-binds.
        await this.#sleep(this.remainingPauseMs, signal)
        if (signal.aborted) break
        continue
      }

      let response: GetUpdatesResp
      try {
        response = await this.#getUpdates(account, signal)
      } catch (error) {
        if (signal.aborted) break
        this.#options.onError?.(error)
        this.#consecutiveFailures += 1
        await this.#sleep(this.#failureDelay(), signal)
        continue
      }

      if (typeof response.longpolling_timeout_ms === 'number' && response.longpolling_timeout_ms > 0) {
        this.#longPollTimeoutMs = response.longpolling_timeout_ms
      }

      const errcode = response.errcode ?? response.ret
      if (errcode !== undefined && errcode !== 0) {
        if (errcode === STALE_TOKEN_ERRCODE) {
          this.#pausedUntil = Date.now() + SESSION_PAUSE_MS
          this.#options.onStop?.('stale-token', 'bot token 已失效，需要重新扫码绑定')
          return 'stale-token'
        }
        this.#consecutiveFailures += 1
        this.#options.onError?.(
          new Error(`getupdates 失败 ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ''}`),
        )
        await this.#sleep(this.#failureDelay(), signal)
        continue
      }

      this.#consecutiveFailures = 0

      // Persist the cursor *before* dispatch: a crash while handling replays the
      // batch instead of losing it.
      if (response.get_updates_buf) {
        this.#syncBuf = response.get_updates_buf
        await this.#options.onSyncBuf?.(this.#syncBuf)
      }

      for (const raw of response.msgs ?? []) {
        const inbound = toInbound(account, raw)
        if (inbound === undefined) continue
        try {
          await this.#options.onMessage(inbound)
        } catch (error) {
          // One bad message must not kill the pump.
          this.#options.onError?.(error)
        }
      }
    }

    this.#options.onStop?.('aborted')
    return 'aborted'
  }

  /** Show or clear the "typing…" indicator for a peer. Best effort. */
  async setTyping(peerId: string, typing: boolean): Promise<void> {
    const { account } = this.#options
    try {
      if (this.#typingTicket === undefined) {
        /*
         * `ilink_user_id` is required here. Without it the service answers `ret: -2,
         * 'ilink_user_id required'` with HTTP 200, `typing_ticket` comes back undefined, and the
         * early return below turns the whole feature into a no-op — invisibly, because typing is
         * designed never to raise. That is exactly what happened: the indicator was implemented,
         * wired up, and never once appeared.
         */
        const config = await apiCall<GetConfigResp>({
          baseUrl: account.baseUrl,
          endpoint: 'ilink/bot/getconfig',
          body: { ilink_user_id: peerId },
          token: account.token,
          timeoutMs: 10_000,
        })
        const errcode = config.errcode ?? config.ret
        if (errcode !== undefined && errcode !== 0) {
          // Recorded rather than swallowed: a failure here is silent by nature, so the log is the
          // only place it can ever be noticed.
          this.#options.onError?.(
            new Error(
              `getconfig 失败 ret=${String(config.ret ?? '')} errcode=${String(config.errcode ?? '')} errmsg=${config.errmsg ?? ''}`,
            ),
          )
        }
        this.#typingTicket = config.typing_ticket
      }
      if (!this.#typingTicket) return
      await apiCall<SendTypingResp>({
        baseUrl: account.baseUrl,
        endpoint: 'ilink/bot/sendtyping',
        body: {
          ilink_user_id: peerId,
          typing_ticket: this.#typingTicket,
          status: typing ? TypingStatus.TYPING : TypingStatus.CANCEL,
        },
        token: account.token,
        timeoutMs: 10_000,
      })
    } catch (error) {
      // Typing is cosmetic: never surface a failure to the caller.
      this.#options.onError?.(error)
    }
  }

  /** Notify the server that this client is stopping. Best effort. */
  async notifyStop(): Promise<void> {
    const { account } = this.#options
    try {
      await apiCall({
        baseUrl: account.baseUrl,
        endpoint: 'ilink/bot/msg/notifystop',
        body: { base_info: baseInfo(this.#options.botAgent ?? DEFAULT_BOT_AGENT) },
        token: account.token,
        timeoutMs: 5_000,
      })
    } catch {
      // Nothing useful to do while shutting down.
    }
  }

  async #getUpdates(account: WeixinAccount, signal: AbortSignal): Promise<GetUpdatesResp> {
    // Client budget exceeds the server's suggestion so the server returns first.
    const clientTimeout = this.#longPollTimeoutMs + 5_000
    try {
      return await apiCall<GetUpdatesResp>({
        baseUrl: account.baseUrl,
        endpoint: 'ilink/bot/getupdates',
        body: {
          get_updates_buf: this.#syncBuf,
          base_info: baseInfo(this.#options.botAgent ?? DEFAULT_BOT_AGENT),
        },
        token: account.token,
        timeoutMs: clientTimeout,
        signal,
      })
    } catch (error) {
      // A held request we stopped waiting on is a normal empty tick.
      if (error instanceof Error && error.name === 'AbortError' && !signal.aborted) {
        return { ret: 0, msgs: [], get_updates_buf: this.#syncBuf }
      }
      throw error
    }
  }

  #failureDelay(): number {
    return this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS
  }
}

/**
 * Send one text message.
 *
 * @param params.account - Credentials for the sending bot.
 * @param params.to - Recipient user id.
 * @param params.text - Message body.
 * @param params.contextToken - Token from the inbound message being answered.
 * @returns The server message id, when the service returns one.
 */
export async function sendText(params: {
  account: WeixinAccount
  to: string
  text: string
  contextToken?: string
  runId?: string
  signal?: AbortSignal
}): Promise<{ clientId: string; serverMessageId?: string }> {
  const clientId = newClientId()
  const response = await apiCall<SendMessageResp>({
    baseUrl: params.account.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: {
      msg: {
        from_user_id: '',
        to_user_id: params.to,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: params.text ? [{ type: 1, text_item: { text: params.text } }] : undefined,
        ...(params.contextToken === undefined ? {} : { context_token: params.contextToken }),
        ...(params.runId === undefined ? {} : { run_id: params.runId }),
      },
    },
    token: params.account.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    signal: params.signal,
  })
  // Before reading `message_id`: a refused send carries no id, so a caller that only looks for the id
  // cannot tell "delivered without an id" from "refused".
  assertSendAccepted(response)
  return {
    clientId,
    ...(response.message_id === undefined ? {} : { serverMessageId: response.message_id }),
  }
}

/** Build a conversation key that stays stable across restarts. */
export function conversationKey(accountId: string, peerId: string, groupId?: string): string {
  return groupId ? `${accountId}:${groupId}:${peerId}` : `${accountId}:${peerId}`
}

/**
 * Convert a wire message into an inbound envelope.
 *
 * Returns `undefined` for anything this plugin does not handle: messages the bot
 * itself sent, and content that is neither text nor media. A media-only message is
 * kept — with empty text — because the media itself is the payload; dropping it here
 * is what made an incoming photo look like nothing had been sent at all.
 *
 * @param account - Account the message arrived on.
 * @param raw - Wire message.
 */
export function toInbound(account: WeixinAccount, raw: WeixinMessage): InboundMessage | undefined {
  // 2 is BOT: our own echo, which would otherwise loop back into the agent.
  if (raw.message_type === 2) return undefined
  const peerId = raw.from_user_id?.trim()
  if (!peerId) return undefined
  const text = extractText(raw)
  const media = mediaItems(raw)
  if (!text && media.length === 0) return undefined
  const conversationId = conversationKey(account.accountId, peerId, raw.group_id || undefined)
  return {
    accountId: account.accountId,
    peerId,
    ...(raw.group_id ? { groupId: raw.group_id } : {}),
    conversationId,
    ...(raw.message_id === undefined ? {} : { messageId: raw.message_id }),
    ...(raw.context_token === undefined ? {} : { contextToken: raw.context_token }),
    text,
    ...(media.length === 0 ? {} : { media }),
    raw,
    receivedAt: Date.now(),
  }
}

/**
 * Every item in the message that carries a downloadable attachment.
 *
 * Kept separate from {@link extractText} so a message can be text, media, or both
 * without either path deciding the other's fate.
 *
 * @param raw - Wire message.
 */
export function mediaItems(raw: WeixinMessage): MessageItem[] {
  return (raw.item_list ?? []).filter((item) => isMediaItem(item))
}

/** Concatenate every text element, and any voice transcript the server supplied. */
export function extractText(raw: WeixinMessage): string {
  const parts: string[] = []
  for (const item of raw.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) parts.push(item.text_item.text)
    // Inbound voice often carries a server-side transcript.
    else if (item.type === 3 && item.voice_item?.text) parts.push(item.voice_item.text)
  }
  return parts.join('\n').trim()
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
