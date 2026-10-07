/**
 * Conversation routing: one WeChat conversation maps to one DSH session, and the
 * user switches between them with in-chat commands.
 *
 * Why commands rather than a picker: WeChat gives a channel exactly one chat
 * surface, so a session list has to live inside the message stream. Tencent's own
 * client uses the same technique (it handles `/echo` and `/toggle-debug` in chat),
 * and the protocol's tool-call item types could eventually render something
 * richer. Commands work today, on every client, with no extra payload.
 *
 * Session ids are minted by this router in DSH's own format (`session-<uuid>`) and
 * handed to the session controller, which adopts an existing session with that id
 * or creates one. The mapping is what survives a restart, so a chat keeps talking
 * to the same session across reboots.
 *
 * @module @dsh-wechat/core/router
 */

import { randomUUID } from 'node:crypto'

/** One conversation's binding to a DSH session. */
export interface SessionBinding {
  conversationId: string
  accountId: string
  peerId: string
  /** DSH session id, in the platform's own `session-<uuid>` form. */
  sessionId: string
  /** Human label shown in `/list`, captured when the session was bound. */
  title: string
  createdAt: number
  lastUsedAt: number
}

/** Why the router handed work to the agent, for logging. */
export interface RouteDecision {
  /** Session the prompt belongs to. */
  sessionId: string
  /** Text to send to the agent. */
  prompt: string
  /** True when this message started a brand new session. */
  created: boolean
}

/** Result of routing one message. */
export type RouteResult =
  | { kind: 'reply'; text: string }
  | { kind: 'prompt'; decision: RouteDecision }

/**
 * The session surface this router needs from the host.
 *
 * Keeping it narrow means the routing rules are unit-testable without booting DSH,
 * and it documents exactly which host calls the channel depends on.
 */
export interface SessionGateway {
  /** Bind or resume a session with this id. Implementations should be idempotent. */
  ensureSession(sessionId: string, title: string): Promise<void>
  /** Hand a prompt to a session. */
  prompt(sessionId: string, text: string): Promise<void>
  /** Recent sessions, newest first, for `/list`. */
  listSessions(): Promise<{ sessionId: string; title: string; updatedAt: number }[]>
  /**
   * Sessions belonging to the channel's own workspace.
   *
   * Optional because only the host knows where a session lives. `/list` uses it to lead with the
   * conversations this chat created and merely mention the rest; without it, every session is
   * treated as the channel's own and the list shows the whole machine.
   */
  listOwnSessions?(): Promise<{ sessionId: string; title: string; updatedAt: number }[]>
  /** Abort whatever the session is currently doing. */
  cancel(sessionId: string): Promise<void>
}

/** Everything persisted for routing, injected so the store stays pluggable. */
export interface BindingStore {
  load(): Promise<Record<string, SessionBinding>>
  save(bindings: Record<string, SessionBinding>): Promise<void>
  /**
   * Record that a session belongs to a conversation.
   *
   * Separate from `bindings`, which only holds where a conversation is *now*. `/new` moves a
   * conversation to a later session, and without this the earlier session could no longer be
   * traced back to its conversation — so a tool called from it, including `send_to_wechat`, would
   * fail precisely when the user switched back.
   *
   * Optional so a test store that only cares about routing stays small.
   *
   * @param sessionId - Session that became active.
   * @param conversationId - Conversation it belongs to.
   */
  rememberOwner?(sessionId: string, conversationId: string): Promise<void>
}

export interface SessionRouterOptions {
  gateway: SessionGateway
  store: BindingStore
  /** Display name used when auto-creating a session title. */
  titlePrefix?: string
}

/**
 * Routes WeChat messages to DSH sessions and implements the in-chat commands.
 */
export class SessionRouter {
  readonly #gateway: SessionGateway
  readonly #store: BindingStore
  readonly #titlePrefix: string
  #bindings: Record<string, SessionBinding> | undefined

  constructor(options: SessionRouterOptions) {
    this.#gateway = options.gateway
    this.#store = options.store
    this.#titlePrefix = options.titlePrefix ?? '微信'
  }

