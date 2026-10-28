/**
 * Host half of the WeChat channel.
 *
 * It owns one long-poll monitor per logged-in bot account, routes inbound messages
 * into DSH sessions, and forwards assistant output back to the chat. All protocol
 * work lives in `@dsh-wechat/core`; this file is the glue to the host.
 *
 * @module dsh-wechat-plugin/host
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import {
  ChannelMonitor,
  SessionRouter,
  StateStore,
  UploadMediaType,
  downloadItemMedia,
  findBrowse,
  findSentMessage,
  findSessionList,
  forgetBrowse,
  hasStoredSession,
  latestSessionList,
  login as loginHandshake,
  isSameWorkspace,
  listAllStoredSessions,
  quotaLedgerFor,
  rememberBrowse,
  rememberSessionList,
  renderSessionRow,
  storedSessionWorkspace,
  rememberSentMessage,
  resolveSettings,
  sendFile,
  sendImage,
  sendText,
  sendVideo,
  toDataUrl,
  uploadMedia,
  SendRefusedError,
  queuePendingNotification,
  expirePendingNotifications,
  QUOTA_PER_TOKEN as QUOTA_LIMIT,
  QUOTA_WARNING as QUOTA_WARNING_TEXT,
  type BindingStore,
  type BrowsePosition,
  type CDNMedia,
  type ChannelSettings,
  type ChannelState,
  type DownloadedMedia,
  type InboundMessage,
  type ListedSession,
  type LoginEvent,
  type MessageItem,
  type NumberedRows,
  type QuotaLedger,
  type RouteDecision,
  type SessionBinding,
  type SessionGateway,
  type SessionState,
  type UploadMediaTypeValue,
  type WeixinAccount,
} from '@dsh-wechat/core'

import {
  ROUTE_CLIENT_ERROR,
  ROUTE_DIAGNOSTICS,
  ROUTE_DISCONNECT,
  ROUTE_LOGIN_CANCEL,
  ROUTE_LOGIN_START,
  ROUTE_LOGIN_STATE,
  ROUTE_LOGIN_VERIFY,
  ROUTE_SETTINGS,
  ROUTE_STATUS,
  ROUTE_TOGGLE,
  type ChannelStatus,
  type LoginState,
} from './routes.ts'
import {
  MEDIA_LABEL_BY_KIND,
  MEDIA_TYPE_BY_KIND,
  mediaKindOf,
  type MediaKind,
} from './media-kind.ts'
import {
  parseApprovalReply,
  parseQuestionReply,
  presentApproval,
  presentQuestions,
  type ApprovalOutcome,
  type QuestionAnswerBatch,
  type QuestionItem,
} from './interactions.ts'
import {
  readStreamFrame,
  type AssistantStreamPayload,
  type Disposer,
  type ModelCatalog,
  type ModelSelection,
  type ToolDefinition,
  type SessionSummary,
  type WechatContext,
} from './services.ts'

/** Cordis plugin name. */
export const name = 'dsh-wechat-plugin'

/** Host services this plugin reads. A missing one keeps the plugin pending. */
export const inject = ['sessionController', 'sessions', 'workspaceRegistry', 'tools']

/** How long the assistant may stay quiet before its reply is sent to WeChat. */
const REPLY_SETTLE_MS = 1_200

/** Upper bound on one outbound WeChat message. The service rejects very long bodies. */
const MAX_REPLY_CHARS = 4_000

/**
 * The reply-window quota, aliased on import so the arithmetic below reads the way it did.
 *
 * Both values live in `@dsh-wechat/core` because `dsh-wechat-send` charges the same count: a script
 * the agent writes and the plugin's own replies have to add up to one ten, and a second copy of these
 * constants is exactly how the two would drift apart. The warning's wording travels with them for the
 * same reason.
 */
const QUOTA_PER_TOKEN = QUOTA_LIMIT
const QUOTA_WARNING = QUOTA_WARNING_TEXT

/**
 * How long an opt-in merge waits for more, and the longest it may wait in total.
 *
 * The window alone is not enough: a caller emitting a fragment every second would reset it
 * forever and nothing would ever be delivered. The hold is what makes the wait finite.
 */
const MERGE_WINDOW_MS = 3_000
const MERGE_MAX_HOLD_MS = 10_000

/** Where a push is going. Named because the merge buffer has to remember it. */
interface NotifyTarget {
  account: WeixinAccount
  peerId: string
  conversationId: string
  contextToken?: string
}

/** How long a finished login result stays visible before a new attempt is allowed. */
const LOGIN_RESULT_TTL_MS = 30_000

/**
 * How often to re-send the "typing…" indicator while a turn is running.
 *
 * The client stops showing it after a few seconds, so sending it once at the start of a task that
 * takes a minute is the same as not sending it at all.
 */
const TYPING_REFRESH_MS = 5_000

/**
 * Name of the system-prompt section carrying the channel note.
 *
 * Stable and unique: the registry throws on a duplicate within one layer, which is how a second
 * mount of this plugin is noticed rather than silently shadowing the first.
 */
const CHANNEL_NOTE_SECTION = 'wechat:channel-note'

/**
 * Where the note sits among the system sections.
 *
 * `50` is the slot the plan-mode policy uses: after the harness identity and the deployment persona
 * (which own the negative orders and `0`), before tool guidance (`100`–`199`).
 */
const CHANNEL_NOTE_ORDER = 50

/**
 * When to give up showing "typing…" regardless of the turn.
 *
 * Nothing should ever be composing for this long, and the indicator must not be able to stick: if a
 * reply never arrives, this is what stops the channel from re-sending forever.
 */
const TYPING_MAX_MS = 30 * 60 * 1000

/**
 * Directory name for the WeChat sessions' workspace, under the DSH home.
 *
 * Every session this channel creates uses this one directory as its `cwd`. That is
 * deliberate and load-bearing:
 *
 * - It groups the channel's sessions in a single folder on the desktop, the way the
 *   `dsh_orb` bundle does with `dsh_orb`, so they are easy to find and archive.
 * - The host compares `cwd` on every adopt and refuses a mismatch, so the value has
 *   to be stable for the life of a session. A per-message or per-conversation path
 *   would permanently break re-attaching to an existing session.
 */
const WORKSPACE_DIR_NAME = 'dsh_wechat'

/**
 * Folder name this channel's sessions appear under on the desktop.
 *
 * Sessions are grouped by Workspace, and a session created with a bare `cwd` lands in
 * the built-in "Ungrouped" bucket, which cannot be named. Registering a Workspace and
 * titling it is what produces a real, named folder.
 */
const WORKSPACE_TITLE = '微信会话'

/**
 * Where inbound attachments are written.
 *
 * Inside the session workspace on purpose: the agent can open the path with an
 * ordinary file read, and it stays in the same folder the conversation shows up in,
 * so a downloaded photo is where the session already looks.
 */
const MEDIA_DIR_NAME = '媒体'

/**
 * Diagnostics log beside the state file.
 *
 * Named once so the settings page can show the same path the writer uses; a second literal is a
 * path that silently drifts the first time one of them changes.
 */
const BOOT_LOG_NAME = 'boot.log'

/**
 * The session tool's description, which carries the confirmation policy.
 *
 * The policy travels in the description because the decision is the agent's: it is the one that
 * knows whether the user actually asked to switch. Stating the rule there is what makes the setting
 * effective without a second round trip, and it is why the registry has to be re-registered when
 * the setting changes — the description is taken by value.
 *
 * @param requireConfirmation - Whether the user wants actions confirmed first.
 * @returns The description to register.
 */
export function sessionToolDescription(requireConfirmation: boolean): string {
  /*
   * Read by the model on every request, so the words are a recurring cost. The rules below are not
   * optional, though: each one replaces a failure that happened when it was missing. The channel's
   * own announcement is the only one that reaches the chat after a switch, and on failure the tool
   * returns `ok: false` while an agent summary can still claim the move worked. The two list levels
   * and the continuous numbering are what let the agent talk about the rows the user was sent.
   */
  const base =
    'Manage which WeChat conversation this channel is on. Call this whenever the user asks to ' +
    'see, switch, create, identify, or stop conversations, however phrased; never just describe it. ' +
    'The channel announces switching/creating, failures included: do not repeat it or claim ' +
    'success, and say nothing if `ok` is false. ' +
    '`list`: this channel\'s conversations; `all`: all workspaces + counts. Both page ' +
    'ten rows, numbering continuous; the user pages by replying (number, name, 「查看其余」) — not ' +
    'you. Any workspace\'s conversation can be switched to.'
  if (requireConfirmation) {
    return (
      `${base} Before acting, state your plan and wait for the user to agree; \`list\` alone can ` +
      'be called directly.'
    )
  }
  return `${base} The user has turned confirmation off — act directly.`
}

/**
 * The model tool's description.
 *
 * Written the way the session tool's is, and for the same reason: the decision belongs to the agent,
 * which is the only part of this system that understands what the user meant. A model is not a
 * session, so the confirmation policy does not travel here — that setting is about moving work
 * between conversations, where an inferred intent costs the user their context.
 *
 * @returns The description to register.
 */
export function modelToolDescription(): string {
  /*
   * Short like the session tool's, for the same per-request reason, and with the same announcement
   * rule: the channel has already told the user what happened, so a second, looser telling can only
   * contradict it. The next-turn sentence is the one that stops the agent describing a switch as
   * applied to the work already running.
   */
  return (
    'Choose this WeChat conversation\'s model and reasoning level, and list what is available. ' +
    'Call this whenever the user asks to see or change either — e.g. "换个模型", "推理等级", ' +
    '"thinking level" — never just describe it. ' +
    'The channel announces listing and switching, failures included: do not repeat it, never ' +
    'claim a model/level switch succeeded, and say nothing if `ok` is false. ' +
    'A switch applies to the caller\'s bound conversation from the next turn.'
  )
}

/**
 * The openings that mean a model command changed nothing.
 *
 * The command answers with guidance rather than throwing, so its text has to be read to know whether
 * a switch happened — the same technique the session tool uses, and needed more here: a false success
 * leaves the agent telling the user about a model the next turn is not using, and about a reasoning
 * level it is not thinking at. Anchored to the start, where the router puts its own words, so a
 * conversation title or a model name further down a successful reply cannot be read as a failure.
 * `当前` covers the whole family of "there is nothing to act on" answers.
 */
const MODEL_FAILURE_PATTERN =
  /^(找不到模型|找不到等级|当前|切换模型失败|切换推理等级失败)/

/**
 * The message that tells the user a session operation actually happened.
 *
 * Written by the channel rather than the agent because it is the one thing the user must see: after
 * it, their next message goes somewhere else. Relying on the agent to mention it produced silence
 * in practice, and the agent's words would be posted to the session the chat just left.
 *
 * The title comes from the binding rather than from what the user typed, because they usually give
 * a number («换 2») and a number is not what they need to see confirmed.
 *
 * @param action - `switch` or `new`.
 * @param resolvedTitle - Title the conversation is now on.
 * @returns The message to send.
 */
function switchConfirmation(action: string, resolvedTitle: string): string {
  const title = resolvedTitle.trim()
  if (action === 'new') {
    return title === ''
      ? '已新建对话，从现在起你的消息发到这里。'
      : `已新建对话「${title}」，从现在起你的消息发到这里。`
  }
  return title === '' ? '已切换对话。' : `已切换到「${title}」。`
}

/**
 * The message that tells the user a session operation did **not** happen.
 *
 * Sent for the same reason as the confirmation, and needed more urgently: without it the agent is
 * free to report a move it never made, because a failed switch is the one outcome where nothing in
 * the WeChat chat changes and the user has no way to tell.
 *
 * @param action - `switch` or `new`.
 * @param target - What the user asked for, so the message names it back.
 * @param reason - The router's own explanation, whose first line is what the user should see.
 * @returns The message to send.
 */
function switchFailure(action: string, target: string | undefined, reason: string): string {
  const headline = reason.split('\n')[0]?.trim() ?? ''
  const what =
    action === 'switch'
      ? target === undefined || target === ''
        ? '切换对话'
        : `切换到「${target}」`
      : '新建对话'
  return `${what}没有成功。${headline}\n\n发「/list」看清单，直接回数字也能切。`
}

/**
 * The message id a quote in this inbound message refers to.
 *
 * A quote arrives as an id and nothing else — no text, no conversation, and `type: 0` in the item —
 * so this is the only thing that ties a reply to what it is replying to. Both spellings are read
 * because the service uses `msg_id` for a message it has already delivered and `svr_id` for one it
 * reports by server identity.
 *
 * @param message - Inbound message, whose items may carry a quote.
 * @returns The quoted id, or undefined when the message quotes nothing.
 */
function quotedMessageId(message: InboundMessage): string | undefined {
  for (const item of message.raw.item_list ?? []) {
    const quote = item.ref_msg
    if (quote === undefined) continue
    const messageId = quote.message_item?.msg_id ?? quote.svr_id
    if (messageId !== undefined) return messageId
  }
  return undefined
}

/**
 * How long an unfinished listing stays open.
 *
 * 「查看其余」 carries no target, so it means "the next ten of what I am looking at" — and that only
 * holds while the user is still looking. Half an hour is long enough to read a screen, answer
 * something else and come back, and short enough that a phrase typed the next morning continues
 * nothing rather than jumping into the middle of a list nobody remembers.
 */
const BROWSE_IDLE_MS = 30 * 60 * 1000

/** A state with nothing stored, so defaults can be resolved without reading the disk. */
const EMPTY_STATE: ChannelState = {
  version: 1,
  accounts: {},
  syncBufs: {},
  contextTokens: {},
  bindings: {},
  sentMessages: {},
}

/**
 * How long any non-text message waits for a follow-up.
 *
 * Every attachment — photo, file, voice, video — opens this window instead of being
 * prompted immediately, whether or not it came with a caption. People send the thing and
 * then say what to do with it; acting on the attachment first would turn one request into
 * two prompts and two answers. The window is short on purpose, since an attachment sent
 * with nothing after it still needs an answer.
 */
const ATTACHMENT_MERGE_WINDOW_MS = 10_000

/**
 * The pending-attachment entry for one conversation.
 *
 * A non-text message is parked here rather than prompted straight away. It carries its own
 * timer, and folds into the next text message if one arrives in time; otherwise the timer
 * prompts it on its own.
 */
  /** Non-text messages awaiting an instruction, batched per conversation. */
interface PendingBatch {
  attachments: { media: DownloadedMedia; path: string }[]
  /** Captions collected from every message in the batch, in arrival order. */
  text: string
  /**
   * Restarted on every arrival, so the window measures quiet time, not total time.
   *
   * Absent when auto-reply is off: the batch then waits for a text message rather than a timer.
   */
  timer: NodeJS.Timeout | undefined
}

/**
 * One permission prompt or question waiting for the user's WeChat reply.
 *
 * The reply is consumed instead of being routed to the agent: "1" answers the prompt the user
 * was just shown, and sending it on as a request would both confuse the agent and leave the
 * pending interaction unresolved.
 */
interface PendingInteraction {
  /** What kind of interaction this is, so the reply can be parsed and shaped correctly. */
  kind: 'approval' | 'question'
  /**
   * Read the user's reply, or return undefined when it is not an answer to this prompt.
   *
   * Returning undefined leaves the interaction pending and lets the text route normally, so an
   * unrelated message sent while a prompt is open is not swallowed as a bad answer.
   */
  accept: (reply: string) => unknown | undefined
  /** Settle the waiting answerer. */
  settle: (value: never) => void
  /** Report a reply that could not be understood, re-showing the prompt. */
  reprompt: () => void
}

/**
 * Write one downloaded attachment and return its absolute path.
 *
 * The name is prefixed with a random fragment because WeChat file names and
 * synthesised image names collide constantly, and silently overwriting a user's
 * earlier attachment is worse than an ugly file name.
 */
