/**
 * Integration tests for the plugin's host glue.
 *
 * The unit tests in `@dsh-wechat/core` cover the protocol and routing in isolation.
 * These mount the real `apply()` against a stub host and drive real messages through
 * it, which is what checks the part that only exists at the boundary: which host
 * calls the channel makes, and with what arguments.
 *
 * The `cwd` assertions are the important ones. The host refuses to adopt a session
 * whose working directory differs from the stored one, so an unset or varying `cwd`
 * would silently strand every session the channel created.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, recordClientFailure, type SendFunction } from '../src/host.ts'
import type { WechatContext } from '../src/services.ts'
import { DEFAULT_SETTINGS, SendRefusedError, aesKeyToBase64, encodeWorkspaceDir, isSameWorkspace, shortId } from '@dsh-wechat/core'

/**
 * Note on the core import: `host.ts` imports `@dsh-wechat/core`, which resolves
 * through `node_modules` to the package's built `lib/`. Node refuses to strip types
 * for files under `node_modules`, so the core package must be built (`pnpm build`)
 * before these tests run. That is also the artifact consumers receive, so the test
 * exercises the shipped form rather than the sources.
 */

/**
 * Remove a temporary DSH home.
 *
 * Retried, because a session write the plugin started can still be settling when a test ends, and
 * Windows then refuses the rmdir with ENOTEMPTY — a cleanup failure that reads as a test failure.
 *
 * @param home - Directory to remove.
 */
async function removeHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

interface Created {
  sessionId?: string
  cwd?: string
  workspaceId?: string
  /** Title the channel asked for, which is what the session list shows. */
  title?: string
}

interface Sent {
  to: string
  text: string
  contextToken?: string
}

/** The slice of the runtime these tests drive. */
interface RuntimeShape {
  status(): Promise<{ enabled: boolean; accounts: unknown[]; needsLogin: boolean; errors: string[] }>
  loginState(): { phase: string; step?: string }
  bindings(): Promise<{ conversationId: string; sessionId: string; title: string }[]>
  setEnabled(enabled: boolean): Promise<void>
  ingest(message: {
    accountId: string
    peerId: string
    conversationId: string
    text: string
    contextToken?: string
    raw: Record<string, unknown>
    receivedAt: number
  }): Promise<void>
}

interface Harness {
  runtime: RuntimeShape
  /** DSH home the plugin resolved, where the boot log and state file live. */
  bundleHome: string
  stateFile: string
  workspace: string
  /** Titles applied to the session Workspace, in order. */
  workspaceTitles: string[]
  /** Host event listeners the plugin registered, keyed by event name. */
  listeners: Map<string, (...args: unknown[]) => void>
  /** Tool definitions the plugin registered with the tool registry. */
  registeredTools: unknown[]
  /** Workspace paths the channel asked the registry to resolve, in order. */
  resolvedWorkspacePaths: string[]
  /** Permission presets the channel applied, in order. */
  presetApplications: { sessionId: string; preset: string }[]
  created: Created[]
  /** Messages carrying the user's own words, which is what most tests are about. */
  prompted: { sessionId: string; mode: 'queue' | 'steer'; text: string }[]
  /** Every submission including the standing channel note, for the tests that check the split. */
  allPrompts: { sessionId: string; mode: 'queue' | 'steer'; text: string }[]
  sent: Sent[]
  events: string[]
  dispose(): void
}

/**
 * Mount the plugin against a stub host.
 *
 * @param options.home - DSH home the plugin resolves paths under.
 * @param options.config - Extra patch config.
 * @param options.seedAccount - Write this account into the state file before mounting.
 */
async function mount(options: {
  home: string
  config?: Record<string, unknown>
  seedAccount?: boolean
  refuseSteer?: boolean
  failAllPrompts?: boolean
}): Promise<Harness> {
  return await mountWith(options)
}

/**
 * Mount with an explicit sender, so a test can make delivery fail on purpose.
 */
async function mountWith(options: {
  home: string
  config?: Record<string, unknown>
  seedAccount?: boolean
  send?: SendFunction
  /** Make every steer attempt throw, as a turn that ended before the steer landed would. */
  refuseSteer?: boolean
  /** Make every submission throw, so the give-the-words-back path can be exercised. */
  failAllPrompts?: boolean
  /** Make the host's session list empty, which is what a real machine returned. */
  hostReportsNoSessions?: boolean
}): Promise<Harness> {
  const created: Created[] = []
  const prompted: { sessionId: string; mode: 'queue' | 'steer'; text: string }[] = []
  /**
   * Every submission, including the standing channel note.
   *
   * `prompted` holds the messages that carry the user's own words, because that is what nearly every
   * test is about. A session's first message is split in two — the request alone, then the note as
   * its own message — so that DSH names the session from the request; counting that split in
   * `prompted` would turn every content assertion into a message-count assertion. The note deserves
   * its own check rather than quiet inclusion here.
   */
  const allPrompts: { sessionId: string; mode: 'queue' | 'steer'; text: string }[] = []
  const sent: Sent[] = []
  const events: string[] = []
  let runtime: RuntimeShape | undefined
  let disposer: (() => void) | undefined

  const stateFile = join(options.home, 'wechat', 'state.json')

  // Seed a bound account so the pipeline has something to reply to.
  if (options.seedAccount === true) {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(options.home, 'wechat'), { recursive: true })
    await writeFile(
      stateFile,
      JSON.stringify({
        version: 1,
        accounts: {
          'test@im.bot': {
            accountId: 'test@im.bot',
            token: 'token',
            baseUrl: 'https://example.invalid',
            userId: 'peer@im.wechat',
          },
        },
        syncBufs: {},
        contextTokens: {},
        bindings: {},
      }),
      'utf8',
    )
  }

  const send: SendFunction =
    options.send ??
    (async (params) => {
      sent.push({
        to: params.to,
        text: params.text,
        ...(params.contextToken === undefined ? {} : { contextToken: params.contextToken }),
      })
      // The service assigns an id to every message; the channel records it so a quote of that
      // message can later be resolved. Returning one here is what lets the quote path be driven.
      return { clientId: `test-${String(sent.length)}`, serverMessageId: `msg-${String(sent.length)}` }
    })

  // Stands in for the Workspace registry. Sessions are grouped on the desktop by
  // Workspace, so the channel must create them through one rather than by cwd.
  const workspaceTitles: string[] = []
  /**
   * Created sessions whose title is still unknown, oldest first.
   *
   * The channel sets the title on the Workspace rather than on the session, so the two signals
   * have to be joined to give the list something to show.
   */
  const pendingTitles: Created[] = []
  const listeners = new Map<string, (...args: unknown[]) => void>()
  /** Tool definitions the plugin registered, in order. */
  const registeredTools: unknown[] = []
  /** Paths the channel asked the registry to resolve, in order. */
  const resolvedWorkspacePaths: string[] = []
  /** Permission presets the channel applied, in order. */
  const presetApplications: { sessionId: string; preset: string }[] = []
  /** Recorded so a test can assert the permission behaviour rather than infer it. */
  const permissionPresetsSet = (session: unknown, preset: string): void => {
    presetApplications.push({ sessionId: String((session as { id?: string }).id ?? ''), preset })
  }
  /**
   * The live-session lookup the channel uses before handing the session to `permissionPresets.set`.
   *
   * It takes the object, not an id, so the stub has to hand one back; returning `undefined` would
   * send the channel down its "service unavailable" path and leave the behaviour untested.
   */
  const sessionsGet = (id: string): { id: string; sessionId: string } => ({ id, sessionId: id })
  /**
   * Workspaces other than the channel's, keyed by the path that owns them.
   *
   * Needed to model the real machine, where sessions belong to many projects and a session can only
   * be adopted under its own.
   */
  const workspacesByPath = new Map<string, { id: string; path: string; title: string; setTitle: (title: string) => Promise<void> }>()
  /**
   * The directory the channel owns.
   *
   * Read from the config rather than assumed: a test that overrides `workspace` otherwise has the
   * harness recording its sessions under a directory the channel never uses, so the store looks
   * empty and the workspace appears to change on every turn.
   */
  const channelWorkspace = (options.config?.workspace as string | undefined) ?? join(options.home, 'dsh_wechat')
  const workspace = {
    id: 'workspace-wechat',
    path: channelWorkspace,
    title: 'Ungrouped',
    async setTitle(title: string) {
      workspaceTitles.push(title)
      workspace.title = title
      // Every created session that has not been titled yet takes this name. Real sessions are
      // created and titled in the same order, so the pairing is faithful rather than convenient.
      for (const entry of pendingTitles.splice(0)) entry.title = title
    },
  }
  /**
   * Build a workspace for a path the channel does not own.
   *
   * Carries `setTitle` because the real one does: a stub missing it fails with a type error deep in
   * the adoption path, which reads as a channel bug rather than a harness one.
   *
   * @param path - Directory the workspace owns.
   */
  function makeWorkspace(path: string): {
    id: string
    path: string
    title: string
    setTitle: (title: string) => Promise<void>
  } {
    // The channel's own directory — the one the harness defaults to — keeps its long-standing id,
    // so the many assertions that name it stay readable. Any other path gets a generated one.
    const isDefaultPath = isSameWorkspace(path, channelWorkspace)
    const made = {
      id: isDefaultPath ? 'workspace-wechat' : `workspace-${String(workspacesByPath.size + 1)}`,
      path,
      title: path,
      setTitle: async (title: string) => {
        made.title = title
      },
    }
    workspacesByPath.set(path, made)
    return made
  }

  const ctx = {
    sessionController: {
      create: async (request: Created) => {
        const entry: Created = {
          sessionId: request.sessionId,
          cwd: request.cwd,
          workspaceId: request.workspaceId,
        }
        created.push(entry)
        // Sessions carry no title of their own; the channel names the Workspace it groups them
        // under. Mirroring that here is what lets the list show real titles in a test.
        pendingTitles.push(entry)
        /*
         * Write the session into the on-disk store, as the real host does.
         *
         * The list reads only that store, and the channel asks it whether a session already exists to
         * decide which message a session will be named from — so an unwritten session makes both
         * answers wrong. Adoption happens before the first prompt on the real host, which is why this
         * is written here rather than from `prompt`.
         */
        const sessionId = request.sessionId
        if (sessionId !== undefined) {
          await seedStoredSession(
            options.home,
            channelWorkspace,
            sessionId,
            workspace.title === 'Ungrouped' ? '' : workspace.title,
          )
        }
        return { sessionId: request.sessionId ?? 'session-generated' }
      },
      prompt: async (request: {
        sessionId: string
        mode: 'queue' | 'steer'
        content: readonly { type: 'text'; text: string }[]
      }) => {
        /*
         * Store the session on its first prompt, not when it is adopted.
         *
         * The real host writes a session when it is first used — that is what makes a session
         * "already exists?" answerable from disk, which the channel relies on to know whether this is
         * the message a session will be named from. Writing at adoption time made every session look
         * pre-existing, so that question always answered "no" and the behaviour went untested.
         */
        if (!(await existsStoredSession(options.home, request.sessionId))) {
          await seedStoredSession(
            options.home,
            channelWorkspace,
            request.sessionId,
            workspace.title === 'Ungrouped' ? '' : workspace.title,
          )
        }
        return { sessionId: request.sessionId ?? 'session-generated' }
      },
      prompt: async (request: {
        sessionId: string
        mode: 'queue' | 'steer'
        content: readonly { type: 'text'; text: string }[]
      }) => {
        // A refused steer is a real outcome — the turn it targeted can end first — so the
        // harness can produce it and the fallback path can be exercised.
        if (request.mode === 'steer' && options.refuseSteer === true) {
          throw new Error('session/steer-unavailable: current turn no longer accepts steering')
        }
        if (options.failAllPrompts === true) {
          throw new Error('session/unavailable: the session is gone')
        }
        const text = request.content.map((part) => part.text).join('')
        allPrompts.push({ sessionId: request.sessionId, mode: request.mode, text })
        // The note is filtered out of `prompted`; see the field's own documentation.
        if (!text.startsWith('[渠道：微信]')) {
          prompted.push({ sessionId: request.sessionId, mode: request.mode, text })
        }
        return { accepted: true as const }
      },
      // The host's own session list. Without it `listSessions()` threw inside the router, the
      // failure was recorded as a channel error, and the list feature looked like it worked while
      // never being exercised — so this is part of the harness, not an extra.
      //
      // Deduplicated by id, because the channel calls `create` again every time it resumes a
      // session. The real host lists sessions, not creation events.
      list: async () => {
        // The state the log showed on a real machine: the host knows nothing, and the channel has
        // to fall back to the on-disk store.
        if (options.hostReportsNoSessions === true) return []
        const byId = new Map<string, { sessionId: string; title: string; updatedAt: number }>()
        for (const entry of created) {
          const sessionId = entry.sessionId ?? ''
          if (sessionId === '') continue
          byId.set(sessionId, { sessionId, title: entry.title ?? '', updatedAt: Date.now() })
        }
        return [...byId.values()].reverse()
      },
      cancel: async () => ({}),
    },
    sessions: { get: sessionsGet },
    permissionPresets: { set: permissionPresetsSet },
    workspaceRegistry: {
      /*
       * One workspace per path, as the real registry behaves, and the same object every time that
       * path is resolved — a fresh object per call would hand out a new id on each adoption.
       */
      resolveByPath: async (path: string) => {
        resolvedWorkspacePaths.push(path)
        if (isSameWorkspace(path, workspace.path)) return workspace
        const existing = workspacesByPath.get(path)
        if (existing !== undefined) return existing
        return makeWorkspace(path)
      },
      create: async (path: string) => makeWorkspace(path),
      get: (id: string) =>
        id === workspace.id
          ? workspace
          : [...workspacesByPath.values()].find((entry) => entry.id === id),
      list: () => [workspace, ...workspacesByPath.values()],
    },
    // Present in every real composition, and the agent's only route to sending a file
    // back to WeChat. Captured so a test can invoke the registered tool.
    tools: {
      register: (definition: unknown) => {
        registeredTools.push(definition)
        return () => {
          const index = registeredTools.indexOf(definition)
          if (index >= 0) registeredTools.splice(index, 1)
        }
      },
    },
    effect(execute: () => void | (() => void)) {
      disposer = execute() ?? undefined
    },
    get(name: string) {
      if (name === 'homePaths') return { home: options.home }
      if (name === 'webServer') return { port: 0, register: () => () => {} }
      /*
       * The permission-preset service, reached the way the plugin reaches it.
       *
       * Without this the plugin takes its "service unavailable" path and the permission behaviour is
       * silently untested — which is what the first version of that test proved by failing.
       */
      if (name === 'permissionPresets') {
        return { set: permissionPresetsSet }
      }
      if (name === 'sessions') return { get: sessionsGet }
      return undefined
    },
    provide(name: string, value: unknown) {
      if (name === 'wechatChannel') runtime = value as RuntimeShape
    },
    on(name: string, listener: (...args: unknown[]) => void) {
      events.push(name)
      // Captured so a test can drive the assistant stream the way the host does.
      // Without this the reply path is untestable, which is exactly how a silent
      // "no reply on the phone" defect survived a green suite once already.
      listeners.set(name, listener)
      return () => {}
    },
  }

  apply(ctx as unknown as WechatContext, { autoStart: false, ...options.config }, { send })
  assert.ok(runtime, 'apply() must provide the wechatChannel service')
  return {
    runtime,
    bundleHome: options.home,
    stateFile,
    workspace: join(options.home, 'dsh_wechat'),
    workspaceTitles,
    listeners,
    registeredTools,
    resolvedWorkspacePaths,
    presetApplications,
    created,
    prompted,
    allPrompts,
    sent,
    events,
    dispose: () => disposer?.(),
  }
}