  /**
   * Route one inbound message.
   *
   * @param params.conversationId - Stable conversation key.
   * @param params.accountId - Bot account the message arrived on.
   * @param params.peerId - Counterparty user id.
   * @param params.text - Message text.
   * @returns Either text to reply with directly, or a prompt for a session.
   */
  async route(params: {
    conversationId: string
    accountId: string
    peerId: string
    text: string
  }): Promise<RouteResult> {
    const text = params.text.trim()

    if (text.startsWith('/')) {
      return await this.#command(params, text)
    }

    const bindings = await this.#load()
    let binding = bindings[params.conversationId]
    let created = false
    if (binding === undefined) {
      binding = await this.#bind(params, undefined)
      created = true
    } else {
      // DSH may have restarted since this binding was made; make sure the session
      // is live before handing it a prompt.
      await this.#gateway.ensureSession(binding.sessionId, binding.title)
    }

    binding.lastUsedAt = Date.now()
    await this.#store.save(bindings)
    // Recorded on every turn, not just on creation, so a session adopted before this field existed
    // gains its owner the first time it is used.
    await this.#store.rememberOwner?.(binding.sessionId, params.conversationId)

    return {
      kind: 'prompt',
      decision: { sessionId: binding.sessionId, prompt: text, created },
    }
  }

  /** Currently bound session for a conversation, if any. */
  async current(conversationId: string): Promise<SessionBinding | undefined> {
    return (await this.#load())[conversationId]
  }

  async #command(
    params: { conversationId: string; accountId: string; peerId: string },
    text: string,
  ): Promise<RouteResult> {
    const { command, args } = splitCommand(text)
    const bindings = await this.#load()

    switch (command) {
      case '/help':
        return { kind: 'reply', text: HELP_TEXT }

      case '/new': {
        const binding = await this.#bind(params, args || undefined)
        // Rebinding is the point of `/new`: the conversation must now *be* the new session, or the
        // next message lands in the old one and the new session exists but is unreachable.
        bindings[params.conversationId] = binding
        await this.#store.save(bindings)
        return {
          kind: 'reply',
          text: `已新建对话「${binding.title}」。\n${shortId(binding.sessionId)}\n\n从现在起，你的消息发到这里。`,
        }
      }

      case '/list': {
        /*
         * The default list is this workspace's own conversations, with the rest only counted.
         *
         * This matches what a spoken request does, so the same question gives the same answer
         * whichever way it is asked. Listing every workspace by default buried ten conversations
         * this chat created under fifty from other projects, with nothing marking which was which.
         */
        const all = await this.#gateway.listSessions()
        if (all.length === 0) return { kind: 'reply', text: '还没有任何对话，直接发消息就会新建一个。' }
        const currentId = bindings[params.conversationId]?.sessionId
        const own = (await this.#gateway.listOwnSessions?.()) ?? all
        const wantsAll = args.trim().toLowerCase() === 'all'
        const shown = wantsAll ? all : own
        // Only the workspaces that were actually held back, so the hint cannot claim a workspace the
        // list already contains.
        const held = wantsAll ? [] : all.filter((session) => !own.includes(session))
        return {
          kind: 'reply',
          text: renderSessionList(shown, currentId, { held }),
        }
      }

      case '/switch': {
        /*
         * Search every session, number only the ones the user was shown.
         *
         * A session from another workspace appears in `/list all`, so it has to be selectable from
         * there — otherwise the listing offers something that cannot be chosen. That is exactly how
         * switching to a named conversation failed in practice: the title was real, the session was
         * real, and the search only ever looked inside this workspace.
         */
        const all = await this.#gateway.listSessions()
        const own = (await this.#gateway.listOwnSessions?.()) ?? all
        const target = resolveTarget(args, all, own)
        if (target === undefined) {
          return { kind: 'reply', text: '找不到这个对话。回复「列表」看清单，再回复数字。' }
        }
        await this.#gateway.ensureSession(target.sessionId, target.title)
        const binding: SessionBinding = {
          conversationId: params.conversationId,
          accountId: params.accountId,
          peerId: params.peerId,
          sessionId: target.sessionId,
          title: target.title || this.#titlePrefix,
          createdAt: bindings[params.conversationId]?.createdAt ?? Date.now(),
          lastUsedAt: Date.now(),
        }
        bindings[params.conversationId] = binding
        await this.#store.save(bindings)
        await this.#store.rememberOwner?.(binding.sessionId, params.conversationId)
        return { kind: 'reply', text: `已切换到「${binding.title}」。\n${shortId(binding.sessionId)}` }
      }

      case '/current': {
        const binding = bindings[params.conversationId]
        if (binding === undefined) return { kind: 'reply', text: '当前没有对话，发任意消息就会新建一个。' }
        return {
          kind: 'reply',
          text: `当前对话「${binding.title}」\n${shortId(binding.sessionId)}\n最后使用：${new Date(binding.lastUsedAt).toLocaleString('zh-CN')}`,
        }
      }

      case '/cancel': {
        const binding = bindings[params.conversationId]
        if (binding === undefined) return { kind: 'reply', text: '当前没有对话。' }
        await this.#gateway.cancel(binding.sessionId)
        return { kind: 'reply', text: '已请求中断当前任务。' }
      }

      default:
        return { kind: 'reply', text: `未知指令 ${command}。\n\n${HELP_TEXT}` }
    }
  }

  /** Create a binding, its session, and persist it. */
  async #bind(
    params: { conversationId: string; accountId: string; peerId: string },
    requestedTitle: string | undefined,
  ): Promise<SessionBinding> {
    const bindings = await this.#load()
    const sessionId = mintSessionId()
    const title = requestedTitle?.trim() || `${this.#titlePrefix} ${shortId(sessionId)}`
    await this.#gateway.ensureSession(sessionId, title)
    const now = Date.now()
    const binding: SessionBinding = {
      conversationId: params.conversationId,
      accountId: params.accountId,
      peerId: params.peerId,
      sessionId,
      title,
      createdAt: now,
      lastUsedAt: now,
    }
    bindings[params.conversationId] = binding
    await this.#store.save(bindings)
    await this.#store.rememberOwner?.(sessionId, params.conversationId)
    return binding
  }

  async #load(): Promise<Record<string, SessionBinding>> {
    this.#bindings ??= await this.#store.load()
    return this.#bindings
  }
}

