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
import { conversationKey, extractText, toInbound, sendText } from '../src/channel.ts'
import { StateStore, expirePendingNotifications, queuePendingNotification } from '../src/state.ts'
import {
  SessionRouter,
  mintSessionId,
  resolveTarget,
  shortId,
  splitCommand,
  HELP_TEXT,
} from '../src/router.ts'
import type { SessionBinding, SessionGateway } from '../src/router.ts'
import type { ChannelState } from '../src/state.ts'
import type { WeixinAccount, WeixinMessage } from '../src/types.ts'

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
  assert.equal(anonymous['iLink-App-ClientVersion'], '204009')
  assert.equal(anonymous.Authorization, undefined)
  assert.equal(anonymous.AuthorizationType, undefined)
  assert.ok(anonymous['X-WECHAT-UIN'].length > 0)

  const authed = buildHeaders({ token: 'abc' })
  assert.equal(authed.Authorization, 'Bearer abc')
  assert.equal(authed.AuthorizationType, 'ilink_bot_token')
})

test('baseInfo reports a stable channel version', () => {
  const info = baseInfo('probe/1')
  assert.equal(info.channel_version, '2.4.9')
  assert.equal(info.bot_agent, 'probe/1')
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
  sessions: { sessionId: string; title: string; updatedAt: number }[] = []
  /** Sessions belonging to other workspaces, which `listOwnSessions` must exclude. */
  readonly foreign: { sessionId: string; title: string; updatedAt: number }[] = []
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

  async listSessions(): Promise<{ sessionId: string; title: string; updatedAt: number }[]> {
    return [...this.sessions, ...this.foreign].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** What `/list` shows by default: this workspace only, newest first. */
  async listOwnSessions(): Promise<{ sessionId: string; title: string; updatedAt: number }[]> {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async cancel(sessionId: string): Promise<void> {
    this.calls.push(`cancel:${sessionId}`)
  }
}

/** In-memory binding store. */
function memoryStore() {
  let data: Record<string, SessionBinding> = {}
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

test('/list shows this workspace and mentions the rest, and /list all shows everything', async () => {
  /*
   * The typed and spoken routes have to agree. Before this, `/list` printed every session on the
   * machine — sixty-six of them here, ten of which belonged to this workspace — while a spoken
   * request showed only the ten and said how many others existed. The same question giving two
   * different answers is what makes a command feel broken.
   */
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  await router.route({ ...conversation, text: 'one' })
  const mine = await gateway.listSessions()
  // A session belonging to another project, which the gateway reports separately.
  gateway.foreign.push({ sessionId: 'session-ffff9999-ffff9999-x', title: '别处的工作', updatedAt: gateway.nextStamp() })

  const own = await router.route({ ...conversation, text: '/list' })
  assert.equal(own.kind, 'reply')
  if (own.kind !== 'reply') return
  // The count includes the held sessions, so the user knows the size of what they are not seeing.
  assert.match(own.text, new RegExp(`共 ${String(mine.length + 1)} 个对话`))
  assert.doesNotMatch(own.text, /别处的工作/, 'the default list is this workspace only')
  assert.match(own.text, /另有 1 个对话在其它工作区/)
  // And how to reach them, or the hint is useless.
  assert.match(own.text, /\/list all/)

  const all = await router.route({ ...conversation, text: '/list all' })
  assert.equal(all.kind, 'reply')
  if (all.kind !== 'reply') return
  assert.match(all.text, /别处的工作/, 'the wider list shows it')
  assert.doesNotMatch(all.text, /另有/, 'nothing is being held back now')
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

test('resolveTarget accepts an index, a full id, the short id, and a title', () => {
  // Realistically shaped ids, minted the same way the router mints them.
  const first = mintSessionId(() => 'aaaa1111-2222-3333-4444-555566667777')
  const second = mintSessionId(() => 'bbbb1111-2222-3333-4444-555566667777')
  const sessions = [
    { sessionId: first, title: '甲', updatedAt: 2 },
    { sessionId: second, title: '乙', updatedAt: 1 },
  ]
  assert.equal(resolveTarget('1', sessions)?.title, '甲')
  assert.equal(resolveTarget('2', sessions)?.title, '乙')
  assert.equal(resolveTarget(second, sessions)?.title, '乙')
  // The short id `/list` prints is exactly what `/switch` accepts.
  assert.equal(resolveTarget(shortId(second), sessions)?.title, '乙')
  assert.equal(resolveTarget('甲', sessions)?.title, '甲')
  assert.equal(resolveTarget('', sessions), undefined)
  assert.equal(resolveTarget('9', sessions), undefined)
  // A suffix shared by several sessions is ambiguous and must not guess.
  assert.equal(resolveTarget('4444-555566667777', sessions), undefined)
  assert.equal(resolveTarget('session-', sessions), undefined)
})

test('a number answers from the shown list while a name may reach any workspace', () => {
  /*
   * The two pools are not the same, and conflating them is what made a listed conversation
   * unselectable: a session from another workspace shows up in `/list all`, but a number refers to a
   * row of that listing while a title has to be findable wherever it lives.
   */
  const mine = [
    { sessionId: 'session-aaaa1111-aaaa1111-x', title: '我的', updatedAt: 2 },
  ]
  const foreign = { sessionId: 'session-bbbb2222-bbbb2222-x', title: '别处的', updatedAt: 1 }
  const every = [mine[0]!, foreign]

  // A number counts the rows the user saw, so with only one own session, 2 is not a shown row.
  assert.equal(resolveTarget('1', every, mine)?.title, '我的')
  assert.equal(resolveTarget('2', every, mine), undefined)
  // With everything shown, 2 is the foreign session.
  assert.equal(resolveTarget('2', every, every)?.title, '别处的')
  // A name is searched across everything, however few rows were displayed.
  assert.equal(resolveTarget('别处的', every, mine)?.title, '别处的')
  // A short id likewise, which is the form `/list` prints beside each row.
  assert.equal(resolveTarget('bbbb2222', every, mine)?.title, '别处的')
  // Omitting the third argument keeps the old behaviour: one pool for both.
  assert.equal(resolveTarget('2', every)?.title, '别处的')
})

test('a title is matched loosely, but never ambiguously', () => {
  /*
   * Real request that failed: 「切换回北京今天天气如何**会话**」 against a session titled
   * 「北京今天天气如何」. Exact matching alone loses to two characters the user added from habit.
   */
  const sessions = [
    { sessionId: 'session-1111aaaa-1111aaaa-x', title: '北京今天天气如何', updatedAt: 3 },
    { sessionId: 'session-2222bbbb-2222bbbb-x', title: '解题辅导会话', updatedAt: 2 },
    { sessionId: 'session-3333cccc-3333cccc-x', title: '写周报', updatedAt: 1 },
  ]

  // The user's own wording, with a word appended.
  assert.equal(resolveTarget('北京今天天气如何会话', sessions)?.title, '北京今天天气如何')
  // A fragment they remember.
  assert.equal(resolveTarget('北京', sessions)?.title, '北京今天天气如何')
  assert.equal(resolveTarget('周报', sessions)?.title, '写周报')
  // Exact still wins.
  assert.equal(resolveTarget('写周报', sessions)?.title, '写周报')

  /*
   * Ambiguity must fail rather than pick one. Both titles here contain 「会话」, so asking for it
   * cannot say which was meant — and a wrong guess moves the conversation somewhere the user did not
   * ask for, which is worse than the failure.
   */
  const ambiguous = [
    { sessionId: 'session-5555eeee-5555eeee-x', title: '解题辅导会话', updatedAt: 2 },
    { sessionId: 'session-6666ffff-6666ffff-x', title: '写周报会话', updatedAt: 1 },
  ]
  assert.equal(resolveTarget('会话', ambiguous), undefined)
  // Nothing matches, so nothing moves.
  assert.equal(resolveTarget('不存在的会话', sessions), undefined)
  // An untitled session must not be selected by every argument that contains nothing — a title of ''
  // is a substring of everything.
  assert.equal(
    resolveTarget('随便什么', [{ sessionId: 'session-4444dddd-4444dddd-x', title: '', updatedAt: 0 }]),
    undefined,
  )
})

test('shortId stays readable and round-trips through resolveTarget', () => {
  const id = mintSessionId(() => '1a2b3c4d-9f8e-7d6c-5b4a-392817061524')
  assert.equal(id, 'session-1a2b3c4d-1a2b3c4d-9f8e-7d6c-5b4a-392817061524')
  assert.equal(shortId(id), '1a2b3c4d')
  const sessions = [{ sessionId: id, title: 'x', updatedAt: 0 }]
  assert.equal(resolveTarget(shortId(id), sessions)?.sessionId, id)
  // A foreign id still yields something printable rather than throwing.
  assert.equal(shortId('not-a-session-id'), 'not-a-se')
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