/** One inbound message in the shape the channel produces. */
function inbound(text: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'test@im.bot',
    peerId: 'peer@im.wechat',
    conversationId: 'test@im.bot:peer@im.wechat',
    text,
    contextToken: 'ctx-token-1',
    raw: { message_id: '1', message_type: 1 },
    receivedAt: Date.now(),
    ...overrides,
  }
}

/**
 * Build an inbound message that quotes a message this channel sent.
 *
 * The shape is the observed one: the quote's `message_item` carries `type: 0` and a `msg_id`,
 * and no text at all — which is exactly why the sent-message record has to exist.
 *
 * @param text - What the user wrote alongside the quote.
 * @param quotedId - The `msg_id` of the quoted message.
 */
function quoting(text: string, quotedId: string) {
  return inbound(text, {
    raw: {
      message_id: '2',
      message_type: 1,
      item_list: [
        {
          type: 1,
          text_item: { text },
          ref_msg: {
            message_item: {
              type: 0,
              is_completed: true,
              msg_id: quotedId,
              create_time_ms: 1791290550000,
            },
          },
        },
      ],
    },
  })
}

async function withHarness<T>(
  run: (harness: Harness) => Promise<T>,
  options: {
    config?: Record<string, unknown>
    seedAccount?: boolean
    refuseSteer?: boolean
    failAllPrompts?: boolean
    hostReportsNoSessions?: boolean
  } = {},
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  // Resolve defaults explicitly instead of spreading a partial object over them: a
  // present-but-undefined key would otherwise overwrite the default and silently
  // change what the test exercises.
  const harness = await mount({
    home,
    config: options.config,
    seedAccount: options.seedAccount ?? true,
    refuseSteer: options.refuseSteer,
    failAllPrompts: options.failAllPrompts,
    hostReportsNoSessions: options.hostReportsNoSessions,
  })
  try {
    return await run(harness)
  } finally {
    harness.dispose()
    await removeHome(home)
  }
}

test('apply mounts, provides its service, and subscribes to the assistant stream', async () => {
  await withHarness(async ({ runtime, events }) => {
    assert.ok(events.includes('agent/assistant-stream'))
    const status = await runtime.status()
    assert.equal(status.enabled, false)
    assert.equal(runtime.loginState().phase, 'idle')
    assert.deepEqual(await runtime.bindings(), [])
  })
})

/**
 * The user's own words, without the standing channel note every prompt carries.
 *
 * The note **trails** every prompt, deliberately: DSH names a session from its first prompt, so
 * anything leading would become every conversation's title. Tests about message content therefore
 * compare everything before the note.
 *
 * @param prompt - The prompt as submitted.
 */
function userPart(prompt: string): string {
  return prompt.replace(/\n\n\[渠道：微信\][^\n]*$/, '')
}

test('a WeChat session is given full permissions, so nothing waits on a phone prompt', async () => {
  /*
   * The point of the channel is running the agent from a phone. A session whose policy is `ask` sends
   * a permission prompt to WeChat and then waits for the answer — which means every command stalls on
   * a conversation the user walked away from. So full access is the default for sessions this channel
   * creates, and it has to be set *before* the session's first turn, because DSH refuses to change a
   * preset once a turn has begun.
   */
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('帮我看看这个 bug'))

    assert.equal(harness.presetApplications.length, 1, 'the preset is applied exactly once')
    assert.equal(harness.presetApplications[0].preset, 'danger-full-access')
    assert.equal(
      harness.presetApplications[0].sessionId,
      harness.created[0].sessionId,
      'applied to the session that was just created, not some other one',
    )
  })
})

test('a stored preset of default leaves the profile\'s own policy alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    // `seedAccount: false` matters: the harness's own seeding writes the account *and* the state
    // file, which would overwrite the `default` this test just stored.
    await seedState(home, { permissionPreset: 'default' })
    const harness = await mount({ home, seedAccount: false })
    try {
      await harness.runtime.ingest(inbound('你好'))
      assert.deepEqual(
        harness.presetApplications,
        [],
        'nothing is applied when the user asked for the profile default',
      )
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a plain message creates one session inside the channel workspace and prompts it', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('帮我看看这个 bug'))

    assert.equal(harness.created.length, 1, 'exactly one session is created')
    assert.match(harness.created[0].sessionId ?? '', /^session-[0-9a-f]{8}-/)
    // The load-bearing assertion. `sessionController.create` accepts a workspaceId or
    // a cwd but never both, and only the workspace form groups the session into a
    // named folder — with a bare cwd it lands in the desktop's "Ungrouped" bucket.
    assert.equal(harness.created[0].workspaceId, 'workspace-wechat')
    assert.equal(harness.created[0].cwd, undefined, 'cwd must not accompany a workspaceId')

    assert.equal(harness.prompted.length, 1)
    assert.equal(userPart(harness.prompted[0].text), '帮我看看这个 bug')
    assert.equal(harness.prompted[0].sessionId, harness.created[0].sessionId)

    // The reply token is remembered per conversation, not per peer.
    const state = JSON.parse(await readFile(harness.stateFile, 'utf8'))
    assert.equal(
      state.contextTokens['test@im.bot']['test@im.bot:peer@im.wechat'],
      'ctx-token-1',
    )
  })
})

test('the session folder is registered once and titled 微信会话', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('one'))
    await harness.runtime.ingest(inbound('two'))

    // The desktop renders this title as the folder name; "Ungrouped" is the built-in
    // bucket a cwd-only session falls into, and it cannot be renamed.
    assert.deepEqual(harness.workspaceTitles, ['微信会话'], 'titled once, not per message')
    assert.equal(harness.created[0].workspaceId, harness.created[1].workspaceId)
  })
})

test('a second message reuses the same session with an identical cwd', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('one'))
    await harness.runtime.ingest(inbound('two'))

    assert.equal(harness.created.length, 2, 'the session is re-ensured, not re-created')
    assert.equal(harness.created[0].sessionId, harness.created[1].sessionId)
    // The same Workspace on every adopt is what keeps the session attachable.
    assert.equal(harness.created[0].workspaceId, harness.created[1].workspaceId)
    assert.deepEqual(
      harness.prompted.map((entry) => userPart(entry.text)),
      ['one', 'two'],
    )
  })
})

/**
 * Drive the assistant stream the way the host does and return the reply that reaches
 * WeChat.
 *
 * The frame shape is `{ type, revision, attemptId }` plus, for `chunk` frames, a
 * `chunk` field holding the model chunk. Reading the wrong field here fails silently:
 * no error is raised anywhere and the phone simply never gets an answer.
 *
 * @param chunks - Frames to deliver, in order.
 * @param settleMs - How long to let the batching window run before reading the result.
 */
async function replyFor(
  harness: Harness,
  chunks: readonly Record<string, unknown>[],
  waitMs = 1_500,
): Promise<string | undefined> {
  await harness.runtime.ingest(inbound('hello'))
  const sessionId = harness.prompted[0].sessionId
  const listener = harness.listeners.get('agent/assistant-stream')
  assert.ok(listener, 'apply must subscribe to agent/assistant-stream')
  for (const chunk of chunks) {
    listener({ agent: { session: { id: sessionId } }, frame: chunk })
  }
  // Long enough to outlast the default settle window, which the channel now reads from its
  // settings rather than from a constant.
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  return harness.sent.at(-1)?.text
}

test('assistant text deltas become one batched WeChat reply', async () => {
  await withHarness(async (harness) => {
    const reply = await replyFor(harness, [
      { type: 'chunk', revision: 2, chunk: { type: 'text-delta', index: 0, text: '你好' } },
      { type: 'chunk', revision: 3, chunk: { type: 'text-delta', index: 0, text: '，世界' } },
      { type: 'end', revision: 4 },
    ])
    assert.equal(reply, '你好，世界', 'deltas must be batched into a single message')
    assert.equal(harness.sent.at(-1)?.contextToken, 'ctx-token-1')
  })
})

test('a multi-step turn sends one message, not one per step', async () => {
  await withHarness(async (harness) => {
    // A turn that calls a tool has several model steps, and each step ends with
    // `finish`. Flushing on `finish` would deliver this single answer as three
    // separate WeChat messages.
    const reply = await replyFor(harness, [
      { type: 'chunk', revision: 2, chunk: { type: 'text-delta', index: 0, text: '我先查一下。' } },
      { type: 'chunk', revision: 3, chunk: { type: 'finish' } },
      { type: 'chunk', revision: 4, chunk: { type: 'tool-call-delta', index: 0, id: 'c1', name: 'read', argumentsDelta: '{}' } },
      { type: 'chunk', revision: 5, chunk: { type: 'finish' } },
      { type: 'chunk', revision: 6, chunk: { type: 'text-delta', index: 0, text: '结果是 42。' } },
      { type: 'chunk', revision: 7, chunk: { type: 'finish' } },
      { type: 'end', revision: 8 },
    ])
    assert.equal(harness.sent.length, 1, 'the whole turn is one message')
    assert.equal(reply, '我先查一下。结果是 42。')
  })
})

test('a reply is still delivered when the turn-end frame never arrives', async () => {
  await withHarness(async (harness) => {
    // The settle window is the backstop: a dropped or unrecognised end frame must not
    // leave the answer stranded in the buffer forever.
    const reply = await replyFor(
      harness,
      [{ type: 'chunk', revision: 2, chunk: { type: 'text-delta', index: 0, text: '兜底' } }],
      1_600,
    )
    assert.equal(reply, '兜底')
  })
})

test('reasoning deltas are never sent to WeChat', async () => {
  await withHarness(async (harness) => {
    const reply = await replyFor(harness, [
      { type: 'chunk', revision: 2, chunk: { type: 'reasoning-delta', index: 0, text: '用户在打招呼' } },
      { type: 'chunk', revision: 3, chunk: { type: 'text-delta', index: 0, text: '你好' } },
      { type: 'end', revision: 4 },
    ])
    // The model's scratchpad is not a reply; leaking it would expose private reasoning.
    assert.equal(reply, '你好')
  })
})

