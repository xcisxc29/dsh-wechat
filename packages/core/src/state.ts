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

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { WeixinAccount } from './types.ts'
import { normalizeQuota, type QuotaEntry } from './quota.ts'
import type { BrowsePosition, SessionBinding } from './router.ts'

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
  /**
   * Numbered session lists this channel has sent, so a quote of one still means what it meant.
   *
   * A number identifies a row of a listing, and a listing is a photograph of a machine that keeps
   * moving: sessions run, others go quiet, and the same number means a different conversation a
   * minute later. A quote names one exact message, so the numbering printed in it can be frozen here
   * when it is sent and read back when the user replies — which is the difference between "switch to
   * 3" meaning the row they are looking at and meaning whichever row happens to be third now.
   *
   * Keyed per account and then per conversation, like {@link ChannelState.sentMessages}, and bounded
   * per conversation: only a recent list is ever quoted.
   */
  sessionLists?: Record<string, Record<string, SessionListMessage[]>>
  /**
   * Where each conversation is in the two-level listing browser, per account.
   *
   * Persisted because 「查看其余」 has no target: it means "the next ten of what I am looking at", and
   * nothing else in the system knows what that is. Kept per **conversation**, not per plugin, because
   * one channel serves several chats and each is standing somewhere different.
   *
   * The entry is small on purpose — a level, a directory and a page number, never a snapshot of the
   * list. A snapshot would make 「查看其余」 immune to the machine moving underneath it, but it would
   * also make every listing write a copy of the session list into a file that is rewritten whole on
   * every message, which is the opposite of what this file is for.
   */
  browsing?: Record<string, Record<string, BrowsePosition>>
  /**
   * Proactive messages the service refused, waiting for the reply window to reopen.
   *
   * The window that allows a send is opened by an inbound message, so a push that arrives too late is
   * refused — and until this queue existed it was simply lost, silently: several permission prompts
   * and result summaries never reached the phone while the log said they had been sent.
   *
   * Kept in the state file rather than in memory so a restart does not discard them, and bounded by
   * both count and age so a long silence cannot grow the file without limit.
   */
  pendingNotifications?: PendingNotification[]
  /**
   * Sends charged against the reply token in use, per conversation.
   *
   * Persisted rather than counted in memory, and that is the point of the field: the count decides
   * when the user is asked for a new window, and the ask has to arrive *before* the last slot is
   * spent. A restart used to lose the count, so a process that came back mid-window believed the ten
   * were untouched and spent the remainder on messages that were refused instead of on warning the
   * user first. `dsh-wechat-send` reads and writes the same entries, so a script and the plugin add
   * up to one count rather than two.
   */
  quota?: Record<string, QuotaEntry>
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
  /**
   * Directory the channel's sessions run in, or empty for the default under the DSH home.
   *
   * Read once, during `apply`: a session's `cwd` is pinned when it is created. Changing it
   * therefore moves the sessions created afterwards and leaves the existing ones on the old
   * directory, which is why the settings page says a restart is needed.
   */
  workspacePath?: string
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
  workspacePath: '',
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
    workspacePath: stored.workspacePath ?? DEFAULT_SETTINGS.workspacePath,
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

/**
 * One numbered session list the channel sent, kept so a quote of it resolves the same way twice.
 *
 * Only what a numbering needs is stored: the position of each row is its index in `sessions`, and the
 * id and title are enough to switch to it. Times and workspace names are deliberately left out —
 * they are what a *new* listing is for, and keeping them would make a frozen listing grow stale in
 * ways the user could see.
 */
export interface SessionListMessage {
  /** Server-assigned id of the message that printed this numbering. */
  messageId: string
  /** The rows in the order that message numbered them. */
  sessions: { sessionId: string; title: string }[]
  /**
   * The number printed beside `sessions[0]`.
   *
   * Stored because numbering runs on across screens: a message showing rows 11..20 is quoted with
   * "14", and an array read from index 1 would answer with row 4 — a conversation that message never
   * printed. Written as 1 for a first screen, which is also what an entry stored before paging
   * existed is read back as.
   */
  first: number
  /** When it was sent, for pruning. */
  at: number
}

/** How many numbered lists to retain per conversation. */
export const SESSION_LIST_HISTORY = 5

/**
 * How much of a conversation title a stored listing keeps.
 *
 * A session is named from the user's first sentence, which is routinely a whole paragraph, and this
 * file is rewritten in full on every change — a binding, a quota count, every reply. Five listings of
 * ten paragraph-long titles would make that write megabytes. The title here only has to be recognisable
 * in a switch confirmation, so the head of it is enough.
 */