/** Commands that may be written with or without an argument. */
const COMMANDS_WITH_ARG = ['/new', '/switch'] as const

/** Commands that never take an argument. */
const COMMANDS_BARE = ['/help', '/list', '/current', '/cancel'] as const

/**
 * Split `/cmd args` into its parts.
 *
 * The separator space is optional, and `:` is accepted in its place, because these
 * commands are typed on a phone keyboard where a dropped space is the common case.
 * `/switch1`, `/switch 1`, and `/switch:1` all mean the same thing. A leading token
 * that only *starts* with a command name is left alone, so `/news` is not `/new`.
 */
export function splitCommand(text: string): { command: string; args: string } {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()

  const space = trimmed.search(/\s/)
  if (space >= 0) {
    return { command: lower.slice(0, space), args: trimmed.slice(space + 1).trim() }
  }

  const colon = lower.indexOf(':')
  if (colon > 0) {
    return { command: lower.slice(0, colon), args: trimmed.slice(colon + 1).trim() }
  }

  if ((COMMANDS_BARE as readonly string[]).includes(lower)) {
    return { command: lower, args: '' }
  }

  for (const command of COMMANDS_WITH_ARG) {
    if (!lower.startsWith(command)) continue
    const rest = trimmed.slice(command.length)
    // A following ASCII letter means this was a different word, not this command
    // with a glued argument: `/news` must not parse as `/new` plus `s`. Digits and
    // non-ASCII text are legitimate glued arguments (`/switch1`, `/new我的任务`).
    if (/^[a-z]/.test(rest)) continue
    return { command, args: rest.replace(/^[:\s]+/, '').trim() }
  }

  return { command: lower, args: '' }
}

