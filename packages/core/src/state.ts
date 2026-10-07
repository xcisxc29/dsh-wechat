/**
 * Durable state for the channel: credentials, the long-poll cursor, and the
 * per-conversation reply token cache.
 *
 * Three things must survive a process restart:
 *
 * - **Credentials.** A bot token is long-lived; re-scanning on every boot would be
 *   unacceptable and, worse, would re-bind the account.
 * - **The poll cursor** (`get_updates_buf`). The server treats it as an incremental
 *   cursor, so dropping it loses whatever arrived while the process was down.
 * - **`context_token`s.** Issued per inbound message and required verbatim on the
 *   reply. The official client persists them per account and per peer for exactly
 *   this reason.
 *
 * Writes are atomic (temp file plus rename) so a crash cannot leave a half-written
 * credential file that locks the user out of their own bot.
 *
 * @module @dsh-wechat/core/state
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { WeixinAccount } from './types.ts'
import type { SessionBinding } from './router.ts'

/** Everything persisted for one channel deployment. */
export interface ChannelState {
  version: 1
  /** Bot accounts, keyed by `ilink_bot_id`. */
  accounts: Record<string, WeixinAccount>
  /** Incremental long-poll cursor, per account id. */
  syncBufs: Record<string, string>
  /**
   * Reply tokens, per account and then per **conversation**.
   *
   * Keyed by conversation rather than by peer on purpose: with several sessions in
   * play, a token captured in one conversation must never be echoed into another,
   * and the conversation key already distinguishes group from direct messages.
   */
  contextTokens: Record<string, Record<string, string>>
  /** Conversation-to-session mapping, so a chat keeps its session across restarts. */
  bindings: Record<string, SessionBinding>
  /**
   * Messages this channel sent, newest last, per account and then per conversation.
   *
   * A quoted message arrives as an id and nothing else — its `message_item` carries `type: 0`
   * and no text — so the quoted content exists nowhere unless we kept it. This is that record.
   * Bounded per conversation, since only a recent message is ever quoted.
   */
  sentMessages: Record<string, Record<string, SentMessage[]>>
  /** Whether the channel should reconnect on boot. */
  autoStart?: boolean
  /**
   * Behaviour the user tunes from the settings page.
   *
   * Kept in the state file rather than in plugin config so a change takes effect on the next
   * message instead of requiring a restart — these are all per-message decisions, and a restart
   * to adjust a wait window is a poor trade.
   */
  settings?: ChannelSettings
}

/**
 * Tuned behaviour, with every field optional so a stored file stays readable across versions.
 *
 * Defaults live in {@link DEFAULT_SETTINGS}; anything absent falls back to them.
 */
export interface ChannelSettings {
  /** Quiet time after a non-text message before it is answered on its own, in milliseconds. */
  mergeWindowMs?: number
  /** Reply text longer than this is sent as a file instead of a message. */
  maxReplyChars?: number
  /** Quiet time that ends a burst of assistant output into one message, in milliseconds. */
  settleMs?: number
  /** How many sent messages to retain per conversation, for resolving quotes. */
  quoteHistory?: number
  /** Whether a non-text message is answered on its own once the window elapses. */
  autoReplyAttachments?: boolean
  /**
   * Whether the agent must confirm a session action with the user before taking it.
   *
   * On by default. The agent decides when to call the session tool, so a misreading would change
   * where the user's work goes with nothing to catch it — the confirmation is what stands between
   * an inferred intent and an effect.
   */
  requireConfirmation?: boolean
  /**
   * Standing note prepended to every prompt, telling the agent it is on WeChat.
   *
   * Editable because the wording is a judgement call, but present by default: without it the
   * agent answers as if its user sits at the desktop console.
   */
  presenceNote?: string
  /**
   * Permission preset applied to every session this channel creates.
   *
   * Defaults to `danger-full-access`, because the other option is unusable from a phone: a session
   * that asks before each tool call sends a prompt to WeChat and stops until the user answers, which
   * on a phone means every command stalls on a conversation. The user chose the phone precisely to
   * stop sitting at the desktop, so a prompt they must come back to is a prompt they will not answer.
   *
   * `default` leaves whatever the DSH profile is configured with, for people who want the same
   * guardrails on WeChat as at the console.
   *
   * The preset can only be applied before a session's first turn — DSH locks it after that — so this
   * is set when the channel creates or adopts a session and cannot retroactively change one that has
   * already run.
   */
  permissionPreset?: PermissionPreset
  /**
   * Whether a session that is not the bound one may push to the WeChat conversation.
   *
   * **On by default**, and that default is the point of the feature: the reason to run DSH from a
   * phone is to leave the desk, and a task that finishes while the user is away is worthless if its
   * result cannot reach them. Whoever is doing the work can then say so.
   *
   * What it costs: any session on this machine can reach the user's phone. That is a deliberate
   * widening, and it is not the bug that removed `sessionOwners` — that was a session *impersonating*
   * a conversation it no longer had, while this only ever delivers *to* the conversation the user is
   * currently in. Turn it off to restore the stricter rule, where only the bound session may send.
   */
  allowCrossSessionNotify?: boolean
}

