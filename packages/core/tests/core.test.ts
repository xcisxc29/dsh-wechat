/**
 * Unit tests for the parts of the client that are easy to get subtly wrong:
 * uint64 identifier precision, inbound filtering, and the in-chat routing rules.
 *
 * These run without a network. The live protocol was verified separately against
 * the service; what is tested here is the logic that sits on top of it.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseWireJson, extractRawIds, baseInfo, buildHeaders, assertSendAccepted, SendRefusedError } from '../src/http.ts'
import { CHANNEL_VERSION, CHANNEL_VERSION_ENV, clientVersionOf, resolveIlinkVersion } from '../src/constants.ts'
import { fetchQRCode } from '../src/login.ts'
import { conversationKey, extractText, toInbound, sendText } from '../src/channel.ts'
import { DEFAULT_SETTINGS, StateStore, SESSION_LIST_HISTORY, SESSION_LIST_TITLE_LIMIT, expirePendingNotifications, findBrowse, findSessionList, forgetBrowse, latestSessionList, queuePendingNotification, rememberBrowse, rememberSessionList, type ChannelSettings } from '../src/state.ts'
import {
  SessionRouter,
  BROWSE_PAGE_SIZE,
  MISSING_BINDING_GRACE_MS,
  SHORT_ID_LENGTH,
  SHOW_REST,
  ambiguousFolderMessage,
  ambiguousTargetMessage,
  browsePage,
  isShowRest,
  mintSessionId,
  parseModelCommand,
  relativeTime,
  renderFolderScreen,
  renderLevels,
  renderModelList,
  renderSessionScreen,
  resolveFolder,
  resolveLevel,
  resolveModelOption,
  resolveTarget,
  sessionFolders,
  shortId,
  splitCommand,
  unprintedFolderMessage,
  unprintedTargetMessage,
  HELP_TEXT,
} from '../src/router.ts'
import type { BrowsePosition, ListedSession, ModelListing, ModelOption, ModelSelection, NumberedRows, NumberedSession, SessionBinding, SessionFolder, SessionGateway, SessionState, TargetResolution } from '../src/router.ts'
import type { ChannelState } from '../src/state.ts'
import { chargeQuota, quotaLedgerFor, type QuotaEntry } from '../src/quota.ts'
import type { WeixinAccount, WeixinMessage } from '../src/types.ts'
import { unmatchedSwitchTarget } from './support.ts'

/** A state with nothing in it, for exercising the queue helpers. */
function emptyState(): ChannelState {
  return { version: 1, accounts: {}, syncBufs: {}, contextTokens: {}, bindings: {}, sentMessages: {} }
}

const account: WeixinAccount = {
  accountId: 'fd17bd2d40c3@im.bot',
  token: 'test-token',
  baseUrl: 'https://ilinkai.weixin.qq.com',
}

// ---------------------------------------------------------------------------
// Wire parsing
// ---------------------------------------------------------------------------

test('parseWireJson keeps a 19-digit message id exact', () => {
  // Observed live: a plain JSON.parse rounds this value.
  const raw = '{"msgs":[{"message_id":7512920379619302536,"from_user_id":"u@im.wechat"}]}'
  assert.notEqual(JSON.parse(raw).msgs[0].message_id, '7512920379619302536')

  const parsed = parseWireJson<{ msgs: { message_id: string }[] }>(raw)
  assert.equal(parsed.msgs[0].message_id, '7512920379619302536')
})

test('parseWireJson leaves short numbers and plain text alone', () => {
  const raw = '{"seq":12,"note":"message_id 7512920379619302536 is quoted","n":7512920379619302536}'
  const parsed = parseWireJson<{ seq: number; note: string; n: number }>(raw)
  assert.equal(parsed.seq, 12)
  assert.equal(parsed.note, 'message_id 7512920379619302536 is quoted')
  // A bare number outside the guarded field names stays numeric.
  assert.equal(typeof parsed.n, 'number')
})

test('parseWireJson guards every identifier field', () => {
  const parsed = parseWireJson<{ msg_id: string; svr_id: string }>(
    '{"msg_id":7512920379619302536,"svr_id":123456789012345}',
  )
  assert.equal(parsed.msg_id, '7512920379619302536')
  assert.equal(parsed.svr_id, '123456789012345')
})

test('extractRawIds surfaces identifiers for lossless logging', () => {
  const ids = extractRawIds('{"message_id":7512920379619302536,"msg_id":7512920382394628488}')
  assert.deepEqual(ids, ['7512920379619302536', '7512920382394628488'])
})

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test('buildHeaders mirrors the official client', () => {
  const anonymous = buildHeaders({})
  assert.equal(anonymous['iLink-App-Id'], 'bot')
  assert.equal(anonymous['iLink-App-ClientVersion'], '132106')
  assert.equal(anonymous.Authorization, undefined)
  assert.equal(anonymous.AuthorizationType, undefined)
  assert.ok(anonymous['X-WECHAT-UIN'].length > 0)

  const authed = buildHeaders({ token: 'abc' })
  assert.equal(authed.Authorization, 'Bearer abc')
  assert.equal(authed.AuthorizationType, 'ilink_bot_token')
})

test('baseInfo reports the current official channel version', () => {
  const info = baseInfo('probe/1')
  assert.equal(info.channel_version, '2.4.10')
  assert.equal(info.bot_agent, 'probe/1')
})

test('the client-version header is the official bit-packed encoding', () => {
  // Tencent's own example from `buildClientVersion`: 1.0.11 -> 0x0001000B.
  assert.equal(clientVersionOf('1.0.11'), '65547')
  assert.equal(clientVersionOf('2.4.10'), '132106')
  assert.throws(() => clientVersionOf('2.4'), /invalid iLink channel version/)
})

test('a version override moves the body and the header together', () => {
  /*
   * The two places must never disagree: the QR is stamped from the body, the API gate reads the
   * header, and a pair that says 2.4.11 in one and 2.4.10 in the other is the same class of bug as
   * no version at all. This is also the escape hatch a user has when WeChat raises its floor.
   */
  const saved = process.env[CHANNEL_VERSION_ENV]
  process.env[CHANNEL_VERSION_ENV] = '2.4.11'
  try {
    assert.equal(baseInfo('probe/1').channel_version, '2.4.11')
    assert.equal(buildHeaders({})['iLink-App-ClientVersion'], '132107')
    assert.equal(resolveIlinkVersion({ [CHANNEL_VERSION_ENV]: ' 2.5.1 ' }).channelVersion, '2.5.1')
  } finally {
    if (saved === undefined) delete process.env[CHANNEL_VERSION_ENV]
    else process.env[CHANNEL_VERSION_ENV] = saved
  }
})

test('an override the header cannot encode keeps the bundled version', () => {
  assert.equal(resolveIlinkVersion({ [CHANNEL_VERSION_ENV]: 'latest' }).channelVersion, CHANNEL_VERSION)
  assert.equal(resolveIlinkVersion({ [CHANNEL_VERSION_ENV]: '2.4.300' }).channelVersion, CHANNEL_VERSION)
})