export const SESSION_LIST_TITLE_LIMIT = 120

/**
 * Record one numbered listing, dropping the oldest when the record is full.
 *
 * @param state - State to mutate.
 * @param accountId - Account the listing went out on.
 * @param conversationId - Conversation it went to.
 * @param entry - The listing: the message id and the rows it numbered.
 * @param limit - How many listings to keep per conversation.
 */
export function rememberSessionList(
  state: ChannelState,
  accountId: string,
  conversationId: string,
  entry: SessionListMessage,
  limit: number = SESSION_LIST_HISTORY,
): void {
  const perAccount = (state.sessionLists ??= {})
  const perConversation = (perAccount[accountId] ??= {})
  const history = (perConversation[conversationId] ??= [])
  history.push({
    messageId: entry.messageId,
    sessions: entry.sessions.map((row) => ({
      sessionId: row.sessionId,
      title: row.title.slice(0, SESSION_LIST_TITLE_LIMIT),
    })),
    first: entry.first,
    at: entry.at,
  })
  if (limit >= 0 && history.length > limit) history.splice(0, history.length - limit)
}

/**
 * Find the listing a quoted message printed.
 *
 * Searched across every conversation of the account, for the same reason as
 * {@link findSentMessage}: the quote carries an id and no conversation, and an id is unique.
 *
 * @param state - State to search.
 * @param accountId - Account the quote arrived on.
 * @param messageId - Id taken from the quote.
 * @returns The recorded numbering, or undefined when that message was not a listing or has aged out.
 */
export function findSessionList(
  state: ChannelState,
  accountId: string,
  messageId: string,
): SessionListMessage | undefined {
  for (const history of Object.values(state.sessionLists?.[accountId] ?? {})) {
    // Newest first: a message id appears once, but scanning backwards costs nothing and matches the
    // order the entries were written in.
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index]
      if (entry?.messageId === messageId) return entry
    }
  }
  return undefined
}

/**
 * The newest listing sent into one conversation.
 *
 * Used when the user replies with a bare number and quotes nothing: the listing they most likely
 * still have on screen is the one this conversation last received. Reading it rather than re-deriving
 * the numbering from live sessions is what keeps a number from drifting onto a different conversation
 * while the user is reading.
 *
 * @param state - State to search.
 * @param accountId - Account the listing went out on.
 * @param conversationId - Conversation it went to.
 * @returns The recorded numbering, or undefined when none was sent.
 */
export function latestSessionList(
  state: ChannelState,
  accountId: string,
  conversationId: string,
): SessionListMessage | undefined {
  const history = state.sessionLists?.[accountId]?.[conversationId]
  return history?.[history.length - 1]
}

/**
 * Record where a conversation is in the listing browser.
 *
 * @param state - State to mutate.
 * @param accountId - Account the conversation belongs to.
 * @param conversationId - Conversation to record for.
 * @param position - The place it has reached.
 */
export function rememberBrowse(
  state: ChannelState,
  accountId: string,
  conversationId: string,
  position: BrowsePosition,
): void {
  const perAccount = (state.browsing ??= {})
  const perConversation = (perAccount[accountId] ??= {})
  perConversation[conversationId] = {
    level: position.level,
    workspace: position.workspace,
    page: position.page,
    at: position.at,
  }
}

/**
 * Where a conversation is in the listing browser, if it is anywhere.
 *
 * @param state - State to read.
 * @param accountId - Account the conversation belongs to.
 * @param conversationId - Conversation to look up.
 * @returns The stored position, or undefined when this conversation is not browsing.
 */
export function findBrowse(
  state: ChannelState,
  accountId: string,
  conversationId: string,
): BrowsePosition | undefined {
  return state.browsing?.[accountId]?.[conversationId]
}

/**
 * Forget a conversation's place in the listing browser.
 *
 * Called both when the user moves on and when a position is found to be stale, so the state file
 * does not accumulate a row per conversation that ever asked for a listing.
 *
 * @param state - State to mutate.
 * @param accountId - Account the conversation belongs to.
 * @param conversationId - Conversation to forget.
 */
export function forgetBrowse(
  state: ChannelState,
  accountId: string,
  conversationId: string,
): void {
  const perAccount = state.browsing?.[accountId]
  if (perAccount === undefined) return
  delete perAccount[conversationId]
  if (Object.keys(perAccount).length === 0) delete state.browsing?.[accountId]
}