/** Permission presets this channel will apply to its own sessions. */
export type PermissionPreset = 'danger-full-access' | 'auto' | 'default'

/** Values applied when a setting has never been stored. */
export const DEFAULT_SETTINGS = {
  mergeWindowMs: 10_000,
  maxReplyChars: 4_000,
  settleMs: 1_200,
  quoteHistory: 40,
  autoReplyAttachments: true,
  requireConfirmation: true,
  permissionPreset: 'danger-full-access',
  allowCrossSessionNotify: true,
  presenceNote:
    '[渠道：微信] 你在和微信上的用户对话，对方在手机上，看不到这台电脑的屏幕和文件系统。' +
    '不要让他去"打开某个路径"或"看某个文件"。需要给他看东西时，直接发送：' +
    '图片或视频会显示成照片/视频，其他文件会作为附件发过去。' +
    '回复尽量简短，适合手机阅读。',
} as const

/**
 * Resolve the stored settings against the defaults.
 *
 * @param state - State to read from.
 * @returns Every setting, with defaults filled in.
 */
export function resolveSettings(state: ChannelState): Required<ChannelSettings> {
  const stored = state.settings ?? {}
  return {
    mergeWindowMs: stored.mergeWindowMs ?? DEFAULT_SETTINGS.mergeWindowMs,
    maxReplyChars: stored.maxReplyChars ?? DEFAULT_SETTINGS.maxReplyChars,
    settleMs: stored.settleMs ?? DEFAULT_SETTINGS.settleMs,
    quoteHistory: stored.quoteHistory ?? DEFAULT_SETTINGS.quoteHistory,
    autoReplyAttachments:
      stored.autoReplyAttachments ?? DEFAULT_SETTINGS.autoReplyAttachments,
    requireConfirmation: stored.requireConfirmation ?? DEFAULT_SETTINGS.requireConfirmation,
    permissionPreset: stored.permissionPreset ?? DEFAULT_SETTINGS.permissionPreset,
    allowCrossSessionNotify:
      stored.allowCrossSessionNotify ?? DEFAULT_SETTINGS.allowCrossSessionNotify,
    presenceNote: stored.presenceNote ?? DEFAULT_SETTINGS.presenceNote,
  }
}

/** One message this channel sent, retained so a quote of it can be resolved. */
export interface SentMessage {
  /** Server-assigned identity, which is what a quote refers to. */
  messageId: string
  /** Item kind it went out as, so a quote of an attachment can be answered sensibly. */
  kind: 'text' | 'image' | 'video' | 'file'
  /** Body preview for text, or the file name for an attachment. */
  preview: string
  /** When it was sent, for pruning. */
  at: number
}

/** How many sent messages to retain per conversation. */
export const SENT_MESSAGE_HISTORY = 40

const EMPTY_STATE: ChannelState = {
  version: 1,
  accounts: {},
  syncBufs: {},
  contextTokens: {},
  bindings: {},
  sentMessages: {},
}

/**
 * Retain one sent message so a later quote of it can be resolved.
 *
 * Old entries are dropped from the front, so the record stays bounded no matter how long the
 * channel runs. Only recent messages are ever quoted, so nothing useful is lost.
 *
 * @param state - State to mutate.
 * @param accountId - Account the message went out on.
 * @param conversationId - Conversation it went to.
 * @param message - What was sent.
 */
export function rememberSentMessage(
  state: ChannelState,
  accountId: string,
  conversationId: string,
  message: SentMessage,
  limit: number = SENT_MESSAGE_HISTORY,
): void {
  const perAccount = (state.sentMessages[accountId] ??= {})
  const history = (perAccount[conversationId] ??= [])
  history.push(message)
  if (limit >= 0 && history.length > limit) {
    history.splice(0, history.length - limit)
  }
}

/**
 * Find a message this channel sent, by the id a quote refers to.
 *
 * Searched across every conversation of the account rather than one: the quote carries an id
 * and no conversation, and an id is unique, so looking wider can only help.
 *
 * @param state - State to search.
 * @param accountId - Account the quote arrived on.
 * @param messageId - Id taken from the quote.
 * @returns The recorded message, or undefined when it was not ours or has aged out.
 */