function storeMedia(home: string, media: DownloadedMedia): string {
  const dir = join(home, WORKSPACE_DIR_NAME, MEDIA_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  const safe = media.fileName.replace(/[^\w.-]+/g, '_').slice(-80)
  const path = join(dir, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${safe}`)
  writeFileSync(path, media.data)
  return path
}

/**
 * Read a session id off a tool's calling agent.
 *
 * The agent object is host-owned, so the id is read defensively rather than typed.
 *
 * @param agent - `exec.agent` from a tool invocation.
 * @returns The session id, or undefined when the shape is not what we expect.
 */
function sessionIdOf(agent: unknown): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const candidate = (agent as { session?: { id?: unknown } }).session?.id
  return typeof candidate === 'string' ? candidate : undefined
}

/**
 * Sender per kind: each item type has its own shape on the wire.
 *
 * Declared here rather than in `media-kind.ts` because it needs the sender functions, which
 * would drag the whole media layer into a module that is otherwise pure mapping.
 */
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
 * One line describing an attachment for the agent, including where it landed.
 *
 * Voice gets two extras that decide whether the agent needs to open the file at all: the
 * service's own transcript, and the decoded length. A transcript means the question can be
 * answered without touching the audio.
 */
function describeMedia(media: DownloadedMedia, path: string): string {
  const size = media.data.length
  const readable = size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`
  const kind = { image: '图片', file: '文件', voice: '语音', video: '视频' }[media.kind]
  const parts = [`[${kind}] ${path} (${readable})`]

  if (media.durationMs !== undefined) {
    parts.push(`时长：${(media.durationMs / 1000).toFixed(1)} 秒`)
  }
  // Where the audio could not be transcoded the extension says so, and the agent should not
  // be left guessing why the file will not open.
  if (media.kind === 'voice' && media.contentType === 'audio/silk') {
    parts.push('（未能转码为 WAV，仍是原始 SILK）')
  }
  if (media.transcript !== undefined && media.transcript !== '') {
    parts.push(`服务端转写：${media.transcript}`)
  }
  return parts.join('\n')
}

interface RuntimeOptions {
  /** DSH home. Used for the state file and the boot log. */
  home: string
  stateFile: string
  /** Session working directory. Must stay constant for the life of a session. */
  workspace: string
  /** Identity reported to the service. */
  botAgent: string
  /**
   * Outbound delivery. Defaults to the real iLink sender; tests substitute a
   * recorder so the whole pipeline can run without touching the network.
   */
  send?: SendFunction
  /**
   * State store to use instead of opening {@link RuntimeOptions.stateFile}.
   *
   * A test seam, like {@link RuntimeOptions.send}. What it buys is a write failure that is the same
   * failure on every platform, which is what a test of "a save that cannot be written" needs: the
   * filesystem's own refusal differs by platform (the errno, where it is raised, and whether the
   * write is refused at all), and a test built on it ends up asserting the operating system.
   */
  stateStore?: StateStore
}

/** One outbound text delivery. */
export type SendFunction = (params: {
  account: WeixinAccount
  to: string
  text: string
  contextToken?: string
}) => Promise<unknown>

/**
 * The whole channel at runtime: accounts, monitors, routing, and the outbound buffer.
 */
class WechatRuntime {
  readonly #ctx: WechatContext
  readonly #store: StateStore
  /** Path of the state file, kept for the one synchronous settings read. */
  readonly #stateFilePath: string
  readonly #router: SessionRouter
  readonly #botAgent: string
  readonly #workspace: string
  readonly #home: string
  readonly #send: SendFunction
  /** One monitor per account, plus its abort controller. */
  readonly #monitors = new Map<string, { monitor: ChannelMonitor; abort: AbortController }>()
  /** The running login handshake, if any. */
  #loginTask:
    | { controller: AbortController; state: LoginState; answer?: (code: string) => void }
    | undefined
  /** Buffered assistant text per session, plus the conversation it belongs to. */
  readonly #replies = new Map<
    string,
    { text: string; conversationId: string; timer: NodeJS.Timeout }
  >()
  /** Recent errors, surfaced in the settings page. */
  readonly #errors: string[] = []
  /** Non-text messages awaiting an instruction, keyed by conversation. */
  readonly #pending = new Map<string, PendingBatch>()
  /**
   * Conversations currently showing "typing…", with the timers that keep it up.
   *
   * Keyed by conversation so a second message in the same chat does not start a second refresh loop,
   * and cleared by the reply rather than by the inbound handler — see {@link #startTyping}.
   */
  readonly #typing = new Map<
    string,
    {
      interval: ReturnType<typeof setInterval>
      cap: ReturnType<typeof setTimeout>
      accountId: string
      peerId: string
    }
  >()
  /**
   * Interactions waiting on a WeChat reply, keyed by conversation.
   *
   * A permission prompt or a multiple-choice question is normally answered in the desktop's
   * conversation pane. Someone whose only device is the phone never sees that pane, and the
   * harness's own answerer fails closed, so the turn would stall. These entries let the channel
   * answer on their behalf: the prompt goes out over WeChat and the next reply settles it.
   */
  readonly #interactions = new Map<string, PendingInteraction>()
  /**
   * The last refusal logged, so one closed window is reported once rather than once per message.
   *
   * Reset by a successful send. See the catch in `#sendOrQueue` for why the reason matters more than
   * the code: a stale session and a real rate limit are told apart by `errmsg` alone.
   */
  #lastRefusal = ''
  /**
   * Sends charged against the reply token in use, per conversation, **on disk**.
   *
   * Keyed by conversation and stamped with the token, because a fresh token carries a fresh ten and
   * comparing the stamp is how that is noticed. Persistent so a restart does not lose the count, and
   * shared with `dsh-wechat-send` so a script the agent writes and this plugin add up to one ten
   * instead of two — the whole reason the count moved out of memory.
   */
  readonly #quota: QuotaLedger
  /**
   * Fragments held for a merge, per conversation.
   *
   * Only ever populated by a caller that asked for it: a timed series must keep arriving one
   * message at a time, so nothing is merged unless it says so.
   */
  readonly #mergeBuf = new Map<
    string,
    { target: NotifyTarget; lines: string[]; first: number; timer: NodeJS.Timeout }
  >()
  /** Observations already written to the log, bucketed so each distinct value logs once. */
  readonly #seenShapes = new Map<string, Set<string>>()
  /**
   * Cached settings, so the synchronous assistant-stream path can read them.
   *
   * `undefined` means "not read yet"; {@link saveSettings} replaces it.
   */
  #settingsCache: Required<ChannelSettings> | undefined
  #needsLogin = false
  /** Resolved Workspace id, cached once the registry answers. */
  #workspaceId: string | undefined
  /**
   * Disposer for the `session_control` registration.
   *
   * Held so the tool can be re-registered when the confirmation setting changes: the registry
   * takes the description by value, so a stale description would leave the setting inert.
   */
  #sessionToolDisposer: Disposer | undefined
  /** Set once the plugin is torn down, so a late async registration does not resurrect a tool. */
  #disposed = false
  /**
   * Sessions this channel currently drives, by session id.
   *
   * The channel note is registered once, globally, as a system-prompt section whose text is decided
   * per assembly — so the decision has to be answerable **synchronously**, from memory, at a moment
   * when awaiting the store is not possible. This set is that answer, kept in step with the binding
   * store by {@link #rememberBoundSessions} rather than read from disk on every assembly.
   */
  #channelSessions = new Set<string>()
  /**
   * Removal of the registered channel-note section.
   *
   * Set asynchronously: the registration waits for the system-prompt service through `inject`, so it
   * lands after `apply` has returned. Held so teardown can take the section out rather than leaving a
   * provider behind that points at a disposed runtime.
   */
  #channelNoteDisposer: (() => void) | undefined

  constructor(ctx: WechatContext, options: RuntimeOptions) {
    this.#ctx = ctx
    this.#botAgent = options.botAgent
    this.#workspace = options.workspace
    this.#home = options.home
    this.#send =
      options.send ??
      (async ({ account, to, text, contextToken }) =>
        await sendText({
          account,
          to,
          text,
          ...(contextToken === undefined ? {} : { contextToken }),
        }))
    this.#store = options.stateStore ?? new StateStore(options.stateFile)
    this.#stateFilePath = options.stateFile
    /*
     * Built over the store rather than over a local map, so the count is read from the file on every
     * send and written back before the send's caller continues. That is what makes a restart, and a
     * `dsh-wechat-send` running in another process, see the same arithmetic.
     */
    this.#quota = quotaLedgerFor(this.#store)
    const bindings: BindingStore = {
      load: async () => {
        const current = (await this.#store.read()).bindings
        // The router asks for these ahead of every prompt, which is what keeps the synchronous index
        // the note is scoped by in step with the file.
        this.#rememberBoundSessions(current)
        return current
      },
      save: async (next: Record<string, SessionBinding>) => {
        await this.#store.update((state) => {
          state.bindings = next
        })
        this.#rememberBoundSessions(next)
      },
    }
    this.#router = new SessionRouter({
      gateway: this.#gateway(),
      store: bindings,
      // The directory and the name are both needed: the store records absolute paths, so knowing the
      // path is what decides which rows go under the heading the user knows this workspace by.
      ownWorkspace: this.#workspace,
      ownWorkspaceLabel: WORKSPACE_TITLE,
      /*
       * The router's decisions go to the boot log.
       *
       * A replaced binding and a *declined* replacement are the two facts a silence is diagnosed
       * from, and neither is visible in the message that was routed: the one that was moved looks
       * like an ordinary prompt, and the one that was left alone looks like nothing happened at all.
       */
      onDiagnostic: (line) => {
        this.#recordBoot(line)
      },
    })
  }

  /** Read the persisted state. */
  state(): Promise<ChannelState> {
    return this.#store.read()
  }

  /** Whether the channel is armed to reconnect on boot. */
  async enabled(): Promise<boolean> {
    return (await this.#store.read()).autoStart === true
  }

  /** Current status for the settings page. */
  async status(): Promise<ChannelStatus> {
    const state = await this.#store.read()
    return {
      enabled: state.autoStart === true,
      accounts: Object.values(state.accounts).map((account) => ({
        accountId: account.accountId,
        ...(account.userId === undefined ? {} : { userId: account.userId }),
        polling: this.#monitors.has(account.accountId),
      })),
      needsLogin: this.#needsLogin,
      errors: [...this.#errors].slice(-10),
      diagnostics: {
        logPath: join(this.#home, 'wechat', BOOT_LOG_NAME),
        statePath: this.#store.file,
        // The resolved workspace, not the default: reporting `join(home, WORKSPACE_DIR_NAME)` here
        // showed the default even when the config pointed somewhere else, so a user who moved the
        // workspace was told the old path was in use.
        workspace: this.#workspace,
        /*
         * What the settings page stores, next to the directory that is actually in use.
         *
         * Two different questions, and until now only the second was answerable: a directory that
         * was never saved and a directory saved without a restart both showed the old path, so the
         * user could not tell "it never saved" from "it saved and is not in effect" — and neither
         * could anyone reading a bug report. The value is read from the store, not from
         * `#settingsCache`, so it is what is on disk rather than what this process last decided.
         */
        settingsWorkspace: resolveSettings(state).workspacePath,
        logTail: this.#bootLogTail(),
      },
    }
  }

  /**
   * Last lines of the boot log, oldest first.
   *
   * Read on demand and bounded: the file grows without limit, and the settings page only ever
   * shows the end of it.
   */
  #bootLogTail(limit = 200): string[] {
    try {
      const text = readFileSync(join(this.#home, 'wechat', BOOT_LOG_NAME), 'utf8')
      return text.split(/\r?\n/).filter((line) => line !== '').slice(-limit)
    } catch {
      // A missing log is normal on a fresh install, not an error worth surfacing.
      return []
    }
  }

  /** Every binding that is still usable, plus the accounts it belongs to. */
  async bindings(): Promise<SessionBinding[]> {
    return Object.values((await this.#store.read()).bindings)
  }

  /**
   * Perform a session action on behalf of the agent.
   *
   * This is the whole of the natural-language path. An earlier attempt recognised phrasings with
   * regular expressions and recognised almost nothing — «换个对话», «刚才那个», «切到第二个» all
   * missed — because the set of ways a person can ask is not enumerable. The agent reads the
   * message anyway and does understand it, so the judgement is delegated to it and the channel
   * only has to carry the action out.
   *
   * Every action is executed through the router's own command path, so there is one implementation
   * of each and the typed and spoken routes cannot drift apart.
   *
   * @param callerSessionId - Session the calling agent is in, which identifies the conversation.
   * @param action - What to do.
   * @param target - Session to switch to, when the action needs one.
   * @returns A result the agent can report, or a reason it could not be done.
   */
  async controlSession(
    callerSessionId: string | undefined,
    action: string,
    target?: string,
  ): Promise<{
    ok: boolean
    detail: string
    /**
     * The numbered rows exactly as the user received them.
     *
     * Rendered from the same numbering the message was built from, so a number the agent repeats in
     * its own words is the number the user is looking at. Built separately from the message body only
     * because the agent needs the rows without the heading and the instructions.
     */
    rows: string
  }> {
    const conversationId = await this.#conversationForAgentSession(callerSessionId)
    if (conversationId === undefined) {
      return { ok: false, detail: '这个会话没有绑定任何微信对话，无法操作。', rows: '' }
    }
    const binding = (await this.#store.read()).bindings[conversationId]
    if (binding === undefined) {
      return { ok: false, detail: '这个会话没有绑定任何微信对话，无法操作。', rows: '' }
    }

    /*
     * Every action reaches the router as the command a typed request would be, `list all` included.
     *
     * That is what keeps the two routes one implementation: the router renders the message, numbers
     * it, decides which level of the browser it opens and reports where that leaves the conversation
     * — and the channel only delivers the result. Rendering a second copy here is what previously let
     * the message and the numbering disagree about which list they were describing.
     */
    const text =
      action === 'switch'
        ? `/switch ${target ?? ''}`
        : action === 'new' && target !== undefined && target !== ''
          ? `/new ${target}`
          : action === 'list' && target === 'all'
            ? '/list all'
            : `/${action}`
    const result = await this.#router.route({
      conversationId,
      accountId: binding.accountId,
      peerId: binding.peerId,
      text,
      // A spoken number is read against the same listing a typed one is: the newest `/list` this
      // conversation received. Sessions run while the user reads, so re-deriving the numbering here
      // would send "switch to 3" somewhere other than the row they are looking at.
      ...(await this.#numberedRowsFor(conversationId, binding.accountId)),
      // Typed and spoken listings need different words for "there are more elsewhere": a spoken
      // request never mentions `/list all`, so telling the user to type it is not an instruction.
      ...(action === 'list'
        ? { heldHint: '说「看全部对话」就能一起看，也可以直接切过去。' }
        : {}),
    })
    if (result.kind !== 'reply') {
      return { ok: false, detail: `不支持的操作：${action}`, rows: '' }
    }

    // The rows the message printed, rendered for the agent's own words. A workspace screen has none:
    // its rows are folders, and the next number is chosen by replying to the channel, which this
    // conversation is already doing.
    const rows = await this.#rowsForAgent(conversationId, result.numbered)
    // A switch to something unknown answers with guidance rather than throwing, so the text has to
    // be read rather than assumed to mean success — otherwise the agent would report a move that
    // never happened.
    const failed = /找不到|未知指令/.test(result.text)

    /*
     * Every outcome is announced by the channel, including the failures.
     *
     * A success has to be announced because the agent's words would be posted to the session the
     * chat has just left, which no longer answers for it. A failure has to be announced for a worse
     * reason: the log shows the tool returning `ok: false` and the agent then telling the user
     * 「已切过去了，直接说你想问的就行」 — a claim about a move that never happened, which the user
     * only discovers when their next message lands in the old conversation.
     */
    if (action === 'switch' || action === 'new') {
      if (failed) {
        await this.#notify(conversationId, switchFailure(action, target, result.text))
      } else {
        const after = (await this.#store.read()).bindings[conversationId]
        await this.#notify(conversationId, switchConfirmation(action, after?.title ?? ''))
      }
      // A switch ends any browse: the listing the user was reading is finished with, and a later
      // 「查看其余」 must not continue it.
      await this.#trackBrowse(binding.accountId, conversationId, result.browse)
    }

    if (failed) {
      return {
        ok: false,
        // Stated as done, because it was: the user has been told directly, and a retelling can only
        // contradict what they already read.
        detail: `切换失败，已直接告诉用户。原因：${result.text.split('\n')[0] ?? ''}`,
        rows,
      }
    }
    /*
     * A listing is sent by the channel itself, exactly as a switch confirmation is.
     *
     * The log showed what leaving it to the agent costs: the tool ran, the rows came back, and the
     * agent answered 「已为你列出对话列表，请看上面的消息」 — pointing at a message that never
     * existed, because a tool result is only ever shown to the agent. It later produced a list of its
     * own, in its own format, without the other workspaces and without the numbering the user is
     * meant to reply with.
     *
     * So the channel sends the router's own rendering — the same bytes a typed `/list` produces — and
     * the agent is told not to repeat it.
     */
    if (action === 'list' || action === 'current') {
      const sentId = await this.#notify(conversationId, result.text)
      /*
       * The id the service assigned is what a later quote of this message refers to, so the numbering
       * it just printed is frozen under it. Without this a spoken listing could be quoted and the
       * number would still be read against live sessions — the drift the quote is meant to remove.
       */
      if (action === 'list' && sentId !== undefined && result.numbered !== undefined) {
        await this.#rememberListedRows(binding.accountId, conversationId, sentId, result.numbered)
      }
      /*
       * Where the browser was left, remembered only when the screen actually reached the user: a
       * position advanced past a message nobody received would skip a page on the next 「查看其余」.
       * Clearing needs no such condition, and every other command clears — `/current` included,
       * because a listing the user has stopped reading is not one to page through later.
       */
      if (sentId !== undefined || result.browse === undefined) {
        await this.#trackBrowse(binding.accountId, conversationId, result.browse)
      }
      return {
        ok: true,
        // The agent gets told what happened, not the list itself: repeating it would double every
        // request, and paraphrasing it is what produced a list the user could not act on. `/current`
        // is different — its answer *is* the useful text, and it names a conversation the user cannot
        // see, so the agent is handed the same words the channel just sent.
        detail: action === 'list' ? '列表已直接发给用户。不要重复这份列表。' : result.text,
        rows,
      }
    }
    return { ok: true, detail: result.text, rows }
  }

  /**
   * The numbered rows of a reply, rendered the way the user received them.
   *
   * @param conversationId - Conversation the listing went to, whose bound session is marked.
   * @param numbered - The numbering the reply printed, when it printed one.
   * @returns The rows as lines, or an empty string when this reply numbered nothing.
   */
  async #rowsForAgent(conversationId: string, numbered: NumberedRows | undefined): Promise<string> {
    if (numbered === undefined || numbered.sessions.length === 0) return ''
    const currentId = (await this.#store.read()).bindings[conversationId]?.sessionId
    const known = new Map<string, ListedSession>(
      (await this.#gateway().listSessions()).map((session) => [session.sessionId, session]),
    )
    return numbered.sessions
      .map((session, offset) => {
        const row = known.get(session.sessionId) ?? session
        // The number printed beside the row, not its position in this array: the second screen of ten
        // starts at 11, and the agent repeats these numbers back to the user.
        return renderSessionRow(row, numbered.first - 1 + offset, currentId)
      })
      .join('\n')
  }

  /**
   * Freeze the numbering one sent message printed, so a quote of it resolves the same way twice.
   *
   * @param accountId - Account the message went out on.
   * @param conversationId - Conversation it went to.
   * @param messageId - Id the service assigned, which is what a quote carries.
   * @param numbered - The rows, and the number printed beside the first of them.
   */
  async #rememberListedRows(
    accountId: string,
    conversationId: string,
    messageId: string,
    numbered: NumberedRows,
  ): Promise<void> {
    try {
      await this.#store.update((state) => {
        rememberSessionList(state, accountId, conversationId, {
          messageId,
          // Copied field by field: what is stored has to be exactly the fields the reader validates,
          // so a later change to the row shape cannot smuggle an unvalidated value in. Long titles
          // are trimmed by the store, which owns that bound.
          sessions: numbered.sessions.map((session) => ({
            sessionId: session.sessionId,
            title: session.title,
          })),
          first: numbered.first,
          at: Date.now(),
        })
      })
    } catch (error) {
      // A listing that cannot be remembered is still a listing the user is reading; the cost is that
      // its numbering is not pinned, which the next `/list` fixes.
      this.#recordError(
        `会话清单编号未能保存: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Perform a model action on behalf of the agent.
   *
   * The natural-language half of `/model`, exactly as {@link controlSession} is the natural-language
   * half of `/switch`: the request is recognised by the agent, and the channel only carries it out.
   * Every action runs through the router's own command path, so a spoken request and a typed one can
   * never diverge — one list, one numbering, one failure message, and one place that decides what a
   * reasoning level is called.
   *
   * @param callerSessionId - Session the calling agent is in, which identifies the conversation.
   * @param action - `list`, `switch`, or `set_level`.
   * @param target - Model to switch to, by number, name or id.
   * @param level - Reasoning level: the one to switch to for `set_level`, and optionally the one to
   *   switch to *with* the model for `switch`.
   * @returns A result the agent can act on, or a reason it could not be done.
   */
  async controlModel(
    callerSessionId: string | undefined,
    action: string,
    target?: string,
    level?: string,
  ): Promise<{ ok: boolean; detail: string }> {
    // Validated here rather than by building `/<action>`: an action this plugin does not know must
    // fail, not turn into a different command that happens to start with a slash.
    if (action !== 'list' && action !== 'switch' && action !== 'set_level') {
      return { ok: false, detail: `不支持的操作：${action}` }
    }
    if (action === 'switch' && (target === undefined || target.trim() === '')) {
      return {
        ok: false,
        detail: '切换模型需要指定目标：清单里的编号、模型名字或模型 id。',
      }
    }
    if (action === 'set_level' && (level === undefined || level.trim() === '')) {
      return {
        ok: false,
        detail: '切换推理等级需要指定等级：回复 /model 看清单，等级名字就在模型下面。',
      }
    }

    const conversationId = await this.#conversationForAgentSession(callerSessionId)
    if (conversationId === undefined) {
      return { ok: false, detail: '这个会话没有绑定任何微信对话，无法操作。' }
    }
    const binding = (await this.#store.read()).bindings[conversationId]
    if (binding === undefined) {
      return { ok: false, detail: '这个会话没有绑定任何微信对话，无法操作。' }
    }

    /*
     * One command text per action, built here rather than by the router, so the router keeps owning
     * the syntax: `等级` is the word it parses, and a second spelling invented here would be a second
     * answer to the same request.
     */
    const named = level === undefined || level.trim() === '' ? '' : ` 等级 ${level.trim()}`
    const text =
      action === 'list'
        ? '/model'
        : action === 'set_level'
          ? `/model 等级 ${String(level).trim()}`
          : `/model ${String(target).trim()}${named}`
    const result = await this.#router.route({
      conversationId,
      accountId: binding.accountId,
      peerId: binding.peerId,
      text,
    })
    if (result.kind !== 'reply') {
      return { ok: false, detail: `不支持的操作：${action}` }
    }

    /*
     * The reply decides the outcome, because the command answers with guidance instead of throwing.
     *
     * A false success is the failure that matters here: the agent would tell the user a model the
     * next turn is not using — or a level it is not thinking at — and nothing about the chat would
     * look wrong. The pattern is anchored to the opening of each failure message, so a conversation
     * title or a model name appearing later in a successful reply cannot be mistaken for one.
     */
    const failed = MODEL_FAILURE_PATTERN.test(result.text)
    // Sent by the channel in both cases, for the same reason the session tool does it: a tool result
    // is only ever shown to the agent, so leaving it to the agent produced replies pointing at a
    // message that never existed.
    await this.#notify(conversationId, result.text)
    if (failed) {
      return {
        ok: false,
        // Stated as done, because it was: the user has been told directly, and a retelling can only
        // contradict what they already read.
        detail: `操作失败，已直接告诉用户。原因：${result.text.split('\n')[0] ?? ''}`,
      }
    }
    return {
      ok: true,
      detail:
        action === 'list'
          ? '模型清单已直接发给用户。不要重复这份清单。'
          : action === 'set_level'
            ? '推理等级已切换，已直接告诉用户。不要重复。'
            : '模型已切换，已直接告诉用户。不要重复。',
    }
  }

  /**
   * Send one message to a conversation, on the channel's own behalf.
   *
   * Used where the user must be told something regardless of what the agent chooses to say. Failure
   * is recorded, not thrown: a missed confirmation must not fail the action it was confirming.
   *
   * @param conversationId - Conversation to notify.
   * @param text - Message body.
   * @returns The id the service assigned, when it assigned one and the send went out. A listing needs
   *   it: that id is what a later quote of the message refers to.
   */
  async #notify(conversationId: string, text: string): Promise<string | undefined> {
    const state = await this.#store.read()
    const binding = state.bindings[conversationId]
    if (binding === undefined) return undefined
    const account = state.accounts[binding.accountId]
    if (account === undefined) return undefined
    try {
      const sent = await this.#send({
        account,
        to: binding.peerId,
        text,
      })
      this.#recordBoot(`session notice sent: ${text.split('\n')[0] ?? ''}`)
      const id = (sent as { serverMessageId?: unknown } | undefined)?.serverMessageId
      return typeof id === 'string' ? id : undefined
    } catch (error) {
      this.#recordError(
        `发送会话通知失败: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /**
   * The rows a bare number in this conversation should be read against.
   *
   * A quoted listing wins, because the user pointed at it: its numbering was frozen when the message
   * was sent, so "3" still means the row they can see however much the machine has moved since. With
   * no quote — or a quote of something that was not a listing — the newest listing this conversation
   * received is used, which is the one most likely to still be on their screen.
   *
   * Nothing is returned when this conversation has never been sent a listing. The router then falls
   * back to the live list, which is the old behaviour and the only answer available.
   *
   * @param conversationId - Conversation the message arrived in.
   * @param accountId - Account it arrived on.
   * @param message - The inbound message, when there is one to quote.
   * @returns The rows a number refers to, or an empty object when there are none.
   */
  async #numberedRowsFor(
    conversationId: string,
    accountId: string,
    message?: InboundMessage,
  ): Promise<{ numbered?: NumberedRows }> {
    const state = await this.#store.read()
    const quotedId = message === undefined ? undefined : quotedMessageId(message)
    const quoted = quotedId === undefined ? undefined : findSessionList(state, accountId, quotedId)
    const listing = quoted ?? latestSessionList(state, accountId, conversationId)
    if (listing === undefined) return {}
    this.#recordBoot(
      `session numbering: ${quoted === undefined ? 'latest' : 'quoted'} listing ` +
        `id=${listing.messageId} rows=${String(listing.sessions.length)} first=${String(listing.first)}`,
    )
    return { numbered: { sessions: listing.sessions, first: listing.first } }
  }

  /**
   * Where a conversation is in the two-level listing browser, or nothing when it is nowhere.
   *
   * An abandoned position is dropped and reported as absent, because 「查看其余」 means "the next ten
   * of what I am looking at": once the user has moved on, the phrase has nothing to continue, and a
   * jump to wherever they left off reads as a malfunction rather than a convenience.
   *
   * @param accountId - Account the conversation belongs to.
   * @param conversationId - Conversation to look up.
   * @returns The position to continue from, when there is a live one.
   */
  async #browseFor(accountId: string, conversationId: string): Promise<BrowsePosition | undefined> {
    const stored = findBrowse(await this.#store.read(), accountId, conversationId)
    if (stored === undefined) return undefined
    if (Date.now() - stored.at <= BROWSE_IDLE_MS) return stored
    await this.#trackBrowse(accountId, conversationId, undefined)
    this.#recordBoot(
      `browse expired: level=${stored.level} page=${String(stored.page)}`,
    )
    return undefined
  }

  /**
   * Remember where a conversation is in the listing browser, or forget it.
   *
   * Written only when it changes: this runs on every message, and the state file is rewritten whole
   * on every write. A failure is recorded rather than thrown, because the cost is one page of
   * browsing and the message it was attached to matters more.
   *
   * @param accountId - Account the conversation belongs to.
   * @param conversationId - Conversation to record for.
   * @param next - The new position, or undefined to forget the old one.
   */
  async #trackBrowse(
    accountId: string,
    conversationId: string,
    next: BrowsePosition | undefined,
  ): Promise<void> {
    const current = findBrowse(await this.#store.read(), accountId, conversationId)
    /*
     * `at` is compared too, so listing the same page again restarts the idle clock.
     *
     * Leaving it out would look like a saving and behave like a bug: `/list` twice inside the window
     * would keep the first timestamp, and the position would expire while the user was still using
     * it. The write it costs is at most one per listing, because every other path either clears the
     * position (compared as equality below) or does not touch it at all.
     */
    if (current === next) return
    if (
      current !== undefined &&
      next !== undefined &&
      current.level === next.level &&
      current.workspace === next.workspace &&
      current.page === next.page &&
      current.at === next.at
    ) {
      return
    }
    try {
      await this.#store.update((state) => {
        if (next === undefined) forgetBrowse(state, accountId, conversationId)
        else rememberBrowse(state, accountId, conversationId, next)
      })
    } catch (error) {
      this.#recordError(
        `浏览位置未能保存: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Tuned settings plus the defaults they fall back to, for the settings page.
   *
   * Both are sent whole: the page shows the effective value of every setting and offers a reset
   * to the defaults, so it needs to know both.
   */
  async settingsForPage(): Promise<{
    settings: Required<ChannelSettings>
    defaults: Required<ChannelSettings>
  }> {
    return {
      settings: await this.#settings(),
      defaults: resolveSettings(EMPTY_STATE),
    }
  }

  /**
   * Disconnect one WeChat account from this machine.
   *
   * Stops its poll and **forgets its credentials**, which is what makes this different from
   * switching the channel off: the channel switch only stops listening and can be turned back on,
   * while this ends the link and requires scanning again to restore it.
   *
   * The account's conversations are forgotten too. Their DSH sessions are untouched — the session
   * is the work, and this only ends the WeChat side of it — so nothing anyone said is lost.
   *
   * @param accountId - Account to disconnect.
   * @returns Whether an account was found and removed.
   */
  async disconnect(accountId: string): Promise<boolean> {
    const running = this.#monitors.get(accountId)
    if (running !== undefined) {
      running.abort.abort()
      void running.monitor.notifyStop()
      this.#monitors.delete(accountId)
    }

    let found = false
    await this.#store.update((state) => {
      if (state.accounts[accountId] === undefined) return
      found = true
      delete state.accounts[accountId]
      delete state.syncBufs[accountId]
      delete state.contextTokens[accountId]
      delete state.sentMessages[accountId]
      // The frozen listings go with it: they exist to resolve a quote that arrives on this account.
      if (state.sessionLists !== undefined) delete state.sessionLists[accountId]
      // So does where its conversations were in the listing browser, for the same reason.
      if (state.browsing !== undefined) delete state.browsing[accountId]
      for (const [key, binding] of Object.entries(state.bindings)) {
        if (binding.accountId === accountId) delete state.bindings[key]
      }
      // Nothing left to reconnect to, so the switch would otherwise claim a channel that is gone.
      if (Object.keys(state.accounts).length === 0) state.autoStart = false
    })

    if (found) this.#recordBoot(`disconnected account ${accountId}`)
    // The bindings this account owned are gone, so the sync index has to lose them too — otherwise a
    // session that is no longer the channel's keeps being told the user is on a phone.
    await this.syncBoundSessions()
    return found
  }

  /**
   * Per-account poll detail.
   *
   * Distinguishes an account whose poll is live from one whose monitor exists but has stopped —
   * the summary status cannot tell those apart, and with several accounts bound that is the
   * difference between "still working" and "silently dead".
   */
  async accountDetail(): Promise<
    {
      accountId: string
      userId?: string
      polling: boolean
      /** False when the token went stale and the account needs a new scan. */
      credentialsUsable: boolean
      /** Conversations bound to this account. */
      bindings: number
    }[]
  > {
    const state = await this.#store.read()
    return Object.values(state.accounts).map((account) => ({
      accountId: account.accountId,
      ...(account.userId === undefined ? {} : { userId: account.userId }),
      polling: this.#monitors.has(account.accountId),
      credentialsUsable: !this.#needsLogin,
      bindings: Object.values(state.bindings).filter(
        (binding) => binding.accountId === account.accountId,
      ).length,
    }))
  }


  /** Current login task state. */
  loginState(): LoginState {
    return this.#loginTask?.state ?? { phase: 'idle' }
  }

  /** Turn the channel on or off and persist the choice. */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.#store.update((state) => {
      state.autoStart = enabled
    })
    if (enabled) await this.start()
    else await this.stop()
  }

  /** Start a monitor for every stored account. Safe to call repeatedly. */
  async start(): Promise<void> {
    const state = await this.#store.read()
    const accounts = Object.values(state.accounts)
    if (accounts.length > 0) this.#needsLogin = false
    for (const account of accounts) await this.#startMonitor(account)
  }

  /** Stop monitoring and tell the service we are going away. */
  async stop(): Promise<void> {
    for (const { monitor, abort } of this.#monitors.values()) {
      abort.abort()
      void monitor.notifyStop()
    }
    this.#monitors.clear()
  }

  /** Tear everything down for plugin disposal. */
  async halt(): Promise<void> {
    for (const entry of this.#replies.values()) clearTimeout(entry.timer)
    this.#replies.clear()
    // Parked attachments hold timers; a reload must not leave one to fire against a
    // disposed runtime.
    this.#clearParked()
    this.#loginTask?.controller.abort()
    this.#loginTask = undefined
    await this.stop()
  }

  /**
   * Feed one inbound message through the channel's real pipeline.
   *
   * Exposed so tests — and any future in-process source of messages — can drive the
   * same path a WeChat delivery takes, without standing up a long poll.
   */
  async ingest(message: InboundMessage): Promise<void> {
    await this.#handleInbound(message)
  }

  /**
   * Run one login handshake to completion, driving the generator.
   *
   * The task outlives the HTTP request that started it, so the user can reload the
   * settings page — or close it — while still on the phone confirming the scan.
   */
  async startLogin(): Promise<LoginState> {
    if (this.#loginTask !== undefined) return this.#loginTask.state

    const state = await this.#store.read()
    // Passing the tokens we already hold is what makes the server answer
    // `binded_redirect` instead of re-binding the account from under the user.
    const existingTokens = Object.values(state.accounts)
      .map((account) => account.token)
      .filter((token) => token.length > 0)

    const controller = new AbortController()
    const task = {
      controller,
      state: { phase: 'running', step: '正在获取二维码…' } as LoginState,
    }
    this.#loginTask = task

    void (async () => {
      try {
        const iterator = loginHandshake(
          { existingTokens, reuseExisting: 'adopt' },
          controller.signal,
        )
        let input: string | undefined
        for (;;) {
          const next = await iterator.next(input)
          if (next.done === true) {
            const result = next.value
            if (result.account !== undefined) {
              await this.#adoptAccount(result.account)
              task.state = {
                phase: 'succeeded',
                step: '已连接微信',
                accountId: result.account.accountId,
              }
            } else if (result.alreadyBound) {
              task.state = { phase: 'already-bound', step: '该微信账号此前已绑定，沿用原有凭据' }
            } else {
              task.state = {
                phase: 'failed',
                step: '登录未完成',
                error: result.reason ?? '未知原因',
              }
            }
            return
          }
          input = await this.#applyLoginEvent(task.state, next.value)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.#recordError(`登录失败: ${message}`)
        task.state = { phase: 'failed', step: '登录失败', error: message }
      } finally {
        if (this.#loginTask === task) {
          // Keep the terminal state readable, then allow a new attempt.
          const timer = setTimeout(() => {
            if (this.#loginTask === task) this.#loginTask = undefined
          }, LOGIN_RESULT_TTL_MS)
          timer.unref?.()
        }
      }
    })()

    return task.state
  }

  /** Answer a verification-code prompt. Returns false when nothing is waiting. */
  provideVerifyCode(code: string): boolean {
    const task = this.#loginTask
    if (task?.answer === undefined) return false
    const answer = task.answer
    task.answer = undefined
    task.state = { ...task.state, awaitingVerifyCode: false, step: '正在校验验证码…' }
    answer(code)
    return true
  }

  /** Abandon the running login task. */
  cancelLogin(): void {
    this.#loginTask?.controller.abort()
    this.#loginTask = undefined
  }

  /** Apply one handshake event to the visible state, returning generator input. */
  async #applyLoginEvent(state: LoginState, event: LoginEvent): Promise<string | undefined> {
    switch (event.kind) {
      case 'qr': {
        const qrDataUrl = await toDataUrl(event.qrUrl)
        Object.assign(state, {
          phase: 'running' as const,
          step: event.refreshed ? '二维码已刷新，请重新扫码' : '请用手机微信扫码',
          qrUrl: event.qrUrl,
          ...(qrDataUrl === undefined ? {} : { qrDataUrl }),
          awaitingVerifyCode: false,
          refreshed: event.refreshed ? (state.refreshed ?? 0) + 1 : 0,
        })
        return undefined
      }
      case 'scanned':
        Object.assign(state, { step: '已扫码，请在手机上确认' })
        return undefined
      case 'redirected':
        Object.assign(state, { step: `服务端要求切换机房：${event.host}` })
        return undefined
      case 'expired':
        Object.assign(state, {
          step: event.willRetry ? '二维码已过期，正在刷新…' : '二维码多次过期',
        })
        return undefined
      case 'failed':
        Object.assign(state, { phase: 'failed' as const, step: '登录失败', error: event.reason })
        return undefined
      case 'already-bound':
        Object.assign(state, { phase: 'already-bound' as const, step: '该微信账号此前已绑定' })
        return undefined
      case 'confirmed':
        // The terminal state is written by the caller that observes `done`.
        return undefined
      case 'verifycode-required': {
        Object.assign(state, { step: '服务端要求输入配对验证码', awaitingVerifyCode: true })
        const task = this.#loginTask
        if (task === undefined) return undefined
        return await new Promise<string>((resolve) => {
          task.answer = resolve
        })
      }
      default:
        return undefined
    }
  }

  /** Persist a freshly issued account and start polling it. */
  async #adoptAccount(account: WeixinAccount): Promise<void> {
    await this.#store.update((state) => {
      state.accounts[account.accountId] = account
      // A freshly issued token supersedes any cursor from a previous binding.
      delete state.syncBufs[account.accountId]
    })
    this.#needsLogin = false
    await this.#startMonitor(account)
  }

  /** Start the long poll for one account, unless it is already running. */
  async #startMonitor(account: WeixinAccount): Promise<void> {
    if (this.#monitors.has(account.accountId)) return

    const monitor = new ChannelMonitor({
      account,
      botAgent: this.#botAgent,
      onMessage: async (message) => {
        await this.#handleInbound(message)
      },
      onSyncBuf: async (buf) => {
        await this.#store.update((state) => {
          state.syncBufs[account.accountId] = buf
        })
      },
      onError: (error) => {
        this.#recordError(error instanceof Error ? error.message : String(error))
      },
      onStop: (reason) => {
        this.#monitors.delete(account.accountId)
        if (reason === 'stale-token') {
          this.#needsLogin = true
          this.#recordError(`账号 ${account.accountId} 的 token 已失效，需要重新扫码`)
        }
      },
    })

    // Restore the persisted cursor before the first poll so nothing is replayed.
    const state = await this.#store.read()
    const saved = state.syncBufs[account.accountId]
    if (saved) monitor.restoreSyncBuf(saved)

    const abort = new AbortController()
    this.#monitors.set(account.accountId, { monitor, abort })
    void monitor.run(abort.signal)
  }

  /**
   * Current tuned settings, with defaults filled in.
   *
   * Cached, and invalidated by {@link saveSettings}. The assistant-stream handler needs them
   * synchronously: awaiting a store read inside a frame handler opens an async gap between two
   * frames of the same answer, and the second frame then finds no buffered entry and starts a
   * fresh one — which silently drops the first half of every reply.
   */
  async #settings(): Promise<Required<ChannelSettings>> {
    this.#settingsCache ??= resolveSettings(await this.#store.read())
    return this.#settingsCache
  }

  /** Settings for a synchronous caller, falling back to the stored defaults. */
  #settingsNow(): Required<ChannelSettings> {
    return this.#settingsCache ?? resolveSettings(EMPTY_STATE)
  }

  /**
   * Read the stored settings synchronously.
   *
   * Needed by exactly one caller: the tool registration, which happens during the synchronous
   * `apply` and has to see what the user actually chose. Everything else reads through
   * {@link #settings}, which awaits the store. A missing or unreadable file falls back to the
   * defaults, exactly as a first run would.
   *
   * @returns The effective settings.
   */
  #settingsFromDisk(): Required<ChannelSettings> {
    if (this.#settingsCache !== undefined) return this.#settingsCache
    let settings: ChannelSettings | undefined
    try {
      const parsed = JSON.parse(readFileSync(this.#stateFilePath, 'utf-8')) as {
        settings?: ChannelSettings
      }
      settings = parsed.settings
    } catch {
      settings = undefined
    }
    this.#settingsCache = resolveSettings({ ...EMPTY_STATE, settings: settings ?? {} })
    return this.#settingsCache
  }

  /**
   * Persist a settings patch and refresh the cache.
   *
   * @param patch - Fields to change; absent fields keep their stored value.
   * @returns The settings after the change.
   */
  async saveSettings(patch: ChannelSettings): Promise<Required<ChannelSettings>> {
    const before: Required<ChannelSettings> = this.#settingsNow()
    let next: Required<ChannelSettings> = before
    try {
      await this.#store.update((state) => {
        state.settings = { ...(state.settings ?? {}), ...patch }
        next = resolveSettings(state)
      })
    } catch (error) {
      /*
       * A failed save leaves the page reporting one thing and the file holding another, and the
       * user's only evidence is that nothing changed. Logged before the throw, because the route
       * turns the throw into a 500 whose text never reaches this file.
       */
      this.#recordBoot(`settings: save FAILED patch=${describeSettingsPatch(patch)} error="${describeError(error)}"`)
      throw error
    }
    this.#settingsCache = next
    /*
     * One line per save, with both values.
     *
     * The state file records what is stored *now*, which cannot tell "this save never arrived" from
     * "it arrived and was dropped" — the old and new values can, and this is the only place both
     * are known. It is what a user means by "I set it and nothing happened".
     */
    this.#recordBoot(`settings: ${describeSettingsSave(before, next, patch)}`)
    // The confirmation policy lives in the session tool's description, which the registry copies at
    // registration. Without this the setting would look inert until the next restart.
    if (next.requireConfirmation !== before.requireConfirmation) this.refreshSessionTool()
    return next
  }

  /** Route one inbound WeChat message. */
  async #handleInbound(message: InboundMessage): Promise<void> {
    /*
     * Every inbound message is logged, and it is the only window marker there is.
     *
     * The reply window opens here and nowhere else, so this line is what lets the log answer the two
     * questions the platform will not: how many sends a window survives before it is refused, and how
     * long a silence it survives. Counting outbound lines back to the nearest one of these gives the
     * first; the timestamp difference gives the second. Deliberately just the peer and the kind —
     * the text is already in the transcript, and a log that grows with every message becomes
     * unreadable exactly when it is needed.
     */
    this.#recordBoot(
      `inbound: ${message.conversationId} media=${String(message.media?.length ?? 0)} text=${String(message.text.length)}`,
    )

    // Remember the reply token for this conversation before anything can fail.
    if (message.contextToken !== undefined) {
      const token = message.contextToken
      await this.#store.update((state) => {
        const perAccount = (state.contextTokens[message.accountId] ??= {})
        perAccount[message.conversationId] = token
      })
    }

    /*
     * A message from the user is the only thing that reopens the reply window, so anything queued
     * while it was closed goes out now — before this message is handled, so the backlog reads as a
     * backlog rather than as answers to the question they just asked.
     */
    await this.#flushPending(message.conversationId)

    const account = await this.#account(message.accountId)
    if (account === undefined) {
      /*
       * The message is dropped here, and this line is the only trace it leaves.
       *
       * The account is gone once its token goes stale (`forgetAccount`), and everything that would
       * have answered the user needs it. Returning silently — which this did — meant a message could
       * be received, logged as an inbound line, and then never answered, never stored and never
       * mentioned again: exactly the silence this channel must not produce. Loud, because unlike a
       * chat that has moved, this one is not a state the user can recover from by writing again.
       */
      this.#recordError(
        `inbound dropped: account ${message.accountId} is no longer stored ` +
          `(conversation=${message.conversationId} text=${String(message.text.length)} chars)`,
      )
      return
    }
    this.#startTyping(message.accountId, message.conversationId, message.peerId)
    let handedOff = false
    try {
      /*
       * No sender check, because the protocol makes one unnecessary.
       *
       * An iLink bot is bound at provisioning to the single WeChat user who scanned the QR, and the
       * issued bot token embeds that user's id. The service only ever delivers that user's messages —
       * `from_user_id` is always the scanner — and the bot is not a WeChat contact entity: it has no
       * shareable card and nothing to search for. There is no third party who could reach it, so
       * there is no list to keep.
       *
       * This is written down because a stale comment here once claimed an allow list *was* checked.
       * None ever existed, and a security warning was built on top of that claim and shipped in the
       * README for the life of the project. Do not reintroduce either.
       */
      // Record the raw item before touching it. The service's own image item is the only
      // known-renderable sample of this protocol — this plugin is the only implementation,
      // and nothing in the application documents the format — so the field list it uses is
      // the reference an outbound item has to match. Writing it down is what makes that
      // comparison possible at all.
      for (const item of message.media ?? []) {
        // The whole item, not a prefix: `encrypt_query_param` alone runs past 600
        // characters, so any short cap cuts off precisely the fields worth comparing.
        this.#recordBoot(`inbound media item: ${JSON.stringify(item)}`)
      }

      // Record every quoted message, whole. A quote is the one inbound shape whose fields have
      // never been observed here, and what it carries decides the entire cache design: a
      // `message_item` needs no cache at all, an `svr_id` needs ours keyed by the same id
      // shape, and a `partial_text` needs neither. Guessing between those three is what the
      // tool-card detour cost, so the sample comes first this time.
      for (const item of message.raw.item_list ?? []) {
        if (item.ref_msg === undefined) continue
        this.#recordBoot(`inbound quote: ${JSON.stringify(item.ref_msg)}`)
      }

      const attachments = await this.#fetchAttachments(message)

      // Read once per message, so every decision below sees one consistent set of settings.
      const settings = await this.#settings()

      // A pending permission prompt or question owns the next reply. It is checked before
      // anything else, because "1" or "允许" answers the prompt the user was just shown — routed
      // as a request it would confuse the agent and leave the interaction stuck forever.
      if (attachments.length === 0 && (await this.#settleInteraction(message))) return

      // A non-text message never gets an immediate answer. It is parked, and this returns
      // without replying: the user is about to say what they want done with it. Only after the
      // merge window does the batch go through on its own.
      if (attachments.length > 0) {
        this.#parkAttachments(message, attachments, settings)
        return
      }

      handedOff = await this.#deliver(message, { media: [], text: message.text, attachments: [] })
    } catch (error) {
      this.#recordError(`处理消息失败: ${error instanceof Error ? error.message : String(error)}`)
      await this.#reply(account, message.conversationId, message.peerId, '处理这条消息时出错了。')
    } finally {
      /*
       * Only cleared when the turn did *not* go to the agent.
       *
       * A message handed to the agent is still being worked on when this returns — `#deliver`
       * submits and comes back — so clearing here would blink the indicator off while the agent is
       * busy, which is the opposite of what it is for. In that case `#reply` clears it, when the
       * answer actually goes out. Anything else (a parked attachment, a command answered locally)
       * is finished by the time this returns, so it is cleared here.
       */
      if (!handedOff) this.#stopTyping(message.conversationId)
    }
  }

  /**
   * Show "typing…" for a conversation, and keep it showing until the reply goes out.
   *
   * Re-sent on an interval because the indicator is short-lived on the client: sent once, it
   * disappears long before a real task finishes, which is the case this exists for. The interval is
   * cleared in {@link #stopTyping}, and bounded here so a reply that never comes cannot leave the
   * channel re-sending forever.
   *
   * @param accountId - Account the message came in on.
   * @param conversationId - Conversation to key the state by.
   * @param peerId - Peer to show it to.
   */
  #startTyping(accountId: string, conversationId: string, peerId: string): void {
    const monitor = this.#monitors.get(accountId)?.monitor
    if (monitor === undefined) return
    if (this.#typing.has(conversationId)) return

    const send = (): void => {
      void monitor.setTyping(peerId, true)
    }
    send()
    const interval = setInterval(send, TYPING_REFRESH_MS)
    // `unref` so a pending indicator never keeps the process alive on shutdown.
    interval.unref?.()
    const cap = setTimeout(() => {
      this.#stopTyping(conversationId)
    }, TYPING_MAX_MS)
    cap.unref?.()
    this.#typing.set(conversationId, { interval, cap, accountId, peerId })
  }

  /**
   * Clear "typing…" for a conversation, if it was showing.
   *
   * @param conversationId - Conversation to clear.
   */
  #stopTyping(conversationId: string): void {
    const state = this.#typing.get(conversationId)
    if (state === undefined) return
    this.#typing.delete(conversationId)
    clearInterval(state.interval)
    clearTimeout(state.cap)
    const monitor = this.#monitors.get(state.accountId)?.monitor
    void monitor?.setTyping(state.peerId, false)
  }

  /**
   * Park one non-text message and (re)start its window.
   *
   * Nothing is sent yet. Whatever was already parked stays, so a video followed by a photo
   * followed by a file is one batch, not three.
   */
  #parkAttachments(
    message: InboundMessage,
    attachments: { media: DownloadedMedia; path: string }[],
    settings: Required<ChannelSettings>,
  ): void {
    const existing = this.#pending.get(message.conversationId)
    if (existing !== undefined) clearTimeout(existing.timer)

    const text = [existing?.text ?? '', message.text]
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join('\n\n')

    // With auto-reply off the batch waits indefinitely for an instruction. The entry is still
    // recorded, so a later text message folds it in — that is what makes the setting "only
    // answer when I say something" rather than "ignore attachments".
    const timer = settings.autoReplyAttachments
      ? setTimeout(() => {
          // The window closed with no instruction, so hand the attachments over on their own.
          // `#deliver` claims the parked batch itself; deleting it here first would throw the
          // attachments away and send an empty turn.
          void this.#deliver(message, { media: [], text: '', attachments: [] })
        }, settings.mergeWindowMs)
      : undefined

    timer?.unref?.()

    this.#pending.set(message.conversationId, {
      attachments: [...(existing?.attachments ?? []), ...attachments],
      text,
      timer,
    })
  }

  /**
   * Settle a pending interaction from the user's reply, when one is waiting.
   *
   * @param message - The inbound message.
   * @returns Whether the reply was consumed as an answer.
   */
  async #settleInteraction(message: InboundMessage): Promise<boolean> {
    const pending = this.#interactions.get(message.conversationId)
    if (pending === undefined) return false
    const value = pending.accept(message.text)
    if (value === undefined) {
      // Not an answer to this prompt. The prompt is shown again rather than swallowing the text,
      // so a message on another topic is neither lost nor mistaken for a bad answer.
      pending.reprompt()
      return false
    }
    this.#interactions.delete(message.conversationId)
    this.#recordBoot(`interaction settled: ${pending.kind}`)
    // The reply was meant for the prompt, not for a listing the user had open before it: that browse
    // is over, and a later 「查看其余」 must not continue it.
    await this.#trackBrowse(message.accountId, message.conversationId, undefined)
    pending.settle(value as never)
    return true
  }

  /**
   * Ask the user a question over WeChat and wait for the answer.
   *
   * The account and peer are passed in rather than looked up from the conversation's binding. The
   * session-control tool runs inside a session that may have no binding yet — it can be asked to
   * create the first one — so requiring a lookup here would fail exactly when the feature is
   * needed.
   *
   * @param conversationId - Conversation to ask.
   * @param account - Account to reply from.
   * @param peerId - Recipient of the question.
   * @param body - Prompt text.
   * @param kind - Interaction kind, for logging.
   * @param parse - Reads the reply, returning undefined when it is not an answer.
   * @param signal - Aborts when the harness withdraws the request.
   * @returns The parsed answer, or undefined when the request was withdrawn first.
   */
  async #ask<T>(
    conversationId: string,
    account: WeixinAccount,
    peerId: string,
    body: string,
    kind: 'approval' | 'question',
    parse: (reply: string) => T | undefined,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const settled = Promise.withResolvers<T | undefined>()
    // A later prompt in the same conversation replaces this one: the user is looking at the most
    // recent question, and holding two would make an ambiguous reply impossible to attribute.
    const previous = this.#interactions.get(conversationId)
    if (previous !== undefined) {
      this.#interactions.delete(conversationId)
      previous.settle(undefined as never)
    }
    this.#interactions.set(conversationId, {
      kind,
      accept: parse as (reply: string) => unknown | undefined,
      settle: settled.resolve as (value: never) => void,
      reprompt: () => {
        void this.#reply(account, conversationId, peerId, `请回复上一条提示。\n\n${body}`)
      },
    })

    const onAbort = (): void => {
      this.#interactions.delete(conversationId)
      settled.resolve(undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      await this.#reply(account, conversationId, peerId, body)
      this.#recordBoot(`interaction asked: ${kind} -> ${peerId}`)
      return await settled.promise
    } finally {
      signal?.removeEventListener('abort', onAbort)
      // Only clear our own entry: a newer prompt may already have replaced it.
      const current = this.#interactions.get(conversationId)
      if (current?.settle === (settled.resolve as (value: never) => void)) {
        this.#interactions.delete(conversationId)
      }
    }
  }

  /**
   * Claim permission prompts for conversations bound to WeChat.
   *
   * Unbound conversations delegate, so the desktop pane answers as before.
   *
   * @returns The listener for `ctx.on('approval/request', ...)`.
   */
  approvalListener(): (
    request: unknown,
    next: () => Promise<ApprovalOutcome>,
  ) => Promise<ApprovalOutcome> {
    return async (request, next) => {
      const record = (request ?? {}) as {
        agent?: unknown
        toolName?: unknown
        displayReason?: unknown
        reason?: unknown
        command?: unknown
        signal?: AbortSignal
      }
      const sessionId = sessionIdOf(record.agent)
      const conversationId = await this.#conversationForAgentSession(sessionId)
      // Recorded either way. An answerer that is never invoked and one that abstains look
      // identical from the phone — both leave the prompt on the desktop — so the decision is
      // written where the next diagnosis can find it.
      this.#recordBoot(
        `approval seen: tool=${String(record.toolName)} session=${sessionId ?? '(none)'} ` +
          `${conversationId === undefined ? 'not-a-wechat-session -> delegate' : 'claiming'}`,
      )
      if (conversationId === undefined) return await next()
      const target = await this.#askTarget(conversationId)
      if (target === undefined) return await next()

      const answer = await this.#ask(
        conversationId,
        target.account,
        target.peerId,
        presentApproval(record).body,
        'approval',
        parseApprovalReply,
        record.signal,
      )
      // Withdrawn or unanswerable: hand it back rather than guessing. Guessing on a permission
      // prompt means granting something the user never agreed to.
      if (answer === undefined) return await next()
      return answer
    }
  }

  /**
   * Claim structured questions for conversations bound to WeChat.
   *
   * @returns The listener for `ctx.on('user-questions/request', ...)`.
   */
  questionListener(): (
    request: unknown,
    next: () => Promise<QuestionAnswerBatch>,
  ) => Promise<QuestionAnswerBatch> {
    return async (request, next) => {
      const record = (request ?? {}) as {
        agent?: unknown
        questions?: QuestionItem[]
        signal?: AbortSignal
      }
      const questions = record.questions
      if (!Array.isArray(questions) || questions.length === 0) return await next()
      const sessionId = sessionIdOf(record.agent)
      const conversationId = await this.#conversationForAgentSession(sessionId)
      this.#recordBoot(
        `question seen: count=${String(questions.length)} session=${sessionId ?? '(none)'} ` +
          `${conversationId === undefined ? 'not-a-wechat-session -> delegate' : 'claiming'}`,
      )
      if (conversationId === undefined) return await next()
      const target = await this.#askTarget(conversationId)
      if (target === undefined) return await next()

      const answer = await this.#ask(
        conversationId,
        target.account,
        target.peerId,
        presentQuestions(questions).body,
        'question',
        (reply) => parseQuestionReply(questions, reply),
        record.signal,
      )
      if (answer === undefined) return await next()
      return answer
    }
  }

  /**
   * Resolve where a question for a conversation should be sent.
   *
   * Used by the listeners that are handed a session rather than a message, so they have to look the
   * conversation up. A confirmation does not need this: it is asked from the inbound message,
   * which already carries both.
   *
   * @param conversationId - Conversation to resolve.
   * @returns The account and peer, or undefined when the conversation is not bound.
   */
  async #askTarget(
    conversationId: string,
  ): Promise<{ account: WeixinAccount; peerId: string } | undefined> {
    const state = await this.#store.read()
    const binding = state.bindings[conversationId]
    if (binding === undefined) return undefined
    const account = state.accounts[binding.accountId]
    if (account === undefined) return undefined
    return { account, peerId: binding.peerId }
  }

  /**
   * The conversation a session may speak for.
   *
   * Only the session a conversation is **currently** bound to may act on its behalf.
   *
   * This used to also accept any session a conversation had ever used, through a `sessionOwners`
   * map. That map is gone, and the reason is worth keeping: it made a conversation's *former*
   * session able to send messages, ask questions and switch sessions for the rest of time. After
   * `/new`, the development session this plugin was written in stayed an owner of the WeChat
   * conversation, so a question asked from it — through a different harness session entirely —
   * arrived on the user's phone.
   *
   * A bookkeeping trail is not a grant of authority, and the two were the same map.
   *
   * @param sessionId - Session to look up, if known.
   * @returns The conversation key, when this session is the one bound to it.
   */
  async #conversationForAgentSession(sessionId: string | undefined): Promise<string | undefined> {
    if (sessionId === undefined) return undefined
    const state = await this.#store.read()
    const found = Object.values(state.bindings).find((entry) => entry.sessionId === sessionId)
    return found?.conversationId
  }

  /**
   * Hand one turn to the agent.
   *
   * Any parked attachment is flushed into this call first, so an instruction that arrives
   * moments after a photo reaches the agent once, with both. Passing empty text yields the
   * same shape as waiting out the window — which is why releasing needs no separate path.
   */
  async #deliver(
    message: InboundMessage,
    incoming: {
      media: DownloadedMedia[]
      text: string
      attachments: { media: DownloadedMedia; path: string }[]
    },
  ): Promise<boolean> {
    try {
      const parked = this.#claimParked(message.conversationId)
      const attachments = [...parked.attachments, ...incoming.attachments]
      // A quote is resolved first: what the user is replying *to* is context the rest of the
      // message only makes sense against, so it belongs before it.
      const quoted = await this.#resolveQuote(message)
      const text = [parked.text, incoming.text]
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .join('\n\n')
      const account = await this.#account(message.accountId)
      if (account === undefined) {
        // Reachable from the parked-attachment timer, which fires long after the inbound handler
        // checked: an account that went away in the meantime would otherwise lose the batch in
        // silence, including the user's own words that were waiting with it.
        this.#recordError(
          `inbound dropped: account ${message.accountId} is no longer stored ` +
            `(conversation=${message.conversationId}, attachments=${String(attachments.length)})`,
        )
        return false
      }

      // A command answers locally and never reaches the agent, so an attachment riding along
      // would be dropped without trace. With an attachment the text goes to the agent as an
      // ordinary instruction instead: losing the user's file is worse than ignoring a slash.
      // A command answered in the user's own words is proposed, not performed. Recognition is
      // allowed to be imperfect precisely because this stands between it and any effect.
      if (attachments.length === 0) {
        /*
         * Where this conversation is in the listing browser, read before routing.
         *
         * 「查看其余」 has no target, so the router can only interpret it against the position the
         * user left — and the state file is the only place that lives. Read here rather than inside
         * the router so the router keeps knowing nothing about persistence.
         */
        const browse = await this.#browseFor(message.accountId, message.conversationId)
        const routed = await this.#router.route({
          conversationId: message.conversationId,
          accountId: message.accountId,
          peerId: message.peerId,
          text,
          // The listing a bare number answers from: the one this message quotes, or the newest one
          // this conversation was sent. Read before routing, so the router never has to guess.
          ...(await this.#numberedRowsFor(message.conversationId, message.accountId, message)),
          ...(browse === undefined ? {} : { browse }),
        })
        if (routed.kind === 'reply') {
          const delivered = await this.#reply(
            account,
            message.conversationId,
            message.peerId,
            routed.text,
            routed.numbered,
          )
          /*
           * A screen advances the browse only once it has actually gone out.
           *
           * The position is what 「查看其余」 continues, so advancing it past a message the service
           * refused would make the next step skip a page the user never saw. Clearing is exempt:
           * a conversation that is not browsing is already there, and a failed clear costs nothing.
           */
          if (delivered || routed.browse === undefined) {
            await this.#trackBrowse(message.accountId, message.conversationId, routed.browse)
          }
          return false
        }
        // Anything handed to the agent ends the browse: the user has moved on to something else, and
        // the phrase must not later continue a listing they are no longer looking at.
        await this.#trackBrowse(message.accountId, message.conversationId, undefined)
        await this.#prompt(routed.decision, message, [], quoted)
        return true
      }

      // Resolve the session the usual way, then hand it the attachments *and* the text
      // together. Empty text is fine here: the router still binds or adopts the session,
      // and the attachments carry the turn on their own.
      const bound = await this.#router.route({
        conversationId: message.conversationId,
        accountId: message.accountId,
        peerId: message.peerId,
        text: '',
      })
      if (bound.kind === 'reply') {
        await this.#reply(account, message.conversationId, message.peerId, bound.text)
        return false
      }
      // A file is not a step in a listing, so the browse it may have interrupted is left behind —
      // the same rule as any other message that is not a step.
      await this.#trackBrowse(message.accountId, message.conversationId, undefined)
      await this.#prompt({ ...bound.decision, prompt: text }, message, attachments, quoted)
      return true
    } catch (error) {
      this.#recordError(`处理消息失败: ${error instanceof Error ? error.message : String(error)}`)
      const account = await this.#account(message.accountId)
      if (account !== undefined) {
        await this.#reply(account, message.conversationId, message.peerId, '处理这条消息时出错了。')
      }
      return false
    }
  }

  /**
   * Claim and clear whatever is parked for a conversation.
   *
   * @param conversationId - Conversation to collect for.
   * @returns The parked attachments and their accumulated caption.
   */
  #claimParked(conversationId: string): {
    attachments: { media: DownloadedMedia; path: string }[]
    text: string
  } {
    const parked = this.#pending.get(conversationId)
    if (parked === undefined) return { attachments: [], text: '' }
    clearTimeout(parked.timer)
    this.#pending.delete(conversationId)
    return { attachments: parked.attachments, text: parked.text }
  }

  /** Drop every parked batch. Called on teardown so no timer outlives the plugin. */
  #clearParked(): void {
    for (const parked of this.#pending.values()) clearTimeout(parked.timer)
    this.#pending.clear()
  }

  /**
   * Register the tool the agent uses to send a file back to WeChat.
   *
   * This is what makes outbound media reachable at all. The client could already upload
   * and send an image — the functions existed — but nothing ever called them, so a file
   * the agent produced had no way out of the process and the phone saw nothing.
   *
   * @returns The disposer that unregisters the tool.
   */
  registerTools(): Disposer {
    const tools = this.#ctx.tools
    if (tools === undefined) {
      this.#recordError('此组合没有工具服务，agent 无法主动发送文件到微信')
      return () => {}
    }

    const send = tools.register({
      name: 'send_to_wechat',
      description:
        'Send a file from this machine to the WeChat conversation that asked for it — for any ' +
        'file, image, video, or screenshot the user wants. Images arrive as photos, videos as ' +
        'playable clips, everything else as a file attachment. The path must be absolute and may ' +
        'be anywhere on this machine; no copy needed.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path of the file to send.',
          },
          caption: {
            type: 'string',
            description: 'Optional short message to send before the file.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        // Standard JSON Schema: `required` is a sibling array of property names. The
        // `defineTool` parameter-spec form puts `required: true` inside the property
        // itself, and the registry rejects that shape with a JsonSchemaError.
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { detail: { type: 'string' } },
          required: ['detail'],
        },
        render: (args) => [
          { type: 'text', text: `sent ${String(args.path ?? '')} to WeChat` },
        ],
      },
      execute: async (args, exec) => ({
        detail: await this.#sendFileToWechat(String(args.path ?? ''), args.caption, exec),
      }),
    })

    // The registry stores the description as given, so a change to the confirmation setting has to
    // re-register rather than mutate. Holding the disposer here is what lets `saveSettings` do it.
    const control = tools.register(this.#sessionToolDefinition())

    // The model half. Registered next to the session tool because the two are the same shape of
    // request — something the user asks for in words that the agent has to interpret — and the
    // description is what tells them apart.
    const model = tools.register(this.#modelToolDefinition())

    /*
     * The proactive half. `send_to_wechat` only works for the session the WeChat conversation is
     * bound to, which means the session doing the work usually cannot report its own result: the user
     * asks for something, walks away, and the answer dies with the turn.
     *
     * This tool resolves the *currently bound* conversation from the store instead of from the
     * caller, so any session can deliver to the phone the user is actually holding. It never takes a
     * target argument, so there is nothing an agent can aim wrongly.
     */
    const notify = tools.register({
      name: 'notify_wechat',
      description:
        'Push a message, and optionally a file, to the user\'s WeChat from any session, even ' +
        'unbound, always to their current conversation; no target can be chosen. Use it for ' +
        'finished work or a requested file. Only ten messages fit per reply window; it reopens ' +
        'only when the user writes, and the rest wait for their next message — so send several ' +
        'things as one message, not several, since each costs a slot. Use this tool even for a ' +
        'timed series, one call per message; a script must run `dsh-wechat-send`, never the iLink ' +
        'API — only plugin sends count, warn and queue, so direct calls lose messages. Keep it ' +
        'short for a phone.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The message to send. Short, and written for a phone.',
          },
          path: {
            type: 'string',
            description:
              'Optional absolute path of a file to send after the text. Images arrive as photos, videos as playable clips, everything else as a file attachment.',
          },
          merge: {
            type: 'boolean',
            description:
              'Set true only when this text is a fragment of one thought and the next few seconds may bring more - fragments then arrive as a single message. Leave it unset for a notice that stands on its own, and never set it for a series meant to arrive one message at a time (a timed reminder, a countdown): merging those is the opposite of what was asked.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { detail: { type: 'string' } },
          required: ['detail'],
        },
        render: (args) => [
          { type: 'text', text: `notify WeChat${args.path === undefined ? '' : ` with ${String(args.path)}`}` },
        ],
      },
      execute: async (args, exec) => ({
        detail: await this.#notifyWechat(
          String(args.text ?? ''),
          args.path,
          exec,
          args.merge === true,
        ),
      }),
    })

    return () => {
      this.#sessionToolDisposer = undefined
      send()
      control()
      model()
      notify()
    }
  }

  /**
   * Deliver a message, and optionally a file, to the bound WeChat conversation.
   *
   * @param text - Message to send. Sent first, so a file arrives with its explanation already there.
   * @param path - Optional absolute path of a file to send after the text.
   * @param exec - Tool execution context, used for cancellation and for the fallback check.
   * @returns A short human-readable outcome.
   */
  async #notifyWechat(
    text: string,
    path: unknown,
    exec: { readonly signal?: AbortSignal; readonly agent?: unknown },
    merge = false,
  ): Promise<string> {
    if (text.trim() === '' && typeof path !== 'string') {
      throw new Error('至少要给 text 或 path 其中一个。')
    }

    /*
     * With the setting off, this behaves exactly as `send_to_wechat` does: the caller has to be the
     * bound session. That keeps the older, stricter rule reachable rather than deleting it, so
     * turning the setting off restores the previous security posture instead of only disabling a
     * convenience.
     */
    if (!this.#settingsFromDisk().allowCrossSessionNotify) {
      const own = await this.#conversationForAgent(exec.agent)
      if (own === undefined) {
        throw new Error(
          '这个会话没有绑定微信对话，而「允许其他会话推送到微信」是关闭的。请让用户在设置里打开它，或先在微信里发一条消息。',
        )
      }
      if (merge && typeof path !== 'string') return this.#mergePush(own, text)
      return await this.#deliverTo(own, text, path, exec.signal)
    }

    const bound = await this.#boundConversation()
    if (!bound.ok) throw new Error(bound.reason)
    if (merge && typeof path !== 'string') return this.#mergePush(bound.target, text)
    return await this.#deliverTo(bound.target, text, path, exec.signal)
  }

  /**
   * Send the text and then the file, into one already-resolved conversation.
   *
   * Each piece is attempted separately and a refusal queues only the piece that was refused, so a
   * message that arrives before the window closes is not sent twice when the file behind it is held
   * back for later.
   *
   * @param target - Conversation to deliver to.
   * @param text - Message to send; skipped when empty.
   * @param path - File to send; skipped unless it is a string.
   * @param signal - Cancellation from the caller, when there is one.
   * @returns What was sent, for the agent to report.
   */
  /**
   * Hold one fragment for the merge window instead of sending it now.
   *
   * A file is never merged: the path is dropped from the buffered branch, because appending a
   * file to a line of text is not a thing the platform can do.
   *
   * @param target - Where the merged message will go.
   * @param text - The fragment.
   * @returns A note for the caller, which is what the tool reports back.
   */
  #mergePush(target: NotifyTarget, text: string): string {
    const key = target.conversationId
    const existing = this.#mergeBuf.get(key)
    const entry = existing ?? {
      target,
      lines: [] as string[],
      first: Date.now(),
      timer: undefined as unknown as NodeJS.Timeout,
    }
    entry.lines.push(text)
    if (existing !== undefined) clearTimeout(existing.timer)
    // Held until the stream goes quiet, but never past the cap: fragments arriving every second
    // would otherwise postpone delivery for as long as they keep coming.
    const age = Date.now() - entry.first
    const wait = Math.max(200, Math.min(MERGE_WINDOW_MS, MERGE_MAX_HOLD_MS - age))
    entry.timer = setTimeout(() => {
      void this.#flushMerge(key)
    }, wait)
    entry.timer.unref?.()
    this.#mergeBuf.set(key, entry)
    return `已并入合并窗口（第 ${String(entry.lines.length)} 条），稍后作为一条消息发出。`
  }

  /** Send whatever a merge has collected, as one message. */
  async #flushMerge(conversationId: string): Promise<void> {
    const entry = this.#mergeBuf.get(conversationId)
    if (entry === undefined) return
    this.#mergeBuf.delete(conversationId)
    try {
      await this.#deliverTo(entry.target, entry.lines.join('\n'), undefined)
    } catch (error) {
      this.#recordError(
        `合并消息发送失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async #deliverTo(
    target: { account: WeixinAccount; peerId: string; conversationId: string; contextToken?: string },
    text: string,
    path: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    const file = typeof path === 'string' && path !== '' ? path : undefined
    if (text.trim() === '' && file === undefined) throw new Error('没有可发送的内容。')

    /*
     * Queued as one entry rather than two, because the text is usually the caption for the file: sent
     * separately later, the file would arrive with no explanation. Whatever went out before the
     * refusal is dropped from the entry so it is not repeated.
     */
    let outstandingText = text.trim() === '' ? '' : text
    let outstandingPath = file
    const done: string[] = []

    if (outstandingText !== '') {
      if (await this.#sendOrQueue(target, outstandingText, undefined, signal)) {
        done.push('消息')
        outstandingText = ''
      }
    }
    if (outstandingPath !== undefined) {
      if (await this.#sendOrQueue(target, '', outstandingPath, signal)) {
        done.push(`文件 ${basename(outstandingPath)}`)
        outstandingPath = undefined
      }
    }
    if (outstandingText === '' && outstandingPath === undefined) {
      const summary = `已通过微信发送：${done.join('、')}`
      // Recorded because a proactive send has no other trace: nothing in the transcript shows it, and
      // "did it actually reach the phone" is the only question that matters when it is reported.
      this.#recordBoot(`notify_wechat: ${done.join(', ')} to ${target.conversationId}`)
      return summary
    }

    // The window is closed. Kept for the next message the user sends, which reopens it.
    const held = outstandingPath === undefined ? '这条消息' : `文件 ${basename(outstandingPath)}`
    this.#recordBoot(
      `notify_wechat: 窗口已关闭，${held} 已排队（会话 ${target.conversationId}）` +
        (done.length > 0 ? `；已先送出 ${done.join('、')}` : ''),
    )
    return (
      `${held}没能立刻发出：微信的回信窗口已关闭。已排队，` +
      `会在用户下次在微信里发消息时自动补发。` +
      (done.length > 0 ? `（已先送出：${done.join('、')}）` : '')
    )
  }

  /**
   * Send one piece, or keep it for the next open window.
   *
   * Only a refusal by the service is treated this way. A missing file, a network failure or a
   * cancelled run all throw as before: those will fail again the same way, and turning them into a
   * backlog would only hide the error behind a delay.
   *
   * @param target - Conversation to deliver to.
   * @param text - Text to send; empty when only a file is being sent.
   * @param path - File to send; undefined when only text is being sent.
   * @param signal - Cancellation from the caller, when there is one.
   * @returns True when it was sent now, false when it was queued.
   */
  async #sendOrQueue(
    target: { account: WeixinAccount; peerId: string; conversationId: string; contextToken?: string },
    text: string,
    path: string | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      if (path !== undefined) await this.#conveyFile(path, undefined, target, signal)
      else {
        await this.#sendText(
          target.account,
          target.conversationId,
          target.peerId,
          text,
          target.contextToken,
        )
      }
      this.#lastRefusal = ''
      return true
    } catch (error) {
      if (!(error instanceof SendRefusedError)) throw error
      /*
       * The reason the service gave, recorded once per closed window.
       *
       * A closed window stays closed until the user writes, so every send in between is refused with
       * the same text. Logging each one would bury everything else; logging none — which is what this
       * did — left the *reason* for a failed push nowhere at all, and the reason is the whole
       * question: a stale session and a real rate limit are told apart by `errmsg`, not by the code
       * they share. Reset on a successful send so the next closure reports afresh.
       */
      const reason = error.message
      const key = `${target.conversationId}\u0000${reason}`
      if (this.#lastRefusal !== key) {
        this.#lastRefusal = key
        this.#recordBoot(`发送被拒: ${reason}`)
      }
      await this.#store.update((state) => {
        const dropped = queuePendingNotification(state, {
          conversationId: target.conversationId,
          text,
          ...(path === undefined ? {} : { path }),
        })
        if (dropped > 0) {
          this.#recordBoot(`notify_wechat: 队列已满，丢弃了 ${String(dropped)} 条最旧的待发消息`)
        }
      })
      return false
    }
  }

  /**
   * Deliver anything queued for this conversation, now that its window is open again.
   *
   * Called as soon as an inbound message refreshes the reply token, and before that message is
   * handled: the user's own turn is what reopens the window, so the backlog belongs in front of the
   * answer rather than after it — otherwise the notifications they were waiting for appear below a
   * reply that has nothing to do with them.
   *
   * A piece that is refused again stays queued for the next attempt; one whose file has since been
   * deleted is dropped, because retrying it forever would block everything behind it.
   *
   * @param conversationId - Conversation whose window just opened.
   */
  async #flushPending(conversationId: string): Promise<void> {
    try {
      // Expire first, then read: reading first would hand the loop entries that were just discarded
      // as too old, and they would go out anyway.
      const expired = await this.#expirePending()
      if (expired > 0) {
        this.#recordBoot(`pending: 丢弃 ${String(expired)} 条过期的待发消息`)
      }
      const pending = (await this.#store.read()).pendingNotifications ?? []
      const mine = pending.filter((entry) => entry.conversationId === conversationId)
      if (mine.length === 0) return

      const bound = await this.#boundConversation()
      if (!bound.ok) return
      const target = bound.target
      if (target.conversationId !== conversationId) return

      let sent = 0
      const unsendable: string[] = []
      for (const entry of mine) {
        try {
          if (entry.text.trim() !== '') {
            await this.#sendText(
              target.account,
              target.conversationId,
              target.peerId,
              entry.text,
              target.contextToken,
            )
          }
          if (entry.path !== undefined) {
            if (!existsSync(entry.path)) {
              // Dropped, not retried: the text above has already gone out, so keeping the entry would
              // repeat it on every later message and block everything queued behind it.
              unsendable.push(basename(entry.path))
              await this.#dropPending(entry.id)
              continue
            }
            await this.#conveyFile(entry.path, undefined, target)
          }
          sent += 1
          await this.#dropPending(entry.id)
        } catch (error) {
          // A refusal means the window closed again between the token and this send, which is odd but
          // possible; keeping the entry is the whole point of the queue. Anything else cannot succeed
          // on a later attempt either, so it is reported and dropped rather than retried forever.
          if (error instanceof SendRefusedError) {
            /*
             * Recorded here as well as in `#sendOrQueue`, because this loop sends directly and would
             * otherwise be the one place a refusal leaves no trace at all. That is exactly how the
             * tenth-and-later message of a burst disappeared: the first ten went out, the rest were
             * refused, and the log showed a successful flush of ten with nothing about the others.
             */
            const key = `${conversationId}\u0000${error.message}`
            if (this.#lastRefusal !== key) {
              this.#lastRefusal = key
              this.#recordBoot(`补发被拒: ${error.message}`)
            }
          } else {
            this.#recordError(
              `补发失败：${error instanceof Error ? error.message : String(error)}`,
            )
            await this.#dropPending(entry.id)
          }
        }
      }
      if (sent > 0 || unsendable.length > 0) {
        this.#recordBoot(
          `pending: 补发 ${String(sent)} 条到 ${conversationId}` +
            (unsendable.length > 0 ? `；${String(unsendable.length)} 个文件已不存在` : ''),
        )
      }
      if (unsendable.length > 0) {
        await this.#notifyAboutMissingFiles(conversationId, unsendable)
      }
    } catch (error) {
      // Never allowed to break the inbound message it was triggered by: the user's own turn matters
      // more than the backlog, and a queue that throws would swallow their message.
      this.#recordError(
        `补发待发消息时出错：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Drop everything past the age bound.
   *
   * @returns How many entries were dropped.
   */
  async #expirePending(): Promise<number> {
    let dropped = 0
    await this.#store.update((state) => {
      dropped = expirePendingNotifications(state).length
    })
    return dropped
  }

  /**
   * Remove one delivered entry.
   *
   * By id rather than by position: the flush loop reads the queue once, and a concurrent enqueue
   * would shift every index under it.
   *
   * @param id - Identity of the entry to remove.
   */
  async #dropPending(id: string): Promise<void> {
    await this.#store.update((state) => {
      const queue = state.pendingNotifications
      if (queue === undefined) return
      const next = queue.filter((entry) => entry.id !== id)
      if (next.length === 0) delete state.pendingNotifications
      else state.pendingNotifications = next
    })
  }

  /**
   * Tell the user which queued files could no longer be found.
   *
   * Sent rather than only logged: they were promised a file, and its absence is the one part of a
   * late delivery they cannot infer from what does arrive.
   *
   * @param conversationId - Conversation to tell.
   * @param names - File names that no longer exist.
   */
  async #notifyAboutMissingFiles(conversationId: string, names: string[]): Promise<void> {
    try {
      const bound = await this.#boundConversation()
      if (!bound.ok || bound.target.conversationId !== conversationId) return
      await this.#sendText(
        bound.target.account,
        bound.target.conversationId,
        bound.target.peerId,
        `之前有 ${String(names.length)} 个排队发送的文件已经找不到了：${names.join('、')}`,
        bound.target.contextToken,
      )
    } catch {
      // Best effort. This is a courtesy note about a failed delivery; if it cannot be sent either,
      // the log already has the names.
    }
  }

  /**
   * Re-register the session tool so its description reflects the current setting.
   *
   * Called after the confirmation preference changes. Without it the setting would appear to do
   * nothing until the next restart, because the agent reads the description, not the setting.
   */
  refreshSessionTool(): void {
    const tools = this.#ctx.tools
    if (tools === undefined) return
    this.#sessionToolDisposer?.()
    this.#sessionToolDisposer = tools.register(this.#sessionToolDefinition())
  }

  /**
   * The session tool as the registry needs it.
   *
   * Built synchronously, because `apply` registers tools during setup and cannot await. The
   * settings are read straight from disk here rather than through the cache, which is filled on
   * first use for the assistant-stream path — reading it at registration would see the built-in
   * defaults and the confirmation setting would silently do nothing.
   *
   * @returns The definition to register.
   */
  #sessionToolDefinition(): ToolDefinition {
    const requireConfirmation = this.#settingsFromDisk().requireConfirmation
    return {
      name: 'session_control',
      description: sessionToolDescription(requireConfirmation),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'switch', 'new', 'current', 'cancel'],
            description:
              'list: show every conversation with its number. switch: move this WeChat conversation to an existing one. new: start a fresh one. current: report which one is in use. cancel: interrupt the work running in it.',
          },
          target: {
            type: 'string',
            description:
              'For switch, the conversation to move to: its number from list, its title, or the 6-character id printed at the end of its row. For new, an optional title. For list, the literal "all" shows the workspaces on this machine instead of this workspace\'s own conversations.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            detail: { type: 'string' },
            ok: { type: 'boolean' },
          },
          required: ['detail', 'ok'],
        },
        render: (args) => [
          { type: 'text', text: `session_control ${String(args.action ?? '')}` },
        ],
      },
      execute: async (args, exec) => {
        const result = await this.controlSession(
          sessionIdOf(exec.agent),
          String(args.action ?? ''),
          args.target === undefined ? undefined : String(args.target),
        )
        this.#recordBoot(
          `session_control: action=${String(args.action)} target=${String(args.target ?? '')} ok=${String(result.ok)}`,
        )
        // The rows are appended so the agent can offer the numbered choice it just described
        // without a second call, which is what makes "switch to the 周报 one" work from one turn.
        // They carry the same numbering the user was sent, so repeating one is safe.
        return {
          detail: result.rows === '' ? result.detail : `${result.detail}\n\n${result.rows}`,
          ok: result.ok,
        }
      },
    }
  }

  /**
   * The model tool as the registry needs it.
   *
   * Built like the session tool, and registered for the same reason: a request phrased as a sentence
   * ("换个模型""切到 X""把推理等级调高") cannot be recognised by rules, so the judgement is the
   * agent's and the channel only executes it. The action set stays small — a model has no equivalent
   * of "new" or "cancel", and inventing one would give the agent a way to ask for something that
   * does not exist. Changing the level is its own action rather than a parameter of `switch`, because
   * the two are different requests: one changes which model answers, the other only how hard it
   * thinks, and a single action that sometimes did both would have to guess which was meant.
   *
   * @returns The definition to register.
   */
  #modelToolDefinition(): ToolDefinition {
    return {
      name: 'model_control',
      description: modelToolDescription(),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'switch', 'set_level'],
            description:
              'list: show every available model with its number and its reasoning levels, and mark the model and level in use. switch: move this WeChat conversation to another model. set_level: change the reasoning level of the model in use, keeping the model.',
          },
          target: {
            type: 'string',
            description:
              'For switch, the model to move to: its number from list, its name, or its model id. Required for switch. Ignored by the other actions.',
          },
          level: {
            type: 'string',
            description:
              'A reasoning level, by the name or id the list showed (for example high or 高). Required for set_level; for switch it is optional and switches the model and the level together.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            detail: { type: 'string' },
            ok: { type: 'boolean' },
          },
          required: ['detail', 'ok'],
        },
        render: (args) => [
          {
            type: 'text',
            text:
              `model_control ${String(args.action ?? '')}` +
              `${args.target === undefined ? '' : ` ${String(args.target)}`}` +
              `${args.level === undefined ? '' : ` 等级 ${String(args.level)}`}`,
          },
        ],
      },
      execute: async (args, exec) => {
        const result = await this.controlModel(
          sessionIdOf(exec.agent),
          String(args.action ?? ''),
          args.target === undefined ? undefined : String(args.target),
          args.level === undefined ? undefined : String(args.level),
        )
        this.#recordBoot(
          `model_control: action=${String(args.action)} target=${String(args.target ?? '')} ` +
            `level=${String(args.level ?? '')} ok=${String(result.ok)}`,
        )
        return { detail: result.detail, ok: result.ok }
      },
    }
  }

  /**
   * Upload one local file and deliver it to the conversation bound to the calling agent.
   *
   * @param path - Absolute path of the file to send.
   * @param caption - Optional text sent ahead of the file.
   * @param exec - Tool execution context, used for the calling agent and cancellation.
   * @returns A short human-readable outcome.
   */
  async #sendFileToWechat(
    path: string,
    caption: unknown,
    exec: { readonly signal?: AbortSignal; readonly agent?: unknown },
  ): Promise<string> {
    const target = await this.#conversationForAgent(exec.agent)
    if (target === undefined) {
      throw new Error(
        '这个会话没有绑定任何微信对话，无法发送。请让用户在微信里先发一条消息。',
      )
    }
    return await this.#conveyFile(path, caption, target, exec.signal)
  }

  /**
   * Upload and send one file into a conversation.
   *
   * Split from {@link #sendFileToWechat} so the channel can send on its own behalf — a reply too
   * long for a message — without pretending to be a tool invocation with an agent to resolve.
   *
   * @param path - File to read and send.
   * @param caption - Optional text sent before the file.
   * @param target - Resolved conversation.
   * @param signal - Cancellation from the caller, when there is one.
   */
  async #conveyFile(
    path: string,
    caption: unknown,
    target: { account: WeixinAccount; conversationId: string; peerId: string; contextToken?: string },
    signal?: AbortSignal,
  ): Promise<string> {
    const data = await readFile(path)
    const fileName = basename(path)
    // The media type is not cosmetic: the service stores the object differently per kind, and
    // a video sent as a generic file arrives as an opaque download rather than a playable clip.
    const kind = mediaKindOf(fileName)

    const uploaded = await uploadMedia({
      account: target.account,
      toUserId: target.peerId,
      data,
      fileName,
      mediaType: MEDIA_TYPE_BY_KIND[kind],
      ...(signal === undefined ? {} : { signal }),
      onDiagnostic: (detail) => {
        // Recorded because a sent-but-invisible image leaves no other trace: the service
        // accepts the message, so nothing throws and no error is ever raised.
        this.#recordBoot(
          `outbound upload: target=${detail.uploadUrl.slice(0, 150)}\n` +
            `  response=${JSON.stringify(detail.response).slice(0, 800)}`,
        )
      },
    })

    // No thumbnail is produced or referenced. The reference implementation's image item
    // carries `media` and `mid_size` only, and an extra reference it does not expect is one
    // more thing the recipient has to reconcile before it can paint the message.

    // The caption goes out *before* the attachment, matching the reference implementation,
    // which sends an optional TEXT item first and the media item second. Sending it after
    // reads as an unrelated message that happens to arrive later.
    if (typeof caption === 'string' && caption.trim() !== '') {
      await this.#reply(target.account, target.conversationId, target.peerId, caption.trim())
    }

    const sender = SENDER_BY_KIND[kind]
    const sent = await sender({
      account: target.account,
      to: target.peerId,
      uploaded,
      ...(target.contextToken === undefined ? {} : { contextToken: target.contextToken }),
      ...(signal === undefined ? {} : { signal }),
    })
    /*
     * An attachment is a message like any other and spends a slot of the same ten.
     *
     * Charged *after* the send, so a refusal — which throws out of `sender` — queues the file without
     * its slot having been counted. Charging before the attempt would make the arithmetic say one more
     * than the service saw for every message the closed window refused.
     */
    await this.#noteQuota(
      target.account,
      target.conversationId,
      target.peerId,
      target.contextToken,
    )

    // The assigned id, next to the message it names: a quoted attachment is resolved by this
    // id alone, and an attachment's content cannot be recovered from the quote itself.
    this.#recordBoot(
      `outbound: ${fileName} ${data.length}B -> ${target.peerId} (${MEDIA_LABEL_BY_KIND[kind]})` +
        ` id=${sent.serverMessageId ?? '(none)'}`,
    )
    if (sent.serverMessageId !== undefined) {
      const id = sent.serverMessageId
      await this.#store.update((s) => {
        // Resolved inside the update so the limit is read from the same state being written.
        const { quoteHistory } = resolveSettings(s)
        rememberSentMessage(
          s,
          target.account.accountId,
          target.conversationId,
          { messageId: id, kind, preview: fileName, at: Date.now() },
          quoteHistory,
        )
      })
    }
    return `已发送 ${fileName}（${data.length} 字节）到微信`
  }

  /**
   * Find the WeChat conversation whose session is the calling agent's.
   *
   * @param agent - The tool's calling agent, whose session id identifies the binding.
   */
  async #conversationForAgent(
    agent: unknown,
  ): Promise<
    | { account: WeixinAccount; peerId: string; conversationId: string; contextToken?: string }
    | undefined
  > {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return undefined

    const state = await this.#store.read()
    const binding = Object.values(state.bindings).find((entry) => entry.sessionId === sessionId)
    return this.#conversationOf(state, binding)
  }

  /**
   * The conversation the channel is currently bound to, whoever is asking.
   *
   * This is what lets a session that is *not* the bound one deliver a message — the point of
   * `notify_wechat`. The target is read from the binding rather than taken from the caller, so a
   * proactive message can only ever reach the conversation the user is actually in; there is no
   * argument an agent could get wrong and send somewhere else.
   *
   * Refuses when several conversations are bound rather than guessing: sending a file to the wrong
   * person is not a failure worth risking to save an error message. Today the channel binds one, so
   * this is a guard against a future that adds accounts.
   *
   * @returns The bound conversation, or a reason it cannot be resolved.
   */
  async #boundConversation(): Promise<
    | { ok: true; target: { account: WeixinAccount; peerId: string; conversationId: string; contextToken?: string } }
    | { ok: false; reason: string }
  > {
    const state = await this.#store.read()
    const bindings = Object.values(state.bindings)
    if (bindings.length === 0) {
      return { ok: false, reason: '还没有微信对话。请先在微信里给机器人发一条消息，之后才能主动推送。' }
    }
    if (bindings.length > 1) {
      return {
        ok: false,
        reason: `当前绑定了 ${String(bindings.length)} 个微信对话，无法确定发给哪一个。请先解绑多余的。`,
      }
    }
    const target = this.#conversationOf(state, bindings[0])
    if (target === undefined) {
      return { ok: false, reason: '绑定的微信账号已经不在状态里，请重新扫码绑定。' }
    }
    return { ok: true, target }
  }

  /**
   * Turn one stored binding into everything a send needs.
   *
   * Shared by the agent-scoped and conversation-scoped lookups so the two cannot drift: the rules
   * about which account and which reply token apply are the same either way.
   *
   * @param state - State the binding came from.
   * @param binding - Stored binding, or undefined when there was none.
   * @returns The conversation, or undefined when the account is gone.
   */
  #conversationOf(
    state: ChannelState,
    binding: SessionBinding | undefined,
  ): { account: WeixinAccount; peerId: string; conversationId: string; contextToken?: string } | undefined {
    if (binding === undefined) return undefined
    const account = state.accounts[binding.accountId]
    if (account === undefined) return undefined
    const contextToken = state.contextTokens[binding.accountId]?.[binding.conversationId]
    return {
      account,
      peerId: binding.peerId,
      conversationId: binding.conversationId,
      ...(contextToken === undefined ? {} : { contextToken }),
    }
  }

  /**
   * Replace the synchronous session index with the bindings just read or written.
   *
   * Called from the binding store this runtime hands the router, so every binding change — a
   * conversation bound to a new session, a conversation moved to another one, a session adopted —
   * updates the index on the way past. Cheap by construction: the set is small, and this runs once
   * per inbound message rather than once per assembly.
   *
   * @param bindings - The whole binding map, as stored.
   */
  #rememberBoundSessions(bindings: Record<string, SessionBinding>): void {
    const next = new Set<string>()
    for (const binding of Object.values(bindings)) {
      if (binding.sessionId !== '') next.add(binding.sessionId)
    }
    this.#channelSessions = next
  }

  /**
   * Fill the index from the store, for assemblies that happen before any routing does.
   *
   * A binding survives a restart, so on a fresh boot the index starts empty while the store still
   * knows which sessions are the channel's. Without this, a turn driven by something other than an
   * inbound message — a background job, a subagent reporting back — would assemble without the note.
   */
  async syncBoundSessions(): Promise<void> {
    try {
      this.#rememberBoundSessions((await this.#store.read()).bindings)
    } catch {
      // Keep whatever the index already holds: a missing note is a smaller loss than a thrown
      // assembly, and the store is re-read on the next inbound message anyway.
    }
  }

  /**
   * Register the channel note as a system-prompt section.
   *
   * The note says things the agent cannot infer — that the person reading is on a phone, that files
   * have to be sent rather than pointed at — so it has to be in front of the model on every turn of
   * a WeChat conversation. This is where DSH puts standing instructions: `systemPrompt.section` is
   * the same registry the plan-mode policy uses, its text is evaluated per assembly, and the section
   * is registered once at host scope rather than once per session.
   *
   * Three properties follow, and each is the reason this is not simply appended to the prompt:
   *
   * - **Not a user message.** A prompt is something the agent answers, so a note delivered as one
   *   draws a second reply to every message (the defect this replaces).
   * - **Not in the naming text.** DSH names a session from its first prompt; a system section is not
   *   part of that text, so titles stay the user's own words.
   * - **Scoped by session, not by process.** The provider returns `''` unless the assembling session
   *   is one this channel drives, so a desktop conversation never sees it.
   *
   * @returns The disposer that removes the section.
   */
  registerChannelPrompt(): Disposer {
    /*
     * Reached through `inject`, not `get`, and that is not a preference.
     *
     * Cordis's `get` is strict: it answers only for a service whose fiber is already active. During
     * this synchronous `apply` the system-prompt service is mounted but not yet active, so `get`
     * returned `undefined` and the note was silently dropped — observed on a real host as
     * "systemPrompt service unavailable" on every boot, while every test passed, because a stub
     * hands back whatever it was told to.
     *
     * `inject` starts a child plugin that waits for the service and runs once it is there. It is
     * also what makes the dependency optional: a composition that never mounts it simply never
     * calls back, where the static `inject` array would leave this whole plugin pending.
     */
    const inject = this.#ctx.inject
    if (typeof inject === 'function') {
      inject.call(this.#ctx, ['systemPrompt'], (promptCtx: unknown) => {
        this.#registerNoteSection(systemPromptOf(promptCtx))
      })
    } else {
      // A host that exposes the service directly, which is also how a stub without `inject` works.
      this.#registerNoteSection(systemPromptOf(this.#ctx))
    }
    return () => {
      this.#channelNoteDisposer?.()
      this.#channelNoteDisposer = undefined
    }
  }

  /**
   * Put the note in the prompt registry, if that registry is there.
   *
   * @param systemPrompt - The service, or `undefined` when this composition has none.
   */
  #registerNoteSection(systemPrompt: PromptSectionRegistry | undefined): void {
    if (this.#disposed) return
    if (systemPrompt?.section === undefined) {
      // Recorded because the symptom is otherwise invisible: replies that read as if written for a
      // desktop, with nothing anywhere saying why.
      this.#recordBoot('systemPrompt service unavailable: the channel note is not injected')
      return
    }
    /*
     * Warm the cache the provider reads. The provider runs during assembly, where awaiting the store
     * would be a race against the step it is assembling for; `#settingsNow` is synchronous and this
     * is what makes its first answer the stored one rather than the defaults.
     */
    this.#settingsFromDisk()
    try {
      const dispose = systemPrompt.section({
        name: CHANNEL_NOTE_SECTION,
        order: CHANNEL_NOTE_ORDER,
        text: (context) => this.#channelNoteFor(context),
      })
      this.#channelNoteDisposer = typeof dispose === 'function' ? dispose : undefined
      this.#recordBoot(`channel note section registered (order ${String(CHANNEL_NOTE_ORDER)})`)
    } catch (error) {
      // A duplicate name is the realistic failure — two mounts of this plugin — and a thrown section
      // would take activation down with it.
      this.#recordBoot(`channel note not registered: ${describeError(error)}`)
    }
  }

  /**
   * The note for one assembly, or `''` when this assembly is not a WeChat conversation.
   *
   * Never throws, and never awaits: it is called while the prompt for a turn is being assembled, so
   * an exception here would cost the turn itself. Every failure path returns `''`, which hides the
   * note rather than breaking the conversation.
   *
   * @param context - The assembly context DSH passes to a section provider.
   * @returns The note text, or an empty string.
   */
  #channelNoteFor(context: unknown): string {
    try {
      const sessionId = sessionIdFromAssembly(context)
      if (sessionId === undefined || !this.#channelSessions.has(sessionId)) return ''
      return sanitizePromptText(this.#settingsNow().presenceNote.trim())
    } catch {
      return ''
    }
  }

  /**
   * Download every attachment on a message and write it inside the session workspace.
   *
   * A failure here is recorded and skipped rather than thrown: a photo the service
   * will not serve should not cost the user the text that came with it.
   *
   * @param message - Inbound envelope, whose `media` is absent for text-only messages.
   * @returns One `{ media, path }` per attachment that downloaded successfully.
   */
  async #fetchAttachments(
    message: InboundMessage,
  ): Promise<{ media: DownloadedMedia; path: string }[]> {
    const items: MessageItem[] = message.media ?? []
    if (items.length === 0) return []

    const stored: { media: DownloadedMedia; path: string }[] = []
    for (const item of items) {
      try {
        const media = await downloadItemMedia({ item })
        if (media === undefined) continue
        const path = storeMedia(this.#home, media)
        stored.push({ media, path })
        this.#recordBoot(`media: ${media.kind} ${media.data.length}B -> ${path}`)      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.#recordError(`附件下载失败: ${detail}`)
        // Record the item that failed. An inbound CDN reference has forms this plugin
        // has never observed from the service, and the URL it derives is a guess: the
        // shape is the one thing that cannot be reconstructed from a failure message.
        this.#recordBoot(`media: download failed, item=${JSON.stringify(item).slice(0, 600)}`)
      }
    }
    return stored
  }

  /** Hand a prompt to its session. */
  async #prompt(
    decision: RouteDecision,
    message: InboundMessage,
    attachments: { media: DownloadedMedia; path: string }[] = [],
    quoted?: string,
  ): Promise<void> {
    /*
     * One inbound message, one prompt — and the channel note is not part of it.
     *
     * The note used to ride along here, and on a session's first message it was split off and sent
     * as a *second* prompt, because DSH names a session from its first prompt
     * (`dsh-session-title-first-prompt-llm`) and a note inside that text became the title. The split
     * removed the note from the naming text and put it into the conversation as a message of its own
     * instead — which the agent answers, because a prompt is a thing it is asked to reply to. One
     * WeChat message therefore drew two replies, the second of them a paragraph explaining that the
     * user is on a phone.
     *
     * The note now lives in the system prompt ({@link registerChannelPrompt}), where a standing
     * instruction belongs: present at every assembly of a session this channel drives, absent from
     * the user's message, absent from the naming text, and never a turn of its own.
     *
     * Attachments are described in the prompt text rather than sent as native image content: that
     * path requires a vision-capable model and rejects the prompt outright otherwise, while a path
     * works with every model and every file kind.
     */

    /*
     * Say so before anything else when the conversation had to be moved.
     *
     * The router replaces a binding whose session is archived or gone, and without this sentence the
     * user sees answers from a conversation with none of their history and no explanation at all —
     * the move is only visible in the log. Sent first, and even when the prompt below fails, because
     * what it explains is the *identity* of the conversation they are now in.
     */
    if (decision.notice !== undefined) {
      const account = await this.#account(message.accountId)
      if (account === undefined) {
        this.#recordError(
          `notice not sent: account ${message.accountId} is no longer stored ` +
            `(conversation=${message.conversationId}) — the conversation was moved anyway`,
        )
      } else {
        await this.#reply(account, message.conversationId, message.peerId, decision.notice)
      }
    }

    const lines = [
      decision.prompt,
      ...(quoted === undefined ? [] : [quoted]),
      ...attachments.map((entry) => describeMedia(entry.media, entry.path)),
    ].filter((line) => line !== '')
    const prompt = lines.join('\n\n')

    // A refused steer is a real outcome — the turn it targeted can end first — so the queue is
    // tried instead of losing the message. One submission, not a loop: there is nothing to split.
    let delivered = false
    if (await this.#submit(decision.sessionId, prompt, 'steer')) delivered = true
    else if (await this.#submit(decision.sessionId, prompt, 'queue')) delivered = true
    if (delivered) return

    this.#recordError(`提交任务失败: 插话与排队都未成功（会话 ${decision.sessionId}）`)
    const account = await this.#account(message.accountId)
    if (account === undefined) return
    // Hand the words back rather than losing them. A dropped message is the one failure here
    // that nothing downstream can repair — the user's own text is the only copy.
    await this.#reply(
      account,
      message.conversationId,
      message.peerId,
      `没能把消息交给会话，请重发一次。\n\n你的内容：\n${truncate(prompt, MAX_REPLY_CHARS)}`,
    )
  }

  /**
   * Submit a prompt, interrupting a running turn and falling back to the queue.
   *
   * A refused steer must not cost the message: the user's words are the one thing here that
   * cannot be reconstructed, while a queued answer is merely later than a steered one. So a
   * refusal becomes a plain queue submission rather than an error.
   *
   * @param sessionId - Session to prompt.
   * @param prompt - Text to submit.
   * @param mode - Placement to request while a turn is running.
   * @returns Whether the prompt was accepted; false leaves the caller to report the loss.
   */
  async #submit(sessionId: string, prompt: string, mode: 'queue' | 'steer'): Promise<boolean> {
    const request = {
      // A media-only message has no text of its own; the attachment line is then the entire
      // prompt, which is what `hasPromptContent` requires.
      content: [{ type: 'text' as const, text: prompt }],
    }
    try {
      await this.#ctx.sessionController.prompt(
        { ...request, requestId: `wechat-${randomUUID()}`, sessionId, mode },
        new AbortController().signal,
      )
      return true
    } catch (error) {
      if (mode !== 'steer') {
        this.#recordError(`提交任务失败: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
      this.#recordBoot(
        `steer refused, falling back to queue: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    try {
      await this.#ctx.sessionController.prompt(
        { ...request, requestId: `wechat-${randomUUID()}`, sessionId, mode: 'queue' },
        new AbortController().signal,
      )
      return true
    } catch (error) {
      this.#recordError(`排队提交也失败: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** Send one reply into a conversation. */

  /**
   * Submit a prompt, falling back to the queue when steering is refused.
   *
   * A refused steer must not lose the message: the user's words are the one thing here that
   * cannot be reconstructed. Steering is refused when the turn it targeted has already ended,
   * so the fallback is a plain queue and the message is answered on the next turn instead.
   *
   * @param sessionId - Session to prompt.
   * @param prompt - Text to submit.
   * @param mode - Preferred placement when a turn is running.
   */
  /** Send one reply into a conversation. */
  async #reply(
    account: WeixinAccount,
    conversationId: string,
    peerId: string,
    text: string,
    numbered?: NumberedRows,
  ): Promise<boolean> {
    /*
     * Anything sent into a conversation ends the "typing…" state for it: the channel is speaking, so
     * it is no longer composing. This is where the indicator is cleared for a turn handed to the
     * agent, because that is the moment the agent's answer goes out — the inbound handler returns
     * long before this, having only submitted the request.
     */
    this.#stopTyping(conversationId)
    const state = await this.#store.read()
    const contextToken = state.contextTokens[account.accountId]?.[conversationId]
    const settings = await this.#settings()
    try {
      return await this.#sendWithinLimit(
        account,
        conversationId,
        peerId,
        text,
        settings,
        contextToken,
        numbered,
      )
    } catch (error) {
      this.#recordError(`发送失败: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Send one message, splitting or filing it when it is longer than the configured limit.
   *
   * A reply over the limit is sent as a Markdown file rather than cut short. Truncation loses
   * the end of an answer silently, which for a long explanation or a code listing is the part
   * that mattered; a file always arrives whole and opens where the user can read it.
   *
   * @param account - Sending bot.
   * @param conversationId - Conversation, for the reply token.
   * @param peerId - Recipient.
   * @param text - Full reply text.
   * @param settings - Resolved settings, so one message sees one consistent limit.
   * @param contextToken - Reply token, when one is stored.
   * @param numbered - Rows this reply numbered, recorded against the id the service assigns.
   * @returns Whether the message reached the service, which a caller tracking a browsing position
   *   needs: a position must not advance past a screen nobody received.
   */
  async #sendWithinLimit(
    account: WeixinAccount,
    conversationId: string,
    peerId: string,
    text: string,
    settings: Required<ChannelSettings>,
    contextToken: string | undefined,
    numbered?: NumberedRows,
  ): Promise<boolean> {
    const limit = settings.maxReplyChars
    if (limit <= 0 || text.length <= limit) {
      return await this.#sendText(
        account,
        conversationId,
        peerId,
        truncate(text, Math.max(limit, 1)),
        contextToken,
        numbered,
      )
    }

    // A caption so the file is not an unexplained attachment, then the file itself. The numbering is
    // deliberately *not* recorded here: a quote of this message would point at the caption, and the
    // rows the user reads are inside the file — so there is nothing to pin the numbers to.
    await this.#sendText(
      account,
      conversationId,
      peerId,
      `回复较长（${String(text.length)} 字），已作为文件发送。`,
      contextToken,
    )
    const name = `回复-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
    const path = join(this.#mediaDir(), name)
    await writeFile(path, text, 'utf8')
    await this.#conveyFile(path, undefined, {
      account,
      conversationId,
      peerId,
      ...(contextToken === undefined ? {} : { contextToken }),
    })
    this.#recordBoot(`long reply ${String(text.length)} chars -> ${name}`)
    // The content arrived, as a file: a caller tracking a browsing position may advance.
    return true
  }

  /**
   * The folder generated replies and inbound attachments are written to, created if absent.
   *
   * Created on demand rather than when the first attachment arrives: a long reply can be the
   * first thing this channel ever writes, and a missing folder would surface as a silently
   * truncated answer instead of a file.
   */
  #mediaDir(): string {
    const dir = join(this.#home, WORKSPACE_DIR_NAME, MEDIA_DIR_NAME)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * Send one text message and record the id the service assigns.
   *
   * @param account - Sending bot.
   * @param conversationId - Conversation, for the reply token and the quote cache.
   * @param peerId - Recipient.
   * @param text - Already-limited text.
   * @param contextToken - Reply token, when one is stored.
   */
  /**
   * Charge one send against the reply token, and ask for a new one as the window runs low.
   *
   * The arithmetic and the persistence both live in `@dsh-wechat/core`; what stays here is the only
   * part that needs the injected sender — delivering the warning. It goes out on the low-level
   * `#send` rather than through `#sendText`, so charging a send cannot charge another one and
   * recurse; the warning is charged as part of the same write, which is what keeps the stored count
   * equal to the number of messages the service actually accepted.
   *
   * @param account - Account the message went through.
   * @param conversationId - Conversation the token belongs to.
   * @param peerId - Counterparty, for the warning.
   * @param contextToken - Token this send used; a change means a fresh quota.
   */
  async #noteQuota(
    account: WeixinAccount,
    conversationId: string,
    peerId: string,
    contextToken: string | undefined,
  ): Promise<void> {
    const charge = await this.#quota.charge(conversationId, contextToken)
    if (!charge.warn) return
    try {
      await this.#send({
        account,
        to: peerId,
        text: QUOTA_WARNING,
        ...(contextToken === undefined ? {} : { contextToken }),
      })
      this.#recordBoot(`quota: 窗口已用 ${String(charge.used)}/${String(QUOTA_PER_TOKEN)}，已提醒续期`)
    } catch {
      // A warning nobody receives is not worth a thrown error; the next send queues regardless.
      this.#recordBoot(`quota: 窗口已用 ${String(charge.used)}/${String(QUOTA_PER_TOKEN)}，提醒未能发出`)
    }
  }

  async #sendText(
    account: WeixinAccount,
    conversationId: string,
    peerId: string,
    text: string,
    contextToken: string | undefined,
    numbered?: NumberedRows,
  ): Promise<boolean> {
    const sent = await this.#send({
      account,
      to: peerId,
      text,
      ...(contextToken === undefined ? {} : { contextToken }),
    })
    // The id the service assigned plus a body preview, recorded so a quote of this message can
    // be resolved and the resolution verified later. Without the preview there is no way to
    // tell a correct lookup from a wrong one.
    const id = (sent as { serverMessageId?: unknown } | undefined)?.serverMessageId
    const preview = text.replace(/\s+/g, ' ').slice(0, 120)
    this.#recordBoot(
      `outbound text id=${typeof id === 'string' ? id : '(none)'} len=${String(text.length)}` +
        ` body=${preview}`,
    )
    /*
     * Charged here, after the send, and only on the path that actually sent.
     *
     * This is the one place a text reply is charged, and it matters that it comes after `#send`:
     * a refused send throws first, so the closed window's queue never counts slots the service did
     * not accept. That is what keeps the stored count equal to the number of messages the user
     * actually received — the number that decides whether the ask for a new window comes in time.
     */
    await this.#noteQuota(account, conversationId, peerId, contextToken)
    if (typeof id === 'string') {
      // Retained so a quote of this message can be turned back into content. A quote carries
      // only an id, so without this the agent sees "elaborate on this" and nothing else.
      const settings = await this.#settings()
      await this.#store.update((s) => {
        rememberSentMessage(
          s,
          account.accountId,
          conversationId,
          { messageId: id, kind: 'text', preview, at: Date.now() },
          settings.quoteHistory,
        )
      })
      /*
       * And, when this message *was* a listing, the numbering it printed is frozen under the same id.
       *
       * It has to be here rather than where the listing was built: the id is assigned by the service
       * when the send succeeds, and that id is the only thing a quote of the message will carry. A
       * listing that could not be sent has no numbering worth remembering.
       */
      if (numbered !== undefined) {
        await this.#rememberListedRows(account.accountId, conversationId, id, numbered)
      }
    }
    // Reported so a caller with a browsing position knows whether the screen arrived. A service that
    // answered without a message id did not deliver it, which is the same failure §3.6 records.
    return typeof id === 'string'
  }

  /**
   * Resolve the WeChat conversation bound to a session.
   *
   * @param sessionId - Session to look up.
   */
  async #conversationForSession(sessionId: string): Promise<
    | { account: WeixinAccount; conversationId: string; peerId: string; contextToken?: string }
    | undefined
  > {
    const state = await this.#store.read()
    const binding = Object.values(state.bindings).find((entry) => entry.sessionId === sessionId)
    if (binding === undefined) return undefined
    const account = state.accounts[binding.accountId]
    if (account === undefined) return undefined
    const contextToken = state.contextTokens[binding.accountId]?.[binding.conversationId]
    return {
      account,
      conversationId: binding.conversationId,
      peerId: binding.peerId,
      ...(contextToken === undefined ? {} : { contextToken }),
    }
  }

  /**
   * Write a line to the boot log the first time a given value is seen.
   *
   * Keeps an observational log bounded: a chunk kind or frame shape repeats thousands of times
   * in one turn, and only its first occurrence carries information.
   *
   * @param bucket - Grouping key, so separate observations do not collide.
   * @param line - Line to write, once.
   */
  #recordOnce(bucket: string, line: string): void {
    if (this.#seenShapes.get(bucket)?.has(line) === true) return
    const seen = this.#seenShapes.get(bucket) ?? new Set<string>()
    seen.add(line)
    this.#seenShapes.set(bucket, seen)
    this.#recordBoot(line)
  }

  /**
   * Feed one assistant stream frame into the reply buffer.
   *
   * DSH emits deltas as the model generates. Batching them behind a short quiet
   * window turns a stream into one coherent WeChat message instead of a burst of
   * fragments, which is what a chat transcript needs. A frame that ends the turn
   * flushes immediately rather than waiting out the window.
   */
  onAssistantFrame(payload: AssistantStreamPayload): void {
    const { sessionId, text, completed, chunkType, frameShape } = readStreamFrame(payload)
    if (sessionId === undefined) return

    // Learn the stream's vocabulary. Each distinct value is logged once, so a long turn cannot
    // flood the log. This is how the tool-call signal gets identified from observation instead
    // of from a second guess about field names.
    if (chunkType !== undefined) this.#recordOnce('#chunkTypes', `stream chunk kind: ${chunkType}`)
    if (frameShape !== undefined) this.#recordOnce('#frameShapes', `stream frame shape: ${frameShape}`)
    if ((text === undefined || text === '') && completed !== true) return

    void (async () => {
      const bindings = (await this.#store.read()).bindings
      const conversation = Object.values(bindings).find((entry) => entry.sessionId === sessionId)
      if (conversation === undefined) {
        /*
         * A session no conversation is bound to produces nothing the phone can receive.
         *
         * That is normal for a turn the user started on the desktop — which is why this is a boot-log
         * observation rather than an error, and why it is written once per session — but it is also
         * what a binding that went away looks like, and then the answer is genuinely lost. Logged
         * because "the model finished and no message arrived" has otherwise no line anywhere: the
         * stream reader saw the text and this early return threw it away without a word.
         */
        this.#recordOnce(
          '#unboundStreams',
          `stream: no WeChat conversation is bound to ${sessionId} — its answer is not delivered`,
        )
        return
      }

      const existing = this.#replies.get(sessionId)
      if (existing !== undefined) clearTimeout(existing.timer)
      const entry = existing ?? {
        text: '',
        conversationId: conversation.conversationId,
        timer: undefined as unknown as NodeJS.Timeout,
      }
      if (text !== undefined) entry.text += text

      if (completed === true) {
        // The turn ended: send now, so the reply is not held behind the settle window.
        this.#replies.set(sessionId, entry)
        await this.#flushReply(sessionId)
        return
      }

      // Read from the cache, never awaited: this handler must stay synchronous so two frames of
      // the same answer cannot interleave and lose the first half of the reply.
      const { settleMs } = this.#settingsNow()
      entry.timer = setTimeout(() => {
        void this.#flushReply(sessionId)
      }, settleMs)
      entry.timer.unref?.()
      this.#replies.set(sessionId, entry)
    })()
  }

  /** Send and clear the buffered reply for a session. */
  async #flushReply(sessionId: string): Promise<void> {
    const entry = this.#replies.get(sessionId)
    if (entry === undefined) return
    this.#replies.delete(sessionId)
    const text = entry.text.trim()
    if (text === '') return

    const state = await this.#store.read()
    const binding = state.bindings[entry.conversationId]
    if (binding === undefined) {
      /*
       * The answer is thrown away, and this is the only record of it.
       *
       * It reaches here when the conversation lost its binding between the turn starting and the
       * answer arriving — a disconnect, or the account being forgotten. The reply is already the
       * finished work of a whole turn, so silence here is the most expensive kind: the user asked,
       * the model answered, and nothing anywhere says where the answer went.
       */
      this.#recordError(
        `reply dropped: conversation ${entry.conversationId} has no binding ` +
          `(session=${sessionId} text=${String(text.length)} chars)`,
      )
      return
    }
    const account = state.accounts[binding.accountId]
    if (account === undefined) {
      this.#recordError(
        `reply dropped: account ${binding.accountId} is no longer stored ` +
          `(conversation=${entry.conversationId} session=${sessionId} text=${String(text.length)} chars)`,
      )
      return
    }
    await this.#reply(account, binding.conversationId, binding.peerId, text)
  }

  /** Flush everything still buffered. Used on shutdown. */
  async flushReplies(): Promise<void> {
    for (const sessionId of [...this.#replies.keys()]) {
      const entry = this.#replies.get(sessionId)
      if (entry !== undefined) clearTimeout(entry.timer)
      await this.#flushReply(sessionId)
    }
  }

  /**
   * Clear every "typing…" indicator and stop its refresh loop. Used on shutdown.
   *
   * Without this the intervals would outlive the plugin and keep calling a monitor that is being
   * torn down, and whichever conversations were mid-turn would be left showing "typing" forever.
   */
  stopTypingAll(): void {
    for (const conversationId of [...this.#typing.keys()]) this.#stopTyping(conversationId)
  }

  async #account(accountId: string): Promise<WeixinAccount | undefined> {
    return (await this.#store.read()).accounts[accountId]
  }

  #recordError(message: string): void {
    this.#errors.push(`${new Date().toISOString()} ${message}`)
    if (this.#errors.length > 50) this.#errors.shift()
    console.error(`dsh-wechat-plugin: ${message}`)
  }

  /**
   * Turn a quoted message back into content the agent can read.
   *
   * A quote arrives as an id and nothing else: the inbound `ref_msg.message_item` carries
   * `type: 0`, no text, and only a `msg_id`. So the quoted content exists only in what this
   * channel recorded when it sent the message, and this is the lookup that recovers it.
   *
   * A quote of a message we have no record of is reported rather than silently dropped: the
   * agent then knows a quote was made and could not be read, which is a better answer than
   * acting on an instruction whose subject it never saw.
   *
   * @param message - Inbound message, whose items may carry a quote.
   * @returns A line to lead the prompt with, or undefined when there is no quote.
   */
  async #resolveQuote(message: InboundMessage): Promise<string | undefined> {
    const messageId = quotedMessageId(message)
    if (messageId === undefined) return undefined

    const state = await this.#store.read()
    const found = findSentMessage(state, message.accountId, messageId)
    this.#recordBoot(
      `quote resolved: id=${messageId} ${found === undefined ? 'NOT FOUND' : `kind=${found.kind}`}`,
    )
    if (found === undefined) {
      // The quoted text is not recoverable, but saying so keeps the agent from guessing.
      return `[引用了一条我发出的消息，但内容已不在缓存中（id ${messageId}）]`
    }
    return found.kind === 'text'
      ? `[引用我此前发送的消息]\n${found.preview}`
      : `[引用我此前发送的${MEDIA_LABEL_BY_KIND[found.kind as 'image' | 'video' | 'file']}] ${found.preview}`
  }

  /**
   * Note a routine event in the boot log.
   *
   * Media arrivals land here: a download that succeeded and one that was silently
   * skipped look identical from the phone, so the path is written down where the
   * next diagnosis can find it.
   */
  #recordBoot(message: string): void {
    bootLog(this.#home, message)
  }

  /**
   * Record a failure reported by the browser half.
   *
   * Written to the same boot log as host failures, because a client throw is
   * otherwise invisible: it happens in a page the host cannot observe, and the
   * settings page may never even mount.
   */
  recordClientError(scope: string, message: string, stack: string): void {
    recordClientFailure(this.#home, scope, message, stack)
    this.#recordError(`客户端错误[${scope}]: ${message}`)
  }

  /**
   * Resolve (or register) the Workspace this channel's sessions live in.
   *
   * Grouping is the whole point: a session created with only a `cwd` shows up in the
   * desktop's "Ungrouped" bucket, and the host rejects a create that names both a
   * `workspaceId` and a `cwd`, so this must supply the workspace instead of the path.
   *
   * Deliberately not swallowed on failure. If the folder cannot be established the
   * channel would keep working but quietly lose its grouping, and the settings page
   * reports the error instead — better one visible failure than silent drift.
   *
   * @returns The Workspace id to pass to `sessionController.create`.
   */
  async #ensureWorkspace(): Promise<string> {
    return await this.#workspaceIdFor(this.#workspace, WORKSPACE_TITLE)
  }

  /**
   * Resolve — or create — the workspace owning a directory.
   *
   * Needed because a session can only be adopted with the workspace it already belongs to: the host
   * pins a session's `cwd`, so resuming a conversation from another project means naming *that*
   * project's workspace rather than the channel's own.
   *
   * @param path - Directory the workspace owns.
   * @param title - Title to apply when this is the channel's own workspace.
   * @returns The workspace id, or an empty string when the composition has no registry.
   */
  async #workspaceIdFor(path: string, title: string): Promise<string> {
    const registry = this.#ctx.workspaceRegistry
    if (registry === undefined) {
      // Composition without Workspaces: leave the id unset so `create` falls back to the pinned cwd
      // and sessions land in the ungrouped bucket. Recorded once, not per call.
      if (isSameWorkspace(path, this.#workspace)) {
        this.#recordError('此组合没有工作区服务，会话将显示在「未分组」下')
      }
      return ''
    }
    // The channel's own workspace keeps its id, and its title is enforced so the folder reads
    // correctly on the desktop. A foreign workspace is left exactly as its owner named it.
    if (isSameWorkspace(path, this.#workspace) && this.#workspaceId !== undefined) {
      return this.#workspaceId
    }

    const workspace = (await registry.resolveByPath(path)) ?? (await registry.create(path))
    if (title !== '' && workspace.title !== title) await workspace.setTitle(title)
    if (isSameWorkspace(path, this.#workspace)) this.#workspaceId = workspace.id
    return workspace.id
  }

  /**
   * Give a session the permission preset the user chose for WeChat.
   *
   * Why this exists at all: a session whose policy is `ask` sends a permission prompt to WeChat and
   * then waits. On a phone that is a dead end — the user left the desk precisely so they would not
   * have to babysit prompts, and a task that stalls until they answer one is a task they cannot run
   * from WeChat. The default therefore lifts the guardrail for this channel's sessions.
   *
   * Two details that decide whether this works:
   *
   *  - It has to run **before the session's first turn**. DSH rejects a preset change once a turn
   *    has begun (`agent-preset/locked`), so this is called from `ensureSession`, which the router
   *    reaches before it prompts anything — for a new conversation and for a switch alike.
   *  - It is best-effort. The service may be absent on a host that does not compose permission
   *    presets, and a failure here must not cost the user their message: the worst case is that the
   *    session keeps the profile's own policy, which is exactly the old behaviour.
   *
   * @param sessionId - Session that was just created or adopted.
   */
  #applyPermissionPreset(sessionId: string): void {
    const preset = this.#settingsFromDisk().permissionPreset
    if (preset === 'default') return
    try {
      const sessions = this.#ctx.get('sessions') as
        | { get?: (id: string) => unknown }
        | undefined
      const presets = this.#ctx.get('permissionPresets') as
        | { set?: (session: unknown, preset: string) => void }
        | undefined
      const session = sessions?.get?.(sessionId)
      if (session === undefined || presets?.set === undefined) {
        // Not an error: a host without the service keeps its own policy.
        bootLog(
          this.#home,
          `permission preset '${preset}' not applied to ${sessionId}: service unavailable`,
        )
        return
      }
      presets.set(session, preset)
      bootLog(this.#home, `permission preset '${preset}' applied to ${sessionId}`)
    } catch (error) {
      /*
       * Recorded rather than thrown. A session that already ran its first turn is the expected way
       * this fails, and losing the user's message over a permission nicety would be a worse outcome
       * than the session keeping the profile's policy.
       */
      bootLog(this.#home, `permission preset failed for ${sessionId}: ${String(error)}`)
    }
  }

  /** Adapt the host session controller to the router's narrow gateway port. */
  #gateway(): SessionGateway {
    const ctx = this.#ctx
    // Pinned for the life of every session: the host rejects an adopt whose `cwd`
    // differs from the stored one.
    const cwd = this.#workspace
    return {
      ensureSession: async (sessionId: string): Promise<void> => {
        /*
         * A session that already exists must not be passed to `create`.
         *
         * Since 0.2.1-rc.2 `sessionController.create` only reuses a named session while it is still
         * blank: one that has run a turn is not adopted, and a fresh session is minted instead (the
         * id it returns is one this channel would then ignore). `ensureSession` runs before every
         * prompt, so calling `create` here would leave a blank session behind on every message.
         * `prompt` resumes a stored session on its own; only an id with no record at all has to be
         * created.
         */
        if (await hasStoredSession(this.#home, sessionId)) return

        // Naming the Workspace rather than the directory is what groups the session under a real
        // folder; a cwd-only session lands in the desktop's unnameable "Ungrouped" bucket.
        const workspaceId = await this.#workspaceIdFor(cwd, WORKSPACE_TITLE)
        if (workspaceId === '') {
          await ctx.sessionController.create({ sessionId, cwd })
          this.#applyPermissionPreset(sessionId)
          return
        }
        await ctx.sessionController.create({ sessionId, workspaceId })
        this.#applyPermissionPreset(sessionId)
      },
      prompt: async (sessionId: string, text: string): Promise<void> => {
        await ctx.sessionController.prompt(
          {
            requestId: `wechat-${randomUUID()}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          new AbortController().signal,
        )
      },
      /*
       * The on-disk store is the only source of sessions.
       *
       * `sessionController.list()` returned an empty array on every run on the machine this was built
       * for, so `/list` answered with nothing while the store held nine conversations for this
       * workspace. It was kept at first as a supplement, but a source that never returns anything is
       * worse than absent: it suggests the channel is showing everything it knows when it is showing
       * what it read from disk, and it says nothing about *where* a session lives — the very field
       * that decides whether it can be adopted.
       *
       * Every row carries the directory it was read from, because that is what the listing groups by.
       * Order is left to the reader: the router sorts and groups for display, and a gateway that also
       * sorted would be a second opinion about what "newest first" means.
       */
      listOwnSessions: async () => {
        const { own } = await splitStoredSessions(this.#home, cwd)
        return own
      },
      listSessions: async () => {
        const { own, others } = await splitStoredSessions(this.#home, cwd)
        return [...own, ...others]
      },
      cancel: async (sessionId: string): Promise<void> => {
        await ctx.sessionController.cancel({ sessionId })
      },
      /*
       * Whether a bound session can still take a message.
       *
       * Both failures this answers for end in the same place — the user's message is accepted and
       * then vanishes with nothing said and nothing logged — so the answer is asked *before* a
       * binding is reused, and a session that cannot work is replaced.
       *
       * `archived` is read from the workspace registry, which is where DSH records the fact: an
       * archived session's prompt is accepted and the *step* it proposes is rejected
       * (`dsh-api-session-controller`'s archived-session gate), so the turn ends blocked and no
       * answer is ever produced. Nothing on disk marks the session, so the registry is the only
       * source that can be right.
       *
       * `missing` is read from the same on-disk index the listing uses, and means the session has no
       * record anywhere. That is *also* what a session looks like during the window between its
       * creation and its first turn — which is why the router will not believe this verdict for a
       * binding younger than `MISSING_BINDING_GRACE_MS`, and why this function reports the raw fact
       * rather than deciding.
       *
       * A record that is *present but unreadable* answers `usable`, not `missing`: that is a damaged
       * store rather than a deleted session, and replacing the conversation over it would happen
       * again every time a binding aged past the grace window.
       *
       * Absent a workspace registry there is no archive set, so only the disk test applies. A
       * failure propagates: the router treats a throwing probe as `usable` and logs it, which keeps
       * one broken probe from costing a working conversation.
       */
      sessionState: async (sessionId: string): Promise<SessionState> => {
        const archived = ctx.workspaceRegistry?.archivedSessionIds
        if (archived?.includes(sessionId) === true) return 'archived'
        const workspace = await storedSessionWorkspace(this.#home, sessionId)
        if (workspace !== undefined) return 'usable'
        return (await hasStoredSession(this.#home, sessionId)) ? 'usable' : 'missing'
      },
      /*
       * The model catalog, flattened for a chat stream.
       *
       * The host groups models by provider because the desktop picker has the room for it. A WeChat
       * message does not, and the number the user replies with has to be a number they were shown,
       * so the grouping is dropped here and the router only ever sees one numbered list.
       *
       * `current` is the *bound session's* own selection, read from its `modelSelection` projection,
       * and the deployment default when the host cannot answer that — see `#modelInUse`. It matters
       * because a model chosen on the desktop for one session is not the default, and a list that
       * marked the default would tell that user they are on a model they are not.
       */
      listModels: async (sessionId?: string) => {
        const catalog = await ctx.sessionController.modelCatalog()
        const current = await this.#modelInUse(catalog, sessionId)
        return {
          current,
          models: catalog.groups.flatMap((group) =>
            group.models.map((model) => ({
              provider: group.id,
              providerName: group.name,
              model: model.id,
              name: model.name,
              /*
               * The levels the model publishes, and the one the host would pick when a switch names
               * none. A reasoning model has to be selected at a level, and leaving that out would
               * hand the decision to a resolve step the user cannot see; this mirrors what the host
               * does when it picks a model for itself.
               */
              ...(model.reasoning === undefined
                ? {}
                : {
                    levels: model.reasoning.efforts.map((effort) => ({
                      id: effort.id,
                      name: effort.name,
                    })),
                    ...(model.reasoning.defaultEffort === undefined
                      ? {}
                      : { defaultLevel: model.reasoning.defaultEffort }),
                  }),
            })),
          ),
          failures: catalog.failures.map((failure) => ({
            name: failure.name,
            message: failure.message,
          })),
        }
      },
      selectModel: async (
        sessionId: string,
        provider: string,
        model: string,
        reasoningEffort?: string,
      ) => {
        const { selected } = await ctx.sessionController.selectModel({
          sessionId,
          provider,
          model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        })
        // The level travels back with the model, because the host normalises it: a selection that
        // named no level comes back with the model's own default, and the reply has to say which
        // level is actually in effect rather than which one was asked for.
        return {
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: selected.reasoningEffort }),
        }
      },
    }
  }

  /**
   * Which model and reasoning level one session runs on.
   *
   * Read from the session's own `modelSelection` projection, which is the only per-session answer the
   * host gives — the catalog answers deployment-wide — and falling back to the deployment default,
   * which is what `/model` marked before this read existed. The fallback covers three normal cases:
   * a conversation with no session yet, a session with no request of its own (the projection is
   * `{lastUsed: null, next: null}` until its first turn), and a host generation that does not expose
   * `projections` at all.
   *
   * The level is filled in here rather than left to the caller, so the one shown is the one that will
   * be used: the projection omits it when the adapter owns the default, and the model's
   * `defaultEffort` is what the host applies in that case. The desktop picker substitutes exactly the
   * same value.
   *
   * @param catalog - Catalog just read, for the default and the models' levels.
   * @param sessionId - Session the conversation is bound to, absent when there is none.
   */
  async #modelInUse(catalog: ModelCatalog, sessionId: string | undefined): Promise<ModelSelection> {
    let reported: ModelSelection | undefined
    if (sessionId !== undefined) {
      try {
        const read = await this.#ctx.sessionController.projections?.(
          { sessionId },
          new AbortController().signal,
        )
        const next = read?.values?.modelSelection?.next
        if (next !== undefined && next !== null && next.provider !== '' && next.model !== '') {
          reported = next
        }
      } catch (error) {
        /*
         * Recorded, not thrown. A read that fails costs only the precision of the mark — the listing
         * falls back to the deployment default, which is what it showed before this read existed —
         * and losing `/model` over it would take away the user's only way to see or change the model.
         */
        this.#recordBoot(
          `model: reading the selection of ${sessionId} failed, marking the deployment default: ${describeError(error)}`,
        )
      }
    }
    const selection = reported ?? catalog.default
    const model = catalog.groups
      .find((group) => group.id === selection.provider)
      ?.models.find((entry) => entry.id === selection.model)
    const effort = selection.reasoningEffort ?? model?.reasoning?.defaultEffort
    return {
      provider: selection.provider,
      model: selection.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
  }
}

/**
 * Sessions on disk, split by whether they belong to the channel's workspace.
 *
 * One reader for both the full and the own-workspace list, so the two can never disagree about where
 * a session lives — the split that decides whether it is shown by default and whether it can be
 * adopted at all.
 *
 * Each row carries its own `workspace`, so the caller can group without a second read of the store.
 *
 * @param home - DSH home directory.
 * @param cwd - The channel's own workspace directory.
 * @returns Own-workspace sessions and all others.
 */
async function splitStoredSessions(
  home: string,
  cwd: string,
): Promise<{
  own: ListedSession[]
  others: ListedSession[]
}> {
  const grouped = await listAllStoredSessions(home).catch(() => new Map())
  const own: ListedSession[] = []
  const others: ListedSession[] = []
  for (const [path, sessions] of grouped) {
    const target = isSameWorkspace(path, cwd) ? own : others
    for (const session of sessions) {
      target.push({
        sessionId: session.sessionId,
        title: session.title,
        updatedAt: session.updatedAt,
        ...(path === '' ? {} : { workspace: path }),
      })
    }
  }
  // A session whose directory was never recorded cannot be attributed, so it is offered as this
  // workspace's own: that is the only workspace this conversation can vouch for.
  return { own, others }
}

/** Truncate a reply, keeping the tail readable. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n…（已截断，完整内容见桌面端）`
}

/** Resolve the DSH home directory this plugin stores under. */
function resolveHome(ctx: WechatContext): string {
  const home = ctx.get('homePaths') as { home?: string } | undefined
  return home?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Resolve where the channel keeps its durable state and its sessions.
 *
 * Both live under the same directory so a user can find, back up, or delete the
 * channel's footprint in one place.
 */
/**
 * The workspace directory chosen in the settings page, if one has been.
 *
 * @param stateFile - Channel state file to read.
 * @returns The chosen directory, or undefined when unset or unreadable.
 */
function storedWorkspacePath(stateFile: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
      settings?: { workspacePath?: unknown }
    }
    const chosen = parsed.settings?.workspacePath
    return typeof chosen === 'string' && chosen.trim() !== '' ? chosen.trim() : undefined
  } catch {
    return undefined
  }
}

function resolvePaths(
  ctx: WechatContext,
  config: WechatConfig,
): { stateFile: string; workspace: string } {
  const home = resolveHome(ctx)
  const stateFile = config.stateFile ?? join(home, 'wechat', 'state.json')
  /*
   * The directory chosen in Settings wins over the loader patch: it is the one the user can
   * see and change, and the patch stays beneath it as the operator-level override. Read
   * straight off disk, because `apply` is synchronous and the store is not open yet.
   */
  const chosen = storedWorkspacePath(stateFile)
  const workspace = chosen ?? config.workspace ?? join(home, WORKSPACE_DIR_NAME)

  /*
   * The session workspace has to exist before a session can be created in it.
   *
   * The host resolves a session's `cwd` with `realpath`, which fails on a directory that is not
   * there — so on a fresh install the first inbound message died with `ENOENT: no such file or
   * directory, realpath '<home>/dsh_wechat'` and the user saw "处理这条消息时出错了".
   *
   * It went unnoticed because the only other place that creates it is the media writer, which uses
   * `recursive: true` and therefore built the whole chain — but only once an attachment arrived. On
   * a machine where that had ever happened the directory existed, and the bug hid itself. A fresh
   * install of a released version found it immediately.
   *
   * Created here, where every path is resolved, so it cannot be skipped: this runs during `apply`,
   * before any message can arrive.
   */
  mkdirSync(workspace, { recursive: true })

  return { stateFile, workspace }
}

/** Plugin configuration from the loader patch. */
export interface WechatConfig {
  /** Reconnect stored accounts on boot. */
  autoStart?: boolean
  /** Override the state file path. */
  stateFile?: string
  /** Override the sessions' working directory. Changing it strands existing sessions. */
  workspace?: string
  /** Identity reported to the service. */
  botAgent?: string
}

/**
 * Mount the WeChat channel.
 *
 * @param ctx - Host context providing `sessionController` and `sessions`.
 * @param config - Patch configuration.
 * @param internals - Test seams. The loader never sets this.
 */
export function apply(
  ctx: WechatContext,
  config: WechatConfig = {},
  internals: { send?: SendFunction; stateStore?: StateStore } = {},
): void {
  const home = resolveHome(ctx)
  bootLog(home, 'apply: entered')

  try {
    const paths = resolvePaths(ctx, config)
    const runtime = new WechatRuntime(ctx, {
      home,
      stateFile: paths.stateFile,
      workspace: paths.workspace,
      botAgent: config.botAgent ?? 'dsh-wechat-plugin/0.0.0',
      ...(internals.send === undefined ? {} : { send: internals.send }),
      ...(internals.stateStore === undefined ? {} : { stateStore: internals.stateStore }),
    })
    // The settings surface reaches the runtime through this service.
    ctx.provide('wechatChannel', runtime)

    ctx.effect(() => {
      const detachStream = ctx.on(
        'agent/assistant-stream',
        (payload) => {
          runtime.onAssistantFrame(payload)
        },
        { global: true },
      )
      const detachRoutes = registerRoutes(ctx, runtime)
      // The channel note, as a system-prompt section rather than a message. Registered inside the
      // effect so a reload takes the old section with it instead of stacking a second one.
      const detachChannelPrompt = runtime.registerChannelPrompt()
      // Registered inside the effect so disposal unregisters the tool rather than
      // leaving a handler that points at a torn-down runtime.
      const detachTool = runtime.registerTools()
      // Both are scoped waterfalls: returning an outcome claims the request, calling `next()`
      // delegates. Unbound conversations delegate, so desktop behaviour is untouched.
      //
      // `global: true` is load-bearing, not a preference. Dispatch keeps a hook when
      // `hook.global || !filter || filter(...)`, and both events are dispatched with
      // `scopeTarget(agent, agent)`, so `filter` is always present. This plugin sits at host
      // scope and owns no agent, so without the flag it is filtered out before it can run, the
      // desktop answerer claims the prompt, and a phone-only user stays stuck.
      //
      // `prepend: true` matters just as much. The waterfall walks listeners in order and stops
      // at the first that claims, and the desktop answerer waits on its UI pane — so if it runs
      // first it takes the prompt and blocks there, and a bound conversation never gets asked
      // over WeChat. Running first is what lets this channel claim its own sessions.
      const detachApproval = ctx.on('approval/request', runtime.approvalListener(), {
        global: true,
        prepend: true,
      })
      const detachQuestions = ctx.on('user-questions/request', runtime.questionListener(), {
        global: true,
        prepend: true,
      })

      void (async () => {
        try {
          // Before the first assembly, not after: a binding survives a restart, so a turn that
          // arrives before any inbound message still has to know whose session it is.
          await runtime.syncBoundSessions()
          if (config.autoStart === true || (await runtime.enabled())) await runtime.start()
          bootLog(home, 'apply: channel started')
        } catch (error) {
          bootLog(home, `apply: start failed: ${describeError(error)}`)
        }
      })()

      return () => {
        try {
          if (typeof detachStream === 'function') detachStream()
          if (typeof detachApproval === 'function') detachApproval()
          if (typeof detachQuestions === 'function') detachQuestions()
          detachRoutes()
          if (typeof detachChannelPrompt === 'function') detachChannelPrompt()
          if (typeof detachTool === 'function') detachTool()
          runtime.stopTypingAll()
          void runtime.flushReplies()
          void runtime.halt()
        } catch (error) {
          bootLog(home, `apply: teardown failed: ${describeError(error)}`)
        }
      }
    })

    bootLog(home, 'apply: mounted')
    console.error('dsh-wechat-plugin: channel mounted')
  } catch (error) {
    // Record before rethrowing: the desktop shell shows this failure once, in a
    // dialog it never writes to disk, so otherwise nothing survives to inspect.
    bootLog(home, `apply: FAILED: ${describeError(error)}`)
    if (error instanceof Error && error.stack) bootLog(home, `apply: stack:\n${error.stack}`)
    throw error
  }
}

/**
 * Append a line to the channel's boot log.
 *
 * Best effort by design: diagnostics must never be the reason startup fails.
 *
 * @param home - DSH home directory.
 * @param line - Text to record.
 */
function bootLog(home: string, line: string): void {
  try {
    const dir = join(home, 'wechat')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, BOOT_LOG_NAME), `${new Date().toISOString()} ${line}\n`, 'utf-8')
  } catch {
    // Ignored: see above.
  }
}

/** Render an unknown throwable for logging, including its cause chain. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause === undefined ? '' : ` <- cause: ${describeError(error.cause)}`
  return `${error.name}: ${error.message}${cause}`
}

/**
 * The part of `@deepseek-ai/dsh-system-prompt` this plugin uses.
 *
 * Structural rather than imported: the host package is not a dependency of this plugin (a plugin
 * that imported it would drag the harness into its own tree), so the one method it needs is declared
 * here and the service is duck-typed at runtime.
 */
interface PromptSectionRegistry {
  section?: (section: {
    name: string
    order: number
    text: (context: unknown) => string
  }) => (() => void) | void
}

/**
 * The system-prompt service behind whatever the host handed over.
 *
 * Two shapes reach here. A context resolved by `inject` carries its services as properties, while a
 * hand-built one — the plugin's own test doubles, and any host that wires services the older way —
 * is asked through `get`. Both are tried rather than one being assumed.
 *
 * @param holder - A context or service container.
 * @returns The registry, or `undefined` when this composition has none.
 */
function systemPromptOf(holder: unknown): PromptSectionRegistry | undefined {
  if (holder === null || typeof holder !== 'object') return undefined
  const direct = (holder as { systemPrompt?: PromptSectionRegistry }).systemPrompt
  if (direct !== undefined) return direct
  const get = (holder as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  return get.call(holder, 'systemPrompt') as PromptSectionRegistry | undefined
}

/**
 * Neutralize DSH's `{{variable}}` interpolation in text the user authored.
 *
 * The system prompt is interpolated with **strict** references: an unknown `{{name}}` throws, and
 * the throw aborts the turn that requested the assembly. The channel note is editable in the
 * settings page, so without this a user who types `{{` would break every WeChat turn in the
 * conversation — with an error that names the prompt, not the setting.
 *
 * Splitting the braces keeps the text readable to the model and leaves the interpolator seeing
 * literal prose. Applied to the note only; nothing else here is user-authored prompt text.
 *
 * @param text - Text destined for the system prompt.
 * @returns The same text with `{{` broken up.
 */
export function sanitizePromptText(text: string): string {
  return text.replaceAll('{{', '{ {')
}

/**
 * The session id behind one prompt-assembly context.
 *
 * `AssembleContext` is deliberately loose about identity: `assembleContextFor(agent)` puts the live
 * agent on `context.agent`, while the public type promises neither `agent` nor any id shape, and a
 * session-shaped `scope` is passed in some compositions. Every plausible path is therefore tried
 * rather than one being assumed — and an id that cannot be found is reported as `undefined`, which
 * hides the note. Guessing wrong in the other direction would put a phone-facing note in front of a
 * desktop conversation.
 *
 * @param context - The assembly context DSH passes to a section provider.
 * @returns The session id, or `undefined` when the context does not name one.
 */
export function sessionIdFromAssembly(context: unknown): string | undefined {
  const idFrom = (value: unknown): string | undefined => {
    if (value === null || typeof value !== 'object') return undefined
    const candidate = value as {
      id?: unknown
      header?: { id?: unknown }
      session?: { id?: unknown; header?: { id?: unknown } }
    }
    const ids = [
      candidate.session?.header?.id,
      candidate.session?.id,
      candidate.header?.id,
      candidate.id,
    ]
    for (const id of ids) {
      if (typeof id === 'string' && id !== '') return id
    }
    return undefined
  }
  if (context === null || typeof context !== 'object') return undefined
  const assembly = context as { agent?: unknown; scope?: unknown }
  return idFrom(assembly.agent) ?? idFrom(assembly.scope)
}

/**
 * Record a browser-side failure in the boot log.
 *
 * Split out from the runtime so it can be tested directly: the whole point of this
 * log is to work when everything else has gone wrong, and that is not a property
 * worth assuming.
 *
 * @param home - DSH home directory.
 * @param scope - Which client phase failed.
 * @param message - Failure text.
 * @param stack - Stack trace, when the browser supplied one.
 */
export function recordClientFailure(
  home: string,
  scope: string,
  message: string,
  stack: string,
): void {
  bootLog(home, `client[${scope}] FAILED: ${message}`)
  if (stack !== '') bootLog(home, `client[${scope}] stack:\n${stack}`)
}

/** Register the settings-page routes. Returns a disposer. */
function registerRoutes(ctx: WechatContext, runtime: WechatRuntime): () => void {
  const webServer = ctx.get('webServer') as
    | {
        register(route: {
          kind: 'prefix'
          path: string
          handler: (
            req: import('node:http').IncomingMessage,
            res: import('node:http').ServerResponse,
          ) => Promise<void>
        }): () => void
      }
    | undefined
  if (webServer === undefined) {
    console.error('dsh-wechat-plugin: no webServer, settings routes unavailable')
    return () => {}
  }

  return webServer.register({
    kind: 'prefix',
    path: '/.dsh-wechat-plugin',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname
      try {
        if (route === ROUTE_STATUS && req.method === 'GET') {
          return json(res, 200, await runtime.status())
        }
        if (route === ROUTE_DIAGNOSTICS && req.method === 'GET') {
          return json(res, 200, (await runtime.status()).diagnostics)
        }
        if (route === ROUTE_SETTINGS && req.method === 'GET') {
          return json(res, 200, await runtime.settingsForPage())
        }
        if (route === ROUTE_SETTINGS && req.method === 'POST') {
          const patch = readSettingsPatch(await readJson(req))
          const settings = await runtime.saveSettings(patch)
          return json(res, 200, { settings })
        }
        if (route === ROUTE_DISCONNECT && req.method === 'POST') {
          const body = await readJson(req)
          const accountId = typeof body.accountId === 'string' ? body.accountId : ''
          const disconnected = await runtime.disconnect(accountId)
          return json(res, disconnected ? 200 : 404, {
            disconnected,
            status: await runtime.status(),
          })
        }
        if (route === ROUTE_LOGIN_STATE && req.method === 'GET') {
          return json(res, 200, runtime.loginState())
        }
        if (route === ROUTE_LOGIN_START && req.method === 'POST') {
          return json(res, 200, await runtime.startLogin())
        }
        if (route === ROUTE_LOGIN_VERIFY && req.method === 'POST') {
          const body = await readJson(req)
          const code = typeof body.code === 'string' ? body.code : ''
          const accepted = runtime.provideVerifyCode(code)
          return json(res, accepted ? 200 : 409, { accepted })
        }
        if (route === ROUTE_LOGIN_CANCEL && req.method === 'POST') {
          runtime.cancelLogin()
          return json(res, 200, { cancelled: true })
        }
        if (route === ROUTE_TOGGLE && req.method === 'POST') {
          const body = await readJson(req)
          await runtime.setEnabled(body.enabled === true)
          return json(res, 200, await runtime.status())
        }
        if (route === ROUTE_CLIENT_ERROR && req.method === 'POST') {
          const body = await readJson(req)
          const scope = typeof body.scope === 'string' ? body.scope : 'client'
          const message = typeof body.message === 'string' ? body.message : '(无消息)'
          const stack = typeof body.stack === 'string' ? body.stack : ''
          runtime.recordClientError(scope, message, stack)
          return json(res, 200, { recorded: true })
        }
        return json(res, 404, { error: 'not found' })
      } catch (error) {
        return json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}

/**
 * Keep the usable fields of a settings patch.
 *
 * The request body is whatever the page sent, so a string where a number belongs would reach a
 * timer as NaN and disable it without an error anywhere. Fields of the wrong type are dropped
 * rather than defaulted, so a malformed request leaves the stored value alone.
 *
 * @param body - Parsed request body.
 * @returns A patch containing only well-typed fields.
 */
function readSettingsPatch(body: Record<string, unknown>): ChannelSettings {
  const patch: ChannelSettings = {}
  for (const key of ['mergeWindowMs', 'maxReplyChars', 'settleMs', 'quoteHistory'] as const) {
    const value = body[key]
    // The upper bounds are sanity limits, not format rules: a window of ten hours is a typo, and
    // a reply limit of a million characters makes every reply a file.
    const ceiling = key === 'maxReplyChars' ? 200_000 : 3_600_000
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= ceiling) {
      patch[key] = Math.round(value)
    }
  }
  if (typeof body.autoReplyAttachments === 'boolean') {
    patch.autoReplyAttachments = body.autoReplyAttachments
  }
  if (typeof body.requireConfirmation === 'boolean') {
    patch.requireConfirmation = body.requireConfirmation
  }
  if (typeof body.presenceNote === 'string') patch.presenceNote = body.presenceNote
  /*
   * Checked against the known values rather than passed through as any string: this value is handed
   * to DSH as a preset name, and a typo would reach the host as a missing preset instead of being
   * rejected here, where the mistake is still visible.
   */
  if (
    body.permissionPreset === 'danger-full-access' ||
    body.permissionPreset === 'auto' ||
    body.permissionPreset === 'default'
  ) {
    patch.permissionPreset = body.permissionPreset
  }
  if (typeof body.allowCrossSessionNotify === 'boolean') {
    patch.allowCrossSessionNotify = body.allowCrossSessionNotify
  }
  /*
   * An empty string is the reset rather than a rejected value: it is how the page clears a
   * chosen directory and goes back to the default under the DSH home.
   */
  if (typeof body.workspacePath === 'string') {
    patch.workspacePath = body.workspacePath.trim()
  }
  return patch
}

/**
 * One setting's value as it appears in a log line.
 *
 * Strings are quoted because the empty string is a meaningful value here — it is how the workspace
 * goes back to the default — and printed bare it reads as a key nobody set.
 *
 * @param value - Value to describe.
 * @returns A short, unambiguous rendering.
 */
function formatSettingValue(value: unknown): string {
  const text = JSON.stringify(value)
  return text === undefined ? 'undefined' : text
}

/**
 * The keys a patch actually carries, for a log line.
 *
 * @param patch - Settings patch the page sent.
 * @returns A compact rendering of the patch.
 */
function describeSettingsPatch(patch: ChannelSettings): string {
  const keys = Object.keys(patch) as (keyof ChannelSettings)[]
  if (keys.length === 0) return '(no usable field)'
  return `{${keys.map((key) => `${key}: ${formatSettingValue(patch[key])}`).join(', ')}}`
}

/**
 * What one settings save changed, as `key "old" -> "new"` pairs.
 *
 * The pair is the point. A page that reports "saved" while the host dropped the value, and a page
 * whose request never left the browser, both leave the state file looking the same; only the two
 * values together say which happened, and only the host has both.
 *
 * @param before - Effective settings before the change.
 * @param after - Effective settings after the change.
 * @param patch - Fields the request asked to change.
 * @returns The log text, without the timestamp.
 */
function describeSettingsSave(
  before: Required<ChannelSettings>,
  after: Required<ChannelSettings>,
  patch: ChannelSettings,
): string {
  const keys = Object.keys(patch) as (keyof ChannelSettings)[]
  if (keys.length === 0) {
    // Not an error: an unreadable body and a body of wrong-typed values both arrive as "nothing to
    // apply", and that is worth being able to tell apart from a save that was never sent.
    return 'save carried no usable field — nothing changed'
  }
  const changes = keys.map(
    (key) => `${key} ${formatSettingValue(before[key])} -> ${formatSettingValue(after[key])}`,
  )
  return `saved ${changes.join('; ')}`
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export { WechatRuntime }