/**
 * A proactive message that could not be delivered, kept for the next open window.
 *
 * Deliberately holds the file's *path*, not its bytes: the queue is written to the state file on
 * every change, and embedding attachments would turn a small JSON document into something that grows
 * with every missed screenshot. The cost is that a file deleted between queueing and delivery cannot
 * be sent, which is reported rather than retried forever.
 */
export interface PendingNotification {
  /**
   * Identity, so a delivered entry can be removed exactly.
   *
   * Matching on its fields instead would remove both copies of two identical messages queued in the
   * same millisecond, which is the one case where a duplicate is worth keeping.
   */
  id: string
  /** Conversation it was meant for. Only a message from this one reopens the window. */
  conversationId: string
  /** Text to send. May be empty when only a file was owed. */
  text: string
  /** Absolute path of the file to send after the text, when there was one. */
  path?: string
  /** When it was queued, for the age bound and for saying how late it is. */
  queuedAt: number
}

/** How many undelivered notifications to keep. */
export const PENDING_NOTIFICATION_LIMIT = 20

/** How long an undelivered notification stays worth sending. */
export const PENDING_NOTIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Add one undelivered notification, dropping the oldest when the queue is full.
 *
 * Oldest-first because the queue is a backlog the user will read in order: when it overflows, the
 * least relevant entry is the one at the front, not the one just added.
 *
 * @param state - State to mutate.
 * @param entry - The notification to keep; `id` and `queuedAt` are filled in.
 * @param now - Current time, injected so tests need no clock.
 * @param limit - How many entries to keep.
 * @returns How many entries were dropped to make room.
 */
export function queuePendingNotification(
  state: ChannelState,
  entry: Omit<PendingNotification, 'id' | 'queuedAt'> & { id?: string; queuedAt?: number },
  now: number = Date.now(),
  limit: number = PENDING_NOTIFICATION_LIMIT,
): number {
  const queue = (state.pendingNotifications ??= [])
  queue.push({ ...entry, id: entry.id ?? randomUUID(), queuedAt: entry.queuedAt ?? now })
  let dropped = 0
  // `limit >= 0` mirrors the sent-message helper: a limit of 0 means "keep nothing", not "no bound".
  while (limit >= 0 && queue.length > limit) {
    queue.shift()
    dropped += 1
  }
  return dropped
}

/**
 * Drop notifications too old to be worth sending.
 *
 * Without this a channel left running for a month would deliver month-old messages the first time
 * the user said hello, which reads as a malfunction rather than a backlog.
 *
 * @param state - State to mutate.
 * @param now - Current time, injected so tests need no clock.
 * @param maxAgeMs - How long an entry stays valid.
 * @returns The entries that were dropped, oldest first.
 */