test('a turn that ends without text produces no empty message', async () => {
  await withHarness(async (harness) => {
    const reply = await replyFor(harness, [
      { type: 'chunk', revision: 2, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read', argumentsDelta: '{}' } },
      { type: 'chunk', revision: 3, chunk: { type: 'finish' } },
      { type: 'end', revision: 4 },
    ])
    assert.equal(reply, undefined, 'a tool-only turn must not send an empty message')
  })
})

/**
 * Serve one encrypted blob over loopback and hand back the reference an inbound
 * `image_item` would carry.
 *
 * The real ciphertext is used on purpose: stubbing the downloader would skip the AES
 * decryption and the key-form handling, which is exactly where an inbound photo is
 * most likely to go wrong.
 */
async function serveEncrypted(
  plaintext: Buffer,
  aesKey: Buffer,
): Promise<{ reference: Record<string, string>; close: () => Promise<void> }> {
  const { encryptAesEcb } = await import('@dsh-wechat/core')
  const ciphertext = encryptAesEcb(plaintext, aesKey)
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(ciphertext)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    // A `full_url` short-circuits URL building and points the downloader at the stub.
    reference: { full_url: `http://127.0.0.1:${String(address.port)}/blob` },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

test('an inbound image is downloaded, decrypted, and handed to the agent by path', async () => {
  const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const plaintext = Buffer.from('这是一张真实的图片字节')
  const { reference, close } = await serveEncrypted(plaintext, aesKey)

  try {
    await withHarness(async (harness) => {
      // Captioned, but every attachment opens the merge window, so this still waits. The
      // point of the test is the download, decryption, and stored path.
      await harness.runtime.ingest(
        inbound('看看这个', {
          media: [{ type: 2, image_item: { media: reference, aeskey: aesKey.toString('hex') } }],
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 10_600))

      // The prompt must carry the agent to the file, since the file itself is bytes.
      assert.equal(harness.prompted.length, 1)
      const prompt = harness.prompted[0].text
      assert.match(prompt, /\[图片\]/)
      assert.match(prompt, /看看这个/, 'the caption travels with the attachment')
      const path = /\[图片\] (.+?) \(/.exec(prompt)?.[1]
      assert.ok(path, `the prompt must name the stored path, got: ${prompt}`)

      // Round-trip proof: the bytes on disk are the plaintext that went in.
      const written = await readFile(path)
      assert.deepEqual(written, plaintext)
      assert.match(path.replaceAll('\\', '/'), /dsh_wechat\/媒体\//)
    })
  } finally {
    await close()
  }
})

test('a broken attachment is reported without losing the message text', async () => {
  await withHarness(async (harness) => {
    // An unreachable CDN: the download fails, but the caption must still reach the agent.
    await harness.runtime.ingest(
      inbound('这张图打不开', {
        media: [
          {
            type: 2,
            image_item: {
              // A key must be present or the item is skipped before any fetch: the test is
              // about a download that fails, not one that is never attempted.
              media: { full_url: 'http://127.0.0.1:1/nope' },
              aeskey: '00112233445566778899aabbccddeeff',
            },
          },
        ],
      }),
    )

    assert.equal(harness.prompted.length, 1, 'the text still reaches the session')
    assert.equal(userPart(harness.prompted[0].text), '这张图打不开')

    // The failure is surfaced rather than swallowed, so the settings page can show it.
    const status = await harness.runtime.status()
    assert.ok(
      status.errors.some((line) => line.includes('附件下载失败')),
      `expected a recorded attachment failure, got: ${JSON.stringify(status.errors)}`,
    )
  })
})

/**
 * Assert a schema is inside the subset the tool registry accepts.
 *
 * Mirrors `checkSchemaNode` in `@deepseek-ai/dsh-tools`. The registered definition takes
 * real JSON Schema, while the first-party `defineTool` helper takes a different
 * parameter spec (`required: true` *inside* a property). Handing the spec form to
 * `register` throws a JsonSchemaError out of `apply`, which fails plugin activation and
 * takes the desktop application down with it — so the shape is asserted here rather than
 * discovered on someone's restart.
 *
 * @param schema - Schema to check.
 * @param path - Diagnostic path prefix.
 */
function assertSupportedSchema(schema: Record<string, unknown>, path = 'schema'): void {
  const allowed = new Set([
    'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
    'enum', 'const', 'description', 'title',
  ])
  for (const key of Object.keys(schema)) {
    assert.ok(allowed.has(key), `${path}.${key} is not a supported keyword`)
  }

  const type = schema.type
  if (type !== undefined) {
    assert.ok(typeof type === 'string', `${path}.type must be a single string`)
    // Each of these is only meaningful on one container type.
    const scoped: Record<string, readonly string[]> = {
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      items: ['array'],
    }
    for (const [key, types] of Object.entries(scoped)) {
      if (Object.hasOwn(schema, key)) {
        assert.ok(
          types.includes(type as string),
          `${path}.${key} is not supported on type "${String(type)}"`,
        )
      }
    }
  }

  if (Object.hasOwn(schema, 'required')) {
    const required = schema.required
    assert.ok(Array.isArray(required), `${path}.required must be an array of strings`)
    const properties = (schema.properties ?? {}) as Record<string, unknown>
    for (const name of required as string[]) {
      assert.ok(
        Object.hasOwn(properties, name),
        `${path}.required names "${name}" which is not in properties`,
      )
    }
  }
  if (Object.hasOwn(schema, 'additionalProperties')) {
    assert.equal(
      typeof schema.additionalProperties,
      'boolean',
      `${path}.additionalProperties must be a boolean`,
    )
  }
  const properties = schema.properties as Record<string, unknown> | undefined
  if (properties !== undefined) {
    for (const [name, child] of Object.entries(properties)) {
      assertSupportedSchema(child as Record<string, unknown>, `${path}.properties.${name}`)
    }
  }
}

test('the agent gets send_to_wechat, session_control and notify_wechat', async () => {
  await withHarness(async (harness) => {
    // Exactly these three. A duplicate would mean a registration path ran twice, which leaves an
    // extra tool in the agent's list and a stale description behind.
    assert.deepEqual(
      harness.registeredTools.map((tool) => (tool as { name?: string }).name),
      ['send_to_wechat', 'session_control', 'notify_wechat'],
    )

    const tool = harness.registeredTools[0] as {
      name: string
      description: string
      parameters: Record<string, unknown>
      output: { schema: Record<string, unknown> }
    }
    assert.equal(tool.name, 'send_to_wechat')
    assert.deepEqual(tool.parameters.required, ['path'])
    assert.match(tool.description, /WeChat/)

    /*
     * The description must not claim the file has to live in the session workspace.
     *
     * It said exactly that, and nothing enforced it: the send path accepts any path the process can
     * read. The cost was user-visible — an agent that believes the restriction tells the user to copy
     * the file first, or refuses outright, so a photo on the Desktop looked impossible to send. The
     * description is the only thing that decides this behaviour, which is why it is asserted.
     */
    assert.doesNotMatch(tool.description, /inside the session workspace/i)
    assert.match(tool.description, /anywhere on this machine/i)

    // The exact shape registration validates. Getting it wrong throws a
    // JsonSchemaError out of `apply`, which fails plugin activation and takes the
    // whole desktop application down — the worst possible failure for a schema typo.
    assertSupportedSchema(tool.parameters, 'parameters')
    assertSupportedSchema(tool.output.schema, 'output.schema')
  })
})

test('send_to_wechat refuses a session with no bound conversation', async () => {
  await withHarness(async (harness) => {
    const tool = harness.registeredTools[0] as {
      execute(args: unknown, exec: unknown): Promise<unknown>
    }
    // An unbound session has no peer to send to. This must fail loudly with advice
    // rather than silently doing nothing, which would look like a lost file.
    await assert.rejects(
      tool.execute({ path: 'x.png' }, { agent: { session: { id: 'session-unbound' } } }),
      /没有绑定任何微信对话/,
    )
  })
})

test('commands are answered in chat without waking a session', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('/help'))
    assert.equal(harness.prompted.length, 0, 'a command must not reach the agent')
    assert.equal(harness.sent.length, 1)
    assert.match(harness.sent[0].text, /可用指令/)
    assert.equal(harness.sent[0].to, 'peer@im.wechat')
    // The reply token captured from the command message must be echoed back.
    assert.equal(harness.sent[0].contextToken, 'ctx-token-1')
  })
})

/**
 * The session workspace must exist before the host is asked to make a session in it.
 *
 * The host resolves a session's `cwd` with `realpath`, and that fails on a missing directory — so a
 * fresh install answered its first inbound message with `ENOENT: no such file or directory, realpath
 * '<home>/dsh_wechat'`. The user saw only "处理这条消息时出错了".
 *
 * It survived every earlier test because the only other creator was the media writer, which used
 * `recursive: true` and so built the whole chain — but only after an attachment arrived. On any
 * machine where that had happened once, the directory was already there.
 */
test('mounting creates the session workspace, so the first message can be handled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  const harness = await mount({ home, seedAccount: false })
  try {
    assert.equal(
      existsSync(join(home, 'dsh_wechat')),
      true,
      'the workspace directory must exist right after apply, before any message arrives',
    )
  } finally {
    harness.dispose()
    await removeHome(home)
  }
})

/**
 * Seed a bound account and settings, then mount without letting the harness overwrite it.
 *
 * The stored settings are the defaults with `overrides` applied, rather than `overrides` alone:
 * a test that only cares about one value must not silently unset every other one, which would
 * change what the rest of the pipeline does.
 *
 * @param run - Test body.
 * @param overrides - Settings to change from their defaults.
 */
async function withSettings<T>(
  run: (harness: Harness) => Promise<T>,
  overrides: Record<string, unknown> = {},
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  await seedState(home, { ...DEFAULT_SETTINGS, ...overrides })
  const harness = await mount({ home, seedAccount: false })
  try {
    return await run(harness)
  } finally {
    harness.dispose()
    await removeHome(home)
  }
}

/**
 * The registered `session_control` tool, driven the way the agent would drive it.
 *
 * Calls go through the definition the registry actually received, so the schema, the argument
 * handling, and the result shape are exercised together rather than a private method being
 * tested in isolation.
 */
interface SessionTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(
    args: Record<string, unknown>,
    exec: { agent?: unknown },
  ): Promise<{ detail: string; ok: boolean }>
}

function sessionTool(harness: Harness): SessionTool {
  const tool = harness.registeredTools.find(
    (candidate) => (candidate as { name?: string }).name === 'session_control',
  )
  assert.ok(tool, 'session_control must be registered')
  return tool as SessionTool
}

/**
 * Call the session tool as the agent of the conversation's **current** session.
 *
 * The bound session, not the last one prompted: `/new` and `/switch` move the binding, and a tool
 * called from the session the conversation has left is refused now — correctly, because that
 * permission is what let a switched-away session keep sending messages to the user's phone.
 *
 * @param harness - Mounted harness.
 * @param action - Action to invoke.
 * @param target - Optional target argument.
 */
async function control(
  harness: Harness,
  action: string,
  target?: string,
): Promise<{ detail: string; ok: boolean; otherWorkspaces: number }> {
  const bound = await harness.runtime.bindings()
  const sessionId =
    bound[0]?.sessionId ?? harness.prompted.at(-1)?.sessionId ?? harness.created.at(-1)?.sessionId
  assert.ok(sessionId, 'a session must exist before the tool can be called')
  const args: Record<string, unknown> = { action }
  if (target !== undefined) args.target = target
  return await sessionTool(harness).execute(args, { agent: { session: { id: sessionId } } })
}

/** Call the session tool as the agent of a named session. */
async function controlFrom(
  harness: Harness,
  sessionId: string,
  action: string,
  target?: string,
): Promise<{ detail: string; ok: boolean; otherWorkspaces: number }> {
  const args: Record<string, unknown> = { action }
  if (target !== undefined) args.target = target
  return await sessionTool(harness).execute(args, { agent: { session: { id: sessionId } } })
}

test('the channel note never precedes the request in what the namer sees', async () => {
  /*
   * DSH names a session from its first prompt, and that naming sees the whole prompt text. A note
   * that led the prompt is what filled the store with 「微信渠道对话支持」 and 「微信手机对话助手」,
   * so the ordering here is the thing being defended.
   *
   * The channel also splits the first message — request alone, then the note — which removes the note
   * from the naming text entirely. That split depends on asking the store whether a session already
   * exists, and this harness writes the session at adoption time, so the split is not reachable from
   * a test here; the ordering below holds either way, which is what makes it worth asserting.
   */
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('帮我查一下明天的天气'))

    const submitted = harness.allPrompts[0]?.text ?? ''
    assert.match(submitted, /^帮我查一下明天的天气/, 'the request comes first')
    assert.equal(
      submitted.indexOf('[渠道：微信]') > submitted.indexOf('帮我查一下明天的天气'),
      true,
      'and the note comes after it',
    )
  })
})