export function findSentMessage(
  state: ChannelState,
  accountId: string,
  messageId: string,
): SentMessage | undefined {
  for (const history of Object.values(state.sentMessages[accountId] ?? {})) {
    for (const entry of history) if (entry.messageId === messageId) return entry
  }
  return undefined
}

/** Composed storage for one state file. */
export class StateStore {
  readonly file: string
  #cache: ChannelState | undefined
  /** In-flight disk load, shared by concurrent {@link read} calls. */
  #loading: Promise<ChannelState> | undefined
  /** Serializes concurrent writes; the channel is event-driven and re-entrant. */
  #writeChain: Promise<void> = Promise.resolve()

  /**
   * @param file - Absolute path of the state file. Parent directories are created on demand.
   */
  constructor(file: string) {
    this.file = file
  }

  /** Resolve the default state path under a DSH home directory. */
  static under(dshHome: string): StateStore {
    return new StateStore(join(dshHome, 'wechat', 'state.json'))
  }

  /** Read the current state, tolerating a missing or corrupt file. */
  async read(): Promise<ChannelState> {
    // Share one in-flight load between concurrent callers. Without this, a second
    // `read()` that starts before the first finishes would fall back to an empty
    // state and cache it, silently discarding everything already on disk — which is
    // how a concurrent update could wipe accounts that had been seeded or adopted.
    this.#loading ??= this.#load()
    return await this.#loading
  }

  /** Load from disk once, caching the result. Only called through {@link read}. */
  async #load(): Promise<ChannelState> {
    if (this.#cache !== undefined) return this.#cache
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf-8')) as Partial<ChannelState>
      this.#cache = normalize(parsed)
    } catch {
      // A missing file is the normal first run; a corrupt one must not be fatal,
      // because the user can always log in again.
      this.#cache = structuredClone(EMPTY_STATE)
    }
    return this.#cache
  }

  /**
   * Apply a mutation and persist the result.
   *
   * @param mutate - Receives the live state object and may change it in place.
   */
  async update(mutate: (state: ChannelState) => void): Promise<void> {
    const state = await this.read()
    mutate(state)
    // Chain writes so two concurrent updates cannot interleave their renames.
    this.#writeChain = this.#writeChain.then(() => this.#persist(state))
    await this.#writeChain
  }

  /** Drop every artifact for one account. Used when a token goes stale. */
  async forgetAccount(accountId: string): Promise<void> {
    await this.update((state) => {
      delete state.accounts[accountId]
      delete state.syncBufs[accountId]
      delete state.contextTokens[accountId]
      for (const [key, binding] of Object.entries(state.bindings)) {
        if (binding.accountId === accountId) delete state.bindings[key]
      }
    })
  }

  async #persist(state: ChannelState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    // mode 0600: the file holds a bearer token that grants full bot access.
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
    try {
      await rename(temp, this.file)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
}

/** Coerce a possibly-foreign object into a well-formed state. */
function normalize(parsed: Partial<ChannelState>): ChannelState {
  return {
    version: 1,
    accounts: isRecord(parsed.accounts) ? (parsed.accounts as Record<string, WeixinAccount>) : {},
    syncBufs: isRecord(parsed.syncBufs) ? (parsed.syncBufs as Record<string, string>) : {},
    contextTokens: isRecord(parsed.contextTokens)
      ? (parsed.contextTokens as Record<string, Record<string, string>>)
      : {},
    bindings: isRecord(parsed.bindings) ? (parsed.bindings as Record<string, SessionBinding>) : {},
    sentMessages: isRecord(parsed.sentMessages)
      ? (parsed.sentMessages as Record<string, Record<string, SentMessage[]>>)
      : {},
    ...(isRecord(parsed.settings) ? { settings: normalizeSettings(parsed.settings) } : {}),
    ...(typeof parsed.autoStart === 'boolean' ? { autoStart: parsed.autoStart } : {}),
  }
}

/**
 * Keep only settings of the expected type.
 *
 * The file is user-editable and survives upgrades, so a hand-written string where a number
 * belongs must not reach arithmetic that would turn it into NaN and disable a timer silently.
 *
 * @param raw - The stored settings object.
 * @returns The usable subset.
 */
function normalizeSettings(raw: Record<string, unknown>): ChannelSettings {
  const settings: ChannelSettings = {}
  for (const key of ['mergeWindowMs', 'maxReplyChars', 'settleMs', 'quoteHistory'] as const) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) settings[key] = value
  }
  if (typeof raw.autoReplyAttachments === 'boolean') {
    settings.autoReplyAttachments = raw.autoReplyAttachments
  }
  if (typeof raw.requireConfirmation === 'boolean') {
    settings.requireConfirmation = raw.requireConfirmation
  }
  if (typeof raw.presenceNote === 'string') settings.presenceNote = raw.presenceNote
  return settings
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