export function expirePendingNotifications(
  state: ChannelState,
  now: number = Date.now(),
  maxAgeMs: number = PENDING_NOTIFICATION_MAX_AGE_MS,
): PendingNotification[] {
  const queue = state.pendingNotifications
  if (queue === undefined || queue.length === 0) return []
  const expired = queue.filter((entry) => now - entry.queuedAt > maxAgeMs)
  if (expired.length > 0) {
    state.pendingNotifications = queue.filter((entry) => now - entry.queuedAt <= maxAgeMs)
  }
  return expired
}

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

  /** Read the current state; only a missing file starts empty. */
  async read(): Promise<ChannelState> {
    // Share one in-flight load between concurrent callers. Without this, a second
    // `read()` that starts before the first finishes would fall back to an empty
    // state and cache it, silently discarding everything already on disk — which is
    // how a concurrent update could wipe accounts that had been seeded or adopted.
    this.#loading ??= this.#load().catch((error) => {
      this.#loading = undefined
      throw error
    })
    return await this.#loading
  }

  /** Load from disk once, caching the result. Only called through {@link read}. */
  async #load(): Promise<ChannelState> {
    if (this.#cache !== undefined) return this.#cache
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf-8'))
      if (!isRecord(parsed)) {
        throw new Error(`微信状态文件格式无效：${this.file}。请修复原文件后重试。`)
      }
      this.#cache = normalize(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        if (error instanceof SyntaxError) {
          // JSON.parse errors can include credential text from the file.
          throw new Error(`无法解析微信状态文件：${this.file}。原文件已保留，请修复后重试。`)
        }
        throw error
      }
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
    const write = this.#writeChain.then(() => this.#persist(state))
    this.#writeChain = write.catch(() => {})
    await write
  }

  /** Drop every artifact for one account. Used when a token goes stale. */
  async forgetAccount(accountId: string): Promise<void> {
    await this.update((state) => {
      delete state.accounts[accountId]
      delete state.syncBufs[accountId]
      delete state.contextTokens[accountId]
      if (state.sessionLists !== undefined) delete state.sessionLists[accountId]
      // A position is only meaningful for a conversation that can still be reached, and the
      // conversations go with the account.
      if (state.browsing !== undefined) delete state.browsing[accountId]
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
    /*
     * Validated entry by entry, like the pending queue.
     *
     * This is the field the handbook warns about: `normalize` is an allowlist, so a field added to
     * `ChannelState` and forgotten here is silently dropped on the next write — settings that save
     * fine and are gone after a restart. It is also read back and *acted on*: a session list with a
     * missing conversation or a row without an id would resolve a number to nothing at all.
     */
    ...(isRecord(parsed.sessionLists) ? { sessionLists: normalizeSessionLists(parsed.sessionLists) } : {}),
    /*
     * Validated entry by entry, like the listings above, and for the same reason: this is read back
     * and acted on. A page number that arrived as a string would make 「查看其余」 arithmetic produce
     * NaN, and a level that is neither of the two known ones would send the router down a branch that
     * does not exist. The loss is one stale position, which the next `/list` replaces.
     */
    ...(isRecord(parsed.browsing) ? { browsing: normalizeBrowsing(parsed.browsing) } : {}),
    /*
     * Filtered rather than trusted. This array is read back and sent to the user, so an entry with a
     * missing conversation or a non-string text would reach the send path as `undefined`.
     */
    ...(Array.isArray(parsed.pendingNotifications)
      ? { pendingNotifications: parsed.pendingNotifications.filter(isPendingNotification) }
      : {}),
    /*
     * Always written, even when empty, and validated entry by entry.
     *
     * This field is the reason the omission it prevents was worth a handbook section: `normalize` is
     * an allowlist, so a field added to `ChannelState` but not here is silently discarded on the next
     * write. The count decides whether the user is asked for a new window in time, so losing it
     * quietly is the same failure the settings page had — data that saves fine and is gone after a
     * restart.
     */
    quota: normalizeQuota(parsed.quota),
    ...(isRecord(parsed.settings) ? { settings: normalizeSettings(parsed.settings) } : {}),
    ...(typeof parsed.autoStart === 'boolean' ? { autoStart: parsed.autoStart } : {}),
  }
}

/**
 * Whether a stored entry is a usable pending notification.
 *
 * @param raw - One entry from the state file.
 * @returns True when every required field is present and of the right type.
 */
function isPendingNotification(raw: unknown): raw is PendingNotification {
  if (!isRecord(raw)) return false
  return (
    typeof raw.id === 'string' &&
    typeof raw.conversationId === 'string' &&
    typeof raw.text === 'string' &&
    typeof raw.queuedAt === 'number' &&
    (raw.path === undefined || typeof raw.path === 'string')
  )
}

/**
 * Keep only the numbered listings that are usable.
 *
 * A listing without a message id can never be found by a quote, and one with a malformed row would
 * resolve a number to a session id of `undefined` — which reaches the session controller as a
 * request to adopt nothing. Both are dropped rather than repaired: the cost is one stale number,
 * and the alternative is guessing at what the user was looking at.
 *
 * @param raw - The stored `sessionLists` object.
 * @returns The usable subset, in the stored order.
 */
function normalizeSessionLists(
  raw: Record<string, unknown>,
): Record<string, Record<string, SessionListMessage[]>> {
  const result: Record<string, Record<string, SessionListMessage[]>> = {}
  for (const [accountId, conversations] of Object.entries(raw)) {
    if (!isRecord(conversations)) continue
    const kept: Record<string, SessionListMessage[]> = {}
    for (const [conversationId, history] of Object.entries(conversations)) {
      if (!Array.isArray(history)) continue
      const entries: SessionListMessage[] = []
      for (const candidate of history) {
        const entry = asSessionListMessage(candidate)
        if (entry !== undefined) entries.push(entry)
      }
      if (entries.length > 0) kept[conversationId] = entries
    }
    if (Object.keys(kept).length > 0) result[accountId] = kept
  }
  return result
}

/**
 * Coerce one stored entry into a usable numbered listing, copying the fields it validates.
 *
 * A listing without a message id can never be found by a quote, and one with a malformed row would
 * resolve a number to a session id of `undefined` — which reaches the session controller as a request
 * to adopt nothing. Both are dropped rather than repaired: the cost is one stale number, and the
 * alternative is guessing at what the user was looking at. The copy is what keeps `first` from being
 * absent on an entry written before paging existed — see {@link SessionListMessage.first}.
 *
 * @param raw - One entry from the state file.
 * @returns The usable entry, or undefined when it cannot resolve a number to a real session.
 */
function asSessionListMessage(raw: unknown): SessionListMessage | undefined {
  if (!isRecord(raw)) return undefined
  if (typeof raw.messageId !== 'string' || raw.messageId === '') return undefined
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined
  if (!Array.isArray(raw.sessions) || raw.sessions.length === 0) return undefined
  const sessions: { sessionId: string; title: string }[] = []
  for (const row of raw.sessions) {
    if (!isRecord(row) || typeof row.sessionId !== 'string' || typeof row.title !== 'string') {
      return undefined
    }
    sessions.push({ sessionId: row.sessionId, title: row.title })
  }
  const first = raw.first === undefined ? 1 : raw.first
  if (typeof first !== 'number' || !Number.isInteger(first) || first < 1) return undefined
  return { messageId: raw.messageId, sessions, first, at: raw.at }
}

/**
 * Keep only the browsing positions that are usable.
 *
 * A position that does not name a known level or carries a page that is not a positive integer cannot
 * be continued, and continuing it wrongly is worse than starting over: 「查看其余」 would page from a
 * number nobody chose. Dropping costs the user one `/list all`.
 *
 * @param raw - The stored `browsing` object.
 * @returns The usable subset, in the stored order.
 */
function normalizeBrowsing(
  raw: Record<string, unknown>,
): Record<string, Record<string, BrowsePosition>> {
  const result: Record<string, Record<string, BrowsePosition>> = {}
  for (const [accountId, conversations] of Object.entries(raw)) {
    if (!isRecord(conversations)) continue
    const kept: Record<string, BrowsePosition> = {}
    for (const [conversationId, entry] of Object.entries(conversations)) {
      const position = asBrowsePosition(entry)
      if (position !== undefined) kept[conversationId] = position
    }
    if (Object.keys(kept).length > 0) result[accountId] = kept
  }
  return result
}

/**
 * Whether a stored entry is a resumable browsing position.
 *
 * @param raw - One entry from the state file.
 * @returns The position, or undefined when it cannot be continued.
 */
function asBrowsePosition(raw: unknown): BrowsePosition | undefined {
  if (!isRecord(raw)) return undefined
  const level = raw.level
  if (level !== 'folders' && level !== 'sessions') return undefined
  if (typeof raw.workspace !== 'string') return undefined
  if (typeof raw.page !== 'number' || !Number.isInteger(raw.page) || raw.page < 1) return undefined
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined
  return { level, workspace: raw.workspace, page: raw.page, at: raw.at }
}

/**
 * One validator per setting, keyed the way the state file stores it.
 *
 * A mapped type over every setting rather than a hand-copied list, because the hand-copied list is
 * what broke: it kept four numbers and three booleans, so `permissionPreset`,
 * `allowCrossSessionNotify` and `workspacePath` were all discarded on load. A saved setting
 * survived until the next write, then vanished — every write reloads and re-normalizes — which is
 * why the page appeared to forget everything across a restart. Adding a setting without a validator
 * here is now a compile error, so the same omission cannot happen again.
 *
 * @param raw - The stored value for one setting.
 * @returns The usable value, or undefined when it is the wrong shape.
 */
const SETTING_VALIDATORS: {
  [K in keyof Required<ChannelSettings>]: (raw: unknown) => ChannelSettings[K] | undefined
} = {
  mergeWindowMs: (raw) => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined),
  maxReplyChars: (raw) => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined),
  settleMs: (raw) => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined),
  quoteHistory: (raw) => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined),
  autoReplyAttachments: (raw) => (typeof raw === 'boolean' ? raw : undefined),
  requireConfirmation: (raw) => (typeof raw === 'boolean' ? raw : undefined),
  presenceNote: (raw) => (typeof raw === 'string' ? raw : undefined),
  permissionPreset: (raw) =>
    raw === 'danger-full-access' || raw === 'auto' || raw === 'default' ? raw : undefined,
  allowCrossSessionNotify: (raw) => (typeof raw === 'boolean' ? raw : undefined),
  workspacePath: (raw) => (typeof raw === 'string' ? raw : undefined),
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
  const settings: Record<string, unknown> = {}
  for (const key of Object.keys(SETTING_VALIDATORS)) {
    const validate = SETTING_VALIDATORS[key as keyof typeof SETTING_VALIDATORS]
    const value = validate(raw[key])
    if (value !== undefined) settings[key] = value
  }
  return settings as ChannelSettings
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