test('the session tool offers every action the user can ask for', async () => {
  await withSettings(async (harness) => {
    const tool = sessionTool(harness)
    const action = (tool.parameters.properties as Record<string, { enum?: string[] }>).action
    // The enum is what the model chooses from, so an action missing here is unreachable.
    assert.deepEqual(action?.enum, ['list', 'switch', 'new', 'current', 'cancel'])
    assert.deepEqual(tool.parameters.required, ['action'])
  })
})

test('the session tool lists conversations with the number to answer', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    await harness.runtime.ingest(inbound('/new 修复登录'))
    await harness.runtime.ingest(inbound('第二条'))
    const before = harness.sent.length

    const result = await control(harness, 'list')
    assert.equal(result.ok, true)

    /*
     * The list is delivered by the channel, not relayed by the agent.
     *
     * The log showed the cost of the other arrangement: the tool ran, the rows came back, and the
     * agent replied 「已为你列出对话列表，请看上面的消息」 — pointing at a message that never
     * existed, because a tool result is only ever shown to the agent.
     */
    assert.equal(harness.sent.length, before + 1, 'exactly one message was sent')
    const body = harness.sent.at(-1)?.text ?? ''
    // A count, a numbered row per conversation with the current one marked, the id that tells two
    // same-workspace conversations apart, and the sentence that makes it answerable.
    assert.match(body, /共 2 个对话/)
    assert.match(body, /1\. /)
    assert.match(body, /2\. /)
    assert.match(body, /← 当前/)
    assert.match(body, /回复数字即可切换/)
    // Rendered once. A duplicated table reads as two separate lists.
    assert.equal(body.match(/1\. /g)?.length, 1, 'the rows appear once')
    // And the agent is told not to repeat it, or every request would arrive twice.
    assert.match(result.detail, /不要重复/)
  })
})

test('a session the conversation has left cannot speak for it any more', async () => {
  /*
   * The bug this guards, found in real use: after `/new`, the session the plugin was being developed
   * in stayed an *owner* of the WeChat conversation, so a question asked from it — from an entirely
   * different harness session — arrived on the user's phone. Ownership was being treated as
   * permission.
   *
   * Ownership still has to exist, for tracing a session back to its conversation. It just must not
   * authorize anything.
   */
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const left = harness.prompted[0]?.sessionId
    assert.ok(left)
    await harness.runtime.ingest(inbound('/new 修复登录'))

    // The conversation has moved on, so this session is no longer the one bound to it.
    const bound = await harness.runtime.bindings()
    assert.notEqual(bound[0]?.sessionId, left, 'the binding really did move')

    // Speaking for the conversation from the abandoned session is refused.
    const refused = await controlFrom(harness, String(left), 'list')
    assert.equal(refused.ok, false)
    assert.match(refused.detail, /没有绑定/)

    // And it cannot make the channel send anything.
    const before = harness.sent.length
    const send = harness.registeredTools.find(
      (candidate) => (candidate as { name?: string }).name === 'send_to_wechat',
    ) as { execute(args: Record<string, unknown>, exec: { agent?: unknown }): Promise<unknown> }
    await assert.rejects(
      async () =>
        await send.execute(
          { path: join(harness.bundleHome, 'anything.txt') },
          { agent: { session: { id: left } } },
        ),
      /没有绑定/,
    )
    assert.equal(harness.sent.length, before, 'nothing reached the chat')
  })
})

test('a switch is announced to the user by the channel, not left to the agent', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    await harness.runtime.ingest(inbound('/new 修复登录'))
    const before = harness.sent.length

    const moved = await control(harness, 'switch', '2')
    assert.equal(moved.ok, true, `switch failed: ${moved.detail}`)

    // The log showed the real failure: the tool ran, the binding moved, and nothing reached the
    // phone. The agent cannot announce this — its words go to the session the chat just left — so
    // the channel has to.
    assert.equal(harness.sent.length, before + 1, 'exactly one notice was sent')
    assert.match(harness.sent.at(-1)?.text ?? '', /已切换到/)
    assert.equal(harness.sent.at(-1)?.to, 'peer@im.wechat')
  })
})

test('creating a conversation is announced too, and says messages now go there', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const before = harness.sent.length

    const created = await control(harness, 'new')
    assert.equal(created.ok, true)

    assert.equal(harness.sent.length, before + 1)
    assert.match(harness.sent.at(-1)?.text ?? '', /已新建对话/)
    assert.match(harness.sent.at(-1)?.text ?? '', /发到这里/)
  })
})

test('a failed switch tells the user, because the agent may claim it worked', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const before = harness.sent.length

    const missed = await control(harness, 'switch', '99')
    assert.equal(missed.ok, false)

    /*
     * The user is told directly, and the log is why: the tool returned `ok: false` and the agent then
     * said 「已切过去了，直接说你想问的就行」. Nothing in the WeChat chat changes on a failed switch,
     * so without a message from the channel the user cannot tell — until their next message lands in
     * the conversation they believed they had left.
     */
    assert.equal(harness.sent.length, before + 1, 'the failure is announced')
    const body = harness.sent.at(-1)?.text ?? ''
    assert.match(body, /没有成功/)
    assert.match(body, /99/, 'the message names what was asked for')
    // And how to succeed instead.
    assert.match(body, /\/list/)
  })
})

test('a switch can reach a conversation in another workspace', async () => {
  /*
   * The failure this guards: a session from another workspace appeared in `/list all`, the user asked
   * for it by name, and the search only ever looked inside the channel's own workspace — so a
   * conversation that had just been listed could not be selected.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedState(home, { ...DEFAULT_SETTINGS, requireConfirmation: false })
    const foreign = join(home, 'some_project')
    const foreignId = 'session-ffff9999-ffff9999-x'
    await seedStoredSession(home, foreign, foreignId, '微信或手机如何联系AI')
    const harness = await mount({ home, seedAccount: false, hostReportsNoSessions: true })
    try {
      await harness.runtime.ingest(inbound('第一条'))

      const moved = await control(harness, 'switch', '微信或手机如何联系AI')
      assert.equal(moved.ok, true, `switch failed: ${moved.detail}`)
      assert.match(harness.sent.at(-1)?.text ?? '', /已切换到「微信或手机如何联系AI」/)

      // And the move is real: the next message goes to that session.
      await harness.runtime.ingest(inbound('切过去之后'))
      assert.equal(harness.prompted.at(-1)?.sessionId, foreignId)
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('the on-disk store supplies the list when the host reports nothing', async () => {
  /*
   * The failure this guards is the one seen in the log: `sessionController.list()` returned an
   * empty array, so `/list` answered with nothing and a request to switch by name failed — while
   * nine conversations for this workspace sat on disk the whole time.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedState(home, { ...DEFAULT_SETTINGS, requireConfirmation: false })
    const workspace = join(home, 'dsh_wechat')
    const storedId = 'session-aaaa1111-aaaa1111-aaaa-1111-111111111111'
    const folder = join(home, 'sessions', encodeWorkspaceDir(workspace), storedId)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'session.v4.jsonl.zstd'), 'x')
    await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(
      join(home, 'storages', 'session_projcache', 'sessions', `${storedId}.json`),
      JSON.stringify({
        record: {
          identity: { cwd: workspace },
          rows: { title: { val: '解题辅导会话' } },
        },
      }),
    )

    // `hostReportsNoSessions` is the state the log showed.
    const harness = await mount({ home, seedAccount: false, hostReportsNoSessions: true })
    try {
      await harness.runtime.ingest(inbound('第一条'))

      const listed = await control(harness, 'list')
      assert.equal(listed.ok, true)
      // The list is sent to the chat, so the stored session has to appear there.
      assert.match(
        harness.sent.at(-1)?.text ?? '',
        /解题辅导会话/,
        'the stored session is listed with its title',
      )

      // And it is switchable — a list of conversations that cannot be selected is not a list.
      const moved = await control(harness, 'switch', '解题辅导会话')
      assert.equal(moved.ok, true, `switch failed: ${moved.detail}`)
      assert.match(harness.sent.at(-1)?.text ?? '', /已切换到「解题辅导会话」/)
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

/**
 * Session store writes made during this test file, in order.
 *
 * The list orders by a session directory's newest write time. A test creating two sessions in the
 * same millisecond gives them the same time, which makes the order depend on the filesystem's clock
 * granularity — so the store writes are spaced deliberately instead.
 *
 * The spacing counts **up** from the start of the run. Counting down from the current time looks
 * equivalent and is not: after enough writes the stamp goes negative, `utimes` throws on a negative
 * time, and the failure lands in whichever later test happens to be running. That is how this first
 * appeared — two tests that pass alone and fail in the full suite.
 */
let storeWriteSeq = 0
const storeWriteBase = Date.now()

/**
 * Seed one session belonging to an arbitrary workspace.
 *
 * @param home - Temporary DSH home.
 * @param workspace - Directory the session belongs to.
 * @param id - Session id.
 * @param title - Title the store should report.
 */
async function seedStoredSession(
  home: string,
  workspace: string,
  id: string,
  title: string,
  at?: number,
): Promise<void> {
  const folder = join(home, 'sessions', encodeWorkspaceDir(workspace), id)
  await mkdir(folder, { recursive: true })
  const transcript = join(folder, 'session.v4.jsonl.zstd')
  await writeFile(transcript, 'x')
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(
    join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
    JSON.stringify({
      record: { identity: { cwd: workspace }, rows: { title: { val: title } } },
    }),
  )
  // A second apart, oldest first, so 「newest first」 is a fact rather than a tie to break.
  const stamp = at ?? storeWriteBase + storeWriteSeq++ * 1_000
  const seconds = stamp / 1_000
  await utimes(transcript, seconds, seconds)
}

/**
 * Whether the store already holds this session.
 *
 * Mirrors how the real host answers the same question, which decides whether a message is the one a
 * session will be named from.
 *
 * @param home - Temporary DSH home.
 * @param sessionId - Session to look for.
 */
async function existsStoredSession(home: string, sessionId: string): Promise<boolean> {
  try {
    const entries = await readdir(join(home, 'sessions'), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const inside = await readdir(join(home, 'sessions', entry.name), { withFileTypes: true })
      if (inside.some((child) => child.isDirectory() && child.name === sessionId)) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Record a session in the store the way the host would, with no title yet.
 *
 * The channel's own workspace is assumed: that is the only place a session created through the
 * harness can belong, and the title is filled in later by {@link Harness} workspace naming.
 *
 * @param home - Temporary DSH home.
 * @param sessionId - Session to record.
 */
async function writeStoredSession(home: string, sessionId: string): Promise<void> {
  await seedStoredSession(home, join(home, 'dsh_wechat'), sessionId, '')
}

test('another workspace is counted and named as reachable, not listed by default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedState(home, { ...DEFAULT_SETTINGS, requireConfirmation: false })
    const foreign = join(home, 'some_project')
    await seedStoredSession(home, foreign, 'session-ffff9999-ffff9999-x', '解题辅导会话')
    const harness = await mount({ home, seedAccount: false, hostReportsNoSessions: true })
    try {
      await harness.runtime.ingest(inbound('第一条'))

      await control(harness, 'list')
      const body = harness.sent.at(-1)?.text ?? ''
      // The default list stays short: this chat's own conversations only.
      assert.doesNotMatch(body, /解题辅导会话/)
      // But the user is told the rest exists, which workspaces they are in, and how to reach them —
      // otherwise they never learn that conversations from other projects can be switched to.
      assert.match(body, /另有 1 个对话在别的工作区/)
      assert.match(body, /some_project/, 'the workspace is named, not just counted')
      assert.match(body, /看全部对话/)

      await control(harness, 'list', 'all')
      assert.match(harness.sent.at(-1)?.text ?? '', /解题辅导会话/, 'the wider list shows it')
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a session from another workspace is adopted under its own workspace', async () => {
  /*
   * The bug this guards: `ensureSession` used the channel's workspace for everything, so a session
   * belonging to another project could not be resumed — the host pins a session's `cwd` and rejects
   * an adopt that names the wrong one.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedState(home, { ...DEFAULT_SETTINGS, requireConfirmation: false })
    const foreign = join(home, 'some_project')
    const foreignId = 'session-ffff9999-ffff9999-x'
    await seedStoredSession(home, foreign, foreignId, '解题辅导会话')
    const harness = await mount({ home, seedAccount: false, hostReportsNoSessions: true })
    try {
      await harness.runtime.ingest(inbound('第一条'))
      const moved = await control(harness, 'switch', '解题辅导会话')
      assert.equal(moved.ok, true, `switch failed: ${moved.detail}`)

      // Adopted through a workspace of its own, not the channel's.
      const adoption = harness.created.find((entry) => entry.sessionId === foreignId)
      assert.ok(adoption, 'the foreign session was adopted')
      assert.notEqual(
        adoption.workspaceId,
        'workspace-wechat',
        'it must not be adopted under the channel workspace',
      )
      // And the registry was asked about the session's own directory.
      assert.ok(
        harness.resolvedWorkspacePaths.some((path) => isSameWorkspace(path, foreign)),
        `expected the foreign path to be resolved, got ${harness.resolvedWorkspacePaths.join(', ')}`,
      )
      assert.equal(adoption.cwd, undefined, 'a workspace id and a cwd are never sent together')

      // The conversation really is on it now.
      await harness.runtime.ingest(inbound('切过去之后的第一句'))
      assert.equal(harness.prompted.at(-1)?.sessionId, foreignId)
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('the channel workspace is still used for its own sessions', async () => {
  // The regression that matters most: making adoption session-aware must not stop the channel's own
  // conversations from being created and resumed as before.
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const own = harness.created[0]
    assert.equal(own.workspaceId, 'workspace-wechat')
    assert.equal(own.cwd, undefined)
    assert.equal(harness.workspaceTitles.includes('微信会话'), true)
  })
})

test('the session tool switches, and the move is real', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const first = harness.prompted[0].sessionId
    await harness.runtime.ingest(inbound('/new 修复登录'))

    /*
     * The older conversation is found by which row is *not* marked current.
     *
     * `/new` has just moved the conversation into a fresh session, so exactly one row carries the
     * marker and the other is where this moves back to. Locating it this way avoids depending on the
     * list's ordering, which for two sessions created in the same millisecond is not stable.
     */
    await control(harness, 'list')
    const body = harness.sent.at(-1)?.text ?? ''
    const rows = body.split('\n').filter((line) => /^\d+\. /.test(line))
    assert.equal(rows.length, 2, `expected two conversations, got: ${body}`)

    const older = rows.findIndex((line) => !line.includes('← 当前'))
    assert.ok(older >= 0, `exactly one row should be current: ${body}`)

    const moved = await control(harness, 'switch', String(older + 1))
    assert.equal(moved.ok, true, `switch failed: ${moved.detail}`)
    assert.match(moved.detail, /已切换/)

    const promptsBefore = harness.prompted.length
    await harness.runtime.ingest(inbound('换回来之后的第一句'))
    assert.equal(harness.prompted.length, promptsBefore + 1)
    // The work goes back into the older session — the one the list showed, identified by the short id
    // printed beside that row. Comparing one prompt with the previous one would prove nothing: `/new`
    // does not prompt, so the previous prompt was the very session being left.
    const olderLine = rows[older] ?? ''
    // The id sits on the line after its row, which is where the renderer puts it.
    const olderShort = /([0-9a-f]{8})/.exec(body.split('\n')[body.split('\n').indexOf(olderLine) + 1] ?? '')?.[1]
    assert.ok(olderShort, `no short id on the older row: ${olderLine}`)
    assert.equal(shortId(String(harness.prompted.at(-1)?.sessionId)), olderShort)
    assert.ok(first !== undefined)
  })
})

test('the session tool starts a new conversation and moves into it', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const before = harness.prompted[0].sessionId

    const created = await control(harness, 'new', '写周报')
    assert.equal(created.ok, true)
    assert.match(created.detail, /已新建对话「写周报」/)

    await harness.runtime.ingest(inbound('新对话里的第一句'))
    assert.notEqual(harness.prompted.at(-1)?.sessionId, before, 'the conversation moved')
  })
})