test('the QR request declares the client version in its header, as the official client does', async () => {
  /*
   * The scan-time refusal ("please upgrade WeChat interface version in OpenClaw") happens inside
   * the phone, before any confirmation, so the QR itself is what is being rejected. Tencent's own
   * client mints that QR with only `local_token_list` in the body; the version travels in the
   * `iLink-App-ClientVersion` header alone. That makes the header the one thing this test must
   * pin.
   */
  const realFetch = globalThis.fetch
  let seen: { url: string; body: string; headers: Record<string, string> } | undefined
  globalThis.fetch = (async (
    url: string,
    init?: { body?: unknown; headers?: Record<string, string> },
  ) => {
    seen = {
      url: String(url),
      body: typeof init?.body === 'string' ? init.body : '',
      headers: init?.headers ?? {},
    }
    return new Response(JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'https://example.invalid/qr' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const qr = await fetchQRCode({ localTokenList: ['token-1'] })
    assert.equal(qr.qrcode, 'qr-1')
    assert.ok(seen)
    assert.match(seen.url, /bot_type=3/)
    assert.deepEqual(JSON.parse(seen.body), { local_token_list: ['token-1'] })
    assert.equal(seen.headers['iLink-App-ClientVersion'], '132106')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---------------------------------------------------------------------------
// Inbound conversion
// ---------------------------------------------------------------------------

function userMessage(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    message_id: '7512920379619302536',
    from_user_id: 'o9cq80ztWVe52FfXbkPElc2dANgk@im.wechat',
    to_user_id: 'fd17bd2d40c3@im.bot',
    message_type: 1,
    message_state: 2,
    context_token: 'AARzJWAFAAABAAAAAAC2',
    item_list: [{ type: 1, text_item: { text: '你好' } }],
    ...overrides,
  }
}

test('toInbound converts a text message and keeps the reply token', () => {
  const inbound = toInbound(account, userMessage())
  assert.ok(inbound)
  assert.equal(inbound.text, '你好')
  assert.equal(inbound.peerId, 'o9cq80ztWVe52FfXbkPElc2dANgk@im.wechat')
  assert.equal(inbound.contextToken, 'AARzJWAFAAABAAAAAAC2')
  assert.equal(inbound.conversationId, conversationKey(account.accountId, inbound.peerId))
})

test('toInbound drops the bot\'s own messages to prevent a reply loop', () => {
  assert.equal(toInbound(account, userMessage({ message_type: 2 })), undefined)
})

test('toInbound drops content with no usable text', () => {
  assert.equal(toInbound(account, userMessage({ item_list: [{ type: 2 }] })), undefined)
  assert.equal(toInbound(account, userMessage({ item_list: [] })), undefined)
  assert.equal(toInbound(account, userMessage({ from_user_id: '' })), undefined)
})

test('a media-only message survives with empty text and its attachment attached', () => {
  // Filtering on text alone is what made an incoming photo look like nothing had
  // been sent: the message was dropped before anything could download it.
  const inbound = toInbound(
    account,
    userMessage({
      item_list: [{ type: 2, image_item: { aeskey: '00'.repeat(16), media: { encrypt_query_param: 'p' } } }],
    }),
  )
  assert.ok(inbound, 'a photo with no caption must still reach the runtime')
  assert.equal(inbound.text, '')
  assert.equal(inbound.media?.length, 1)
  assert.equal(inbound.media?.[0].type, 2)
})

test('text and media in one message keep both', () => {
  const inbound = toInbound(
    account,
    userMessage({
      item_list: [
        { type: 1, text_item: { text: '看这张图' } },
        { type: 2, image_item: { media: { encrypt_query_param: 'p' } } },
      ],
    }),
  )
  assert.ok(inbound)
  assert.equal(inbound.text, '看这张图')
  assert.equal(inbound.media?.length, 1)
})

test('a text message carries no media array at all', () => {
  const inbound = toInbound(account, userMessage())
  assert.ok(inbound)
  assert.equal(inbound.media, undefined)
})

test('extractText prefers real text and accepts a voice transcript', () => {
  assert.equal(extractText(userMessage()), '你好')
  assert.equal(
    extractText({ item_list: [{ type: 3, voice_item: { text: '语音转写' } }] }),
    '语音转写',
  )
  assert.equal(
    extractText({ item_list: [{ type: 1, text_item: { text: 'a' } }, { type: 1, text_item: { text: 'b' } }] }),
    'a\nb',
  )
})

test('group messages get their own conversation key', () => {
  const inbound = toInbound(account, userMessage({ group_id: 'g-1' }))
  assert.ok(inbound)
  assert.equal(inbound.groupId, 'g-1')
  assert.notEqual(inbound.conversationId, conversationKey(account.accountId, inbound.peerId))
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** In-memory gateway that records every host call. */
class FakeGateway implements SessionGateway {
  readonly calls: string[] = []
  readonly prompts: { sessionId: string; text: string }[] = []
  sessions: ListedSession[] = []
  /** Sessions belonging to other workspaces, which `listOwnSessions` must exclude. */
  readonly foreign: ListedSession[] = []
  /**
   * Clock for seeded sessions, advanced a second per session.
   *
   * `Date.now()` gives two sessions created in the same millisecond the same timestamp, and the list
   * orders by it — so the order would be whatever the sort happened to do with the tie. Spacing the
   * values keeps the ordering a fact rather than a coincidence.
   */
  #clock = 1_700_000_000_000

  /** Next timestamp for a seeded session, a second after the previous one. */
  nextStamp(): number {
    this.#clock += 1_000
    return this.#clock
  }

  async ensureSession(sessionId: string, title: string): Promise<void> {
    this.calls.push(`ensure:${sessionId}:${title}`)
    if (!this.sessions.some((s) => s.sessionId === sessionId)) {
      // Spaced rather than `Date.now()`, so the list's ordering is a fact and not a tie to break.
      this.sessions.push({ sessionId, title, updatedAt: this.nextStamp() })
    }
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    this.prompts.push({ sessionId, text })
  }

  async listSessions(): Promise<ListedSession[]> {
    return [...this.sessions, ...this.foreign]
  }

  /** What `/list` shows by default: this workspace only. */
  async listOwnSessions(): Promise<ListedSession[]> {
    return [...this.sessions]
  }

  async cancel(sessionId: string): Promise<void> {
    this.calls.push(`cancel:${sessionId}`)
  }
}

/**
 * A gateway that can also say whether a bound session still works.
 *
 * Kept separate from {@link FakeGateway} rather than folded into it, because the two answer different
 * questions: a composition *without* a probe has to keep behaving exactly as it always did, and that
 * is only testable while a gateway without one still exists.
 */
class ProbeGateway extends FakeGateway {
  /** Verdicts to report, by session id. */
  readonly states = new Map<string, SessionState>()
  /** Sessions the probe was asked about, in order. */
  readonly probes: string[] = []
  /** When true, every probe throws, as an unreadable store or a broken implementation would. */
  failProbe = false

  /**
   * @param fallback - Verdict for a session with no entry in {@link states}.
   */
  constructor(readonly fallback: SessionState = 'usable') {
    super()
  }

  async sessionState(sessionId: string): Promise<SessionState> {
    this.probes.push(sessionId)
    if (this.failProbe) throw new Error('store unreadable')
    return this.states.get(sessionId) ?? this.fallback
  }
}

/** In-memory binding store. */
function memoryStore(initial: Record<string, SessionBinding> = {}) {
  let data: Record<string, SessionBinding> = initial
  return {
    async load() {
      return data
    },
    async save(next: Record<string, SessionBinding>) {
      data = next
    },
    peek: () => data,
  }
}

const conversation = {
  conversationId: 'fd17bd2d40c3@im.bot:user@im.wechat',
  accountId: 'fd17bd2d40c3@im.bot',
  peerId: 'user@im.wechat',
}

/**
 * A binding as a previous run would have left it, `ageMs` old.
 *
 * The age is the whole point of these tests: `missing` is only believed once a binding has been
 * around long enough that its session's first turn would have written a record.
 *
 * @param sessionId - Session the conversation is bound to.
 * @param title - Title the binding carries.
 * @param ageMs - How long ago it was created.
 */
function agedBinding(sessionId: string, title: string, ageMs: number): SessionBinding {
  const now = Date.now()
  return {
    conversationId: conversation.conversationId,
    accountId: conversation.accountId,
    peerId: conversation.peerId,
    sessionId,
    title,
    createdAt: now - ageMs,
    lastUsedAt: now - ageMs,
  }
}

test('first message auto-binds a new session and returns a prompt decision', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const result = await router.route({ ...conversation, text: '帮我看看这个 bug' })
  assert.equal(result.kind, 'prompt')
  if (result.kind !== 'prompt') return
  assert.equal(result.decision.created, true)
  assert.equal(result.decision.prompt, '帮我看看这个 bug')
  assert.match(result.decision.sessionId, /^session-[0-9a-f]{8}-[0-9a-f-]{36}$/)
  // Binding creates the session but delivery belongs to the caller, which owns
  // typing indicators, reply correlation, and streaming.
  assert.deepEqual(gateway.prompts, [])
  assert.ok(gateway.calls.some((call) => call.startsWith(`ensure:${result.decision.sessionId}:`)))
})

test('a second message reuses the same session', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const first = await router.route({ ...conversation, text: 'one' })
  const second = await router.route({ ...conversation, text: 'two' })
  assert.equal(first.kind, 'prompt')
  assert.equal(second.kind, 'prompt')
  if (first.kind !== 'prompt' || second.kind !== 'prompt') return
  assert.equal(first.decision.sessionId, second.decision.sessionId)
  assert.equal(second.decision.created, false)
  // The reused session is re-ensured so a host restart cannot strand it.
  assert.ok(gateway.calls.some((call) => call.startsWith(`ensure:${first.decision.sessionId}:`)))
})

/*
 * The probe, and the two failures it exists for.
 *
 * Both of them are invisible from outside: an archived session is still on disk and still accepts a
 * prompt — DSH rejects the *step* the prompt proposes, so the turn ends with nothing said — and a
 * session that is gone receives the prompt into nowhere. Neither raises, neither is logged by anyone
 * else, and the user simply never hears back. So these tests are as much about the log lines as about
 * the rebinding: a fix that rebinds silently would leave the next report just as unanswerable.
 */

test('a binding whose session was archived is replaced, and the user is told', async () => {
  const gateway = new ProbeGateway()
  const store = memoryStore()
  const lines: string[] = []
  const router = new SessionRouter({ gateway, store, onDiagnostic: (line) => lines.push(line) })

  const first = await router.route({ ...conversation, text: '第一句' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return
  const archived = first.decision.sessionId
  // Nothing to ask about yet: a conversation with no binding is created, never probed.
  assert.deepEqual(gateway.probes, [])
  gateway.states.set(archived, 'archived')

  const second = await router.route({ ...conversation, text: '第二句' })
  assert.equal(second.kind, 'prompt')
  if (second.kind !== 'prompt') return
  assert.notEqual(second.decision.sessionId, archived, 'the archived session is left behind')
  assert.equal(second.decision.created, true)
  assert.equal(second.decision.prompt, '第二句', 'the user\'s words still reach the agent')
  assert.ok(
    (second.decision.notice ?? '').includes('归档'),
    'the user is told why the conversation changed',
  )
  assert.ok(
    (second.decision.notice ?? '').includes(shortId(archived)),
    'and which conversation was left behind, by the short id the user can recognise',
  )
  assert.ok(gateway.calls.some((call) => call.startsWith(`ensure:${second.decision.sessionId}:`)))
  // Persisted, or the next message would land in the archived session again.
  assert.equal(store.peek()[conversation.conversationId]?.sessionId, second.decision.sessionId)
  const moved = lines.find((line) => line.includes('state=archived'))
  assert.ok(moved !== undefined, `a replaced binding must be written down; got ${lines.join(' | ')}`)
  assert.ok(moved.includes(conversation.conversationId), 'the line names the conversation')
  assert.ok(moved.includes(archived), 'and the session that was left')
  assert.ok(moved.includes(second.decision.sessionId), 'and the one that took over')
})

test('an archived session is replaced however young the binding is', async () => {
  /*
   * The grace period below exists because a *new* session has no record yet. Archiving is not that:
   * the registry answers immediately and knows nothing about whether a record has been written, so
   * waiting the two minutes out would leave the user talking to a session that cannot answer.
   */
  const gateway = new ProbeGateway()
  const old = mintSessionId()
  gateway.states.set(old, 'archived')
  const store = memoryStore({
    [conversation.conversationId]: agedBinding(old, '微信 刚建的', 1_000),
  })
  const router = new SessionRouter({ gateway, store })

  const result = await router.route({ ...conversation, text: '这条不能丢' })
  assert.equal(result.kind, 'prompt')
  if (result.kind !== 'prompt') return
  assert.notEqual(result.decision.sessionId, old)
  assert.equal(result.decision.created, true)
})

test('a session that is gone from disk is replaced once the binding is old enough to be sure', async () => {
  const gateway = new ProbeGateway()
  const old = mintSessionId()
  gateway.states.set(old, 'missing')
  const store = memoryStore({
    [conversation.conversationId]: agedBinding(
      old,
      '微信 旧对话',
      MISSING_BINDING_GRACE_MS + 1_000,
    ),
  })
  const lines: string[] = []
  const router = new SessionRouter({ gateway, store, onDiagnostic: (line) => lines.push(line) })

  const result = await router.route({ ...conversation, text: '还在吗' })
  assert.equal(result.kind, 'prompt')
  if (result.kind !== 'prompt') return
  assert.notEqual(result.decision.sessionId, old)
  assert.equal(result.decision.created, true)
  assert.ok((result.decision.notice ?? '').includes('不存在'), 'the user is told what happened')
  assert.equal(store.peek()[conversation.conversationId]?.sessionId, result.decision.sessionId)
  assert.ok(lines.some((line) => line.includes('state=missing') && line.includes(old)))
})

test('a session with no record yet is kept, not replaced', async () => {
  /*
   * This is the bug the grace period was written for. A session's record is written by its first
   * turn, so a brand-new binding legitimately looks "missing" — believing that verdict replaced the
   * session it had just created and produced one new conversation per message on a live machine.
   */
  const gateway = new ProbeGateway()
  const fresh = mintSessionId()
  gateway.states.set(fresh, 'missing')
  const store = memoryStore({
    [conversation.conversationId]: agedBinding(fresh, '微信 刚开始', 1_000),
  })
  const lines: string[] = []
  const router = new SessionRouter({ gateway, store, onDiagnostic: (line) => lines.push(line) })

  const result = await router.route({ ...conversation, text: '第一条' })
  assert.equal(result.kind, 'prompt')
  if (result.kind !== 'prompt') return
  assert.equal(result.decision.sessionId, fresh, 'the young binding is reused')
  assert.equal(result.decision.created, false)
  assert.equal(result.decision.notice, undefined, 'and nothing is said to the user about it')
  assert.ok(gateway.calls.some((call) => call.startsWith(`ensure:${fresh}:`)))
  assert.ok(
    lines.some((line) => line.includes('grace') && line.includes(fresh)),
    `the declined replacement must be visible; got ${lines.join(' | ')}`,
  )
})

test('a missing verdict inside the grace window cannot multiply sessions', async () => {
  // Every probe answers missing, which is exactly the state the live machine was in: the record is
  // written by the first turn, so *whatever* this channel creates looks missing until then.
  const gateway = new ProbeGateway('missing')
  const store = memoryStore()
  const router = new SessionRouter({ gateway, store })

  const ids: string[] = []
  for (let index = 0; index < 5; index += 1) {
    const result = await router.route({ ...conversation, text: `第 ${String(index)} 条` })
    assert.equal(result.kind, 'prompt')
    if (result.kind !== 'prompt') return
    ids.push(result.decision.sessionId)
  }
  assert.equal(new Set(ids).size, 1, 'five messages, one conversation')
})

test('a burst of messages after an archived session is replaced creates one new session', async () => {
  const gateway = new ProbeGateway()
  const store = memoryStore()
  const router = new SessionRouter({ gateway, store })

  const first = await router.route({ ...conversation, text: '一' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return
  gateway.states.set(first.decision.sessionId, 'archived')

  const created: string[] = []
  for (const text of ['二', '三', '四']) {
    const result = await router.route({ ...conversation, text })
    assert.equal(result.kind, 'prompt')
    if (result.kind !== 'prompt') return
    created.push(result.decision.sessionId)
  }
  assert.equal(new Set(created).size, 1, 'the replacement is not replaced again')
  // Once per reuse, and never for the message that created the first binding: there was nothing to ask.
  assert.equal(gateway.probes.length, 3)
})

test('a probe that throws is treated as usable, so a broken probe cannot cost a message', async () => {
  const gateway = new ProbeGateway()
  gateway.failProbe = true
  const store = memoryStore()
  const lines: string[] = []
  const router = new SessionRouter({ gateway, store, onDiagnostic: (line) => lines.push(line) })

  const first = await router.route({ ...conversation, text: '一' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return

  const second = await router.route({ ...conversation, text: '二' })
  assert.equal(second.kind, 'prompt')
  if (second.kind !== 'prompt') return
  assert.equal(second.decision.sessionId, first.decision.sessionId, 'the working session is kept')
  assert.equal(second.decision.notice, undefined)
  assert.equal(store.peek()[conversation.conversationId]?.sessionId, first.decision.sessionId)
  assert.ok(
    lines.some((line) => line.includes('probe failed') && line.includes(first.decision.sessionId)),
    `a failed probe must be written down; got ${lines.join(' | ')}`,
  )
})

test('a gateway with no probe behaves exactly as it did before', async () => {
  // A gateway that cannot answer must not be punished for it: no rebinding, no notice, and not even a
  // diagnostic line, because nothing was asked.
  const gateway = new FakeGateway()
  const store = memoryStore()
  const lines: string[] = []
  const router = new SessionRouter({ gateway, store, onDiagnostic: (line) => lines.push(line) })

  const first = await router.route({ ...conversation, text: '一' })
  const second = await router.route({ ...conversation, text: '二' })
  assert.equal(first.kind, 'prompt')
  assert.equal(second.kind, 'prompt')
  if (first.kind !== 'prompt' || second.kind !== 'prompt') return
  assert.equal(second.decision.sessionId, first.decision.sessionId)
  assert.equal(second.decision.created, false)
  assert.equal(second.decision.notice, undefined)
  assert.deepEqual(lines, [])
})

test('/new creates a distinct session', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const first = await router.route({ ...conversation, text: 'hello' })
  const created = await router.route({ ...conversation, text: '/new 重构任务' })
  const after = await router.route({ ...conversation, text: '继续' })

  assert.equal(created.kind, 'reply')
  if (created.kind === 'reply') assert.match(created.text, /重构任务/)
  assert.equal(first.kind, 'prompt')
  assert.equal(after.kind, 'prompt')
  if (first.kind !== 'prompt' || after.kind !== 'prompt') return
  assert.notEqual(first.decision.sessionId, after.decision.sessionId)
})

test('/list marks the current session and /switch moves between them', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const first = await router.route({ ...conversation, text: 'first session' })
  const created = await router.route({ ...conversation, text: '/new 第二个' })
  assert.equal(first.kind, 'prompt')
  assert.equal(created.kind, 'reply')
  if (first.kind !== 'prompt') return

  // The marker sits on the session we just created.
  const listed = await router.route({ ...conversation, text: '/list' })
  assert.equal(listed.kind, 'reply')
  if (listed.kind !== 'reply') return
  const markedLine = listed.text.split('\n').find((line) => line.includes('← 当前'))
  assert.ok(markedLine, 'expected a current-session marker')
  assert.match(markedLine, /第二个/)

  // Switch to the *first* session by its short id, which is unambiguous.
  const switched = await router.route({
    ...conversation,
    text: `/switch ${first.decision.sessionId}`,
  })
  assert.equal(switched.kind, 'reply')
  if (switched.kind === 'reply') assert.match(switched.text, /已切换/)

  const after = await router.route({ ...conversation, text: '/current' })
  if (after.kind !== 'reply') return
  assert.match(after.text, new RegExp(shortId(first.decision.sessionId)))
  assert.doesNotMatch(after.text, /第二个/)
})

/** The `1. …` rows of a rendered screen, in printed order. */
function screenRows(text: string): string[] {
  return text.split('\n').filter((line) => /^\d+\. /.test(line))
}

/**
 * Drive the router the way the host does, carrying the browsing position between messages.
 *
 * In production the position lives in the state file and the host reads and writes it; here it is a
 * local, because what is under test is the router's half of that arrangement — 「查看其余」 walking
 * whichever level the last reply left the conversation on.
 *
 * @param router - Router to drive.
 * @param target - Conversation to drive it for.
 */
function browsing(
  router: SessionRouter,
  target: { conversationId: string; accountId: string; peerId: string } = conversation,
) {
  let browse: BrowsePosition | undefined
  return {
    async say(text: string) {
      const result = await router.route({
        ...target,
        text,
        ...(browse === undefined ? {} : { browse }),
      })
      browse = result.kind === 'reply' ? result.browse : undefined
      return result
    },
    position: () => browse,
  }
}

test('/list opens this workspace, and /list all opens the workspace list', async () => {
  /*
   * The two commands answer at different levels now. `/list` is the listing people actually want, so
   * it opens this workspace's conversations directly; `/list all` opens the workspaces, which is the
   * only way to reach anything else. Before this, both printed one flat table and the whole-machine
   * one was indistinguishable from the local one on a machine whose own workspace is the busiest.
   */
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  await router.route({ ...conversation, text: 'one' })
  // A session belonging to another project, which the gateway reports separately.
  gateway.foreign.push({
    sessionId: 'session-ffff9999-ffff9999-x',
    title: '别处的工作',
    updatedAt: gateway.nextStamp(),
    workspace: 'C:\\Users\\me\\some_project',
  })

  const own = await router.route({ ...conversation, text: '/list' })
  assert.equal(own.kind, 'reply')
  if (own.kind !== 'reply') return
  // The heading says which level this is and how many screens it has.
  assert.match(own.text, /【微信会话】会话（1\/1）/)
  assert.doesNotMatch(own.text, /别处的工作/, 'the default list is this workspace only')
  assert.match(own.text, /另有 1 个对话在其它会话夹（some_project）/)
  // And how to reach them, or the hint is useless.
  assert.match(own.text, /\/list all/)
  // Every screen leaves a position behind, or 「查看其余」 has nothing to continue.
  assert.equal(own.browse?.level, 'sessions')
  assert.equal(own.browse?.page, 1)

  const all = await router.route({ ...conversation, text: '/list all' })
  assert.equal(all.kind, 'reply')
  if (all.kind !== 'reply') return
  // The workspace level lists folders with counts, not conversations: a session title here would mean
  // the level the user asked for is not the level they got.
  assert.match(all.text, /会话夹（1\/1）/)
  assert.match(all.text, /1\. 微信会话  1 个会话/)
  assert.match(all.text, /2\. some_project  1 个会话/)
  assert.doesNotMatch(all.text, /别处的工作/)
  assert.equal(all.browse?.level, 'folders')
  // Nothing is held back at this level, so nothing is counted out loud.
  assert.doesNotMatch(all.text, /另有/)
})

test('the workspace level pages ten at a time, and the numbering runs on', async () => {
  /*
   * The requirement this exists for: 「查看其余」 walks ten more, all the way to the end, and the
   * numbers do not start over. Restarting each screen at 1 would give one number two meanings inside
   * a single browse, which is exactly what the number is not allowed to do.
   */
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  await router.route({ ...conversation, text: 'one' })
  for (let index = 0; index < 11; index += 1) {
    gateway.foreign.push({
      sessionId: `session-${String(index).padStart(4, '0')}bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
      title: `别处 ${String(index)}`,
      updatedAt: gateway.nextStamp(),
      workspace: `C:\\Users\\me\\project${String(index)}`,
    })
  }

  const browser = browsing(router)
  const first = await browser.say('/list all')
  assert.equal(first.kind, 'reply')
  if (first.kind !== 'reply') return
  assert.match(first.text, /会话夹（1\/2）/)
  assert.equal(screenRows(first.text).length, BROWSE_PAGE_SIZE, 'a screen holds ten and no more')
  assert.match(screenRows(first.text)[0] ?? '', /^1\. 微信会话/)
  assert.match(screenRows(first.text)[BROWSE_PAGE_SIZE - 1] ?? '', /^10\. /)
  assert.match(first.text, /回复「查看其余」看下十个/)

  const second = await browser.say(SHOW_REST)
  assert.equal(second.kind, 'reply')
  if (second.kind !== 'reply') return
  assert.match(second.text, /会话夹（2\/2）/)
  assert.equal(screenRows(second.text).length, 2)
  assert.match(screenRows(second.text)[0] ?? '', /^11\. /, 'the numbering runs on')
  assert.match(screenRows(second.text)[1] ?? '', /^12\. /)
  // The last screen does not invite a step that does not exist: teaching the user a command that
  // answers "已经到底了" is worse than not mentioning it.
  assert.doesNotMatch(second.text, /查看其余/)

  const bottom = await browser.say(SHOW_REST)
  assert.equal(bottom.kind, 'reply')
  if (bottom.kind !== 'reply') return
  assert.match(bottom.text, /只有 2 页，已经到底了/)
  assert.equal(browser.position()?.page, 2, 'a step that goes nowhere must not move the position')
})

test('entering a workspace works by number and by name, and does not move the binding', async () => {
  /*
   * Entering is browsing, not switching. The user picked a folder to look inside; the conversation
   * they are talking to has not changed, and moving work on the strength of a menu selection is the
   * kind of inference this channel does not make.
   */
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const home = await router.route({ ...conversation, text: '第一条' })
  assert.equal(home.kind, 'prompt')
  if (home.kind !== 'prompt') return
  gateway.foreign.push(
    {
      sessionId: 'session-eeee8888-eeee8888-x',
      title: '另一个项目',
      updatedAt: gateway.nextStamp(),
      workspace: 'C:\\Users\\me\\dsh_orb',
    },
    {
      sessionId: 'session-ffff9999-ffff9999-x',
      title: '别处的工作',
      updatedAt: gateway.nextStamp(),
      workspace: 'C:\\Users\\me\\some_project',
    },
  )

  const browser = browsing(router)
  await browser.say('/list all')

  const byNumber = await browser.say('2')
  assert.equal(byNumber.kind, 'reply')
  if (byNumber.kind !== 'reply') return
  assert.match(byNumber.text, /【some_project】会话（1\/1）/)
  assert.match(byNumber.text, /1\. 别处的工作/)
  assert.equal(byNumber.browse?.level, 'sessions')
  assert.equal(byNumber.browse?.workspace, 'C:\\Users\\me\\some_project')
  assert.equal(
    (await router.current(conversation.conversationId))?.sessionId,
    home.decision.sessionId,
    'entering a folder is not a switch',
  )

  // The name printed in the list is also accepted, because that is what a person remembers.
  await browser.say('/list all')
  const byName = await browser.say('some_project')
  assert.equal(byName.kind, 'reply')
  if (byName.kind !== 'reply') return
  assert.match(byName.text, /【some_project】会话（1\/1）/)

  // A remark that names nothing is not swallowed by the browser: it belongs to the agent.
  await browser.say('/list all')
  const unmatched = await browser.say('帮我看看这个 bug')
  assert.equal(unmatched.kind, 'prompt')
})

test('a folder number this machine does not have is answered, and the walk continues', async () => {
  /*
   * A number in the folder list is a position, not a name. This used to fall through to the labels,
   * so a workspace whose directory is called `9` answered "9" even when there was no ninth folder —
   * the same shape of guess that cost three flaky tests one level down (`resolveTarget`). The
   * fixture makes the difference deterministic: without the rule, this test switches folders instead
   * of saying so.
   */
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  await router.route({ ...conversation, text: '第一条' })
  gateway.foreign.push(
    {
      sessionId: 'session-9999aaaa-9999aaaa-x',
      title: '九号项目的活',
      updatedAt: gateway.nextStamp(),
      workspace: 'C:\\Users\\me\\9',
    },
    {
      sessionId: 'session-ffff9999-ffff9999-x',
      title: '别处的工作',
      updatedAt: gateway.nextStamp(),
      workspace: 'C:\\Users\\me\\some_project',
    },
  )

  const browser = browsing(router)
  const folders = await browser.say('/list all')
  assert.equal(folders.kind, 'reply')
  if (folders.kind !== 'reply') return
  assert.equal(screenRows(folders.text).length, 3, `three workspaces:\n${folders.text}`)

  const refused = await browser.say('9')
  assert.equal(refused.kind, 'reply')
  if (refused.kind !== 'reply') return
  assert.match(refused.text, /找不到编号 9：会话夹只有 3 个（1–3）/)
  // Still standing in the folder list, so the next number is read at that level — a refusal is not
  // the end of the walk.
  assert.equal(refused.browse?.level, 'folders')
  const entered = await browser.say('2')
  assert.equal(entered.kind, 'reply')
  if (entered.kind !== 'reply') return
  assert.match(entered.text, /【some_project】会话（1\/1）/, 'row 2 is a real folder and still opens')
})

test('a conversation number the screen never printed is answered, and the walk continues', async () => {
  /*
   * The same rule at the conversation level, and the hostile part matters: another conversation in
   * this workspace has a short id beginning with the number used below. The old resolver answered "5"
   * with that session — the third incident's shape (`/switch 14` finding `14c71a`) — so this test
   * fails on every run without the fix, instead of once in 256.
   */
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const home = await router.route({ ...conversation, text: '第一条' })
  assert.equal(home.kind, 'prompt')
  if (home.kind !== 'prompt') return
  gateway.sessions.push({
    sessionId: 'session-5aaa0000-5aaa0000-4aaa-8aaa-aaaaaaaaaaaa',
    title: '另一件事',
    updatedAt: gateway.nextStamp(),
  })

  const browser = browsing(router)
  const listed = await browser.say('/list')
  assert.equal(listed.kind, 'reply')
  if (listed.kind !== 'reply') return
  assert.equal(screenRows(listed.text).length, 2)

  const refused = await browser.say('5')
  assert.equal(refused.kind, 'reply')
  if (refused.kind !== 'reply') return
  assert.match(refused.text, /找不到编号 5：这一屏只有 2 项（1–2）/)
  assert.equal(refused.browse?.level, 'sessions')
  assert.equal(
    (await router.current(conversation.conversationId))?.sessionId,
    home.decision.sessionId,
    'and nothing moved',
  )
  // The position survived the refusal: the next 「查看其余」 answers as a continuing walk would.
  const rest = await browser.say(SHOW_REST)
  assert.equal(rest.kind, 'reply')
  if (rest.kind !== 'reply') return
  assert.match(rest.text, /只有 1 页，已经到底了/)
})

test('two workspaces with the same folder name are not guessed between', async () => {
  /*
   * Two projects can both end in `workplace`, and the name printed is the last path component — so a
   * name alone cannot say which was meant. Entering the wrong project's folder is worse than a
   * question, and the answer names the numbers, which are never ambiguous.
   */
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  await router.route({ ...conversation, text: '第一条' })
  gateway.foreign.push(
    {
      sessionId: 'session-ffff9999-ffff9999-x',
      title: '甲项目的工作',
      updatedAt: gateway.nextStamp(),
      workspace: 'C:\\Users\\me\\alpha\\workplace',
    },
    {
      sessionId: 'session-eeee8888-eeee8888-x',
      title: '乙项目的工作',
      updatedAt: gateway.nextStamp(),
      workspace: 'C:\\Users\\me\\beta\\workplace',
    },
  )

  const browser = browsing(router)
  await browser.say('/list all')
  const clash = await browser.say('workplace')
  assert.equal(clash.kind, 'reply')
  if (clash.kind !== 'reply') return
  assert.match(clash.text, /有多个会话夹匹配「workplace」/)
  // Both candidates, each with the number that identifies it.
  assert.match(clash.text, /2\. C:\\Users\\me\\(alpha|beta)\\workplace/)
  assert.match(clash.text, /3\. C:\\Users\\me\\(alpha|beta)\\workplace/)

  // The number works, and it is what the message told them to reply with. Folder 2 is the more
  // recently active of the two, so it is beta — the listing's own order, not the order they were
  // pushed in.
  const entered = await browser.say('2')
  assert.equal(entered.kind, 'reply')
  if (entered.kind !== 'reply') return
  assert.match(entered.text, /【workplace】会话（1\/1）/)
  assert.match(entered.text, /乙项目的工作/)
  assert.ok(entered.browse?.workspace.endsWith('beta\\workplace'))
})

test('the conversation level pages ten at a time, and a number names the row it printed', async () => {
  /*
   * The second level, with the same two rules: one screen of ten, and numbering that runs on. The
   * last screen is short, and the number on it is the one that has to name its row.
   */
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  for (let index = 0; index < 25; index += 1) {
    gateway.sessions.push({
      sessionId: `session-${String(index).padStart(4, '0')}cccc-cccc-4ccc-8ccc-cccccccccccc`,
      title: `会话 ${String(index)}`,
      updatedAt: gateway.nextStamp(),
    })
  }

  const browser = browsing(router)
  const first = await browser.say('/list')
  assert.equal(first.kind, 'reply')
  if (first.kind !== 'reply') return
  assert.match(first.text, /【微信会话】会话（1\/3）/)
  assert.equal(screenRows(first.text).length, BROWSE_PAGE_SIZE)
  assert.match(screenRows(first.text)[0] ?? '', /^1\. 会话 24/)

  const second = await browser.say(SHOW_REST)
  assert.equal(second.kind, 'reply')
  if (second.kind !== 'reply') return
  assert.match(second.text, /【微信会话】会话（2\/3）/)
  assert.match(screenRows(second.text)[0] ?? '', /^11\. /)
  assert.match(screenRows(second.text)[9] ?? '', /^20\. /)

  const third = await browser.say(SHOW_REST)
  assert.equal(third.kind, 'reply')
  if (third.kind !== 'reply') return
  assert.match(third.text, /【微信会话】会话（3\/3）/)
  assert.equal(screenRows(third.text).length, 5)
  assert.match(screenRows(third.text)[0] ?? '', /^21\. /)
  assert.match(screenRows(third.text)[4] ?? '', /^25\. /)
  assert.doesNotMatch(third.text, /查看其余/)

  const bottom = await browser.say(SHOW_REST)
  assert.equal(bottom.kind, 'reply')
  if (bottom.kind !== 'reply') return
  assert.match(bottom.text, /只有 3 页，已经到底了/)

  // Row 25 is the oldest conversation, which only the third screen ever printed.
  const picked = await browser.say('25')
  assert.equal(picked.kind, 'reply')
  if (picked.kind !== 'reply') return
  assert.match(picked.text, /已切换到「会话 0」/)
  assert.equal(
    (await router.current(conversation.conversationId))?.sessionId,
    gateway.sessions[0]?.sessionId,
  )
  // A switch ends the browse: the position is dropped rather than continued.
  assert.equal(picked.browse, undefined)
  assert.equal(browser.position(), undefined)
})

test('a number on a later screen is read with that screen’s offset', () => {
  /*
   * Numbering runs on across screens, so a screen printing 11..20 has to be resolved with `first`.
   * Without it, "13" would be answered from row 3 of that screen — a conversation it never printed —
   * which is the drift the pinned numbering exists to prevent, reintroduced by paging.
   */
  const titles = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
  const rows: NumberedRows = {
    sessions: titles.map((title, index) => ({
      sessionId: `session-aaaa${String(index).padStart(4, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      title: `会话 ${title}`,
    })),
    first: 11,
  }
  /*
   * The two extra conversations are this test's teeth.
   *
   * Their short ids begin with the very numbers the assertions below say were never printed, and
   * their titles repeat those digits. The resolver used to fall through to "an id that starts with
   * those digits" when no row carried the number, so with a machine like this it answered "3" and
   * "25" with a conversation the screen never showed — which is exactly the failure that used to
   * arrive by chance, once in 256 runs, whenever a random id happened to begin with the number a
   * test had written. Here it would be deterministic, so a regression cannot pass quietly.
   */
  const machine = [
    ...rows.sessions,
    { sessionId: 'session-3aaa0000-3aaa0000-4aaa-8aaa-aaaaaaaaaaaa', title: '会话 三号 3' },
    { sessionId: 'session-25bb0000-25bb0000-4aaa-8aaa-aaaaaaaaaaaa', title: '会话 二五 25' },
  ]

  assert.equal(found(resolveTarget('13', machine, rows))?.title, '会话 丙')
  assert.equal(found(resolveTarget('11', machine, rows))?.title, '会话 甲')
  assert.equal(found(resolveTarget('20', machine, rows))?.title, '会话 癸')
  // A number from a screen the user has scrolled past is not folded onto row 1: guessing which row
  // they meant is the one thing a pinned numbering must never do. Nor is it read as an id.
  const below = resolveTarget('3', machine, rows)
  assert.equal(below.kind, 'unprinted')
  if (below.kind === 'unprinted') {
    assert.deepEqual(
      { number: below.number, first: below.first, last: below.last },
      { number: 3, first: 11, last: 20 },
    )
  }
  // And a number past the screen's last row is refused for the same reason, even though an id and a
  // title both begin with it.
  const above = resolveTarget('25', machine, rows)
  assert.equal(above.kind, 'unprinted')
  if (above.kind !== 'unprinted') return
  const message = unprintedTargetMessage(above.number, above.first, above.last)
  assert.match(message, /找不到编号 25/, 'the answer names the number that matched nothing')
  assert.match(message, /这一屏只有 10 项（11–20）/, 'and the range it could have named')
  assert.match(message, /行尾那 6 位/, 'and how to be unambiguous instead')
})

test('the same screen is byte-identical however the store hands the rows over', () => {
  /*
   * The regression this exists for: the listing printed a different order on every run, and a
   * different "上次时间" beside the same conversation. The order came from the directory walk and the
   * time from a file's mtime, so neither was a property of the data — and with several sessions
   * sharing a timestamp (imports, bulk runs) there was no tie-break to save it.
   *
   * Both levels are rendered here, because both are built out of the same ordering and both are what
   * the user reads.
   */
  const stamp = 1_700_000_000_000
  const rows: ListedSession[] = [
    { sessionId: 'session-aaaa1111-aaaa1111-x', title: '甲', updatedAt: stamp },
    { sessionId: 'session-bbbb2222-bbbb2222-x', title: '乙', updatedAt: stamp },
    { sessionId: 'session-cccc3333-cccc3333-x', title: '丙', updatedAt: stamp },
    { sessionId: 'session-dddd4444-dddd4444-x', title: '丁', updatedAt: stamp - 1 },
  ]
  const renderOne = (input: readonly ListedSession[]): string =>
    renderSessionScreen([...input].sort(compareRowsNewestFirst), {
      label: '微信会话',
      page: 1,
      now: stamp + 60_000,
    }).text
  const renderFolders = (input: readonly ListedSession[]): string =>
    renderFolderScreen(
      sessionFolders(folderRows(input), { ownWorkspace: 'C:\\Users\\me\\dsh_wechat', ownLabel: '微信会话' }),
      1,
    )
  const folderRows = (input: readonly ListedSession[]): ListedSession[] =>
    input.map((row, index) => ({ ...row, workspace: `C:\\Users\\me\\p${String(index % 2)}` }))

  assert.equal(renderOne(rows), renderOne([...rows].reverse()), 'input order must not reach the output')
  assert.equal(renderFolders(rows), renderFolders([...rows].reverse()))

  // The tie is broken on the id, ascending, so the equal-timestamp rows come out in a fixed order —
  // and the older one still follows them, because time is still the first key.
  const order = screenRows(renderOne(rows)).map((line) => /^\d+\. (\S+)/.exec(line)?.[1])
  assert.deepEqual(order, ['甲', '乙', '丙', '丁'])
})

/** Order rows the way every listing does, so these tests exercise the same comparator. */
function compareRowsNewestFirst(a: { sessionId: string; updatedAt: number }, b: { sessionId: string; updatedAt: number }): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  if (a.sessionId === b.sessionId) return 0
  return a.sessionId < b.sessionId ? -1 : 1
}

test('the workspace list counts each folder, and leads with this workspace', () => {
  const rows: ListedSession[] = [
    { sessionId: 'session-aaaa1111-aaaa1111-x', title: '甲', updatedAt: 1_000 },
    { sessionId: 'session-bbbb2222-bbbb2222-x', title: '乙', updatedAt: 2_000 },
    { sessionId: 'session-cccc3333-cccc3333-x', title: '丙', updatedAt: 5_000, workspace: 'C:\\me\\alpha' },
    { sessionId: 'session-dddd4444-dddd4444-x', title: '丁', updatedAt: 4_000, workspace: 'C:\\me\\alpha' },
    { sessionId: 'session-eeee5555-eeee5555-x', title: '戊', updatedAt: 9_000, workspace: 'C:\\me\\beta' },
  ]
  const folders = sessionFolders(rows, {
    ownWorkspace: 'C:\\Users\\me\\dsh_wechat',
    ownLabel: '微信会话',
  })
  assert.deepEqual(
    folders.map((folder) => [folder.label, folder.count]),
    [
      ['微信会话', 2],
      ['beta', 1],
      ['alpha', 2],
    ],
    'this workspace first, then the others by their most recent conversation',
  )
})

test('resolveFolder accepts a number and a name, and refuses to choose between two', () => {
  const folders: SessionFolder[] = [
    { path: '', label: '微信会话', count: 3 },
    { path: 'C:\\me\\alpha\\workplace', label: 'workplace', count: 1 },
    { path: 'C:\\me\\beta\\workplace', label: 'workplace', count: 2 },
    { path: 'C:\\me\\dsh_orb', label: 'dsh_orb', count: 7 },
  ]

  // The number is the one the listing printed, which runs on across screens.
  const byNumber = resolveFolder('3', folders)
  assert.equal(byNumber.kind, 'found')
  if (byNumber.kind !== 'found') return
  assert.equal(byNumber.folder.path, 'C:\\me\\beta\\workplace')
  /*
   * A number past the last workspace says how many there are instead of being read as a name. The
   * extra folder below is named `9`, which is exactly the guess this used to make: it has a number of
   * its own (5), and "9" is a position first.
   */
  const named9: SessionFolder[] = [...folders, { path: 'C:\\me\\9', label: '9', count: 1 }]
  const missing = resolveFolder('9', folders)
  assert.equal(missing.kind, 'unprinted')
  if (missing.kind === 'unprinted') {
    assert.deepEqual({ number: missing.number, count: missing.count }, { number: 9, count: 4 })
    assert.match(unprintedFolderMessage(missing.number, missing.count), /会话夹只有 4 个（1–4）/)
  }
  assert.equal(resolveFolder('9', named9).kind, 'unprinted', 'a folder named 9 does not answer "9"')
  const fifth = resolveFolder('5', named9)
  assert.equal(fifth.kind, 'found')
  if (fifth.kind === 'found') assert.equal(fifth.folder.path, 'C:\\me\\9', 'the number reaches it')
  // A name that names one folder is enough, in either direction of slop.
  assert.equal(resolveFolder('dsh_orb', folders).kind, 'found')
  assert.equal(resolveFolder('dsh', folders).kind, 'found')
  // Two directories share the printed name, so the name cannot decide.
  const clash = resolveFolder('workplace', folders)
  assert.equal(clash.kind, 'ambiguous')
  if (clash.kind !== 'ambiguous') return
  assert.equal(clash.candidates.length, 2)
  // And the message it produces points at the numbers, which are never ambiguous.
  const message = ambiguousFolderMessage('workplace', clash.candidates, folders)
  assert.match(message, /2\. C:\\me\\alpha\\workplace  1 个会话/)
  assert.match(message, /3\. C:\\me\\beta\\workplace  2 个会话/)
})

test('the phrase that pages on tolerates a full stop and nothing else', () => {
  assert.equal(isShowRest('查看其余'), true)
  assert.equal(isShowRest(' 查看其余。 '), true)
  assert.equal(isShowRest('查看其余！'), true)
  // A near miss must not be guessed at: the phrase carries no target, so a wrong reading moves the
  // user somewhere they did not ask to go.
  assert.equal(isShowRest('看看其余'), false)
  assert.equal(isShowRest('查看其余 2'), false)
  assert.equal(isShowRest(''), false)
})

test('browsePage clamps a page that no longer exists instead of printing nothing', () => {
  const rows = [1, 2, 3]
  assert.deepEqual(browsePage(rows, 1), { items: [1, 2, 3], page: 1, pages: 1, start: 0 })
  assert.deepEqual(browsePage(rows, 4), { items: [1, 2, 3], page: 1, pages: 1, start: 0 })
  const many = Array.from({ length: 25 }, (_, index) => index)
  assert.equal(browsePage(many, 3).items.length, 5)
  assert.equal(browsePage(many, 3).pages, 3)
})

test('relative times read the way a person says them', () => {
  const now = 1_800_000_000_000
  assert.equal(relativeTime(now - 10_000, now), '刚刚')
  assert.equal(relativeTime(now - 3 * 60_000, now), '3 分钟前')
  assert.equal(relativeTime(now - 2 * 3_600_000, now), '2 小时前')
  assert.equal(relativeTime(now - 25 * 3_600_000, now), '昨天')
  assert.equal(relativeTime(now - 3 * 24 * 3_600_000, now), '3 天前')
  // A week on, a date is more use than a count nobody converts in their head.
  assert.doesNotMatch(relativeTime(now - 30 * 24 * 3_600_000, now), /前/)
})

test('a pinned listing decides what a number means', async () => {
  /*
   * Why this matters: a number identifies a row of a *listing*, and a listing is a photograph of a
   * machine that keeps moving. Answering "2" from whatever is newest at that moment means the user
   * can point at one conversation and land in another — which is the failure the quote-pinned
   * numbering exists to remove.
   *
   * The same argument is deliberately read twice below, against two different listings, and it has to
   * mean two different conversations.
   */
  const gateway = new FakeGateway()
  const store = memoryStore()
  const router = new SessionRouter({ gateway, store })

  const first = await router.route({ ...conversation, text: '第一条' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return
  await router.route({ ...conversation, text: '/new 第二个' })
  const newest = store.peek()[conversation.conversationId]?.sessionId
  assert.ok(newest && newest !== first.decision.sessionId)

  // What the user was shown: the older conversation on row 1, the newer one on row 2.
  const pinned: NumberedRows = {
    sessions: [
      { sessionId: first.decision.sessionId, title: '第一条' },
      { sessionId: newest, title: '第二个' },
    ],
    first: 1,
  }

  const toFirst = await router.route({ ...conversation, text: '/switch 1', numbered: pinned })
  assert.equal(toFirst.kind, 'reply')
  if (toFirst.kind === 'reply') assert.match(toFirst.text, /已切换到「第一条」/)
  assert.equal(store.peek()[conversation.conversationId]?.sessionId, first.decision.sessionId)

  const toSecond = await router.route({ ...conversation, text: '/switch 2', numbered: pinned })
  assert.equal(toSecond.kind, 'reply')
  if (toSecond.kind === 'reply') assert.match(toSecond.text, /已切换到「第二个」/)
  assert.equal(store.peek()[conversation.conversationId]?.sessionId, newest)

  // The live list is ordered the other way round, so the same "2" without a pin names the *other*
  // conversation. Both behaviours are wanted: a pin is what makes the number mean what the user saw.
  await router.route({ ...conversation, text: '/switch 2' })
  assert.equal(
    store.peek()[conversation.conversationId]?.sessionId,
    first.decision.sessionId,
    'unpinned numbers still come from the live list',
  )
})

test('a numbered listing survives a save and a reload', async () => {
  /*
   * The field this covers is a new one in `state.json`, and the store's reader is an allowlist: a
   * field added to `ChannelState` and forgotten in `normalize` saves perfectly and is gone after the
   * next restart. That has happened here before, with settings, so the round trip is asserted rather
   * than assumed.
   *
   * The extra `update(() => {})` is the part that matters: every write re-reads and re-normalizes,
   * so a field the normalizer drops disappears on the *next* write and takes one more restart to
   * notice.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  try {
    const file = join(home, 'state.json')
    const store = new StateStore(file)
    await store.update((state) => {
      rememberSessionList(state, 'acct', 'acct:peer', {
        messageId: 'msg-1',
        sessions: [{ sessionId: 'session-aaaa1111-aaaa1111-x', title: '甲' }],
        first: 1,
        at: 1_700_000_000_000,
      })
      rememberSessionList(state, 'acct', 'acct:peer', {
        messageId: 'msg-2',
        sessions: [
          { sessionId: 'session-aaaa1111-aaaa1111-x', title: '甲' },
          { sessionId: 'session-bbbb2222-bbbb2222-x', title: '乙' },
        ],
        // A second screen of ten: the numbers it printed start at 11, and the offset has to survive
        // the reload or a quoted "13" would be read as row 3 of that screen.
        first: 11,
        at: 1_700_000_001_000,
      })
    })
    await store.update(() => {})

    const reloaded = await new StateStore(file).read()
    assert.deepEqual(findSessionList(reloaded, 'acct', 'msg-2')?.sessions, [
      { sessionId: 'session-aaaa1111-aaaa1111-x', title: '甲' },
      { sessionId: 'session-bbbb2222-bbbb2222-x', title: '乙' },
    ])
    assert.equal(findSessionList(reloaded, 'acct', 'msg-2')?.first, 11)
    // The older one is still there, keyed by its own message id.
    assert.equal(findSessionList(reloaded, 'acct', 'msg-1')?.sessions.length, 1)
    assert.equal(findSessionList(reloaded, 'acct', 'msg-1')?.first, 1)
    // And the conversation's newest listing is the one a bare number answers from.
    assert.equal(latestSessionList(reloaded, 'acct', 'acct:peer')?.messageId, 'msg-2')
    // Another account sees nothing, so a shared machine cannot resolve across bots.
    assert.equal(findSessionList(reloaded, 'other', 'msg-2'), undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('where a conversation is in the listing browser survives a save and a reload', async () => {
  /*
   * The field this covers is the one 「查看其余」 depends on, and the store's reader is an allowlist: a
   * field added to `ChannelState` and forgotten in `normalize` saves perfectly and is gone after the
   * next restart — which here would mean the phrase answers with nothing, or pages from a number
   * nobody chose. The extra `update(() => {})` is the part that matters: every write re-reads and
   * re-normalizes, so a dropped field disappears on the *next* write rather than the next restart.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  try {
    const file = join(home, 'state.json')
    const store = new StateStore(file)
    await store.update((state) => {
      rememberBrowse(state, 'acct', 'acct:peer', {
        level: 'sessions',
        workspace: 'C:\\Users\\me\\some_project',
        page: 2,
        at: 1_700_000_000_000,
      })
      rememberBrowse(state, 'acct', 'acct:other', {
        level: 'folders',
        workspace: '',
        page: 1,
        at: 1_700_000_000_500,
      })
    })
    await store.update(() => {})

    const reloaded = await new StateStore(file).read()
    assert.deepEqual(findBrowse(reloaded, 'acct', 'acct:peer'), {
      level: 'sessions',
      workspace: 'C:\\Users\\me\\some_project',
      page: 2,
      at: 1_700_000_000_000,
    })
    assert.deepEqual(findBrowse(reloaded, 'acct', 'acct:other'), {
      level: 'folders',
      workspace: '',
      page: 1,
      at: 1_700_000_000_500,
    })
    // Another account sees nothing: one plugin serves several chats, and neither place is the other's.
    assert.equal(findBrowse(reloaded, 'other', 'acct:peer'), undefined)

    // Forgetting one leaves the other alone, and forgetting the last one takes the account with it —
    // otherwise the file keeps a row per conversation that ever asked for a listing.
    await store.update((state) => {
      forgetBrowse(state, 'acct', 'acct:peer')
    })
    const after = await new StateStore(file).read()
    assert.equal(findBrowse(after, 'acct', 'acct:peer'), undefined)
    assert.ok(findBrowse(after, 'acct', 'acct:other'))
    await store.update((state) => {
      forgetBrowse(state, 'acct', 'acct:other')
    })
    assert.equal((await new StateStore(file).read()).browsing?.acct, undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a browsing position that cannot be continued is dropped', async () => {
  /*
   * Read back and acted on: a page that arrived as a string would make the next page's arithmetic
   * produce NaN, and a level that is neither of the two known ones would send the router down a branch
   * that does not exist. Dropping costs one `/list all`; continuing it wrongly pages from a number
   * nobody chose.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  try {
    const file = join(home, 'state.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        browsing: {
          acct: {
            'acct:peer': { level: 'sessions', workspace: 'C:\\me\\x', page: 2, at: 1 },
            'acct:bad-level': { level: 'chapters', workspace: '', page: 1, at: 1 },
            'acct:bad-page': { level: 'folders', workspace: '', page: '2', at: 1 },
            'acct:zero-page': { level: 'folders', workspace: '', page: 0, at: 1 },
            'acct:no-workspace': { level: 'folders', page: 1, at: 1 },
            'acct:bad-time': { level: 'folders', workspace: '', page: 1, at: 'yesterday' },
            'acct:not-an-entry': 'nope',
          },
          'not-an-account': 7,
        },
      }),
      'utf8',
    )

    const state = await new StateStore(file).read()
    assert.ok(findBrowse(state, 'acct', 'acct:peer'), 'the good one stays')
    for (const conversation of [
      'acct:bad-level',
      'acct:bad-page',
      'acct:zero-page',
      'acct:no-workspace',
      'acct:bad-time',
      'acct:not-an-entry',
    ]) {
      assert.equal(findBrowse(state, 'acct', conversation), undefined, `${conversation} is unusable`)
    }
    assert.deepEqual(Object.keys(state.browsing ?? {}), ['acct'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a malformed numbered listing is dropped instead of resolving a number to nothing', async () => {
  /*
   * Read back and acted on: a row without a session id would reach the session controller as a
   * request to adopt `undefined`. Dropping the entry costs one stale number; guessing at what the
   * user was looking at costs a switch to the wrong conversation.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  try {
    const file = join(home, 'state.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        sessionLists: {
          acct: {
            'acct:peer': [
              { messageId: 'msg-1', at: 1, sessions: [{ sessionId: 'session-aaaa-x', title: '甲' }] },
              { messageId: '', at: 2, sessions: [{ sessionId: 'session-bbbb-x', title: '乙' }] },
              { messageId: 'msg-3', at: 3, sessions: [] },
              { messageId: 'msg-4', at: 4, sessions: [{ sessionId: 7, title: '丙' }] },
              { messageId: 'msg-5', at: 'soon', sessions: [{ sessionId: 'session-eeee-x', title: '戊' }] },
              {
                messageId: 'msg-6',
                at: 6,
                sessions: [{ sessionId: 'session-ffff-x', title: '己' }],
                // A page number that is not a positive whole number cannot be paged from: it would
                // make the offset arithmetic produce a fraction or NaN.
                first: 0,
              },
              'not an entry',
            ],
          },
          'not-an-account': 'nope',
        },
      }),
      'utf8',
    )

    const state = await new StateStore(file).read()
    assert.equal(findSessionList(state, 'acct', 'msg-1')?.sessions.length, 1, 'the good one stays')
    assert.equal(findSessionList(state, 'acct', 'msg-1')?.first, 1, 'a pre-paging entry is a first screen')
    assert.equal(findSessionList(state, 'acct', 'msg-3'), undefined, 'an empty numbering is unusable')
    assert.equal(findSessionList(state, 'acct', 'msg-4'), undefined, 'a non-string id is unusable')
    assert.equal(findSessionList(state, 'acct', 'msg-5'), undefined, 'a non-numeric time is unusable')
    assert.equal(findSessionList(state, 'acct', 'msg-6'), undefined, 'an impossible page is unusable')
    assert.equal(state.sessionLists?.acct?.['acct:peer']?.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a stored listing keeps its rows and trims a paragraph-long title', () => {
  // The state file is rewritten whole on every change, and a session is named from the user's first
  // sentence — so an untrimmed title would make every later write carry a paragraph times fifty.
  const state = emptyState()
  const paragraph = '请'.repeat(4_000)
  rememberSessionList(state, 'acct', 'acct:peer', {
    messageId: 'msg-1',
    sessions: [{ sessionId: 'session-aaaa1111-aaaa1111-x', title: paragraph }],
    first: 1,
    at: 1_700_000_000_000,
  })
  const stored = latestSessionList(state, 'acct', 'acct:peer')?.sessions[0]
  assert.equal(stored?.sessionId, 'session-aaaa1111-aaaa1111-x')
  assert.equal(stored?.title.length, SESSION_LIST_TITLE_LIMIT)
  assert.ok(paragraph.startsWith(stored?.title ?? ''), 'the head of the title, not a rewrite')
})

test('only the newest few listings are kept, so the state file cannot grow without bound', () => {
  const state = emptyState()
  for (let i = 0; i < SESSION_LIST_HISTORY + 4; i += 1) {
    rememberSessionList(state, 'acct', 'acct:peer', {
      messageId: `msg-${String(i)}`,
      sessions: [{ sessionId: `session-${String(i)}-x`, title: `第 ${String(i)} 个` }],
      first: 1,
      at: 1_700_000_000_000 + i,
    })
  }
  const kept = state.sessionLists?.acct?.['acct:peer'] ?? []
  assert.equal(kept.length, SESSION_LIST_HISTORY)
  // The newest survive, which is what matters: only a recent list is ever quoted.
  assert.equal(latestSessionList(state, 'acct', 'acct:peer')?.messageId, `msg-${String(SESSION_LIST_HISTORY + 3)}`)
  assert.equal(findSessionList(state, 'acct', 'msg-0'), undefined, 'the oldest is gone')
})

test('a binding moves on, and switching back points at that session again', async () => {
  /*
   * This replaced a test of the session-owner map, which was removed.
   *
   * The map existed to answer "which conversation does this session belong to?" for sessions a
   * conversation had left, because `bindings` only records where it is now. That turned out to be
   * unnecessary — and actively harmful: a session the conversation had moved away from stayed an
   * owner forever, and ownership was being read as permission to send messages. A conversation that
   * switched away left its former session able to speak for it indefinitely.
   *
   * What actually has to hold is the pair below: the binding moves, and switching back restores it.
   */
  const gateway = new FakeGateway()
  const store = memoryStore()
  const router = new SessionRouter({ gateway, store })

  const first = await router.route({ ...conversation, text: 'one' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return
  await router.route({ ...conversation, text: '/new 修复登录' })

  // The binding moved: the old session is no longer the one this conversation points at.
  assert.equal(
    Object.values(store.peek()).some((entry) => entry.sessionId === first.decision.sessionId),
    false,
    'the binding really did move on',
  )

  // And switching back by short id restores it, so tools called from it resolve again — which is the
  // case the owner map was built for, now handled by the binding itself.
  const back = await router.route({ ...conversation, text: `/switch ${shortId(first.decision.sessionId)}` })
  assert.equal(back.kind, 'reply')
  if (back.kind !== 'reply') return
  assert.match(back.text, /已切换/)
  assert.equal(
    Object.values(store.peek())[0]?.sessionId,
    first.decision.sessionId,
    'switching back makes it the bound session again',
  )
})

test('routing state survives a new router instance', async () => {
  const gateway = new FakeGateway()
  const store = memoryStore()
  const router = new SessionRouter({ gateway, store })
  const first = await router.route({ ...conversation, text: 'one' })

  const reborn = new SessionRouter({ gateway, store })
  const second = await reborn.route({ ...conversation, text: 'two' })

  assert.equal(first.kind, 'prompt')
  assert.equal(second.kind, 'prompt')
  if (first.kind !== 'prompt' || second.kind !== 'prompt') return
  assert.equal(first.decision.sessionId, second.decision.sessionId)
})

test('/cancel and /current are answered locally', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  // With no binding yet, both commands answer with guidance instead of calling out.
  const noSession = await router.route({ ...conversation, text: '/cancel' })
  assert.equal(noSession.kind, 'reply')
  if (noSession.kind === 'reply') assert.match(noSession.text, /没有对话/)
  assert.equal(gateway.calls.length, 0)

  const bound = await router.route({ ...conversation, text: 'work' })
  assert.equal(bound.kind, 'prompt')

  const current = await router.route({ ...conversation, text: '/current' })
  assert.equal(current.kind, 'reply')
  if (current.kind === 'reply') assert.match(current.text, /当前对话/)

  const cancelled = await router.route({ ...conversation, text: '/cancel' })
  assert.equal(cancelled.kind, 'reply')
  if (cancelled.kind === 'reply') assert.match(cancelled.text, /已请求中断/)
  assert.ok(gateway.calls.some((call) => call.startsWith('cancel:')))
})

test('an unknown command explains itself instead of reaching the agent', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const result = await router.route({ ...conversation, text: '/nope' })
  assert.equal(result.kind, 'reply')
  if (result.kind === 'reply') assert.match(result.text, /未知指令/)
  assert.equal(gateway.prompts.length, 0)
})

test('/help returns the command list and never prompts', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const result = await router.route({ ...conversation, text: '/help' })
  assert.equal(result.kind, 'reply')
  if (result.kind === 'reply') assert.equal(result.text, HELP_TEXT)
  assert.equal(gateway.prompts.length, 0)
})

// ---------------------------------------------------------------------------
// State store
// ---------------------------------------------------------------------------

test('a store seeds from an existing file without losing its contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  try {
    const file = join(dir, 'state.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        accounts: { 'bot@im.bot': { accountId: 'bot@im.bot', token: 't', baseUrl: 'u' } },
        syncBufs: { 'bot@im.bot': 'cursor' },
        contextTokens: { 'bot@im.bot': { conv: 'ctx' } },
        bindings: {},
        autoStart: true,
      }),
      'utf8',
    )

    const store = new StateStore(file)
    // Concurrent reads must all observe the file, not a fallback empty state. A
    // non-idempotent load would cache the empty state and drop the account.
    const [first, second, third] = await Promise.all([store.read(), store.read(), store.read()])
    for (const state of [first, second, third]) {
      assert.ok(state.accounts['bot@im.bot'], 'seeded account must survive concurrent reads')
      assert.equal(state.syncBufs['bot@im.bot'], 'cursor')
      assert.equal(state.autoStart, true)
    }

    // A write issued while the load was in flight must build on the file, not on
    // an empty state.
    const store2 = new StateStore(file)
    const read = store2.read()
    const update = store2.update((state) => {
      state.autoStart = false
    })
    await Promise.all([read, update])
    const after = await store2.read()
    assert.ok(after.accounts['bot@im.bot'], 'concurrent write must not discard the account')
    assert.equal(after.autoStart, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('every setting survives a save and a reload', async () => {
  /*
   * The reload is the step that used to eat them. `StateStore.update` re-reads and re-normalizes
   * before persisting, and the normalizer kept a hand-copied list of seven settings — so anything
   * added after it was written (`permissionPreset`, `allowCrossSessionNotify`, `workspacePath`) was
   * dropped on the very next write and gone by the next restart.
   *
   * The count check below is the part that keeps this honest: a setting added to the defaults
   * without a line here would leave the test passing while covering less than it claims.
   */
  const wanted: ChannelSettings = {
    mergeWindowMs: 4_321,
    maxReplyChars: 1_234,
    settleMs: 987,
    quoteHistory: 7,
    autoReplyAttachments: false,
    requireConfirmation: false,
    permissionPreset: 'auto',
    allowCrossSessionNotify: false,
    workspacePath: 'C:\\chosen-workspace',
    presenceNote: 'round-trip note',
  }
  assert.equal(
    Object.keys(wanted).length,
    Object.keys(DEFAULT_SETTINGS).length,
    'this test names every setting in DEFAULT_SETTINGS',
  )

  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  try {
    const file = join(home, 'state.json')
    const store = new StateStore(file)
    await store.update((state) => {
      state.settings = wanted
    })
    // Forces the read-normalize-write cycle that dropped them.
    await store.update(() => {})
    const stored = (await new StateStore(file).read()).settings ?? {}
    assert.deepEqual(stored, wanted)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('splitCommand tolerates a missing separator, as typed on a phone', () => {
  assert.deepEqual(splitCommand('/list'), { command: '/list', args: '' })
  assert.deepEqual(splitCommand('/NEW  我的 任务 '), { command: '/new', args: '我的 任务' })
  // The common phone-keyboard case: the space never got typed. A numeric argument
  // is unambiguous, and CJK text is too.
  assert.deepEqual(splitCommand('/switch1'), { command: '/switch', args: '1' })
  assert.deepEqual(splitCommand('/new我的任务'), { command: '/new', args: '我的任务' })
  // A colon works in place of the space.
  assert.deepEqual(splitCommand('/switch:2'), { command: '/switch', args: '2' })
  // A command-looking prefix followed by an ASCII letter is a different word, not a
  // glued argument: otherwise `/news` would silently create a session. A short id
  // that starts with a letter therefore needs its separator.
  assert.deepEqual(splitCommand('/news'), { command: '/news', args: '' })
  assert.deepEqual(splitCommand('/switchabc123'), { command: '/switchabc123', args: '' })
  assert.deepEqual(splitCommand('/switch abc123'), { command: '/switch', args: 'abc123' })
})

test('a missing separator still switches the session', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const first = await router.route({ ...conversation, text: 'one' })
  await router.route({ ...conversation, text: '/new 第二个' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return

  /*
   * The position is read from the list rather than assumed to be 1.
   *
   * Both sessions used to be stamped in the same millisecond, so which one sorted first was a tie
   * the sort happened to break — and the test only ever passed because the tie broke the way it
   * needed. With the timestamps spaced, the newer session sorts first and the older one is second.
   */
  const listed = await router.route({ ...conversation, text: '/list' })
  if (listed.kind !== 'reply') return
  const position = listed.text
    .split('\n')
    .filter((line) => /^\d+\. /.test(line))
    .findIndex((line) => line.includes(shortId(first.decision.sessionId)))
  assert.ok(position >= 0, `the first session is missing from the list: ${listed.text}`)

  // Switch by list position with no space, the way it gets typed on a phone.
  const switched = await router.route({ ...conversation, text: `/switch${String(position + 1)}` })
  assert.equal(switched.kind, 'reply')
  if (switched.kind === 'reply') assert.match(switched.text, /已切换/)

  const current = await router.route({ ...conversation, text: '/current' })
  if (current.kind !== 'reply') return
  assert.match(current.text, new RegExp(shortId(first.decision.sessionId)))
})

/** One row as the gateway hands it over. Times are irrelevant to resolution, so they stay zero. */
function row(sessionId: string, title = '甲', workspace?: string): ListedSession {
  return { sessionId, title, updatedAt: 0, ...(workspace === undefined ? {} : { workspace }) }
}

/**
 * The session a resolution found, or undefined when it found none or several.
 *
 * @param resolution - What `resolveTarget` returned.
 */
function found(resolution: TargetResolution): NumberedSession | undefined {
  return resolution.kind === 'found' ? resolution.session : undefined
}

test('resolveTarget accepts an index, a full id, the short id, and a title', () => {
  // Realistically shaped ids, minted the same way the router mints them.
  const first = mintSessionId(() => 'aaaa1111-2222-3333-4444-555566667777')
  const second = mintSessionId(() => 'bbbb1111-2222-3333-4444-555566667777')
  const sessions = [row(first, '甲'), row(second, '乙')]
  assert.equal(found(resolveTarget('1', sessions))?.title, '甲')
  assert.equal(found(resolveTarget('2', sessions))?.title, '乙')
  assert.equal(found(resolveTarget(second, sessions))?.title, '乙')
  // The short id `/list` prints is exactly what `/switch` accepts.
  assert.equal(found(resolveTarget(shortId(second), sessions))?.title, '乙')
  assert.equal(found(resolveTarget('甲', sessions))?.title, '甲')
  assert.equal(resolveTarget('', sessions).kind, 'none')
  // A number with no row behind it says so; it is not rescued by an id or a title (next test).
  assert.equal(resolveTarget('9', sessions).kind, 'unprinted')
  // A suffix shared by several sessions is ambiguous and must not guess.
  assert.equal(resolveTarget('4444-555566667777', sessions).kind, 'ambiguous')
  assert.equal(resolveTarget('session-', sessions).kind, 'none')
})

test('a number that names no row is never read as an id or a title', () => {
  /*
   * The three incidents, as one fixture.
   *
   * `/switch 99` and `/switch 14` were written as "must fail" targets — and 99 and 14 are legal hex
   * prefixes. A short id is six random hex digits, so about one run in 256 a session's id began with
   * the digits the test had written, the switch the test required to fail *succeeded*, and the
   * failure read as a flake. The auto-generated title repeats those digits (`微信 14c71a`), so the
   * title reading could have rescued them even after the prefix reading had been patched — which is
   * why patching one entrance at a time never held.
   *
   * The rule now: a number is a row of the listing and nothing else. This machine is hostile by
   * construction — an id *and* a title carrying the digits, both reachable by every other reading.
   */
  const incident = 'session-14c71a00-14c71a00-4aaa-8aaa-aaaaaaaaaaaa'
  const machine = [
    row('session-aaaa0000-aaaa0000-4aaa-8aaa-aaaaaaaaaaaa', '微信 aaaa00'),
    row(incident, '微信 14c71a'),
    // A conversation whose whole title is a number: the other reading a numeric argument used to get.
    row('session-2024bb00-2024bb00-4aaa-8aaa-aaaaaaaaaaaa', '2024'),
  ]
  const screen: NumberedRows = {
    sessions: [
      { sessionId: 'session-aaaa0000-aaaa0000-4aaa-8aaa-aaaaaaaaaaaa', title: '微信 aaaa00' },
    ],
    first: 1,
  }

  // 14 is refused although `14c71a` exists and its title contains "14".
  const miss = resolveTarget('14', machine, screen)
  assert.equal(miss.kind, 'unprinted')
  if (miss.kind === 'unprinted') {
    assert.deepEqual(
      { number: miss.number, first: miss.first, last: miss.last },
      { number: 14, first: 1, last: 1 },
    )
  }
  // 2024 is refused too, although a conversation is named exactly that. A number is not a name: the
  // way to reach that one is its row number (every listing prints one), which is why refusing leaves
  // nothing unreachable.
  assert.equal(resolveTarget('2024', machine, screen).kind, 'unprinted')

  // The number is not banned — it is a position, and it wins when a screen printed it.
  const fourteenRows: NumberedRows = {
    sessions: Array.from({ length: 14 }, (_, index) => ({
      sessionId: `session-cccc${String(index).padStart(4, '0')}-cccc-4ccc-8ccc-cccccccccccc`,
      title: `会话 ${String(index + 1)}`,
    })),
    first: 1,
  }
  assert.equal(found(resolveTarget('14', machine, fourteenRows))?.title, '会话 14')

  /*
   * What a number was never meant to break: the printed id still works, in both the short form the
   * row carries and any longer prefix of it.
   */
  assert.equal(found(resolveTarget(shortId(incident), machine, screen))?.sessionId, incident)
  assert.equal(found(resolveTarget('14c7', machine, screen))?.sessionId, incident)

  /*
   * And a printed id made only of digits still works — exactly, at the length the row prints.
   *
   * That is not the old fall-through coming back: the value has to be six characters and has to equal
   * what the row prints, so `14` can never reach `14c71a`. Without this a row whose id happens to be
   * `123456` (roughly one row in seventeen) could not be switched to by the very form the listing
   * tells the user to type — a failure arriving once every seventeen runs, which is precisely the
   * shape of flake this change exists to remove. It was found exactly that way: the first cut of this
   * fix made an existing `/switch <printed id>` test fail about one run in seventeen.
   */
  const digitsId = 'session-123456ab-123456ab-4aaa-8aaa-aaaaaaaaaaaa'
  const digitsMachine = [...machine, row(digitsId, '微信 123456')]
  assert.equal(shortId(digitsId), '123456')
  assert.equal(found(resolveTarget(shortId(digitsId), digitsMachine, screen))?.sessionId, digitsId)
  // Only exactly: a shorter prefix of that same id is a number with no row behind it, and a
  // six-digit number that is nobody's printed id is refused the same way.
  assert.equal(resolveTarget('1234', digitsMachine, screen).kind, 'unprinted')
  assert.equal(resolveTarget('654321', digitsMachine, screen).kind, 'unprinted')
})

test('a number answers from the shown list while a name may reach any workspace', () => {
  /*
   * The two pools are not the same, and conflating them is what made a listed conversation
   * unselectable: a session from another workspace shows up in `/list all`, but a number refers to a
   * row of that listing while a title has to be findable wherever it lives.
   */
  const mine = [row('session-aaaa1111-aaaa1111-x', '我的')]
  const every = [mine[0]!, row('session-bbbb2222-bbbb2222-x', '别处的')]
  const shown = (sessions: ListedSession[]): NumberedRows => ({ sessions, first: 1 })

  // A number counts the rows the user saw, so with only one own session, 2 is not a shown row.
  assert.equal(found(resolveTarget('1', every, shown(mine)))?.title, '我的')
  assert.equal(resolveTarget('2', every, shown(mine)).kind, 'unprinted')
  // With everything shown, 2 is the foreign session.
  assert.equal(found(resolveTarget('2', every, shown(every)))?.title, '别处的')
  // A name is searched across everything, however few rows were displayed.
  assert.equal(found(resolveTarget('别处的', every, shown(mine)))?.title, '别处的')
  // A short id likewise, which is the form `/list` prints beside each row.
  assert.equal(found(resolveTarget('bbbb', every, shown(mine)))?.title, '别处的')
  // Omitting the third argument keeps the old behaviour: one pool for both.
  assert.equal(found(resolveTarget('2', every))?.title, '别处的')
})

test('a title is matched loosely, but never ambiguously', () => {
  /*
   * Real request that failed: 「切换回北京今天天气如何**会话**」 against a session titled
   * 「北京今天天气如何」. Exact matching alone loses to two characters the user added from habit.
   */
  const sessions = [
    row('session-1111aaaa-1111aaaa-x', '北京今天天气如何'),
    row('session-2222bbbb-2222bbbb-x', '解题辅导会话'),
    row('session-3333cccc-3333cccc-x', '写周报'),
  ]

  // The user's own wording, with a word appended.
  assert.equal(found(resolveTarget('北京今天天气如何会话', sessions))?.title, '北京今天天气如何')
  // A fragment they remember.
  assert.equal(found(resolveTarget('北京', sessions))?.title, '北京今天天气如何')
  assert.equal(found(resolveTarget('周报', sessions))?.title, '写周报')
  // Exact still wins.
  assert.equal(found(resolveTarget('写周报', sessions))?.title, '写周报')

  /*
   * Ambiguity must fail rather than pick one. Both titles here contain 「会话」, so asking for it
   * cannot say which was meant — and a wrong guess moves the conversation somewhere the user did not
   * ask for, which is worse than the failure.
   */
  const ambiguous = [
    row('session-5555eeee-5555eeee-x', '解题辅导会话'),
    row('session-6666ffff-6666ffff-x', '写周报会话'),
  ]
  assert.equal(resolveTarget('会话', ambiguous).kind, 'none')
  // Nothing matches, so nothing moves.
  assert.equal(resolveTarget('不存在的会话', sessions).kind, 'none')
  // An untitled session must not be selected by every argument that contains nothing — a title of ''
  // is a substring of everything.
  assert.equal(
    resolveTarget('随便什么', [{ sessionId: 'session-4444dddd-4444dddd-x', title: '' }]).kind,
    'none',
  )
})

test('a short id two conversations share fails instead of picking one', () => {
  /*
   * The printed id is the first few hex characters of the session id, so two conversations *can*
   * share one — six hex digits is 16 777 216 values, and a machine with a few hundred sessions still
   * collides eventually. The answer has to be "your id is too short", naming the candidates: silently
   * switching to whichever was found first would move the user's work somewhere they never asked for.
   */
  const clashA = 'session-e716f0aa-e716f0aa-47fd-4e61-bec6-d21d19457f37'
  const clashB = 'session-e716f0bb-e716f0bb-47fd-4e61-bec6-d21d19457f37'
  const sessions = [row(clashA, '写周报'), row(clashB, '查北京天气')]

  assert.equal(shortId(clashA), shortId(clashB), 'the fixtures really do collide')
  const resolution = resolveTarget(shortId(clashA), sessions)
  assert.equal(resolution.kind, 'ambiguous')
  if (resolution.kind !== 'ambiguous') return
  assert.deepEqual(
    resolution.candidates.map((session) => session.title),
    ['写周报', '查北京天气'],
  )

  // A longer id identifies one, which is exactly what the failure message tells the user to send.
  assert.equal(found(resolveTarget('e716f0a', sessions))?.title, '写周报')
  assert.equal(found(resolveTarget('e716f0b', sessions))?.title, '查北京天气')
  assert.equal(found(resolveTarget(clashA, sessions))?.title, '写周报')

  // And the message says so, in words, with both candidates printed.
  const message = ambiguousTargetMessage(shortId(clashA), resolution.candidates)
  assert.match(message, /有多个会话匹配「e716f0」/)
  assert.match(message, /更长的 id/)
  assert.match(message, /e716f0aa · 写周报/)
  assert.match(message, /e716f0bb · 查北京天气/)
})

test('shortId stays readable, stays within six characters, and round-trips', () => {
  const id = mintSessionId(() => '1a2b3c4d-9f8e-7d6c-5b4a-392817061524')
  assert.equal(id, 'session-1a2b3c4d-1a2b3c4d-9f8e-7d6c-5b4a-392817061524')
  assert.equal(shortId(id), '1a2b3c')
  // The bound is the requirement: an id the user has to copy is not one they will use.
  assert.equal(SHORT_ID_LENGTH <= 6, true)
  const sessions = [row(id, 'x')]
  assert.equal(found(resolveTarget(shortId(id), sessions))?.sessionId, id)
  // A foreign id still yields something printable rather than throwing — and still within the bound.
  assert.ok(shortId('not-a-session-id').length <= SHORT_ID_LENGTH)
  assert.ok(shortId('session-').length <= SHORT_ID_LENGTH)
})

test('the helper that names nothing really names nothing, and never the same thing twice', () => {
  /*
   * Every test that needs a switch to fail now asks this helper instead of writing a literal, so the
   * helper is what stands between the suite and a fourth repeat: a literal like `99` or `14` was only
   * *probably* safe, and probability is what failed three times. So resolve a few of its answers
   * against a machine built to catch them: ids beginning with digits and hex run, titles carrying
   * them, a numeric title, and the two shapes that made the old resolver loose (prefix and title).
   */
  const machine = [
    row('session-12345600-12345600-4aaa-8aaa-aaaaaaaaaaaa', '微信 123456'),
    row('session-e716f0aa-e716f0aa-4aaa-8aaa-aaaaaaaaaaaa', '会话 3'),
    row('session-ffffffff-ffffffff-4aaa-8aaa-aaaaaaaaaaaa', '2024'),
  ]
  const answered = new Set<string>()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const target = unmatchedSwitchTarget()
    // Generated, not remembered: a fixed literal is the failure mode this replaced.
    assert.equal(answered.has(target), false, 'each call produces a fresh target')
    answered.add(target)
    assert.equal(resolveTarget(target, machine, { sessions: machine.slice(0, 1), first: 1 }).kind, 'none')
  }
})

/*
 * ---------------------------------------------------------------------------
 * Model and reasoning level
 * ---------------------------------------------------------------------------
 *
 * A level is a property of a model, not of the session: the same provider/model pair at `high` and at
 * `low` are two different answers, and which levels exist is the provider adapter's decision (the
 * adapter that ships with DSH publishes `off`/`low`/`high`/`max`). So these tests are about the two
 * halves of one choice — which model, and how hard it thinks — and about the three ways a level
 * change can be refused, none of which may be reported as a success.
 */

/** The catalog `/model` is answered from. Two providers, two of the models with levels. */
const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    provider: 'deepseek-account',
    providerName: 'DeepSeek 官方',
    model: 'deepseek-chat',
    name: 'DeepSeek V3.2',
  },
  {
    provider: 'deepseek-account',
    providerName: 'DeepSeek 官方',
    model: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    levels: [
      { id: 'off', name: 'Off' },
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
      { id: 'max', name: 'Max' },
    ],
    defaultLevel: 'high',
  },
  {
    provider: 'openrouter',
    providerName: 'OpenRouter',
    model: 'qwen3-coder',
    name: 'Qwen3 Coder',
    levels: [
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
    ],
    defaultLevel: 'low',
  },
]

test('a model number is a row of the catalog, never part of a name or an id', () => {
  /*
   * The same rule as `/switch`, for the same incident: a numeric argument must not be read as
   * something it was not printed as. The catalog is short and every model is a numbered row, so
   * refusing an out-of-range number leaves nothing unreachable — the caller answers with the list.
   */
  const catalog: readonly ModelOption[] = [
    { provider: 'p', providerName: 'P', model: 'one', name: 'One' },
    // Hostile on purpose: the number 3 is also this model's id and a word in its name.
    { provider: 'p', providerName: 'P', model: '3', name: 'Model 3' },
  ]
  assert.equal(resolveModelOption('2', catalog)?.model, '3', 'the number still means row 2')
  assert.equal(resolveModelOption('3', catalog), undefined, 'row 3 does not exist and 3 is not a name')
  assert.equal(resolveModelOption('Model 3', catalog)?.model, '3', 'the name still works')
})

/**
 * A gateway that also offers models, which is what `/model` needs.
 *
 * Kept apart from {@link FakeGateway} for the same reason the probe gateway is: a composition without
 * a catalog has to keep behaving exactly as it did, and that is only testable while a gateway without
 * one still exists.
 */
class ModelGateway extends FakeGateway implements SessionGateway {
  /** Selections the router asked the host to install, in order. */
  readonly selections: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }[] = []
  /** Session ids `listModels` was asked about, in order. */
  readonly listings: (string | undefined)[] = []
  /** The selection the host reports as current, as the per-session projection would. */
  current: ModelSelection = { provider: 'deepseek-account', model: 'deepseek-chat' }
  /** When true every selection throws, as a missing key or a withdrawn model does. */
  failSelection = false

  async listModels(sessionId?: string): Promise<ModelListing> {
    this.listings.push(sessionId)
    return { current: this.current, models: MODEL_OPTIONS }
  }

  async selectModel(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: string,
  ): Promise<ModelSelection> {
    if (this.failSelection) throw new Error('session/model-unavailable: no key for this provider')
    if (!MODEL_OPTIONS.some((option) => option.provider === provider && option.model === model)) {
      throw new Error(`unknown model ${provider}/${model}`)
    }
    const selected: ModelSelection = {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
    this.selections.push({ sessionId, ...selected })
    this.current = selected
    return selected
  }
}

/** A gateway that lists models but cannot select one. */
class ListingOnlyGateway extends FakeGateway implements SessionGateway {
  current: ModelSelection = { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' }

  async listModels(): Promise<ModelListing> {
    return { current: this.current, models: MODEL_OPTIONS }
  }
}

test('/model shows each model’s reasoning levels and marks the one in effect', async () => {
  const gateway = new ModelGateway()
  gateway.current = {
    provider: 'deepseek-account',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  }
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const result = await router.route({ ...conversation, text: '/model' })
  assert.equal(result.kind, 'reply')
  if (result.kind !== 'reply') return

  // The heading answers "which model, and how hard is it thinking" without scanning the rows.
  assert.match(result.text, /可用模型（共 3 个，当前：DeepSeek Reasoner · High）：/)
  // The levels sit under their model, with the one in effect marked.
  assert.match(result.text, /推理等级：Off · Low · High（当前） · Max/)
  /*
   * A model that is *not* the conversation's marks the host's default instead, because that is what a
   * switch to it would land on. Marking it "当前" would be a claim about a model nobody is using.
   */
  assert.match(result.text, /推理等级：Low（默认） · High/)
  // The example is taken from the catalog — and is a level worth landing on, not the first one it
  // happens to publish (`off` would suggest switching thinking off).
  assert.match(result.text, /回复 \/model 等级 <等级> 切换推理等级，例如 \/model 等级 high。/)
  assert.deepEqual(gateway.selections, [], 'listing changes nothing')
})

test('/model asks the host about the session this conversation is bound to', async () => {
  const gateway = new ModelGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const first = await router.route({ ...conversation, text: '第一条' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return

  await router.route({ ...conversation, text: '/model' })

  /*
   * Without the session id the host can only answer with the deployment default, which is wrong for
   * anyone who picked a model in the desktop for this one session — the mark would name a model the
   * next turn is not using, and the user would read the level off the wrong row.
   */
  assert.deepEqual(gateway.listings, [first.decision.sessionId])
})

test('/model with no level hint when nothing offers levels', () => {
  const onlyChat = MODEL_OPTIONS.filter((option) => option.levels === undefined)
  const text = renderModelList({ models: onlyChat })
  assert.match(text, /可用模型（共 1 个）：/)
  assert.doesNotMatch(text, /推理等级/)
})

test('/model 等级 names the levels of the model in use and changes nothing', async () => {
  const gateway = new ModelGateway()
  gateway.current = {
    provider: 'deepseek-account',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  }
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const result = await router.route({ ...conversation, text: '/model 等级' })
  assert.equal(result.kind, 'reply')
  if (result.kind !== 'reply') return
  assert.match(result.text, /DeepSeek Reasoner 的推理等级：/)
  assert.match(result.text, /High（当前）/)
  assert.match(result.text, /回复 \/model 等级 off 切换。/)
  assert.deepEqual(gateway.selections, [])
})

test('/model 等级 low changes only the level, on the model already in use', async () => {
  const gateway = new ModelGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const first = await router.route({ ...conversation, text: '第一条' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return
  gateway.current = {
    provider: 'deepseek-account',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  }

  const result = await router.route({ ...conversation, text: '/model 等级 low' })
  assert.equal(result.kind, 'reply')
  if (result.kind !== 'reply') return

  // The same provider and model, at the new level: that is what "change the level" means to the host.
  assert.deepEqual(gateway.selections, [
    {
      sessionId: first.decision.sessionId,
      provider: 'deepseek-account',
      model: 'deepseek-reasoner',
      reasoningEffort: 'low',
    },
  ])
  assert.match(result.text, /已把「.+」的推理等级切到 Low（DeepSeek Reasoner）。/)
})

test('/model <模型> 等级 <等级> switches the model and the level in one step', async () => {
  const gateway = new ModelGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const first = await router.route({ ...conversation, text: '第一条' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return

  // The name is accepted, not just the id, and the capitalisation is the phone keyboard's problem.
  const result = await router.route({ ...conversation, text: '/model 2 等级 MAX' })
  assert.equal(result.kind, 'reply')
  if (result.kind !== 'reply') return
  assert.deepEqual(gateway.selections, [
    {
      sessionId: first.decision.sessionId,
      provider: 'deepseek-account',
      model: 'deepseek-reasoner',
      reasoningEffort: 'max',
    },
  ])
  assert.match(result.text, /已把「.+」切换到 DeepSeek Reasoner（DeepSeek 官方）。/)
  assert.match(result.text, /推理等级：Max/)
  // The id still follows, because the id is what the user can type back.
  assert.match(result.text, /deepseek-reasoner/)
})

test('/model 等级 with a level the model does not publish lists the ones it does', async () => {
  const gateway = new ModelGateway()
  gateway.current = {
    provider: 'deepseek-account',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  }
  const router = new SessionRouter({ gateway, store: memoryStore() })
  await router.route({ ...conversation, text: '第一条' })

  const result = await router.route({ ...conversation, text: '/model 等级 超高' })
  assert.equal(result.kind, 'reply')
  if (result.kind !== 'reply') return
  assert.match(result.text, /^找不到等级「超高」。/)
  // The whole set is printed: a level the adapter does not publish is not something to guess at.
  assert.match(result.text, /Off、Low、High、Max/)
  assert.deepEqual(gateway.selections, [], 'nothing was selected')
})

test('/model 等级 on a model with no levels says so instead of selecting one', async () => {
  const gateway = new ModelGateway()
  // The conversation's model is the non-reasoning one, which is the common case.
  const router = new SessionRouter({ gateway, store: memoryStore() })
  await router.route({ ...conversation, text: '第一条' })

  for (const text of ['/model 等级 high', '/model 1 等级 high']) {
    const result = await router.route({ ...conversation, text })
    assert.equal(result.kind, 'reply')
    if (result.kind !== 'reply') return
    assert.match(result.text, /^当前模型不支持推理等级/, `answered for ${text}`)
    assert.match(result.text, /回复 \/model 看清单/)
  }
  assert.deepEqual(gateway.selections, [])
})

test('a level switch the host refuses is reported, never counted as done', async () => {
  const gateway = new ModelGateway()
  gateway.current = {
    provider: 'deepseek-account',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  }
  const router = new SessionRouter({ gateway, store: memoryStore() })
  await router.route({ ...conversation, text: '第一条' })
  gateway.failSelection = true

  const result = await router.route({ ...conversation, text: '/model 等级 low' })
  assert.equal(result.kind, 'reply')
  if (result.kind !== 'reply') return
  // The host's own words, so the user has something to act on, and an opening that reads as a failure.
  assert.match(result.text, /^切换推理等级失败：session\/model-unavailable/)
  assert.deepEqual(gateway.selections, [])
})

test('a gateway with no catalog, and one that cannot select, each say so', async () => {
  const bare = new SessionRouter({ gateway: new FakeGateway(), store: memoryStore() })
  for (const text of ['/model', '/model 等级 high', '/model 2']) {
    const result = await bare.route({ ...conversation, text })
    assert.equal(result.kind, 'reply')
    if (result.kind !== 'reply') return
    assert.match(result.text, /当前组合没有模型列表/)
  }

  const listingOnly = new SessionRouter({ gateway: new ListingOnlyGateway(), store: memoryStore() })
  await listingOnly.route({ ...conversation, text: '第一条' })
  const switchModel = await listingOnly.route({ ...conversation, text: '/model 2' })
  assert.equal(switchModel.kind, 'reply')
  if (switchModel.kind !== 'reply') return
  assert.match(switchModel.text, /当前组合不支持切换模型/)

  const switchLevel = await listingOnly.route({ ...conversation, text: '/model 等级 low' })
  assert.equal(switchLevel.kind, 'reply')
  if (switchLevel.kind !== 'reply') return
  assert.match(switchLevel.text, /当前组合不支持切换推理等级/)
})

test('a level is named explicitly, so no model argument is ever split by guesswork', () => {
  // The plain forms are exactly what they were before levels existed.
  assert.deepEqual(parseModelCommand(''), { target: '', levelForm: false })
  assert.deepEqual(parseModelCommand('2'), { target: '2', levelForm: false })
  assert.deepEqual(parseModelCommand('DeepSeek Reasoner'), {
    target: 'DeepSeek Reasoner',
    levelForm: false,
  })
  // A keyword introduces the level, and everything before it is the model (or nothing).
  assert.deepEqual(parseModelCommand('等级'), { target: '', levelForm: true })
  assert.deepEqual(parseModelCommand('等级 high'), { target: '', level: 'high', levelForm: true })
  assert.deepEqual(parseModelCommand('2 等级 high'), { target: '2', level: 'high', levelForm: true })
  assert.deepEqual(parseModelCommand('DeepSeek Reasoner 等级 High'), {
    target: 'DeepSeek Reasoner',
    level: 'High',
    levelForm: true,
  })
  // The full name of the setting works, and so does the English one.
  assert.deepEqual(parseModelCommand('推理等级 高'), { target: '', level: '高', levelForm: true })
  assert.deepEqual(parseModelCommand('level high'), { target: '', level: 'high', levelForm: true })
})

test('a level is matched by id or by name, and never partially', () => {
  const levels = MODEL_OPTIONS[1]?.levels ?? []
  assert.equal(resolveLevel('high', levels)?.id, 'high')
  assert.equal(resolveLevel('High', levels)?.id, 'high')
  assert.equal(resolveLevel('HIGH', levels)?.id, 'high')
  assert.equal(resolveLevel('', levels), undefined)
  // A prefix is not a level: `h` guessing at `high` would change how hard the model thinks without
  // the user saying so.
  assert.equal(resolveLevel('h', levels), undefined)
  assert.equal(resolveLevel('高', levels), undefined)
  // The rendered body of one model's levels, for the model the conversation is not on.
  const text = renderLevels(
    MODEL_OPTIONS[1] as ModelOption,
    { provider: 'deepseek-account', model: 'deepseek-chat' },
    levels,
  )
  assert.match(text, /DeepSeek Reasoner 的推理等级：/)
  assert.match(text, /High（默认）/)
})

/*
 * A refused send must not look like a delivered one.
 *
 * The service answers HTTP 200 either way, so the only signal is the code in the body — and it uses
 * `errcode` for one refusal and `ret` for another, which is why both are checked. Before this, a
 * refusal was reported to the user as "已通过微信发送" while the phone received nothing.
 */
test('a send refused with errcode throws instead of returning an id', () => {
  // The class matters as much as the message: the channel queues a refused message for the next open
  // window, and must not do that for a failure that would repeat.
  assert.throws(
    () => assertSendAccepted({ errcode: -14, errmsg: 'session timeout' }),
    (error: unknown) => error instanceof SendRefusedError && error.errcode === -14,
  )
})

test('a send refused with ret throws, naming the code the service gave', () => {
  // Verified against the live service: this shape is what a dead session returns for a fully headed
  // request, while the same refusal through a bare request comes back as `errcode`.
  assert.throws(
    () => assertSendAccepted({ ret: -2, errmsg: 'prepare failed' }),
    (error: unknown) =>
      error instanceof SendRefusedError && /errcode=-2.*prepare failed/.test(error.message),
  )
})

test('a refusal records every field the service gave, without inventing one', () => {
  /*
   * The log is the only instrument for telling the two shared-code refusals apart, so what it carries
   * decides whether the next investigation is even possible. Three things have to hold:
   *
   * - the `errmsg` is kept, because `-2 prepare failed` (a session needing an inbound message) and
   *   `-2 rate limited` (a session needing a pause) share a code and differ only here;
   * - `ret` is kept when present, since the send path has been seen populating `ret` while the
   *   polling path populates `errcode`;
   * - an absent field is omitted rather than printed as `undefined`, which reads as a value and sends
   *   the next reader looking for a `ret` that was never sent.
   */
  assert.throws(
    () => assertSendAccepted({ ret: -2, errmsg: 'prepare failed' }),
    (error: unknown) =>
      error instanceof SendRefusedError &&
      /ret=-2 errcode=-2 errmsg=prepare failed/.test(error.message) &&
      !/undefined/.test(error.message),
  )
  // The other shape: `errcode` alone, which must not grow a phantom `ret=`.
  assert.throws(
    () => assertSendAccepted({ errcode: -2, errmsg: 'rate limited' }),
    (error: unknown) =>
      error instanceof SendRefusedError &&
      /errcode=-2 errmsg=rate limited/.test(error.message) &&
      !/ret=/.test(error.message),
  )
})

test('a send the service accepted is left alone', () => {
  // Both the plain success and an explicit zero must pass: a strict `errmsg === undefined` check
  // would reject a perfectly good delivery.
  assertSendAccepted({ message_id: '1' })
  assertSendAccepted({ message_id: '1', ret: 0 })
  assertSendAccepted({ message_id: '1', errcode: 0, errmsg: '' })
})

test('queuePendingNotification stamps an id and a time, and drops the oldest when full', () => {
  const state = emptyState()
  for (let i = 0; i < 3; i += 1) {
    queuePendingNotification(state, { conversationId: 'c', text: `第 ${String(i)} 条` }, 1000 + i, 2)
  }
  assert.deepEqual(
    state.pendingNotifications?.map((entry) => entry.text),
    ['第 1 条', '第 2 条'],
    'the oldest goes first: the queue is a backlog, read in order',
  )
  assert.equal(state.pendingNotifications?.[0].queuedAt, 1001, 'the injected clock is used')
  assert.ok(state.pendingNotifications?.[0].id, 'every entry gets an identity')
  assert.notEqual(
    state.pendingNotifications?.[0].id,
    state.pendingNotifications?.[1].id,
    'two identical messages queued in the same millisecond stay distinguishable',
  )
})

test('expirePendingNotifications keeps the fresh and drops the stale', () => {
  const state = emptyState()
  queuePendingNotification(state, { conversationId: 'c', text: '旧的' }, 0)
  queuePendingNotification(state, { conversationId: 'c', text: '新的' }, 9_000)

  const dropped = expirePendingNotifications(state, 10_000, 5_000)

  assert.deepEqual(dropped.map((entry) => entry.text), ['旧的'])
  assert.deepEqual(state.pendingNotifications?.map((entry) => entry.text), ['新的'])
})

test('a malformed pending entry is dropped when the state is read back', async () => {
  /*
   * This array is read from a user-editable file and then sent, so an entry missing its conversation
   * would reach the send path as `undefined` — a crash on the one path that exists to survive a
   * failure.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  try {
    const store = new StateStore(join(home, 'state.json'))
    const good = { id: 'k', conversationId: 'c', text: '好的', queuedAt: 1 }
    await store.update((state) => {
      state.pendingNotifications = [
        good,
        { conversationId: 'c', text: '没有 id' },
        { id: 'x', text: '没有 conversation' },
        { id: 'y', conversationId: 'c', text: 42 },
      ] as never
    })

    const read = await new StateStore(join(home, 'state.json')).read()
    assert.deepEqual(read.pendingNotifications, [good], 'only the well-formed entry survives')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Reply-window quota
// ---------------------------------------------------------------------------

/** One conversation's quota entry, as the state file stores it. */
function quotaOf(state: ChannelState, conversationId: string): QuotaEntry | undefined {
  return state.quota?.[conversationId]
}

test('the quota count survives a write, a fresh read, and another write', async () => {
  /*
   * The reason this test exists at all: `normalize()` is an allowlist, and a field added to
   * `ChannelState` without a line there is discarded by the very next write. That is exactly how the
   * settings page spent several releases losing everything the user saved (`HANDBOOK-DEV.md` §4.9) —
   * saved fine, gone after a restart.
   *
   * The count is now the same kind of data and matters more than most: it decides whether the user is
   * asked for a new window *before* the last slot is spent, so silently resetting it to zero on every
   * write means the ask comes too late and the tail of a series is refused.
   *
   * The second `update` is the step that used to eat things: every write re-reads and re-normalizes
   * the file first.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-quota-'))
  try {
    const file = join(home, 'state.json')
    const wanted: QuotaEntry = { token: 'ctx-token-1', used: 9, warned: true }
    const store = new StateStore(file)
    await store.update((state) => {
      state.quota = { 'bot@im.bot:peer@im.wechat': wanted }
    })
    await store.update(() => {})

    const stored = quotaOf(await new StateStore(file).read(), 'bot@im.bot:peer@im.wechat')
    assert.deepEqual(stored, wanted, 'the count is still there after a reload and a rewrite')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a malformed quota entry is dropped when the state is read back', async () => {
  // `used` reaches arithmetic that decides whether to ask for a new window. A string there would
  // compare as false forever, so the warning would silently never fire; an entry with no `warned`
  // would make the same ask repeat on every send and spend the remaining slots on asking.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-quota-'))
  try {
    const file = join(home, 'state.json')
    const good: QuotaEntry = { token: 'ctx', used: 3, warned: false }
    const store = new StateStore(file)
    await store.update((state) => {
      state.quota = {
        good,
        'used-is-a-string': { token: 'ctx', used: '3', warned: false },
        'warned-missing': { token: 'ctx', used: 3 },
        'used-is-negative': { token: 'ctx', used: -1, warned: false },
        'token-is-a-number': { token: 7, used: 1, warned: false },
      } as never
    })

    assert.deepEqual(
      Object.keys((await new StateStore(file).read()).quota ?? {}),
      ['good'],
      'only the well-formed entry survives',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the count starts at one and asks for a new window two short of the limit', () => {
  /*
   * Three things are pinned here, and each of them is a way the ask can fail to arrive in time:
   *
   * 1. A conversation with no stored entry is a fresh window, counted from one rather than two.
   * 2. The ask happens at eight, not at ten — the warning is itself a message, so an ask at the limit
   *    would be an ask with no slot left to carry it.
   * 3. The warning is charged in the same step, so the count matches what the service actually saw.
   */
  const first = chargeQuota({ token: 'ctx' })
  assert.deepEqual(first.entry, { token: 'ctx', used: 1, warned: false })
  assert.equal(first.warn, false, 'nothing to ask for on the first send of a window')

  const seventh = chargeQuota({ stored: { token: 'ctx', used: 6, warned: false }, token: 'ctx' })
  assert.equal(seventh.warn, false, 'seven sends is still quiet')

  const eighth = chargeQuota({ stored: { token: 'ctx', used: 7, warned: false }, token: 'ctx' })
  assert.equal(eighth.warn, true, 'the eighth send is the one that carries the ask')
  assert.equal(eighth.used, 9, 'the ask itself spends a slot, so the count reflects it')
  assert.equal(eighth.entry.warned, true)
})

test('the ask happens once per window, never twice', () => {
  // The ninth and every later send must stay quiet. Repeating the ask would spend the remaining slots
  // on asking, which is the loop this flag exists to break.
  const ninth = chargeQuota({ stored: { token: 'ctx', used: 9, warned: true }, token: 'ctx' })
  assert.equal(ninth.warn, false)
  assert.equal(ninth.used, 10)

  const tenth = chargeQuota({ stored: { token: 'ctx', used: 10, warned: true }, token: 'ctx' })
  assert.equal(tenth.warn, false, 'a spent window is not asked about again')
  assert.equal(tenth.used, 11, 'countermanding nothing here: the arithmetic keeps counting')
})

test('a new token resets both the count and the ask', () => {
  /*
   * The platform issues a fresh ten with every inbound message, and nothing tells this side when that
   * happens except the token changing. A conversation stamped with the previous window therefore has
   * to start over completely — count *and* flag, or the second window would never ask.
   */
  const fresh = chargeQuota({ stored: { token: 'ctx-1', used: 10, warned: true }, token: 'ctx-2' })
  assert.deepEqual(fresh.entry, { token: 'ctx-2', used: 1, warned: false })
  assert.equal(fresh.warn, false)
})

test('a window with no stored token is its own window', () => {
  // What a restart before the first inbound message looks like. Treating `undefined` as a value rather
  // than as "no window" is what keeps the arithmetic honest when the token later appears.
  const none = chargeQuota({ token: undefined })
  assert.deepEqual(none.entry, { used: 1, warned: false })

  const stamped = chargeQuota({ stored: none.entry, token: 'ctx' })
  assert.deepEqual(stamped.entry, { token: 'ctx', used: 1, warned: false }, 'a real token is a new window')
})

test('the ledger charges the entry it read from the file', async () => {
  // The end-to-end shape of the thing: a charge read from disk, written back, and read again by a
  // second reader. This is the property the command line depends on — it is a separate process, so
  // its charges have to be visible to the plugin through the file and nothing else.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-quota-'))
  try {
    const file = join(home, 'state.json')
    const ledger = quotaLedgerFor(new StateStore(file))
    // Seven sends, so the next charge is the eighth — the one that carries the ask.
    for (let index = 0; index < 7; index += 1) await ledger.charge('conv', 'ctx')

    const charge = await ledger.charge('conv', 'ctx')
    assert.equal(charge.warn, true, 'the eighth send of a window asks for a new one')
    assert.equal(charge.used, 9)

    const stored = quotaOf(await new StateStore(file).read(), 'conv')
    assert.deepEqual(stored, { token: 'ctx', used: 9, warned: true }, 'and it is on disk, not in memory')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a changed token makes the next charge start from one again', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-quota-'))
  try {
    const file = join(home, 'state.json')
    const ledger = quotaLedgerFor(new StateStore(file))
    for (let index = 0; index < 9; index += 1) await ledger.charge('conv', 'ctx-1')

    const charge = await ledger.charge('conv', 'ctx-2')
    assert.equal(charge.used, 1, 'the inbound message that carried ctx-2 opened a fresh window')
    assert.equal(charge.warn, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('sendText surfaces a refusal rather than reporting success', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ret: -2, errmsg: 'prepare failed' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

  try {
    await assert.rejects(
      async () => await sendText({ account, to: 'u@im.wechat', text: 'hi' }),
      /errcode=-2/,
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

test('setTyping asks for the ticket with the required ilink_user_id', async () => {
  /*
   * The request that made "typing…" a no-op for the whole life of the project.
   *
   * `getconfig` requires `ilink_user_id`. An empty body gets `ret: -2, 'ilink_user_id required'` back
   * with HTTP 200, `typing_ticket` comes back undefined, and `setTyping` returns early. Nothing
   * throws — that method deliberately swallows everything, being cosmetic — so the feature was
   * implemented, wired up, and never once visible.
   */
  const bodies: { url: string; body: string }[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: { body?: unknown }) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    bodies.push({ url: String(url), body })
    const payload = String(url).includes('getconfig')
      ? { ret: 0, typing_ticket: 'ticket-1' }
      : { ret: 0 }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const { ChannelMonitor } = await import('../src/channel.ts')
    const monitor = new ChannelMonitor({ account, onMessage: async () => {} })
    await monitor.setTyping('peer@im.wechat', true)

    const config = bodies.find((entry) => entry.url.includes('getconfig'))
    assert.ok(config, 'the ticket is fetched first')
    assert.match(config.body, /"ilink_user_id":"peer@im\.wechat"/, 'and it carries the peer id')

    const typing = bodies.find((entry) => entry.url.includes('sendtyping'))
    assert.ok(typing, 'then the indicator is sent')
    assert.match(typing.body, /"typing_ticket":"ticket-1"/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('setTyping records a refused getconfig instead of failing silently', async () => {
  // A ticket that cannot be fetched is invisible by design, so the log is the only place it could ever
  // be noticed. This assertion is what would have caught the missing parameter immediately.
  const errors: unknown[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ret: -2, errmsg: 'ilink_user_id required' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

  try {
    const { ChannelMonitor } = await import('../src/channel.ts')
    const monitor = new ChannelMonitor({
      account,
      onMessage: async () => {},
      onError: (error) => errors.push(error),
    })
    await monitor.setTyping('peer@im.wechat', true)

    assert.equal(errors.length, 1, 'the refusal is recorded')
    assert.match(String(errors[0]), /ilink_user_id required/)
  } finally {
    globalThis.fetch = realFetch
  }
})