/**
 * Resolve a `/switch` argument against the session list.
 *
 * Accepts a 1-based list position, a full session id, the short id printed by
 * `/list`, or an exact title — a phone keyboard makes copying a full uuid painful.
 *
 * Matching is deliberately strict. Session ids share a common shape
 * (`session-<short>-<uuid>`), so a loose `includes` test can match several rows;
 * an ambiguous argument must fail rather than switch to a surprise session.
 *
 * @param args - What the user typed after `/switch`.
 * @param sessions - Every session that may be selected, usually the whole machine.
 * @param numbered - The rows a number refers to, when they differ from `sessions`.
 *
 *   This matters because the two are not the same list. A number is answered from the list the user
 *   was actually shown, while a title or id may name a session from any workspace — and a
 *   conversation the user picked out of a listing has to be switchable, or the listing is a lie.
 *   Without this, a session from another workspace was printed and then could not be selected.
 */
export function resolveTarget(
  args: string,
  sessions: readonly { sessionId: string; title: string; updatedAt: number }[],
  numbered: readonly { sessionId: string; title: string; updatedAt: number }[] = sessions,
): { sessionId: string; title: string } | undefined {
  const value = args.trim()
  if (!value) return undefined

  if (/^\d+$/.test(value)) {
    // A number refers to a row of the listing the user was shown, which is not necessarily the whole
    // machine — hence `numbered` rather than `sessions`.
    const byIndex = numbered[Number(value) - 1]
    if (byIndex !== undefined) return { sessionId: byIndex.sessionId, title: byIndex.title }
    // Fall through: a numeric string can still be a title.
  }

  const exactId = sessions.find((session) => session.sessionId === value)
  if (exactId !== undefined) return { sessionId: exactId.sessionId, title: exactId.title }

  // The short id lives in the middle: `session-<short>-<uuid>`.
  const byShort = sessions.filter((session) => session.sessionId.startsWith(`session-${value}-`))
  if (byShort.length === 1) return { sessionId: byShort[0].sessionId, title: byShort[0].title }

  const bySuffix = sessions.filter((session) => session.sessionId.endsWith(value))
  if (bySuffix.length === 1) return { sessionId: bySuffix[0].sessionId, title: bySuffix[0].title }

  const byTitle = sessions.find((session) => session.title === value)
  if (byTitle !== undefined) return { sessionId: byTitle.sessionId, title: byTitle.title }

  /*
   * Last, a *core* title match in either direction — and only when exactly one session matches.
   *
   * People name a conversation the way they talk about it, in both directions of slop: they type a
   * fragment («北京»), or they add words of their own («北京今天天气如何**会话**»). Both are the same
   * request as the exact title, and exact matching alone failed on each — a hard failure for a
   * request the user can see is answerable.
   *
   * Uniqueness is the safeguard, and it is why this is the last resort. Several matches, or none,
   * return undefined: an ambiguous argument must fail rather than move the conversation somewhere the
   * user did not ask for. A word as short as a single character will usually match nothing here for
   * the same reason — good, because it would be a guess.
   */
  const core = (session: { title: string }): boolean =>
    session.title.includes(value) || value.includes(session.title)
  const byCore = sessions.filter((session) => session.title !== '' && core(session))
  if (byCore.length === 1) return { sessionId: byCore[0].sessionId, title: byCore[0].title }

  return undefined
}

/**
 * Mint a session id in DSH's own format.
 *
 * The id is `session-<uuid>` because the host treats that shape as its native
 * session identity. The trailing hex group is random; the leading group is
 * derived from it so that the compact form shown by `/list` is also the form
 * `/switch` accepts. Keeping the two identical is what makes switching possible
 * from a phone keyboard.
 */
export function mintSessionId(random: () => string = randomUUID): string {
  const uuid = random()
  const tail = uuid.replace(/-/g, '').slice(0, 8)
  return `session-${tail}-${uuid}`
}