test('a switch to something unknown reports failure instead of a phantom move', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))

    const missed = await control(harness, 'switch', '99')
    // The command answers with guidance rather than throwing, so the result has to be read rather
    // than assumed — otherwise the agent tells the user it switched when nothing happened.
    assert.equal(missed.ok, false)
    assert.match(missed.detail, /找不到/)
  })
})

test('the session tool reports the current conversation', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const result = await control(harness, 'current')
    assert.equal(result.ok, true)
    // The marker is the answer to "which one am I in", so it has to be present and unambiguous.
    assert.match(result.detail, /← 当前/)
    assert.match(result.detail, /1\. /)
  })
})

test('the session tool cancels without starting a turn', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const promptsBefore = harness.prompted.length

    const result = await control(harness, 'cancel')
    assert.equal(result.ok, true)
    assert.match(result.detail, /已请求中断/)
    assert.equal(harness.prompted.length, promptsBefore, 'cancelling is not a new turn')
  })
})

test('the session tool refuses when the caller is not bound to a WeChat conversation', async () => {
  await withSettings(async (harness) => {
    const result = await sessionTool(harness).execute(
      { action: 'list' },
      { agent: { session: { id: 'session-not-ours' } } },
    )
    assert.equal(result.ok, false)
    assert.match(result.detail, /没有绑定/)
  })
})

test('the confirmation policy travels in the tool description and follows the setting', async () => {
  await withSettings(async (harness) => {
    // On by default: the agent is told to state its intent and wait. Judging intent is the agent's
    // job, so the confirmation is what stands between an inferred intent and an effect.
    const description = sessionTool(harness).description
    assert.match(description, /wait for the user to agree/)
    // And it is told not to claim an outcome itself. The log shows why: the tool returned
    // `ok: false` and the agent told the user the switch had worked, which the user only discovered
    // when their next message landed in the conversation they thought they had left.
    assert.match(description, /Never tell the user a switch or a new conversation succeeded/)
    assert.match(description, /including when they fail/)
  })

  await withSettings(
    async (harness) => {
      // The registry takes the description by value, so a setting that did not re-register would
      // appear to do nothing until the next restart.
      assert.match(sessionTool(harness).description, /confirmation off/)
    },
    { requireConfirmation: false },
  )
})

/**
 * Wait for a condition the channel reaches asynchronously.
 *
 * A confirmation is answered by a later message, so the question is sent from a detached task
 * rather than inside the inbound call. Tests therefore have to wait for the effect instead of
 * asserting the instant `ingest` returns — and polling with a deadline keeps a genuine hang
 * failing fast rather than holding the suite open.
 *
 * @param check - Condition that becomes true.
 * @param what - Description used in the failure message.
 */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}


/** An inbound image item pointing at a loopback blob. */
async function imageMessage(
  aesKey: Buffer,
  caption: string,
  reference: Record<string, string>,
): Promise<ReturnType<typeof inbound>> {
  return inbound(caption, {
    media: [{ type: 2, image_item: { media: reference, aeskey: aesKey.toString('hex') } }],
  })
}

test('a caption-less photo waits for a caption instead of prompting on its own', async () => {
  const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const { reference, close } = await serveEncrypted(Buffer.from('photo bytes'), aesKey)

  try {
    await withHarness(async (harness) => {
      await harness.runtime.ingest(await imageMessage(aesKey, '', reference))

      // Parked, not prompted: otherwise the caption that follows becomes a second
      // unrelated turn and the user gets two answers to one question.
      assert.equal(harness.prompted.length, 0, 'the photo is held, not acted on yet')
      assert.equal(harness.sent.length, 0, 'nothing is said while waiting')
    })
  } finally {
    await close()
  }
})

test('a caption arriving within the window merges with the parked photo', async () => {
  const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const { reference, close } = await serveEncrypted(Buffer.from('photo bytes'), aesKey)

  try {
    await withHarness(async (harness) => {
      await harness.runtime.ingest(await imageMessage(aesKey, '', reference))
      await harness.runtime.ingest(inbound('这张图里是什么？'))

      assert.equal(harness.prompted.length, 1, 'one prompt, not two')
      const prompt = harness.prompted[0].text
      assert.match(prompt, /\[图片\]/, 'the attachment is described')
      assert.match(prompt, /这张图里是什么？/, 'and the caption is there')
      // The caption leads and the description follows it, because DSH names the session from the
      // start of the first prompt: a description at the top would name every conversation
      // 「[图片]」 instead of what the user asked about it.
      assert.ok(
        prompt.indexOf('这张图里是什么？') < prompt.indexOf('[图片]'),
        'the caption leads the description',
      )
    })
  } finally {
    await close()
  }
})

test('a caption that never comes releases the photo after the window', async () => {
  const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const { reference, close } = await serveEncrypted(Buffer.from('photo bytes'), aesKey)

  try {
    await withHarness(async (harness) => {
      await harness.runtime.ingest(await imageMessage(aesKey, '', reference))
      assert.equal(harness.prompted.length, 0)

      // Wait out the merge window; the photo must not be stranded.
      await new Promise((resolve) => setTimeout(resolve, 10_600))

      assert.equal(harness.prompted.length, 1, 'the photo is prompted once the window closes')
      assert.match(harness.prompted[0].text, /\[图片\]/)
    })
  } finally {
    await close()
  }
})

test('a caption-less photo and its caption reach the same session', async () => {
  const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const { reference, close } = await serveEncrypted(Buffer.from('photo bytes'), aesKey)

  try {
    await withHarness(async (harness) => {
      await harness.runtime.ingest(await imageMessage(aesKey, '', reference))
      await harness.runtime.ingest(inbound('看这个'))
      // A merge that created a second session would lose the conversation's context.
      assert.equal(harness.created.length, 1, 'one session for the pair')
    })
  } finally {
    await close()
  }
})

test('a captioned photo waits too, so a follow-up joins it instead of starting a new turn', async () => {
  const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const { reference, close } = await serveEncrypted(Buffer.from('photo bytes'), aesKey)

  try {
    await withHarness(async (harness) => {
      // Every attachment opens the window, captioned or not. Acting on the caption
      // immediately would make whatever the user types next a second, unrelated turn —
      // which is exactly the stray-reply behaviour this window exists to prevent.
      await harness.runtime.ingest(await imageMessage(aesKey, '看这张图', reference))
      assert.equal(harness.prompted.length, 0, 'a captioned photo still waits')

      await harness.runtime.ingest(inbound('重点是右上角'))

      assert.equal(harness.prompted.length, 1, 'one prompt, not two')
      const prompt = harness.prompted[0].text
      assert.match(prompt, /\[图片\]/)
      assert.match(prompt, /看这张图/, 'the photo keeps its own caption')
      assert.match(prompt, /重点是右上角/, 'and the follow-up joins it')
      // The photo must not be described twice.
      assert.equal(prompt.split('[图片]').length - 1, 1, 'the attachment is listed once')
    })
  } finally {
    await close()
  }
})

test('attachments from several messages accumulate into one prompt', async () => {
  const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const { reference, close } = await serveEncrypted(Buffer.from('photo bytes'), aesKey)

  try {
    await withHarness(async (harness) => {
      // A file followed by a photo, then the instruction: all three belong to one request.
      // The file carries its key on the reference, which is how a real inbound file arrives.
      await harness.runtime.ingest(
        inbound('', {
          media: [
            {
              type: 4,
              file_item: {
                media: { ...reference, aes_key: aesKeyToBase64(aesKey) },
                file_name: 'a.txt',
                len: '2',
              },
            },
          ],
        }),
      )
      await harness.runtime.ingest(await imageMessage(aesKey, '', reference))
      assert.equal(harness.prompted.length, 0)

      await harness.runtime.ingest(inbound('对比一下'))

      assert.equal(harness.prompted.length, 1, 'three messages, one prompt')
      const prompt = harness.prompted[0].text
      assert.match(prompt, /\[文件\]/)
      assert.match(prompt, /\[图片\]/)
      assert.match(prompt, /对比一下/)
    })
  } finally {
    await close()
  }
})

test('/new switches the conversation to a freshly created session', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('first'))
    const firstSession = harness.prompted[0].sessionId

    await harness.runtime.ingest(inbound('/new 第二个会话'))
    assert.match(harness.sent.at(-1)?.text ?? '', /第二个会话/)

    await harness.runtime.ingest(inbound('second'))
    const secondSession = harness.prompted.at(-1)?.sessionId
    assert.ok(secondSession)
    assert.notEqual(secondSession, firstSession)
    assert.equal(harness.created.at(-1)?.workspaceId, 'workspace-wechat')

    const bindings = await harness.runtime.bindings()
    assert.equal(bindings.length, 1, 'one conversation holds one binding at a time')
    assert.equal(bindings[0].sessionId, secondSession)
    assert.equal(bindings[0].title, '第二个会话')
  })
})

test('routing survives a remount: the same session is adopted again', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    const first = await mount({ home, seedAccount: true })
    await first.runtime.ingest(inbound('first'))
    const sessionId = first.prompted[0].sessionId
    first.dispose()

    // A fresh mount reads the persisted binding and adopts the same session.
    const second = await mount({ home })
    await second.runtime.ingest(inbound('after restart'))
    assert.equal(second.created.length, 1)
    assert.equal(second.created[0].sessionId, sessionId)
    assert.equal(second.created[0].workspaceId, 'workspace-wechat')
    // Re-resolution goes through the same path, so the folder is unchanged.
    assert.deepEqual(second.resolvedWorkspacePaths, [second.workspace])
    second.dispose()
  } finally {
    await removeHome(home)
  }
})

test('the workspace override is honoured and stays constant', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  const custom = join(home, 'custom-ws')
  const harness = await mount({ home, seedAccount: true, config: { workspace: custom } })
  try {
    await harness.runtime.ingest(inbound('one'))
    await harness.runtime.ingest(inbound('two'))
    // The configured directory is the one registered, and the resolution is cached: the host refuses
    // an adopt whose workspace differs, so it must never drift. The id itself is the harness's to
    // choose, so what matters is that both turns used the same one.
    assert.deepEqual(harness.resolvedWorkspacePaths, [custom])
    const ids = harness.created.map((entry) => entry.workspaceId)
    assert.equal(ids.length, 2)
    assert.equal(ids[0], ids[1], 'the workspace must not drift between turns')
    assert.ok(ids[0] !== undefined && ids[0] !== '', 'a workspace was named')
  } finally {
    harness.dispose()
    await removeHome(home)
  }
})

test('a quote of a message this channel sent reaches the agent as its content', async () => {
  await withHarness(async (harness) => {
    // Bind the session and make the channel send one reply, whose id is then recorded.
    await harness.runtime.ingest(inbound('第一句'))
    const first = harness.prompted[0]
    assert.ok(first)

    // A command reply is the simplest way to get a message on the record, and it is also the
    // case where the reply never reached the agent.
    await harness.runtime.ingest(inbound('/help'))
    const sentReply = harness.sent.at(-1)
    assert.ok(sentReply?.text, 'the command produced a reply to quote')

    // Quote that reply. Its text exists nowhere in the quote itself — only its id — so a prompt
    // carrying the original wording proves the lookup worked.
    await harness.runtime.ingest(quoting('这个再展开说说', 'msg-1'))
    const last = harness.prompted.at(-1)
    assert.ok(last)
    assert.match(last.text, /\[引用我此前发送的消息\]/, 'the quote is labelled')
    assert.match(last.text, /这个再展开说说/, 'the user instruction is still there')
    // The request leads and the quote follows, because DSH names the session from whatever comes
    // first — a quoted message at the top would name every conversation after someone else's words.
    // The label is what keeps the quote from being read as the request.
    assert.ok(
      last.text.indexOf('这个再展开说说') < last.text.indexOf('[引用'),
      'the request leads and the quote follows',
    )
  })
})

test('a quote of an unknown message is disclosed instead of silently ignored', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('第一句'))
    // A quote of something this channel has no record of. Saying so is what stops the agent
    // from answering an instruction whose subject it never saw.
    await harness.runtime.ingest(quoting('这个再展开说说', '9999999999999999999'))
    const last = harness.prompted.at(-1)
    assert.ok(last)
    assert.match(last.text, /内容已不在缓存中/)
    assert.match(last.text, /9999999999999999999/, 'the id is named, for diagnosis')
  })
})

test('a message with no quote is unaffected', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('普通消息'))
    const last = harness.prompted.at(-1)
    assert.ok(last)
    assert.doesNotMatch(last.text, /\[引用/, 'no quote line is invented')
  })
})

test('a message interrupts the running turn instead of queuing behind it', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('给我找一张图片'))
    await harness.runtime.ingest(inbound('要边境牧羊犬的图'))

    // A queued follow-up is only read after the first request runs to completion, which is the
    // behaviour being replaced: the second message corrects work in progress rather than being
    // a new request behind it.
    assert.deepEqual(
      harness.prompted.map((entry) => entry.mode),
      ['steer', 'steer'],
    )
  })
})

test('a refused steer falls back to the queue rather than losing the message', async () => {
  await withHarness(
    async (harness) => {
      await harness.runtime.ingest(inbound('改一下方向'))
      // The submission runs detached from ingest, and the fallback adds a round trip, so the
      // assertion waits rather than racing it.
      await new Promise((resolve) => setTimeout(resolve, 60))

      // A refused steer must still be submitted: a lost message cannot be reconstructed, while
      // a delayed one is merely late.
      assert.deepEqual(
        harness.prompted.map((entry) => entry.mode),
        ['queue'],
        'the fallback lands in the queue',
      )
      assert.match(harness.prompted[0].text, /改一下方向/, "the user's words survive the fallback")

      const log = await readFile(join(harness.bundleHome, 'wechat', 'boot.log'), 'utf8')
      assert.match(log, /steer refused, falling back to queue/)
    },
    { refuseSteer: true },
  )
})

test('a message that cannot be submitted is handed back, not dropped', async () => {
  await withHarness(
    async (harness) => {
      await harness.runtime.ingest(inbound('这句话不能丢'))
      await new Promise((resolve) => setTimeout(resolve, 60))

      // Both attempts failed. The user's own text is the only copy that exists, so it is
      // returned rather than replaced by a generic apology.
      const reply = harness.sent.at(-1)
      assert.ok(reply)
      assert.match(reply.text, /没能把消息交给会话/)
      assert.match(reply.text, /这句话不能丢/, 'the words come back')
    },
    { failAllPrompts: true },
  )
})

test('the agent is told it is on WeChat and should send things rather than point at paths', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('帮我看下这个文件'))
    // Without this the agent answers as if its user is at the desktop console, telling someone
    // on a phone to open a local path they cannot reach.
    assert.match(harness.prompted[0].text, /\[渠道：微信\]/)
    assert.match(harness.prompted[0].text, /看不到这台电脑的屏幕和文件系统/)
    // The note trails rather than leads: DSH names a session from the start of its first prompt, so
    // a leading note named every WeChat conversation after the note instead of the question.
    assert.match(harness.prompted[0].text, /^帮我看下这个文件/)
  })
})

/**
 * Bind a conversation to a live session and return that session's id.
 *
 * Approval and question prompts are claimed only for sessions bound to a WeChat conversation —
 * that is what keeps desktop behaviour untouched — so a test about answering them must bind one
 * first, exactly as a real conversation would.
 *
 * @param harness - Mounted harness.
 * @returns The bound session id.
 */
async function bindConversation(harness: Harness): Promise<string> {
  await harness.runtime.ingest(inbound('先建立会话'))
  const sessionId = harness.prompted[0]?.sessionId
  assert.ok(sessionId, 'the first message bound a session')
  return sessionId
}

test('case 1: a permission prompt is answered from WeChat', async () => {
  await withHarness(async (harness) => {
    const sessionId = await bindConversation(harness)
    const approval = harness.listeners.get('approval/request')
    assert.ok(approval, 'the plugin claims approval requests')

    let delegated = false
    // The harness hands the answerer a `next()` that another answerer (the desktop pane) owns.
    const outcomePromise = approval(
      {
        agent: { session: { id: sessionId } },
        toolName: 'shell',
        reason: 'rm -rf build',
      },
      () => {
        delegated = true
        return Promise.resolve('delegated' as const)
      },
    )

    // The prompt reaches the phone without the desktop being involved.
    await new Promise((resolve) => setTimeout(resolve, 30))
    const prompt = harness.sent.at(-1)
    assert.ok(prompt, 'a prompt was sent')
    assert.match(prompt.text, /需要你确认/)
    assert.match(prompt.text, /shell/)
    assert.match(prompt.text, /rm -rf build/)
    assert.match(prompt.text, /回复 允许 或 拒绝/)
    assert.equal(delegated, false, 'the request was claimed, not delegated')

    // The reply settles the prompt instead of being routed to the agent as a new request.
    const promptsBefore = harness.prompted.length
    await harness.runtime.ingest(inbound('允许'))
    const outcome = await outcomePromise

    assert.equal(outcome, 'allowed-once')
    assert.equal(harness.prompted.length, promptsBefore, 'the reply did not reach the agent')
  })
})

test('case 1: a refusal over WeChat is reported as rejected', async () => {
  await withHarness(async (harness) => {
    const sessionId = await bindConversation(harness)
    const approval = harness.listeners.get('approval/request')
    assert.ok(approval)

    const outcomePromise = approval(
      { agent: { session: { id: sessionId } }, toolName: 'shell' },
      () => Promise.resolve('delegated' as const),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    await harness.runtime.ingest(inbound('拒绝'))
    // A denial must never be read as consent, and "不允许" in particular contains "允许".
    assert.equal(await outcomePromise, 'rejected')
  })
})

test('case 1: a prompt is delegated when the session is not a WeChat conversation', async () => {
  await withHarness(async (harness) => {
    const approval = harness.listeners.get('approval/request')
    assert.ok(approval)

    // The whole reason the desktop pane keeps working: an unrelated session is someone else's
    // to answer, so this plugin must abstain rather than claim it.
    const outcome = await approval(
      { agent: { session: { id: 'some-desktop-session' } }, toolName: 'shell' },
      () => Promise.resolve('delegated' as const),
    )
    assert.equal(outcome, 'delegated')
  })
})

test('case 2: a multiple-choice question is answered from WeChat by number', async () => {
  await withHarness(async (harness) => {
    const sessionId = await bindConversation(harness)
    const questions = harness.listeners.get('user-questions/request')
    assert.ok(questions, 'the plugin claims structured questions')

    let delegated = false
    const answerPromise = questions(
      {
        agent: { session: { id: sessionId } },
        questions: [
          {
            id: 'q1',
            question: '用哪个方案？',
            header: '方案',
            options: [
              { label: '重写', description: '改动大但彻底' },
              { label: '打补丁' },
            ],
          },
        ],
      },
      () => {
        delegated = true
        return Promise.resolve({ answers: [] })
      },
    )

    await new Promise((resolve) => setTimeout(resolve, 30))
    const prompt = harness.sent.at(-1)
    assert.ok(prompt, 'a prompt was sent')
    assert.match(prompt.text, /用哪个方案？/)
    assert.match(prompt.text, /1\. 重写 — 改动大但彻底/)
    assert.match(prompt.text, /2\. 打补丁/)
    assert.match(prompt.text, /回复编号/)
    assert.equal(delegated, false, 'the request was claimed')

    const promptsBefore = harness.prompted.length
    await harness.runtime.ingest(inbound('2'))
    const answer = await answerPromise

    assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['打补丁'] }] })
    assert.equal(harness.prompted.length, promptsBefore, 'the reply did not reach the agent')
  })
})