/** Compact identifier shown to the user, and accepted back by `/switch`. */
export function shortId(sessionId: string): string {
  const match = /^session-([0-9a-f]{8})-/i.exec(sessionId)
  if (match) return match[1]
  return sessionId.replace(/^session-/, '').slice(0, 8)
}

/** How many rows the list shows. Beyond this, older sessions are out of reach by number. */
const LIST_LIMIT = 20

/**
 * Render one row of a session list.
 *
 * The title leads because it is what a person recognises. The short id follows on its own line,
 * because a workspace title is shared by every session in it, so two conversations in one workspace
 * are otherwise indistinguishable — and the id is what `/switch` accepts when a number is not enough.
 *
 * Shared by `/list` and by the tool's natural-language path, so the same request cannot produce two
 * different-looking answers depending on whether it was typed or spoken.
 *
 * @param session - Session to render.
 * @param index - 0-based position, rendered as the 1-based number to reply with.
 * @param currentId - Session this conversation is bound to, marked in the list.
 * @returns The row.
 */
export function renderSessionRow(
  session: { sessionId: string; title?: string; updatedAt?: number },
  index: number,
  currentId: string | undefined,
): string {
  const mark = session.sessionId === currentId ? '  ← 当前' : ''
  const title = (session.title ?? '').trim() || '(无标题)'
  const when = session.updatedAt === undefined ? '' : ` · ${relativeTime(session.updatedAt)}`
  return `${index + 1}. ${title}${mark}\n   ${shortId(session.sessionId)}${when}`
}

/**
 * Render the session list.
 *
 * @param sessions - Sessions to show, newest first.
 * @param currentId - Session this conversation is bound to, marked in the list.
 * @param options - `held` is the sessions left out, so the message can say they exist and how to see
 * them. Naming them is the whole point: a user who is never told cannot ask.
 * @returns The message body.
 */
export function renderSessionList(
  sessions: readonly { sessionId: string; title: string; updatedAt: number }[],
  currentId: string | undefined,
  options: {
    held?: readonly { sessionId: string; title: string; updatedAt: number }[]
    /** How to reach the held sessions. Typed and spoken requests need different wording. */
    heldHint?: string
  } = {},
): string {
  const held = options.held ?? []
  const shown = sessions.slice(0, LIST_LIMIT)
  const lines = shown.map((session, index) => renderSessionRow(session, index, currentId))
  const more =
    sessions.length > shown.length ? `\n\n（还有 ${sessions.length - shown.length} 个更早的对话未显示）` : ''
  const elsewhere =
    held.length === 0
      ? ''
      : `\n\n另有 ${String(held.length)} 个对话在其它工作区，${options.heldHint ?? '一起看就发 /list all。'}`
  const all = sessions.length + held.length
  return [
    `共 ${String(all)} 个对话${held.length === 0 ? '' : `（这里显示 ${String(sessions.length)} 个）`}：`,
    '',
    lines.join('\n\n'),
    more,
    elsewhere,
    '',
    '回复数字即可切换，例如「3」。',
  ].join('\n')
}

/**
 * How long ago something happened, in the words a person would use.
 *
 * Relative rather than absolute because the question the list answers is "which one was I just
 * working on", and a 24-hour clock makes that harder, not easier.
 *
 * @param at - Timestamp in milliseconds.
 * @param now - Current time, injectable for tests.
 * @returns A short phrase such as `3 分钟前`.
 */
export function relativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(at).toLocaleDateString('zh-CN')
}

export const HELP_TEXT = [
  '可用指令：',
  '/new [标题]     新建对话',
  '/list           列出最近对话',
  '/switch <编号>  切换到某个对话',
  '/current        显示当前对话',
  '/cancel         中断当前任务',
  '/help           显示本帮助',
  '',
  '直接发消息即与当前对话对话。',
  '',
  '也可以直接用大白话说，例如「查看对话列表」「换个对话」「停下」，',
  '我会先问你一次确认，确认后才执行。',
].join('\n')