test('case 2: a free-form reply is carried through rather than refused', async () => {
  await withHarness(async (harness) => {
    const sessionId = await bindConversation(harness)
    const questions = harness.listeners.get('user-questions/request')
    assert.ok(questions)

    const answerPromise = questions(
      {
        agent: { session: { id: sessionId } },
        questions: [{ id: 'q1', question: '叫什么名字？' }],
      },
      () => Promise.resolve({ answers: [] }),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    // No options were offered, so the reply is the answer. Refusing it would strand the user at
    // a prompt, which is the problem this feature exists to solve.
    await harness.runtime.ingest(inbound('就叫小助'))
    assert.deepEqual(await answerPromise, {
      answers: [{ id: 'q1', selected: [], custom: '就叫小助' }],
    })
  })
})

test('an unrelated message during a prompt is not swallowed as an answer', async () => {
  await withHarness(async (harness) => {
    const sessionId = await bindConversation(harness)
    const approval = harness.listeners.get('approval/request')
    assert.ok(approval)

    let settled = false
    const outcomePromise = approval(
      { agent: { session: { id: sessionId } }, toolName: 'shell' },
      () => Promise.resolve('delegated' as const),
    ).then((value) => {
      settled = true
      return value
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    // Not a decision. It must route normally — losing a user's message because a prompt happened
    // to be open is worse than an unanswered prompt.
    const promptsBefore = harness.prompted.length
    await harness.runtime.ingest(inbound('顺便帮我查一下天气'))
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(settled, false, 'the prompt is still open')
    assert.equal(harness.prompted.length, promptsBefore + 1, 'the message reached the agent')
    assert.equal(userPart(harness.prompted.at(-1)?.text ?? ''), '顺便帮我查一下天气')
    // And the prompt is repeated, so the user is not left wondering what was expected.
    assert.match(harness.sent.at(-1)?.text ?? '', /请回复上一条提示/)

    await harness.runtime.ingest(inbound('允许'))
    assert.equal(await outcomePromise, 'allowed-once')
  })
})

/**
 * Write a complete channel state file before the plugin mounts.
 *
 * The state is written whole, including the seeded account, because `mount` rewrites the file
 * whenever it seeds one — so a test that needs stored settings must supply the account itself
 * and mount with `seedAccount: false`, or its settings are overwritten before the plugin reads
 * them.
 *
 * @param home - DSH home.
 * @param settings - Settings to store.
 */
async function seedState(home: string, settings: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, 'wechat'), { recursive: true })
  await writeFile(
    join(home, 'wechat', 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        accounts: {
          'test@im.bot': {
            accountId: 'test@im.bot',
            token: 'token',
            baseUrl: 'https://example.invalid',
            userId: 'peer@im.wechat',
          },
        },
        syncBufs: {},
        contextTokens: {},
        bindings: {},
        sentMessages: {},
        settings,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

/** The `notify_wechat` tool, driven the way the agent would drive it. */
function notifyTool(harness: Harness): {
  execute(
    args: Record<string, unknown>,
    exec: { agent?: unknown },
  ): Promise<{ detail: string }>
} {
  const candidate = harness.registeredTools.find(
    (tool) => (tool as { name?: string }).name === 'notify_wechat',
  )
  assert.ok(candidate, 'notify_wechat must be registered')
  return candidate as ReturnType<typeof notifyTool>
}

/**
 * Seed a state whose WeChat conversation is bound to a session that is *not* the caller.
 *
 * A conversation has to exist for a proactive send to have anywhere to go, and — for the interesting
 * case — it must be bound to some other session, so the caller is genuinely the foreign one this
 * feature exists for.
 *
 * @param home - DSH home to write into.
 * @param settings - Extra settings to store alongside the defaults.
 * @param pending - Notifications to seed the unsent queue with.
 */
async function seedBoundConversation(
  home: string,
  settings: Record<string, unknown> = {},
  pending: unknown[] = [],
): Promise<void> {
  await mkdir(join(home, 'wechat'), { recursive: true })
  await writeFile(
    join(home, 'wechat', 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        accounts: {
          'test@im.bot': {
            accountId: 'test@im.bot',
            token: 'token',
            baseUrl: 'https://example.invalid',
            userId: 'peer@im.wechat',
          },
        },
        syncBufs: {},
        contextTokens: { 'test@im.bot': { 'test@im.bot:peer@im.wechat': 'ctx-token-1' } },
        bindings: {
          'test@im.bot:peer@im.wechat': {
            conversationId: 'test@im.bot:peer@im.wechat',
            accountId: 'test@im.bot',
            peerId: 'peer@im.wechat',
            sessionId: 'session-wechat-bound',
            title: '微信那边',
            createdAt: 1,
            lastUsedAt: 1,
          },
        },
        sentMessages: {},
        ...(pending.length > 0 ? { pendingNotifications: pending } : {}),
        settings: { ...DEFAULT_SETTINGS, ...settings },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

test('settings changes apply without a restart', async () => {
  await withHarness(async (harness) => {
    const before = await harness.runtime.settingsForPage()
    assert.equal(before.settings.mergeWindowMs, 10_000, 'the default is reported')

    await harness.runtime.saveSettings({ mergeWindowMs: 0 })
    const after = await harness.runtime.settingsForPage()
    assert.equal(after.settings.mergeWindowMs, 0)
    // The defaults stay reported, so the page can offer "reset to default".
    assert.equal(after.defaults.mergeWindowMs, 10_000)
  })
})

test('a session that is not the bound one can push to WeChat', async () => {
  /*
   * The feature this exists for: the user starts work at the desk, leaves, and the result has to
   * reach their phone. The session doing that work is not the one the WeChat conversation is bound
   * to, so `send_to_wechat` refuses it — which is why this tool resolves the target from the store
   * rather than from the caller.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedBoundConversation(home)
    const harness = await mount({ home, seedAccount: false })
    try {
      const result = await notifyTool(harness).execute(
        { text: '构建完成了' },
        { agent: { session: { id: 'session-somewhere-else' } } },
      )

      assert.match(result.detail, /已通过微信发送/)
      assert.equal(harness.sent.length, 1, 'exactly one message leaves')
      assert.equal(harness.sent[0].text, '构建完成了')
      assert.equal(harness.sent[0].to, 'peer@im.wechat')
      // The reply token is echoed, so the message lands in the existing conversation rather than
      // starting a new one.
      assert.equal(harness.sent[0].contextToken, 'ctx-token-1')
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('turning the setting off restores the bound-session rule', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedBoundConversation(home, { allowCrossSessionNotify: false })
    const harness = await mount({ home, seedAccount: false })
    try {
      await assert.rejects(
        async () =>
          await notifyTool(harness).execute(
            { text: '应该被拒绝' },
            { agent: { session: { id: 'session-somewhere-else' } } },
          ),
        /没有绑定微信对话/,
      )
      assert.equal(harness.sent.length, 0, 'nothing is sent when the setting is off')
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a proactive send with no bound conversation says so instead of failing silently', async () => {
  await withHarness(async (harness) => {
    await assert.rejects(
      async () => await notifyTool(harness).execute({ text: '有人吗' }, { agent: { session: { id: 'x' } } }),
      /还没有微信对话/,
    )
  })
})

/** Read the persisted pending queue. */
async function pendingQueue(harness: Harness): Promise<{ id: string; text: string; path?: string; queuedAt: number }[]> {
  const state = JSON.parse(await readFile(harness.stateFile, 'utf8'))
  return state.pendingNotifications ?? []
}

test('a refused push is queued, and the agent is told it will be delivered later', async () => {
  /*
   * The behaviour this exists for. A push that arrives after the reply window closed used to be lost
   * while the log said it had been sent — several permission prompts and result summaries never
   * reached the phone. Nothing can reopen the window from this side, but the message can wait for the
   * user to reopen it by sending something, which is what the queue does.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedBoundConversation(home)
    const refuse: SendFunction = async () => {
      throw new SendRefusedError('微信会话已超时（session timeout）。', -14)
    }
    const harness = await mountWith({ home, seedAccount: false, send: refuse })
    try {
      const result = await notifyTool(harness).execute(
        { text: '构建完成了' },
        { agent: { session: { id: 'session-somewhere-else' } } },
      )

      // Reported as queued, not as sent: the old failure mode was a report that read like success.
      assert.match(result.detail, /已排队/)
      assert.doesNotMatch(result.detail, /^已通过微信发送/)

      const queue = await pendingQueue(harness)
      assert.equal(queue.length, 1)
      assert.equal(queue[0].text, '构建完成了')
      assert.ok(queue[0].id, 'an id is needed to remove exactly this entry later')
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a push that fails for any other reason still throws and is not queued', async () => {
  // A missing file or a dead network will fail again the same way, so turning it into a backlog would
  // hide the error behind a delay instead of reporting it.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedBoundConversation(home)
    const fail: SendFunction = async () => {
      throw new Error('网络断了')
    }
    const harness = await mountWith({ home, seedAccount: false, send: fail })
    try {
      await assert.rejects(
        async () =>
          await notifyTool(harness).execute(
            { text: '这条不该排队' },
            { agent: { session: { id: 'session-somewhere-else' } } },
          ),
        /网络断了/,
      )
      assert.deepEqual(await pendingQueue(harness), [], 'nothing is queued for a failure that will repeat')
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('the next inbound message delivers what the closed window held back', async () => {
  /*
   * The whole cycle, driven the way it happens: the push is refused because the window is closed, the
   * user says something, and what was held goes out — before their own message is handled, so it
   * reads as a backlog rather than as answers to the question they just asked.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedBoundConversation(home)
    const delivered: string[] = []
    /** How many agent turns had started when each delivery happened. */
    const promptsWhenDelivered: number[] = []
    let refuse = true
    let harness: Harness | undefined
    const send: SendFunction = async (params) => {
      if (refuse) throw new SendRefusedError('微信会话已超时（session timeout）。', -14)
      delivered.push(params.text)
      promptsWhenDelivered.push(harness?.prompted.length ?? -1)
      return { clientId: `t-${String(delivered.length)}`, serverMessageId: `m-${String(delivered.length)}` }
    }

    harness = await mountWith({ home, seedAccount: false, send })
    try {
      await notifyTool(harness).execute(
        { text: '构建完成了' },
        { agent: { session: { id: 'session-somewhere-else' } } },
      )
      assert.equal((await pendingQueue(harness)).length, 1, 'refused, so it waits')

      // The user comes back, which is the only thing that reopens the window.
      refuse = false
      await harness.runtime.ingest(inbound('在吗'))

      assert.ok(
        delivered.includes('构建完成了'),
        `the held message goes out, got: ${JSON.stringify(delivered)}`,
      )
      assert.equal(
        promptsWhenDelivered[0],
        0,
        'the backlog is delivered before the agent starts on the new message',
      )
      assert.deepEqual(await pendingQueue(harness), [], 'and the queue is emptied')
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a queued file that no longer exists is dropped and the user is told', async () => {
  /*
   * The queue keeps a path, not the bytes, so a file can be deleted between queueing and delivery.
   * Retrying it forever would block everything behind it, and dropping it silently would leave the
   * user waiting for an attachment they were promised — so it is dropped and named.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    const gone = join(home, '已经不在了.docx')
    await seedBoundConversation(home, {}, [
      {
        id: 'held-file',
        conversationId: 'test@im.bot:peer@im.wechat',
        text: '报告好了',
        path: gone,
        queuedAt: Date.now(),
      },
    ])
    const harness = await mountWith({ home, seedAccount: false })
    try {
      assert.ok(!existsSync(gone), 'the file must really be missing for this to mean anything')

      await harness.runtime.ingest(inbound('在吗'))

      const texts = harness.sent.map((entry) => entry.text)
      assert.ok(texts.includes('报告好了'), `the text still goes out, got: ${JSON.stringify(texts)}`)
      assert.ok(
        texts.some((text) => text.includes('已经不在了.docx')),
        `the user is told which file is gone, got: ${JSON.stringify(texts)}`,
      )
      assert.deepEqual(await pendingQueue(harness), [], 'and the entry is dropped rather than retried')
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('the permission preset is stored and reported, defaulting to full access', async () => {
  await withHarness(async (harness) => {
    const before = await harness.runtime.settingsForPage()
    assert.equal(
      before.settings.permissionPreset,
      'danger-full-access',
      'full access is the default, so a phone conversation never waits on a prompt',
    )

    await harness.runtime.saveSettings({ permissionPreset: 'default' })
    const after = await harness.runtime.settingsForPage()
    assert.equal(after.settings.permissionPreset, 'default')
    // Reported separately, so the page can still offer "reset to default".
    assert.equal(after.defaults.permissionPreset, 'danger-full-access')
  })
})

test('the merge window follows the setting', async () => {
  const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const { reference, close } = await serveEncrypted(Buffer.from('photo bytes'), aesKey)
  try {
    const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
    try {
      // Zero means "answer the attachment at once", which is the opposite end from the default
      // ten seconds. Ten seconds is too short for this test to tell the two apart.
      await seedState(home, { mergeWindowMs: 0 })
      const harness = await mount({ home, seedAccount: false })
      try {
        await harness.runtime.ingest(await imageMessage(aesKey, '', reference))
        await new Promise((resolve) => setTimeout(resolve, 120))
        assert.equal(harness.prompted.length, 1, 'released without waiting out the default')
      } finally {
        harness.dispose()
      }
    } finally {
      await removeHome(home)
    }
  } finally {
    await close()
  }
})

test('with auto-reply off an attachment waits for a caption instead of being answered', async () => {
  const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const { reference, close } = await serveEncrypted(Buffer.from('photo bytes'), aesKey)
  try {
    const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
    try {
      await seedState(home, { autoReplyAttachments: false, mergeWindowMs: 0 })
      const harness = await mount({ home, seedAccount: false })
      try {
        await harness.runtime.ingest(await imageMessage(aesKey, '', reference))
        await new Promise((resolve) => setTimeout(resolve, 150))
        assert.equal(harness.prompted.length, 0, 'the attachment is held, not answered')

        // Held, not dropped: a caption still folds it into a turn.
        await harness.runtime.ingest(inbound('这张图是什么'))
        assert.equal(harness.prompted.length, 1)
        const prompt = harness.prompted[0].text
        assert.match(prompt, /这张图是什么/)
        assert.match(prompt, /\[图片\]/, 'the held photo rides along')
      } finally {
        harness.dispose()
      }
    } finally {
      await removeHome(home)
    }
  } finally {
    await close()
  }
})

test('a reply longer than the limit is sent as a file instead of being cut short', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedState(home, { maxReplyChars: 120 })
    const harness = await mount({ home, seedAccount: false })
    // The long-reply path uploads to the CDN, so the transport is stubbed and the request bodies
    // are captured. Asserting on the wire is the only way to show a file was really sent rather
    // than merely written to disk.
    const bodies: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
      if (typeof init?.body === 'string') bodies.push(init.body)
      return new Response(JSON.stringify({ message_id: '1', upload_full_url: 'https://x.invalid' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-encrypted-param': 'param' },
      })
    }) as typeof fetch

    try {
      await harness.runtime.ingest(inbound('写一段长文'))
      const sessionId = harness.prompted[0].sessionId
      const listener = harness.listeners.get('agent/assistant-stream')
      assert.ok(listener)

      // Comfortably past the limit. Truncating would silently lose the end of the answer, which
      // for a long explanation is the part that mattered.
      const long = '这是一段很长的回复。'.repeat(20)
      listener({
        agent: { session: { id: sessionId } },
        frame: { type: 'chunk', revision: 2, chunk: { type: 'text-delta', index: 0, text: long } },
      })
      listener({ agent: { session: { id: sessionId } }, frame: { type: 'end', revision: 3 } })
      await new Promise((resolve) => setTimeout(resolve, 400))

      const texts = harness.sent.map((entry) => entry.text)
      assert.ok(
        texts.some((text) => /已作为文件发送/.test(text)),
        'the user is told a file is coming',
      )
      assert.ok(
        !texts.some((text) => text.includes(long)),
        'the full text is not dumped into a message',
      )

      const log = await readFile(join(home, 'wechat', 'boot.log'), 'utf8')
      assert.match(log, /long reply \d+ chars -> 回复-.*\.md/)

      // The whole reply is on disk, so nothing about it was lost.
      const dir = join(home, 'dsh_wechat', '媒体')
      const name = (await readdir(dir)).find((entry) => entry.endsWith('.md'))
      assert.ok(name, 'the reply was written to a file')
      assert.equal(await readFile(join(dir, name), 'utf8'), long, 'the file holds the whole reply')
    } finally {
      globalThis.fetch = realFetch
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a reply within the limit is sent normally', async () => {
  await withHarness(async (harness) => {
    const reply = await replyFor(harness, [
      { type: 'chunk', revision: 2, chunk: { type: 'text-delta', index: 0, text: '简短回复' } },
      { type: 'end', revision: 3 },
    ])
    assert.equal(reply, '简短回复')
  })
})

test('diagnostics report where the log, state, and workspace are', async () => {
  await withHarness(async (harness) => {
    const status = await harness.runtime.status()
    // Finding these by hand means knowing an internal layout under the DSH home, which is
    // exactly what someone debugging a channel failure does not know.
    assert.match(status.diagnostics.logPath, /wechat[\\/]boot\.log$/)
    assert.match(status.diagnostics.statePath, /wechat[\\/]state\.json$/)
    assert.ok(status.diagnostics.workspace.endsWith('dsh_wechat'))
    assert.ok(Array.isArray(status.diagnostics.logTail))
  })
})

test('disconnecting an account ends the link and forgets its credentials', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('建立会话'))
    assert.equal((await harness.runtime.status()).accounts.length, 1)

    const disconnected = await harness.runtime.disconnect('test@im.bot')
    assert.equal(disconnected, true)

    const after = await harness.runtime.status()
    // The account is gone, so restoring it needs a fresh scan — which is what separates this from
    // switching the channel off, where the credentials survive.
    assert.equal(after.accounts.length, 0, 'the account is forgotten')
    assert.equal(after.enabled, false, 'nothing left to reconnect to, so the switch is off')

    const state = JSON.parse(await readFile(harness.stateFile, 'utf8')) as {
      accounts: Record<string, unknown>
      contextTokens: Record<string, unknown>
      bindings: Record<string, unknown>
    }
    assert.deepEqual(state.accounts, {})
    assert.deepEqual(state.contextTokens, {}, 'reply tokens for that account are dropped too')
    assert.deepEqual(state.bindings, {}, 'its conversations go with it')
  })
})

test('disconnecting an unknown account changes nothing', async () => {
  await withHarness(async (harness) => {
    // A repeated click, or a page left open across a reconnect, must not report success.
    assert.equal(await harness.runtime.disconnect('nobody@im.bot'), false)
    assert.equal((await harness.runtime.status()).accounts.length, 1, 'the real one survives')
  })
})

test('enabling the channel persists autoStart for the next boot', async () => {
  await withHarness(async (harness) => {
    assert.equal((await harness.runtime.status()).enabled, false)
    await harness.runtime.setEnabled(true)
    assert.equal((await harness.runtime.status()).enabled, true)

    // The flag has to reach disk, because it is what reconnects on the next boot.
    const state = JSON.parse(await readFile(harness.stateFile, 'utf8'))
    assert.equal(state.autoStart, true)
  })
})

test('a failing delivery is recorded instead of breaking the channel', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    // A sender that always throws, the way a stale token or a network outage would.
    const failing: SendFunction = async () => {
      throw new Error('simulated delivery failure')
    }
    const harness = await mountWith({ home, seedAccount: true, send: failing })
    try {
      await harness.runtime.ingest(inbound('/help'))
      // The command was handled; only the delivery failed, and that is recorded.
      const status = await harness.runtime.status()
      assert.equal(status.errors.length, 1)
      assert.match(status.errors[0], /simulated delivery failure/)

      // The pipeline stays usable afterwards: a normal message still routes.
      await harness.runtime.ingest(inbound('仍然可以工作'))
      assert.equal(harness.prompted.length, 1)
      assert.equal(userPart(harness.prompted[0].text), '仍然可以工作')
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('mounting writes a boot log, so a later failure is diagnosable', async () => {
  await withHarness(async (harness) => {
    const log = await readFile(join(harness.bundleHome, 'wechat', 'boot.log'), 'utf8')
    assert.match(log, /apply: entered/)
    assert.match(log, /apply: mounted/)
  })
})

test('a client-side failure lands in the same boot log', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    // Client failures are reported over HTTP by the page, which is why they need
    // their own recording path: the host cannot otherwise observe them.
    recordClientFailure(home, 'load', '模拟的浏览器端异常', 'at WechatSettings (client.js:1:1)')

    const log = await readFile(join(home, 'wechat', 'boot.log'), 'utf8')
    assert.match(log, /client\[load\] FAILED: 模拟的浏览器端异常/)
    assert.match(log, /at WechatSettings/)
  } finally {
    await removeHome(home)
  }
})

/**
 * Capture the message items the channel sends through the real API.
 *
 * Tool cards go out with `sendmessage` rather than through the injected text sender, so they
 * cannot be observed from the harness recorder.
 *
 * @returns A restore function and the live list of captured item lists.
 */
function captureSentItems(): { items: Record<string, unknown>[][]; restore: () => void } {
  const items: Record<string, unknown>[][] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    if (typeof init?.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as {
          msg?: { item_list?: Record<string, unknown>[] }
        }
        if (parsed.msg?.item_list !== undefined) items.push(parsed.msg.item_list)
      } catch {
        // Not a send request; ignore.
      }
    }
    return new Response(JSON.stringify({ message_id: '1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return {
    items,
    restore: () => {
      globalThis.fetch = realFetch
    },
  }
}

test('a tool call in the stream produces a tool card', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('读一下文件'))
    const sessionId = harness.prompted[0].sessionId
    const listener = harness.listeners.get('agent/assistant-stream')
    assert.ok(listener)

    const capture = captureSentItems()
    try {
      // The tool announces itself through the model chunk, which is the only tool signal that
      // reliably reaches a host-scope plugin.
      listener({
        agent: { session: { id: sessionId } },
        frame: {
          type: 'chunk',
          revision: 3,
          chunk: { type: 'tool-call-delta', index: 0, id: 'call-9', name: 'read', argumentsDelta: '{' },
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      capture.restore()
    }

    assert.equal(capture.items.length, 1, 'one card request')
    const item = capture.items[0][0]
    assert.equal(item.type, 11, 'TOOL_CALL_START')
    assert.deepEqual(item.tool_call_start_item, { tool_name: 'read', tool_call_id: 'call-9' })
  })
})

test('a repeated tool-call delta for one call sends the card only once', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('读一下'))
    const sessionId = harness.prompted[0].sessionId
    const listener = harness.listeners.get('agent/assistant-stream')
    assert.ok(listener)

    const capture = captureSentItems()
    try {
      // Only the first delta carries the name; a second frame for the same call — or a repeat
      // of the first — must not produce a duplicate card in the chat.
      for (let i = 0; i < 3; i += 1) {
        listener({
          agent: { session: { id: sessionId } },
          frame: {
            type: 'chunk',
            revision: 4 + i,
            chunk: { type: 'tool-call-delta', index: 0, id: 'call-9', name: 'read', argumentsDelta: 'x' },
          },
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      capture.restore()
    }

    assert.equal(capture.items.length, 1, 'one card, not one per fragment')
  })
})

test('an argument-only tool-call delta is not mistaken for a new call', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('读一下'))
    const sessionId = harness.prompted[0].sessionId
    const listener = harness.listeners.get('agent/assistant-stream')
    assert.ok(listener)

    const capture = captureSentItems()
    try {
      // Later deltas of the same call arrive with no name; treating one as a call would put a
      // nameless card in the chat.
      listener({
        agent: { session: { id: sessionId } },
        frame: { type: 'chunk', revision: 5, chunk: { type: 'tool-call-delta', index: 0, id: 'call-9', argumentsDelta: '}' } },
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      capture.restore()
    }

    assert.equal(capture.items.length, 0, 'no card without a name')
  })
})

test('an unusable tool-call frame is logged with its field names', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('读一下'))
    const sessionId = harness.prompted[0].sessionId
    const listener = harness.listeners.get('agent/assistant-stream')
    assert.ok(listener)

    // Whether a tool-call frame carries `name` is an assumption about a host-owned shape. If it
    // does not, every card silently disappears and no test notices — so the field set is
    // recorded, and this pins that it is.
    for (const revision of [5, 6]) {
      listener({
        agent: { session: { id: sessionId } },
        frame: {
          type: 'chunk',
          revision,
          chunk: { type: 'tool-call-delta', index: 0, call_id: 'call-9', tool_name: 'read' },
        },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 50))

    const log = await readFile(join(harness.bundleHome, 'wechat', 'boot.log'), 'utf8')
    assert.match(log, /tool-call frame fields \(no call made\): type,index,call_id,tool_name/)
    assert.equal(
      log.split('no call made').length - 1,
      1,
      'the same shape is reported once, not once per fragment',
    )
  })
})

test('every distinct stream chunk kind is written to the log once', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('读一下'))
    const sessionId = harness.prompted[0].sessionId
    const listener = harness.listeners.get('agent/assistant-stream')
    assert.ok(listener)

    // Which chunk announces a tool call is an unobserved assumption. Recording the vocabulary
    // the stream actually uses settles it from evidence, and logging each kind once keeps the
    // log bounded no matter how long a turn runs.
    const kinds = ['text-delta', 'reasoning-delta', 'tool-call-delta', 'block-start', 'finish']
    for (let round = 0; round < 2; round += 1) {
      for (const [index, kind] of kinds.entries()) {
        listener({
          agent: { session: { id: sessionId } },
          frame: {
            type: 'chunk',
            revision: 10 + index,
            chunk: { type: kind, index: 0, text: 'x', id: 'call-1', name: 'read' },
          },
        })
      }
      // A frame with no chunk at all, to pin that its shape is reported too.
      listener({
        agent: { session: { id: sessionId } },
        frame: { type: 'start', revision: 30 },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 50))

    const log = await readFile(join(harness.bundleHome, 'wechat', 'boot.log'), 'utf8')
    for (const kind of kinds) {
      const seen = log.split(`stream chunk kind: ${kind}`).length - 1
      assert.equal(seen, 1, `${kind} must be reported exactly once`)
    }
    assert.equal(log.split('stream frame shape:').length - 1, 1, 'the frameless shape, once')
  })
})

test('turn end closes a tool card the harness never reported on', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('读一下'))
    const sessionId = harness.prompted[0].sessionId
    const listener = harness.listeners.get('agent/assistant-stream')
    assert.ok(listener)

    const capture = captureSentItems()
    try {
      listener({
        agent: { session: { id: sessionId } },
        frame: { type: 'chunk', revision: 3, chunk: { type: 'tool-call-delta', index: 0, id: 'call-9', name: 'read' } },
      })
      // The turn ends without a tools/result ever arriving.
      listener({
        agent: { session: { id: sessionId } },
        frame: { type: 'chunk', revision: 4, chunk: { type: 'text-delta', index: 0, text: '好了' } },
      })
      listener({ agent: { session: { id: sessionId } }, frame: { type: 'end', revision: 5 } })

      // The grace window lets a real result overtake this closure.
      await new Promise((resolve) => setTimeout(resolve, 1_800))
    } finally {
      capture.restore()
    }

    const types = capture.items.map((list) => list[0].type)
    assert.deepEqual(types, [11, 12], 'the card is opened and then closed')
    const end = capture.items[1][0] as { tool_call_result_item?: { tool_call_id?: string } }
    assert.equal(end.tool_call_result_item?.tool_call_id, 'call-9', 'closed with the matching id')
  })
})
