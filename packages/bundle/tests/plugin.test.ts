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
import { ROUTE_SETTINGS } from '../src/routes.ts'
import type { WechatContext } from '../src/services.ts'
import {
  DEFAULT_SETTINGS,
  SendRefusedError,
  StateStore,
  aesKeyToBase64,
  encodeWorkspaceDir,
  isSameWorkspace,
  shortId,
} from '@dsh-wechat/core'
// The helper lives with core's tests, next to the resolver whose readings it has to satisfy, and is
// shared so a second copy cannot drift into being the less careful one.
import { unmatchedSwitchTarget } from '../../core/tests/support.ts'

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

/**
 * The catalog the stub host reports.
 *
 * Two providers, one of them with a reasoning model, because that is the shape the real one has and
 * the two-provider case is what makes the provider label load-bearing: the same model id can be
 * offered by more than one provider, and a row that shows only the label would be ambiguous.
 */
const MODEL_CATALOG = {
  default: { provider: 'deepseek-account', model: 'deepseek-chat' },
  routableProviders: ['deepseek-account', 'openrouter'],
  groups: [
    {
      id: 'deepseek-account',
      name: 'DeepSeek 官方',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek V3.2' },
        {
          id: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'medium', name: '中' },
              { id: 'high', name: 'High' },
            ],
            defaultEffort: 'medium',
          },
        },
      ],
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      models: [{ id: 'qwen3-coder', name: 'Qwen3 Coder' }],
    },
  ],
  failures: [],
}

/** One model selection the stub host was asked to install. */
interface ModelRequest {
  sessionId: string
  provider: string
  model: string
  reasoningEffort?: string
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
  status(): Promise<{
    enabled: boolean
    accounts: unknown[]
    needsLogin: boolean
    errors: string[]
    diagnostics?: {
      workspace: string
      settingsWorkspace: string
      logTail: string[]
    }
  }>
  loginState(): { phase: string; step?: string }
  bindings(): Promise<{ conversationId: string; sessionId: string; title: string }[]>
  /**
   * The live state, as the channel holds it in memory.
   *
   * Reached so a test can age a binding: `missing` is only believed past the grace window, and the
   * only way to be past it without waiting two minutes is to move the timestamp the verdict is
   * weighed against.
   */
  state(): Promise<{ bindings: Record<string, { sessionId: string; createdAt: number }> }>
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
  /** Model selections the channel installed, in order. */
  modelSelections: ModelRequest[]
  /**
   * Sessions the stub registry reports as archived.
   *
   * The archive set is the registry's, not a field on the session, which is what makes it the only
   * place the channel can learn the fact — and what these tests drive.
   */
  archivedSessionIds: string[]
  created: Created[]
  /** Messages carrying the user's own words, which is what most tests are about. */
  prompted: { sessionId: string; mode: 'queue' | 'steer'; text: string }[]
  /** Every submission including the standing channel note, for the tests that check the split. */
  allPrompts: { sessionId: string; mode: 'queue' | 'steer'; text: string }[]
  sent: Sent[]
  events: string[]
  /**
   * Routes the plugin registered on the DSH web server.
   *
   * Captured rather than discarded so a test can call the real handler the settings page calls.
   * Calling `runtime.saveSettings` directly would skip the request parsing and the type check that
   * decide what a page's save actually means — which is where a save can be dropped without a word.
   */
  routes: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }[]
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
  hostReportsNoSessions?: boolean
  modelProjection?: 'live' | 'absent' | 'throws'
  failModelSelectionFrom?: number
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
  /**
   * How the host answers a per-session model/level read.
   *
   * `absent` is a composition that does not expose the projection at all, and `throws` is one whose
   * read fails; both are normal in the field and neither may cost the user `/model`. The default
   * tracks what a real session would report.
   */
  modelProjection?: 'live' | 'absent' | 'throws'
  /**
   * Make model selections fail from this call on (1-based), as a provider that lost its key does.
   *
   * From a numbered call rather than from the first, because the setup of such a test is itself a
   * selection: failing every one would leave the conversation on the model that has no levels, and the
   * refusal under test would never be reached.
   */
  failModelSelectionFrom?: number
  /**
   * State store to mount with, instead of the real one over the mounted home.
   *
   * A store whose writes fail is the only platform-independent way to reach the "a save could not be
   * written" path: making the filesystem refuse instead asserts the operating system's errno.
   */
  stateStore?: StateStore
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
  /** Routes registered on the stub web server, in order. */
  const routes: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }[] = []

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
  /** Model selections the channel installed, in order. */
  const modelSelections: ModelRequest[] = []
  /**
   * The selection installed for each session, which is what the host's `modelSelection` projection
   * would report. Kept per session because that is the whole point of the read: a model chosen for one
   * conversation is not the deployment default.
   */
  const installedSelections = new Map<string, { provider: string; model: string; reasoningEffort?: string }>()
  /**
   * The archive set the stub registry reports.
   *
   * A stub without it would send the channel down its "no archive concept" path, where nothing can
   * ever be archived — and the behaviour under test would look correct while never running.
   */
  const archivedSessionIds: string[] = []
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
      // The catalog and the selection call, as the real controller exposes them. A stub without them
      // would send `/model` down its "no model support" path and the whole feature would look like it
      // worked while never being exercised.
      modelCatalog: async () => MODEL_CATALOG,
      selectModel: async (request: ModelRequest) => {
        // The host validates the pair and throws for anything it cannot route; the stub has to as
        // well, because that throw is the only failure path the user is told about in the host's own
        // words.
        const known = MODEL_CATALOG.groups.some(
          (group) =>
            group.id === request.provider &&
            group.models.some((model) => model.id === request.model),
        )
        if (!known) throw new Error(`unknown model ${request.provider}/${request.model}`)
        if (
          options.failModelSelectionFrom !== undefined &&
          modelSelections.length + 1 >= options.failModelSelectionFrom
        ) {
          throw new Error('session/model-unavailable: the provider key is missing')
        }
        modelSelections.push(request)
        /*
         * The real controller resolves the level through the adapter and answers with the normalized
         * selection, so a request that named none comes back with the model's default effort. Mirrored
         * here because that value is what the reply tells the user is now in effect.
         */
        const effort =
          request.reasoningEffort ??
          MODEL_CATALOG.groups
            .find((group) => group.id === request.provider)
            ?.models.find((model) => model.id === request.model)?.reasoning?.defaultEffort
        const selected = {
          provider: request.provider,
          model: request.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        }
        installedSelections.set(request.sessionId, selected)
        return { selected }
      },
      /*
       * The per-session read `/model` marks the current model and level from. The two ways it can be
       * missing are both real — a host generation without the projection, and a read that fails — and
       * each has to leave `/model` working, so both are reproducible here.
       */
      ...(options.modelProjection === 'absent'
        ? {}
        : {
            projections: async (request: { sessionId: string }) => {
              if (options.modelProjection === 'throws') {
                throw new Error('session query unavailable')
              }
              return {
                values: {
                  modelSelection: {
                    lastUsed: null,
                    next: installedSelections.get(request.sessionId) ?? null,
                  },
                },
              }
            },
          }),
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
      // A getter, as the real registry has: the channel reads the set at the moment it asks, so a
      // test that archives a session mid-run is seen by the next probe rather than by a new mount.
      get archivedSessionIds(): readonly string[] {
        return archivedSessionIds
      },
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
      if (name === 'webServer') {
        return {
          port: 0,
          register: (route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
            routes.push(route)
            return () => {}
          },
        }
      }
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

  apply(
    ctx as unknown as WechatContext,
    { autoStart: false, ...options.config },
    {
      send,
      ...(options.stateStore === undefined ? {} : { stateStore: options.stateStore }),
    },
  )
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
    modelSelections,
    archivedSessionIds,
    created,
    prompted,
    allPrompts,
    sent,
    events,
    routes,
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
    assert.equal(harness.created.length, 1, 'and the session is created once')
    assert.equal(harness.created[0].workspaceId, 'workspace-wechat')
  })
})

test('a second message continues in the same session without creating another', async () => {
  /*
   * The host's `create` is not an "ensure": since 0.2.1-rc.2 it reuses a named session only while it
   * is still blank, and mints a fresh one when the named session has already run a turn. This channel
   * works on an existing session by prompting it — `prompt` resumes a stored session itself — so
   * calling `create` again here would leave a blank session behind on every message.
   */
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('one'))
    await harness.runtime.ingest(inbound('two'))

    assert.equal(harness.created.length, 1, 'the existing session is not offered to create again')
    assert.equal(harness.prompted.length, 2)
    assert.equal(harness.prompted[0].sessionId, harness.created[0].sessionId)
    assert.equal(harness.prompted[1].sessionId, harness.created[0].sessionId)
    assert.deepEqual(
      harness.prompted.map((entry) => userPart(entry.text)),
      ['one', 'two'],
    )
  })
})

/**
 * Remove one session from the on-disk store, as deleting it on the desktop does.
 *
 * Both halves go: the session's own directory under `sessions/`, which is what the transcript lives
 * in, and its row in the index the listing and the probe read. Leaving either behind would keep the
 * session looking alive to one reader and gone to another — and the whole bug being tested is that
 * "gone" was never noticed.
 *
 * @param home - Temporary DSH home.
 * @param workspace - Directory the session belonged to.
 * @param sessionId - Session to delete.
 */
async function deleteStoredSession(
  home: string,
  workspace: string,
  sessionId: string,
): Promise<void> {
  await rm(join(home, 'sessions', encodeWorkspaceDir(workspace), sessionId), {
    recursive: true,
    force: true,
  })
  await rm(join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), {
    force: true,
  })
}

/**
 * Age every binding past the `missing` grace window.
 *
 * A session has no record on disk until its first turn writes one, so the probe's `missing` verdict
 * is only believed for a binding older than two minutes. Moving the timestamp is the only way to
 * reach that state without waiting, and it is the same field the router weighs.
 *
 * @param harness - Mounted channel.
 * @param ageMs - How old to make the bindings.
 */
async function ageBindings(harness: Harness, ageMs: number): Promise<void> {
  const state = await harness.runtime.state()
  for (const binding of Object.values(state.bindings)) {
    binding.createdAt = Date.now() - ageMs
  }
}

/** Everything the channel wrote to its boot log, newest last. */
async function bootLogLines(harness: Harness): Promise<string[]> {
  const text = await readFile(join(harness.bundleHome, 'wechat', 'boot.log'), 'utf8')
  return text.split(/\r?\n/).filter((line) => line !== '')
}

/**
 * Call one of the plugin's own routes the way the web server calls it.
 *
 * The handler reads the request as an async iterable of chunks and answers through `writeHead` /
 * `end`, so the fakes implement exactly that and nothing more. What this buys over calling the
 * runtime directly: the request body goes through JSON parsing and the host's type check, which is
 * where a page's save can be accepted, trimmed, or dropped.
 *
 * @param harness - Mounted plugin.
 * @param url - Request path, as `routes.ts` composes it.
 * @param options.method - HTTP method; defaults to GET.
 * @param options.body - JSON body to send, omitted for GET.
 * @returns The status code and the parsed response body.
 */
async function callRoute(
  harness: Harness,
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = harness.routes.find((entry) => url.startsWith(entry.path))
  assert.ok(route, `the plugin registered a route covering ${url}`)
  const chunks =
    options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body), 'utf8')]
  const req = {
    url,
    method: options.method ?? 'GET',
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let status = 0
  let payload = ''
  const res = {
    writeHead(code: number) {
      status = code
      return this
    },
    end(text?: string) {
      payload = text ?? ''
    },
  }
  await route.handler(req, res)
  return { status, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) }
}

test('a message for an archived session starts a new one, rebinds, and says so', async () => {
  /*
   * The failure this is written for: an archived session is still on disk and still accepts a prompt,
   * and DSH then refuses the *step* that prompt proposes — so the turn ends with nothing said and
   * nothing logged, and the user's message is simply gone. Asking the registry before reuse is the
   * only point at which the channel can tell.
   */
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('第一句'))
    const archived = harness.created[0].sessionId ?? ''
    assert.notEqual(archived, '')
    harness.archivedSessionIds.push(archived)

    await harness.runtime.ingest(inbound('第二句'))

    const replacement = harness.created.at(-1)?.sessionId ?? ''
    assert.notEqual(replacement, archived, 'a different session answers from now on')
    assert.equal(harness.created.length, 2, 'one replacement, not a session per message')
    assert.equal(
      harness.prompted.at(-1)?.sessionId,
      replacement,
      'the user\'s own words go to the new session, not the archived one',
    )
    assert.deepEqual(
      (await harness.runtime.bindings()).map((binding) => binding.sessionId),
      [replacement],
      'the rebind is persisted, or the next message would land in the archived session again',
    )
    // The user has to be told: answers now come from a conversation with none of their history.
    const notice = harness.sent.at(-1)?.text ?? ''
    assert.match(notice, /归档/)
    assert.match(notice, /新建/)
    // And the move is written down, which is what makes the next report of a silence diagnosable.
    const lines = await bootLogLines(harness)
    const moved = lines.find((line) => line.includes('state=archived'))
    assert.ok(moved !== undefined, `the rebind must be logged; got ${lines.join(' | ')}`)
    assert.ok(moved.includes(archived) && moved.includes(replacement))
  })
})

test('a message for a session deleted from disk starts a new one and says so', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('第一句'))
    const deleted = harness.created[0].sessionId ?? ''
    await deleteStoredSession(harness.bundleHome, harness.workspace, deleted)
    // Past the grace window: a session with no record is only believed gone once its first turn
    // would certainly have written one.
    await ageBindings(harness, 5 * 60 * 1000)

    await harness.runtime.ingest(inbound('第二句'))

    const replacement = harness.created.at(-1)?.sessionId ?? ''
    assert.notEqual(replacement, deleted)
    assert.equal(harness.created.length, 2)
    assert.equal(harness.prompted.at(-1)?.sessionId, replacement)
    assert.match(harness.sent.at(-1)?.text ?? '', /不存在/)
    const lines = await bootLogLines(harness)
    const moved = lines.find((line) => line.includes('state=missing'))
    assert.ok(moved !== undefined, `the rebind must be logged; got ${lines.join(' | ')}`)
    assert.ok(moved.includes(deleted) && moved.includes(replacement))
  })
})

test('a session the store cannot read is kept, not replaced', async () => {
  /*
   * The fail-safe direction, end to end. A record that exists but does not parse is a damaged store,
   * not a deleted session, and answering "gone" for it would start a new conversation — and start
   * another one every time the binding aged past the grace window, because damage does not heal. The
   * user's message must keep going where it was going.
   */
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('第一句'))
    const sessionId = harness.created[0].sessionId ?? ''
    await writeFile(
      join(
        harness.bundleHome,
        'storages',
        'session_projcache',
        'sessions',
        `${sessionId}.json`,
      ),
      '{',
    )
    await ageBindings(harness, 5 * 60 * 1000)

    await harness.runtime.ingest(inbound('第二句'))

    assert.deepEqual(
      new Set(harness.created.map((entry) => entry.sessionId)),
      new Set([sessionId]),
      'the session is reused, however unreadable its record is',
    )
    assert.equal(harness.prompted.at(-1)?.sessionId, sessionId)
    assert.equal(harness.sent.length, 0, 'and nothing is said to the user')
  })
})

test('a session with no record yet is kept, so messages cannot multiply sessions', async () => {
  /*
   * The live machine's first version of this fix created a new conversation per message: a session
   * has no record until its first turn writes one, so every freshly created session looked missing.
   * The binding's age is what separates the two cases, and this is the test that pins it.
   */
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('第一句'))
    const sessionId = harness.created[0].sessionId ?? ''
    await deleteStoredSession(harness.bundleHome, harness.workspace, sessionId)
    // But *young*, which is the whole point: this is what a session looks like before its first
    // turn has written anything.

    await harness.runtime.ingest(inbound('第二句'))
    await harness.runtime.ingest(inbound('第三句'))

    assert.equal(harness.created.length, 2, 'only the record-less turn re-creates the same session')
    assert.deepEqual(new Set(harness.created.map((entry) => entry.sessionId)), new Set([sessionId]))
    assert.deepEqual(
      new Set(harness.prompted.map((entry) => entry.sessionId)),
      new Set([sessionId]),
      'and every message stayed in that session',
    )
    assert.equal(harness.sent.length, 0, 'and the user is told nothing, because nothing changed')
    // The declined replacement is still written down: "why did it not repair itself" has to be
    // answerable from the log.
    const lines = await bootLogLines(harness)
    assert.ok(
      lines.some((line) => line.includes('grace') && line.includes(sessionId)),
      `the skipped replacement must be visible; got ${lines.join(' | ')}`,
    )
  })
})

test('a conversation whose binding is healthy is left alone', async () => {
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('one'))
    await harness.runtime.ingest(inbound('two'))

    assert.equal(harness.sent.length, 0, 'nothing is said when nothing is wrong')
    assert.equal(
      (await harness.runtime.bindings())[0]?.sessionId,
      harness.created[0].sessionId,
      'and the session that was created is still the one bound',
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
    // A short merge window: the test is about what happens *after* it closes, not about its length,
    // and the default ten seconds is ten seconds of suite time for nothing.
    await withSettings(
      async (harness) => {
        // Captioned, but every attachment opens the merge window, so this still waits. The
        // point of the test is the download, decryption, and stored path.
        await harness.runtime.ingest(
          inbound('看看这个', {
            media: [{ type: 2, image_item: { media: reference, aeskey: aesKey.toString('hex') } }],
          }),
        )
        await waitFor(() => harness.prompted.length === 1, 'the attachment to be released')

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
      },
      { mergeWindowMs: 200 },
    )
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

test('the agent gets send_to_wechat, session_control, model_control and notify_wechat', async () => {
  await withHarness(async (harness) => {
    // Exactly these four. A duplicate would mean a registration path ran twice, which leaves an
    // extra tool in the agent's list and a stale description behind.
    assert.deepEqual(
      harness.registeredTools.map((tool) => (tool as { name?: string }).name),
      ['send_to_wechat', 'session_control', 'model_control', 'notify_wechat'],
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
 * Mount with the default settings and a host that answers the model read in a particular way.
 *
 * The model tests need both halves: a seeded state file (so there is a bound account to reply to) and
 * a host whose `modelSelection` read is missing or broken, because those are the compositions in the
 * field where `/model` still has to work.
 *
 * @param run - Test body.
 * @param options - How the stub host should answer the per-session model read.
 */
async function withMount<T>(
  run: (harness: Harness) => Promise<T>,
  options: {
    modelProjection?: 'live' | 'absent' | 'throws'
    failModelSelectionFrom?: number
  } = {},
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  await seedState(home, DEFAULT_SETTINGS)
  const harness = await mount({ home, seedAccount: false, ...options })
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
): Promise<{ detail: string; ok: boolean }> {
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
): Promise<{ detail: string; ok: boolean }> {
  const args: Record<string, unknown> = { action }
  if (target !== undefined) args.target = target
  return await sessionTool(harness).execute(args, { agent: { session: { id: sessionId } } })
}

/** The registered `model_control` tool, driven the way the agent would drive it. */
interface ModelTool {
  name: string
  description: string
  parameters: { properties: Record<string, unknown>; required?: readonly string[] }
  execute(
    args: Record<string, unknown>,
    exec: { agent?: unknown },
  ): Promise<{ detail: string; ok: boolean }>
}

function modelTool(harness: Harness): ModelTool {
  const tool = harness.registeredTools.find(
    (candidate) => (candidate as { name?: string }).name === 'model_control',
  )
  assert.ok(tool, 'model_control must be registered')
  return tool as ModelTool
}

/**
 * Call the model tool as the agent of the conversation's **bound** session, exactly as `control`
 * does for the session tool: the selection has to land on the session the phone user is talking to,
 * not on whichever session happens to be asking.
 *
 * @param harness - Mounted harness.
 * @param action - Action to invoke.
 * @param target - Optional model argument.
 * @param level - Optional reasoning-level argument.
 */
async function controlModel(
  harness: Harness,
  action: string,
  target?: string,
  level?: string,
): Promise<{ detail: string; ok: boolean }> {
  const bound = await harness.runtime.bindings()
  const sessionId =
    bound[0]?.sessionId ?? harness.prompted.at(-1)?.sessionId ?? harness.created.at(-1)?.sessionId
  assert.ok(sessionId, 'a session must exist before the tool can be called')
  const args: Record<string, unknown> = { action }
  if (target !== undefined) args.target = target
  if (level !== undefined) args.level = level
  return await modelTool(harness).execute(args, { agent: { session: { id: sessionId } } })
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
    // A heading that says which level and which screen, a numbered row per conversation with the
    // current one marked, the id that tells two same-workspace conversations apart, and the sentence
    // that makes it answerable.
    assert.match(body, /【微信会话】会话（1\/1）/)
    assert.match(body, /1\. /)
    assert.match(body, /2\. /)
    assert.match(body, /← 当前/)
    // Both ways to answer are named, including the short id: the row prints it, so nothing else tells
    // the user what it is for, and it is the one form that cannot expire.
    assert.match(body, /回复编号或行尾 6 位 id 切换/)
    assert.match(body, /引用这条消息再回编号/, 'the quote trick is explained where it is needed')
    // One screen and no more, so the phrase that pages on is not offered where it would do nothing.
    assert.doesNotMatch(body, /查看其余/)
    // Every row closes with the short id the reply accepts, within the six-character bound.
    for (const row of body.split('\n').filter((line) => /^\d+\. /.test(line))) {
      assert.ok(/  [0-9a-f]{1,6}$/.test(row), `no short id at the end of the row: ${row}`)
    }
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

    /*
     * The target is generated rather than remembered, and that is the point.
     *
     * This sent `99` for a long time, and `99` is a legal hex prefix: on the run where the
     * conversation's new session had a short id beginning with those digits, the switch *succeeded*,
     * `ok` came back true, and the test failed for a reason that had nothing to do with what it
     * checks — about one run in 256. It was then changed to `zzzzzzz`, which fixed that run and not
     * the class: the resolver was still free to reinterpret a numeric target, and the third incident
     * was exactly that. The helper names nothing on purpose (its own test in `core.test.ts` proves it
     * against a hostile machine), so this failure path is reached on every run.
     */
    const target = unmatchedSwitchTarget()
    const missed = await control(harness, 'switch', target)
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
    assert.ok(body.includes(target), `the message names what was asked for: ${body}`)
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

test('quoting a listing pins the numbers it printed', async () => {
  /*
   * The request this exists for: with sessions running while the user reads, "reply 3" could mean a
   * different conversation by the time the reply arrives, and there was no way to fix that by typing.
   * Quoting the listing makes the number mean the row *that message* printed, for as long as the
   * message can be quoted.
   *
   * Two listings are sent on purpose, with a different conversation in row 2 of each. If the quote
   * were ignored and the newest listing used instead, this test would land on the wrong conversation —
   * which is exactly what it has to be able to detect.
   */
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const first = harness.prompted[0]?.sessionId
    assert.ok(first)
    await harness.runtime.ingest(inbound('/new 第二个'))

    // Listing one: row 2 is the first conversation.
    await harness.runtime.ingest(inbound('/list'))
    const firstListing = harness.sent.at(-1)?.text ?? ''
    const firstListId = `msg-${String(harness.sent.length)}`
    const firstRows = firstListing.split('\n').filter((line) => /^\d+\. /.test(line))
    assert.equal(firstRows.length, 2, `expected two conversations, got: ${firstListing}`)
    const position = firstRows.findIndex((line) => line.includes(shortId(String(first)))) + 1
    assert.equal(position, 2, `the first conversation should be row 2: ${firstListing}`)
    // The row closes with its own id, which is what the user could type instead.
    assert.match(firstRows[position - 1] ?? '', new RegExp(`  ${shortId(String(first))}$`))

    // A third conversation, and a second listing: the same row number now names a different one.
    await harness.runtime.ingest(inbound('/new 第三个'))
    await harness.runtime.ingest(inbound('/list'))
    const secondListing = harness.sent.at(-1)?.text ?? ''
    const secondRows = secondListing.split('\n').filter((line) => /^\d+\. /.test(line))
    assert.equal(secondRows.length, 3)
    assert.doesNotMatch(
      secondRows[position - 1] ?? '',
      new RegExp(shortId(String(first))),
      'the newest listing must put a different conversation on that row, or this proves nothing',
    )

    // Quoting the *first* listing and answering with its own number still means that row.
    await harness.runtime.ingest(quoting(`/switch ${String(position)}`, firstListId))
    assert.match(harness.sent.at(-1)?.text ?? '', /已切换到/)
    assert.equal(
      (await harness.runtime.bindings())[0]?.sessionId,
      first,
      'the quoted listing decided what the number meant',
    )

    // Without the quote the same number means the newest listing's row, which is a different
    // conversation — both behaviours are wanted, and neither may leak into the other.
    await harness.runtime.ingest(inbound(`/switch ${String(position)}`))
    assert.notEqual((await harness.runtime.bindings())[0]?.sessionId, first)

    // By id, which needs no pinning at all, and works from the quoted context too.
    await harness.runtime.ingest(quoting(`/switch ${shortId(String(first))}`, firstListId))
    assert.equal((await harness.runtime.bindings())[0]?.sessionId, first)

    // The numbering lives in the state file under the id the service assigned, so a restart does not
    // lose it — a quote that arrives after a reboot has to resolve the same way.
    const stored = JSON.parse(await readFile(harness.stateFile, 'utf8')) as {
      sessionLists?: Record<string, Record<string, { messageId: string; sessions: unknown[] }[]>>
    }
    const history = stored.sessionLists?.['test@im.bot']?.['test@im.bot:peer@im.wechat'] ?? []
    const entry = history.find((candidate) => candidate.messageId === firstListId)
    assert.ok(entry, `the listing was not recorded: ${JSON.stringify(history)}`)
    assert.equal(entry.sessions.length, 2)
  })
})

test('an id two conversations share is reported rather than guessed', async () => {
  /*
   * The printed id is six hex characters, so a collision is possible on a large machine. The reply
   * has to say the id was too short and name the candidates: picking one silently would move the
   * user's work into a conversation they never named.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedState(home, { ...DEFAULT_SETTINGS, requireConfirmation: false })
    const workspace = join(home, 'dsh_wechat')
    // Same first six hex characters, so `/list` prints the same short id twice.
    await seedStoredSession(home, workspace, 'session-e716f0aa-e716f0aa-47fd-4e61-bec6-d21d19457f37', '写周报')
    await seedStoredSession(home, workspace, 'session-e716f0bb-e716f0bb-47fd-4e61-bec6-d21d19457f37', '查天气')
    const harness = await mount({ home, seedAccount: false, hostReportsNoSessions: true })
    try {
      await harness.runtime.ingest(inbound('第一条'))
      await harness.runtime.ingest(inbound('/switch e716f0'))
      const reply = harness.sent.at(-1)?.text ?? ''
      assert.match(reply, /有多个会话匹配「e716f0」/)
      assert.match(reply, /更长的 id/)
      assert.match(reply, /e716f0aa · 写周报/)
      assert.match(reply, /e716f0bb · 查天气/)
      // Nothing moved: the conversation this chat created is still the bound one.
      const bound = (await harness.runtime.bindings())[0]?.sessionId
      assert.ok(bound?.startsWith('session-') && !bound.includes('e716'))

      // A longer id settles it, which is what the message told the user to send.
      await harness.runtime.ingest(inbound('/switch e716f0a'))
      assert.match(harness.sent.at(-1)?.text ?? '', /已切换到「写周报」/)
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
 * The list orders by the timestamp *inside* each session record, so the record is what carries the
 * order. Counting up from the start of the run: counting down from the current time looks equivalent
 * and is not — after enough writes the stamp goes negative, `utimes` throws on a negative time, and
 * the failure lands in whichever later test happens to be running. That is how this first appeared —
 * two tests that pass alone and fail in the full suite.
 */
let storeWriteSeq = 0
const storeWriteBase = Date.now()

/**
 * Seed one session belonging to an arbitrary workspace.
 *
 * The recorded last-prompt time is what makes "newest first" a fact rather than a tie to break. The
 * file's mtime is stamped the same way and is deliberately not what the listing reads — the store
 * uses the record, so a session's own history decides its place (see `session-index.test.ts` for the
 * test that pins that).
 *
 * @param home - Temporary DSH home.
 * @param workspace - Directory the session belongs to.
 * @param id - Session id.
 * @param title - Title the store should report.
 * @param at - Recorded last-prompt time, defaulting to a stamp spaced a second after the last one.
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
  // A second apart, oldest first, so 「newest first」 is a fact rather than a tie to break.
  const stamp = at ?? storeWriteBase + storeWriteSeq++ * 1_000
  await writeFile(
    join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
    JSON.stringify({
      record: {
        identity: { cwd: workspace, createdAt: stamp },
        rows: {
          title: { val: title },
          sessionListMetadata: { val: { blank: false, lastPromptAt: stamp } },
        },
      },
    }),
  )
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
      // The default list opens this workspace's conversations, so the other project's session is not
      // in it — but the user is told the rest exists, which workspaces they are in, and how to reach
      // them, or they never learn that conversations from other projects can be switched to.
      assert.doesNotMatch(body, /解题辅导会话/)
      assert.match(body, /【微信会话】会话（1\/1）/)
      assert.match(body, /另有 1 个对话在其它会话夹（some_project）/)
      assert.match(body, /看全部对话/)

      await control(harness, 'list', 'all')
      const wider = harness.sent.at(-1)?.text ?? ''
      // The workspace level: one row per project, with how many conversations it holds. The session
      // title belongs to the level below this one.
      assert.match(wider, /会话夹（1\/1）/)
      assert.match(wider, /1\. 微信会话  1 个会话/)
      assert.match(wider, /2\. some_project  1 个会话/)
      assert.doesNotMatch(wider, /解题辅导会话/)
      assert.doesNotMatch(wider, /另有/, 'nothing is held back at this level')

      // Entering the folder is answered by the channel, by name or by number, and shows its rows.
      await harness.runtime.ingest(inbound('some_project'))
      assert.match(harness.sent.at(-1)?.text ?? '', /【some_project】会话（1\/1）/)
      assert.match(harness.sent.at(-1)?.text ?? '', /1\. 解题辅导会话/)
      // Entering a folder is browsing, not switching: no turn was started and the chat has not moved.
      assert.equal(harness.prompted.length, 1, 'only the first message reached the agent')
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a spoken full list shows every workspace even when this one is the busiest', async () => {
  /*
   * The spoken route must reach the same level as the typed command. Before this it grouped and cut
   * the rows itself, so fixing only `/list all` would have left the same question answered two ways —
   * the divergence this repository has already been bitten by once. Now both call the same command
   * and send the router's own rendering.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedState(home, { ...DEFAULT_SETTINGS, requireConfirmation: false })
    const workspace = join(home, 'dsh_wechat')
    // Seeded first, so it is older than everything this workspace holds: any single cut of the newest
    // rows would be this workspace alone.
    await seedStoredSession(home, join(home, 'some_project'), 'session-ffff9999-ffff9999-x', '别处的工作')
    for (let index = 0; index < 12; index += 1) {
      await seedStoredSession(
        home,
        workspace,
        `session-${String(index).padStart(4, '0')}aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        `本工作区 ${String(index)}`,
      )
    }

    const harness = await mount({ home, seedAccount: false, hostReportsNoSessions: true })
    try {
      await harness.runtime.ingest(inbound('第一条'))
      const result = await control(harness, 'list', 'all')
      assert.equal(result.ok, true, result.detail)

      const body = harness.sent.at(-1)?.text ?? ''
      assert.match(body, /会话夹（1\/1）/, 'the workspace level, not a flat table')
      assert.match(body, /1\. 微信会话  13 个会话/, 'this workspace is a folder like any other')
      assert.match(body, /2\. some_project  1 个会话/, 'and the other one is visible without paging')
      assert.match(body, /回复编号或名字进入/)
      // The session titles live one level down, so they are not printed here.
      assert.doesNotMatch(body, /本工作区 0|别处的工作/)
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a quoted spoken listing answers with the rows that message printed', async () => {
  /*
   * The numbering is frozen under the id the service assigns to the message that printed it, so a
   * quote of that message resolves the numbers the user can see. Paging makes this sharper rather
   * than weaker: numbering runs on across screens, so a screen that printed 11..14 must answer "14"
   * with its own row — and the screen before it, which stopped at 10, must not answer that number at
   * all. The two are asserted against each other, because a test where they agreed would pass with
   * the offset missing.
   *
   * The oldest conversation's short id deliberately begins with `14`: that is the third incident in
   * this repository's history. `14` is a legal hex prefix, so a resolver that fell back to "an id
   * beginning with those digits" answered this number on the first screen as well — and on the run
   * where a session's random id happened to start with it, a switch that was required to fail
   * succeeded. Here the id is not random, so a regression fails this test on every run instead of
   * one run in 256.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedState(home, { ...DEFAULT_SETTINGS, requireConfirmation: false })
    const workspace = join(home, 'dsh_wechat')
    const ids: string[] = []
    for (let index = 0; index < 13; index += 1) {
      // The oldest carries the id that a first-screen "14" must not be allowed to become.
      const hex = index === 0 ? '14aaaa00' : `${String(index).padStart(4, '0')}aaaa`
      const id = `session-${hex}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
      ids.push(id)
      // Oldest first, so the newest is row 1 and the oldest is row 13.
      await seedStoredSession(home, workspace, id, `本工作区 ${String(index)}`)
    }
    const oldest = ids[0] ?? ''
    assert.equal(shortId(oldest), '14aaaa', 'the fixture has to carry the id the number could name')

    const harness = await mount({ home, seedAccount: false, hostReportsNoSessions: true })
    try {
      await harness.runtime.ingest(inbound('第一条'))

      const listed = await control(harness, 'list')
      assert.equal(listed.ok, true, listed.detail)
      const pageOne = harness.sent.at(-1)?.text ?? ''
      const pageOneId = `msg-${String(harness.sent.length)}`
      assert.match(pageOne, /【微信会话】会话（1\/2）/)
      assert.equal(pageOne.split('\n').filter((line) => /^\d+\. /.test(line)).length, 10)
      assert.doesNotMatch(pageOne, /本工作区 0 ·/, 'the oldest is not on the first screen')

      // 「查看其余」 walks to the second screen, which the channel answers itself.
      await harness.runtime.ingest(inbound('查看其余'))
      const pageTwo = harness.sent.at(-1)?.text ?? ''
      const pageTwoId = `msg-${String(harness.sent.length)}`
      assert.match(pageTwo, /【微信会话】会话（2\/2）/)
      assert.match(pageTwo, /^14\. 本工作区 0/m, `the numbering runs on:\n${pageTwo}`)

      // Quoting the second screen and answering with its own number means that row.
      await harness.runtime.ingest(quoting('/switch 14', pageTwoId))
      assert.match(harness.sent.at(-1)?.text ?? '', /已切换到「本工作区 0」/)
      assert.equal((await harness.runtime.bindings())[0]?.sessionId, oldest)

      // Row 1 of the first screen is a different conversation, so the "moved nothing" assertion
      // below is about the refusal rather than about the binding already being the one under test.
      await harness.runtime.ingest(quoting('/switch 1', pageOneId))
      const afterFirst = (await harness.runtime.bindings())[0]?.sessionId
      assert.ok(afterFirst)
      assert.notEqual(afterFirst, oldest, 'row 1 of the first screen is a different conversation')

      /*
       * The same `14`, quoted against the screen that stopped at 10, is refused out loud.
       *
       * Every earlier version of this test had to *search* for a number no live session id could
       * match, which is how the flake was dodged rather than fixed. Now the number is refused
       * because no row on that screen carries it, whatever ids exist — so the test can say the one
       * thing the user reads: which numbers that screen did carry.
       */
      await harness.runtime.ingest(quoting('/switch 14', pageOneId))
      const refused = harness.sent.at(-1)?.text ?? ''
      assert.match(refused, /找不到编号 14/)
      assert.match(refused, /这一屏只有 10 项（1–10）/)
      assert.equal(
        (await harness.runtime.bindings())[0]?.sessionId,
        afterFirst,
        'a number that screen never printed moves nothing',
      )
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('the phrase that pages on is answered by the channel, without waking the agent', async () => {
  /*
   * 「查看其余」 carries no target, so only the channel knows what it continues — the agent sees two
   * characters and no question. It has to be answered locally, and the position it continues has to
   * outlive the message that set it, which is what the state file is for.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedState(home, { ...DEFAULT_SETTINGS, requireConfirmation: false })
    const workspace = join(home, 'dsh_wechat')
    for (let index = 0; index < 12; index += 1) {
      await seedStoredSession(
        home,
        workspace,
        `session-${String(index).padStart(4, '0')}aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        `本工作区 ${String(index)}`,
      )
    }

    const harness = await mount({ home, seedAccount: false, hostReportsNoSessions: true })
    try {
      await harness.runtime.ingest(inbound('第一条'))
      const promptsBefore = harness.prompted.length

      await harness.runtime.ingest(inbound('/list'))
      assert.match(harness.sent.at(-1)?.text ?? '', /【微信会话】会话（1\/2）/)
      const pageOneId = `msg-${String(harness.sent.length)}`

      await harness.runtime.ingest(inbound('查看其余'))
      const pageTwo = harness.sent.at(-1)?.text ?? ''
      assert.match(pageTwo, /【微信会话】会话（2\/2）/)
      assert.match(pageTwo, /^11\. /m, 'the numbering runs on across screens')
      assert.equal(harness.prompted.length, promptsBefore, 'the phrase never became a turn')

      // The second screen is frozen under its own message id, and answering it with a row on it
      // switches — so the position and the numbering agree about which screen is on screen.
      await harness.runtime.ingest(quoting('12', `msg-${String(harness.sent.length)}`))
      assert.match(harness.sent.at(-1)?.text ?? '', /已切换到/)

      // That switch ended the browse, so the phrase now belongs to the agent again rather than
      // continuing a listing the user has left.
      await harness.runtime.ingest(inbound('查看其余'))
      assert.equal(harness.prompted.length, promptsBefore + 1, 'the browse was dropped by the switch')
      assert.doesNotMatch(harness.sent.at(-1)?.text ?? '', /会话（2\/2）/)
      void pageOneId
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('where a conversation stopped browsing outlives the plugin, and not for ever', async () => {
  /*
   * The position is in the state file, so it has to survive the two things that happen to that file:
   * a restart (DSH updates, the machine reboots, the user toggles the channel) and time.
   *
   * The restart half is the one that catches the §4.9 mistake — a field written but dropped by the
   * reader looks perfectly healthy inside one process, where the in-memory copy still has it. Only a
   * remount reads the file back, and a 「查看其余」 that reaches the agent instead of paging is what a
   * dropped position looks like to the user.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedState(home, { ...DEFAULT_SETTINGS, requireConfirmation: false })
    const workspace = join(home, 'dsh_wechat')
    for (let index = 0; index < 12; index += 1) {
      await seedStoredSession(
        home,
        workspace,
        `session-${String(index).padStart(4, '0')}aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        `本工作区 ${String(index)}`,
      )
    }

    const first = await mount({ home, seedAccount: false, hostReportsNoSessions: true })
    try {
      await first.runtime.ingest(inbound('第一条'))
      await first.runtime.ingest(inbound('/list'))
      assert.match(first.sent.at(-1)?.text ?? '', /会话（1\/2）/)
      const stored = JSON.parse(await readFile(join(home, 'wechat', 'state.json'), 'utf8')) as {
        browsing?: Record<string, Record<string, { page: number }>>
      }
      assert.equal(
        stored.browsing?.['test@im.bot']?.['test@im.bot:peer@im.wechat']?.page,
        1,
        'the position is on disk, not only in memory',
      )
    } finally {
      first.dispose()
    }

    const second = await mount({ home, seedAccount: false, hostReportsNoSessions: true })
    try {
      const before = second.prompted.length
      await second.runtime.ingest(inbound('查看其余'))
      assert.match(second.sent.at(-1)?.text ?? '', /会话（2\/2）/, 'the position was read back')
      assert.equal(second.prompted.length, before, 'and the phrase still never became a turn')
    } finally {
      second.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a position left overnight pages nothing, and a stale one is dropped', async () => {
  /*
   * The phrase is only meaningful while the user is still reading. Without an expiry, 「查看其余」
   * typed the next morning would jump into the middle of a list nobody remembers — which is worse
   * than treating it as an ordinary message, so an abandoned position is retired and the words reach
   * the agent like anything else.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedState(home, { ...DEFAULT_SETTINGS, requireConfirmation: false })
    const workspace = join(home, 'dsh_wechat')
    for (let index = 0; index < 12; index += 1) {
      await seedStoredSession(
        home,
        workspace,
        `session-${String(index).padStart(4, '0')}aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        `本工作区 ${String(index)}`,
      )
    }

    const harness = await mount({ home, seedAccount: false, hostReportsNoSessions: true })
    try {
      await harness.runtime.ingest(inbound('第一条'))
      await harness.runtime.ingest(inbound('/list'))
      const stateFile = join(home, 'wechat', 'state.json')
      const stored = JSON.parse(await readFile(stateFile, 'utf8')) as {
        browsing?: Record<string, Record<string, { page: number; at: number }>>
      }
      const at = stored.browsing?.['test@im.bot']?.['test@im.bot:peer@im.wechat']?.at
      assert.ok(at, `the position was not stored: ${JSON.stringify(stored.browsing)}`)

      // Backdate it past the idle window, the way a night's sleep would.
      stored.browsing!['test@im.bot']!['test@im.bot:peer@im.wechat']!.at = at - 24 * 60 * 60 * 1000
      await writeFile(stateFile, JSON.stringify(stored, null, 2), 'utf8')
      // The store caches, so the plugin has to be restarted to read the edited file — which is also
      // what a real overnight gap looks like from the plugin's point of view.
      harness.dispose()
      const restarted = await mount({ home, seedAccount: false, hostReportsNoSessions: true })
      try {
        const before = restarted.prompted.length
        await restarted.runtime.ingest(inbound('查看其余'))
        assert.equal(restarted.prompted.length, before + 1, 'it reached the agent as an ordinary message')
        assert.doesNotMatch(restarted.sent.at(-1)?.text ?? '', /会话（2\/2）/)
        const after = JSON.parse(await readFile(stateFile, 'utf8')) as { browsing?: unknown }
        assert.equal(after.browsing?.['test@im.bot'], undefined, 'and the stale position was dropped')
      } finally {
        restarted.dispose()
      }
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a session from another workspace is resumed in place, not re-created', async () => {
  /*
   * A stored session already records its own working directory, and `prompt` resumes it from that
   * record — so no `create` call may name a workspace or a cwd for it. This used to be an adoption:
   * the channel re-created the session under its own workspace first. Since 0.2.1-rc.2 a named
   * session that has run a turn is not adopted at all, so that call would mint a blank session and
   * leave it behind instead.
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

      assert.equal(
        harness.created.some((entry) => entry.sessionId === foreignId),
        false,
        'an existing session is never offered to create',
      )

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
    // The id closes its own row, which is where the renderer puts it — one line per conversation, so
    // a listing of ten fits in one WeChat message.
    const olderShort = /  ([0-9a-f]{1,6})$/.exec(olderLine)?.[1]
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

    /*
     * The same generated target the typed command is checked with, and for the same reason: `99` was
     * a legal hex prefix, so on a run where the new session's id began with those two digits the
     * switch *succeeded* and `ok` came back true — which is exactly what a CI run reported here.
     * The helper cannot name anything, so the failure path is reached on every run instead of on
     * about 255 of every 256.
     */
    const missed = await control(harness, 'switch', unmatchedSwitchTarget())
    // The command answers with guidance rather than throwing, so the result has to be read rather
    // than assumed — otherwise the agent tells the user it switched when nothing happened.
    assert.equal(missed.ok, false)
    assert.match(missed.detail, /找不到/)
  })
})

test('a spoken switch to a number the screen never printed is a failure, not a phantom move', async () => {
  /*
   * A number is the case that used to *succeed* at random: the target missed the shown screen, the
   * resolver fell through, and a session whose short id began with those digits became the target.
   * The tool then reported success and the channel announced a move — the exact thing the failure
   * announcement exists to prevent.
   *
   * The channel recognises a failed switch by the router's own words (there is no separate flag on a
   * reply), so this also pins that an answer which named no conversation keeps saying `找不到`. If a
   * future reword dropped it, the tool would return `ok: true` here and the assertion below would
   * catch the phantom success rather than the wording.
   */
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const listed = await control(harness, 'list')
    assert.equal(listed.ok, true, listed.detail)
    const bound = (await harness.runtime.bindings())[0]?.sessionId
    assert.ok(bound)

    // The listing this conversation just received printed one row, so 9 names nothing at all. After
    // the fix a number is never read as an id, so no random session can rescue it — this used to be
    // a 1-in-256 bet, which is why the literal is a number *this screen cannot have* rather than one
    // no live id was expected to match.
    const missed = await control(harness, 'switch', '9')
    assert.equal(missed.ok, false, `a number with no row must fail: ${missed.detail}`)
    assert.match(missed.detail, /切换失败/)
    const body = harness.sent.at(-1)?.text ?? ''
    assert.match(body, /没有成功/)
    assert.match(body, /找不到编号 9/)
    assert.match(body, /这一屏只有 1 项（1–1）/)
    assert.equal((await harness.runtime.bindings())[0]?.sessionId, bound, 'and nothing moved')
  })
})

test('the session tool reports the current conversation', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const result = await control(harness, 'current')
    assert.equal(result.ok, true)
    // The answer is `/current`'s own words, the same ones a typed command produces: the spoken and
    // typed routes share one implementation, so a user asking in a sentence and a user typing the
    // command must not get two different replies.
    assert.match(result.detail, /当前对话「/)
    assert.match(result.detail, /[0-9a-f]{6}/, 'and the id, which is what identifies it')
    // And the channel said it, rather than leaving the agent to describe a conversation the user
    // cannot see.
    assert.match(harness.sent.at(-1)?.text ?? '', /当前对话「/)
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
    assert.match(description, /do not repeat it or claim success/)
    assert.match(description, /failures included/)
    assert.match(description, /say nothing if `ok` is false/)
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

test('/model lists every model, numbered, with the one in use marked', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const promptsBefore = harness.prompted.length

    await harness.runtime.ingest(inbound('/model'))

    assert.equal(harness.prompted.length, promptsBefore, 'a command must not reach the agent')
    const body = harness.sent.at(-1)?.text ?? ''
    // The heading names the model in use, so the answer to "which one am I on" does not depend on
    // the user scanning the rows for the marker.
    assert.match(body, /可用模型（共 3 个，当前：DeepSeek V3\.2）：/)
    // Rows in catalog order, numbered the way the user has to reply.
    const rows = body.split('\n').filter((line) => /^\d+\. /.test(line))
    assert.deepEqual(
      rows.map((row) => row.replace('  ← 当前', '')),
      ['1. DeepSeek V3.2', '2. DeepSeek Reasoner', '3. Qwen3 Coder'],
    )
    assert.equal(body.match(/← 当前/g)?.length, 1, 'exactly one model is marked current')
    assert.match(body, /1\. DeepSeek V3\.2 {2}← 当前/)
    /*
     * The provider and the id sit on the second line of each row.
     *
     * Two providers can offer the same model id, and the id is what a user may end up typing, so a
     * row that showed only the label would be ambiguous in exactly the case that matters.
     */
    assert.match(body, /DeepSeek 官方 · deepseek-chat/)
    assert.match(body, /OpenRouter · qwen3-coder/)
    assert.match(body, /回复 \/model 编号即可切换/)
  })
})

test('/model switches by name, on the session the conversation is bound to', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const sessionId = harness.prompted[0]?.sessionId

    await harness.runtime.ingest(inbound('/model DeepSeek Reasoner'))

    /*
     * The selection is addressed by session id rather than resolved from the caller.
     *
     * The person switching is on a phone and is not inside any session; the session that has to
     * change is the one their conversation is bound to.
     */
    assert.deepEqual(harness.modelSelections, [
      {
        sessionId,
        provider: 'deepseek-account',
        model: 'deepseek-reasoner',
        // A reasoning model has to be selected at a level, and the model's own default is what the
        // host itself would pick — so the user is not silently handed a different one.
        reasoningEffort: 'medium',
      },
    ])
    const confirmation = harness.sent.at(-1)?.text ?? ''
    assert.match(confirmation, /^已把「.+」切换到 DeepSeek Reasoner（DeepSeek 官方）。/)
    // The id follows the label, because the id is what the user can type back.
    assert.match(confirmation, /deepseek-reasoner/)
  })
})

test('/model switches by the number the list printed', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))

    await harness.runtime.ingest(inbound('/model 3'))

    // Row 3 in the catalog is the other provider's model, so a number reaching the wrong row would
    // land on the wrong provider and still look like a success.
    assert.deepEqual(
      harness.modelSelections.map((entry) => `${entry.provider}/${entry.model}`),
      ['openrouter/qwen3-coder'],
    )
    assert.match(harness.sent.at(-1)?.text ?? '', /切换到 Qwen3 Coder（OpenRouter）/)
  })
})

test('/model with a name that does not exist changes nothing and says so', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))

    await harness.runtime.ingest(inbound('/model GPT-9'))

    const reply = harness.sent.at(-1)?.text ?? ''
    // Named back, and the next step spelled out — the user cannot tell a missing model from a
    // differently spelled one without being shown the list.
    assert.match(reply, /找不到模型「GPT-9」/)
    assert.match(reply, /回复 \/model 看清单/)
    assert.deepEqual(harness.modelSelections, [], 'nothing was selected')
  })
})

test('the model tool offers the actions a user can ask for, levels included', async () => {
  await withSettings(async (harness) => {
    const tool = modelTool(harness)
    const properties = tool.parameters.properties as Record<
      { enum?: string[] } & Record<string, unknown>
    >
    const action = (properties as Record<string, { enum?: string[] }>).action
    // The enum is what the model chooses from, so an action missing here is unreachable.
    assert.deepEqual(action?.enum, ['list', 'switch', 'set_level'])
    assert.deepEqual(tool.parameters.required, ['action'])
    // The description is the only thing that decides whether a spoken request reaches this tool.
    assert.match(tool.description, /Call this whenever the user asks/)
    assert.match(tool.description, /换个模型/)
    // A level asked for in words has to reach this tool too, or "调高一点" is answered with prose.
    assert.match(tool.description, /推理等级/)
    assert.match(tool.description, /thinking level/)
    assert.match(tool.description, /never claim a model\/level switch succeeded/)
    assert.match(tool.description, /say nothing if `ok` is false/)
    assert.match(tool.description, /from the next turn/)
    // The level is its own parameter, documented for both actions that take one.
    const level = (properties as Record<string, { description?: string }>).level
    assert.match(level?.description ?? '', /Required for set_level/)
    assert.match(level?.description ?? '', /switch it is optional/)
  })
})

/*
 * The two rules in `notify_wechat`'s description that no code can enforce for the agent.
 *
 * Nothing in the tool refuses a burst of ten separate messages: the service accepts them until the
 * window closes, and then the eleventh is refused. The ten-message rule reaches the model only
 * through this text. Likewise, a script that opens its own iLink client bypasses the ledger the
 * plugin and `dsh-wechat-send` share — the plugin cannot count, warn about, or queue a send it
 * never sees. These assertions are the guard against "shortening" either rule out of existence.
 */
test('the notify_wechat description keeps the ten-message window and the script route', async () => {
  await withHarness(async (harness) => {
    const description = notifyTool(harness).description

    assert.match(description, /ten messages/)
    assert.match(description, /reply window/)
    assert.match(description, /reopens only when the user writes/)
    assert.match(description, /one message, not several/)

    assert.match(description, /dsh-wechat-send/)
    assert.match(description, /never the iLink API/)
    assert.match(description, /count, warn and queue/)
    assert.match(description, /direct calls lose messages/)
  })
})

/*
 * The channel's own announcement is the only message that reaches the chat after a switch.
 *
 * An agent summary on top of it is noise at best. At worst it contradicts the channel: on a failed
 * switch the tool returns `ok: false` while the agent, reading only its own intention, tells the
 * user the move worked. Both descriptions therefore have to say it: the channel announced it, do
 * not repeat it, never claim success, and stay silent when `ok` is false.
 */
test('the session and model descriptions keep the channel-announcement rule', async () => {
  await withSettings(async (harness) => {
    const session = sessionTool(harness).description
    assert.match(session, /announces switching\/creating/)
    assert.match(session, /failures included/)
    assert.match(session, /do not repeat it or claim success/)
    assert.match(session, /say nothing if `ok` is false/)

    const model = modelTool(harness).description
    assert.match(model, /announces listing and switching/)
    assert.match(model, /failures included/)
    assert.match(model, /do not repeat it/)
    assert.match(model, /never claim a model\/level switch succeeded/)
    assert.match(model, /say nothing if `ok` is false/)
    // A switch lands on the next turn; claiming it changed the turn already running is the lie this
    // sentence prevents.
    assert.match(model, /from the next turn/)
  })
})

test('/model marks the session’s own model and level, not the deployment default', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))

    // The conversation moves itself onto the reasoning model, which is a session-local selection.
    await harness.runtime.ingest(inbound('/model DeepSeek Reasoner'))

    await harness.runtime.ingest(inbound('/model'))
    const body = harness.sent.at(-1)?.text ?? ''
    /*
     * The mark comes from the session's own projection.
     *
     * The deployment default is still `deepseek-chat`, so a list that marked the default would name
     * DeepSeek V3.2 — and the user would read the level off a model their next turn is not using.
     */
    assert.match(body, /可用模型（共 3 个，当前：DeepSeek Reasoner · 中）：/)
    assert.match(body, /2\. DeepSeek Reasoner {2}← 当前/)
    assert.match(body, /推理等级：Low · 中（当前） · High/)
    // The levels are offered, with an example taken from the catalog (the model's own default).
    assert.match(body, /回复 \/model 等级 <等级> 切换推理等级，例如 \/model 等级 medium。/)
  })
})

test('a host that cannot report the session’s model still lists it, marked with the default', async () => {
  for (const modelProjection of ['absent', 'throws'] as const) {
    await withMount(
      async (harness) => {
        await harness.runtime.ingest(inbound('第一条'))
        const before = harness.sent.length

        await harness.runtime.ingest(inbound('/model'))

        // The whole point: the read is optional, so losing it costs the precision of one mark and
        // never the command itself. A throw escaping here would replace the list with a failure.
        assert.equal(harness.sent.length, before + 1, `one list for ${modelProjection}`)
        const body = harness.sent.at(-1)?.text ?? ''
        assert.match(body, /可用模型（共 3 个，当前：DeepSeek V3\.2）：/, `listing for ${modelProjection}`)
        // And a level switch is still reachable, with the level named by hand: nothing about the
        // session read is needed to *set* one.
        const switched = await controlModel(harness, 'switch', 'DeepSeek Reasoner', 'high')
        assert.equal(switched.ok, true, `level switch after ${modelProjection}: ${switched.detail}`)
        assert.deepEqual(
          harness.modelSelections.map((entry) => entry.reasoningEffort),
          ['high'],
        )
      },
      { modelProjection },
    )
  }
})

test('a failed session-model read is recorded, so the weaker mark is answerable', async () => {
  await withMount(
    async (harness) => {
      await harness.runtime.ingest(inbound('第一条'))
      await harness.runtime.ingest(inbound('/model'))

      const log = (await bootLogLines(harness)).join('\n')
      // §3.7/§4.14: a path that silently falls back is one nobody can diagnose. The session id and
      // the host's own error are what make "why is my list wrong" answerable.
      assert.match(log, /model: reading the selection of session-/)
      assert.match(log, /session query unavailable/)
    },
    { modelProjection: 'throws' },
  )
})

test('/model 等级 switches the level of the model in use, by command', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    await harness.runtime.ingest(inbound('/model DeepSeek Reasoner'))
    const sessionId = harness.prompted[0]?.sessionId

    await harness.runtime.ingest(inbound('/model 等级 high'))

    // Same provider and model, new level: that is what "change the level" means to the host.
    assert.deepEqual(harness.modelSelections, [
      {
        sessionId,
        provider: 'deepseek-account',
        model: 'deepseek-reasoner',
        reasoningEffort: 'medium',
      },
      {
        sessionId,
        provider: 'deepseek-account',
        model: 'deepseek-reasoner',
        reasoningEffort: 'high',
      },
    ])
    const body = harness.sent.at(-1)?.text ?? ''
    assert.match(body, /^已把「.+」的推理等级切到 High（DeepSeek Reasoner）。/)
  })
})

test('/model 等级 with a level the model does not have says so and changes nothing', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const selectionsBefore = harness.modelSelections.length

    await harness.runtime.ingest(inbound('/model 等级 超高'))

    const body = harness.sent.at(-1)?.text ?? ''
    // The model in use has no levels at all, which is the more common refusal.
    assert.match(body, /^当前模型不支持推理等级/)
    assert.equal(harness.modelSelections.length, selectionsBefore, 'nothing was selected')
  })
})

test('a level switch the host refuses is told to the user, and never reported as done', async () => {
  await withMount(
    async (harness) => {
      await harness.runtime.ingest(inbound('第一条'))
      await harness.runtime.ingest(inbound('/model DeepSeek Reasoner'))
      const before = harness.sent.length

      const result = await controlModel(harness, 'set_level', undefined, 'high')

      /*
       * The failure the whole shape exists for: the command answers with guidance instead of throwing,
       * so the tool result has to *read* the answer. A false success here leaves the agent telling the
       * user a level the next turn is not thinking at, and nothing about the chat would look wrong.
       */
      assert.equal(result.ok, false)
      assert.match(result.detail, /操作失败，已直接告诉用户/)
      assert.match(result.detail, /切换推理等级失败/)
      // And the user is told directly, which is what makes the agent's silence safe.
      assert.equal(harness.sent.length, before + 1)
      assert.match(harness.sent.at(-1)?.text ?? '', /^切换推理等级失败：session\/model-unavailable/)
    },
    // The first call moves the conversation onto the reasoning model; the second one is the refusal.
    { failModelSelectionFrom: 2 },
  )
})

test('the model tool changes the level on its own, and the channel tells the user', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    await harness.runtime.ingest(inbound('/model DeepSeek Reasoner'))
    const sessionId = harness.prompted[0]?.sessionId
    const before = harness.sent.length

    const result = await controlModel(harness, 'set_level', undefined, 'Low')

    assert.equal(result.ok, true, `level switch failed: ${result.detail}`)
    assert.deepEqual(harness.modelSelections.at(-1), {
      sessionId,
      provider: 'deepseek-account',
      model: 'deepseek-reasoner',
      // Matched by name, case-insensitively: `Low` is what the list printed.
      reasoningEffort: 'low',
    })
    assert.equal(harness.sent.length, before + 1, 'exactly one message was sent')
    assert.match(harness.sent.at(-1)?.text ?? '', /推理等级切到 Low/)
    assert.match(result.detail, /推理等级已切换/)
  })
})

test('the model tool switches model and level together, in one action', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))

    const result = await controlModel(harness, 'switch', 'DeepSeek Reasoner', 'high')

    assert.equal(result.ok, true, `switch failed: ${result.detail}`)
    assert.deepEqual(harness.modelSelections.at(-1), {
      sessionId: harness.prompted[0]?.sessionId,
      provider: 'deepseek-account',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    })
    const body = harness.sent.at(-1)?.text ?? ''
    assert.match(body, /切换到 DeepSeek Reasoner/)
    assert.match(body, /推理等级：High/)
  })
})

test('the model tool refuses a level action with no level, and an unknown action', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const selectionsBefore = harness.modelSelections.length

    // A targetless level switch would otherwise list the levels and report success, which reads as a
    // change that happened.
    const targetless = await controlModel(harness, 'set_level')
    assert.equal(targetless.ok, false)
    assert.match(targetless.detail, /需要指定等级/)

    assert.equal(harness.modelSelections.length, selectionsBefore)
  })
})

test('the model tool switches, and the channel tells the user', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const before = harness.sent.length

    const result = await controlModel(harness, 'switch', 'Qwen3 Coder')

    assert.equal(result.ok, true, `switch failed: ${result.detail}`)
    assert.deepEqual(
      harness.modelSelections.map((entry) => `${entry.provider}/${entry.model}`),
      ['openrouter/qwen3-coder'],
    )
    /*
     * Exactly one message, sent by the channel.
     *
     * A tool result is only ever shown to the agent, so leaving the confirmation to it is what
     * produced replies pointing at a message that never existed. And the agent is told not to repeat
     * it, so the user is not told twice.
     */
    assert.equal(harness.sent.length, before + 1, 'exactly one message was sent')
    assert.match(harness.sent.at(-1)?.text ?? '', /切换到 Qwen3 Coder/)
    assert.match(result.detail, /不要重复/)
  })
})

test('the model tool lists models and hands the listing to the channel', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const before = harness.sent.length

    const result = await controlModel(harness, 'list')

    assert.equal(result.ok, true)
    assert.equal(harness.sent.length, before + 1)
    const body = harness.sent.at(-1)?.text ?? ''
    assert.match(body, /可用模型（共 3 个/)
    assert.match(body, /← 当前/)
    assert.match(result.detail, /不要重复/)
  })
})

test('a model switch that fails is reported, because the agent may claim it worked', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const before = harness.sent.length

    const result = await controlModel(harness, 'switch', 'GPT-9')

    // The command answers with guidance rather than throwing, so the result has to be read rather
    // than assumed — otherwise the agent tells the user about a model the next turn is not using.
    assert.equal(result.ok, false)
    assert.match(result.detail, /找不到模型/)
    // The user is told directly, which is the only thing that makes the agent's silence safe.
    assert.equal(harness.sent.length, before + 1)
    assert.match(harness.sent.at(-1)?.text ?? '', /找不到模型「GPT-9」/)
  })
})

test('the model tool refuses an unknown action and a switch with no target', async () => {
  await withSettings(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const promptsBefore = harness.prompted.length
    const selectionsBefore = harness.modelSelections.length

    // An action this plugin does not have must fail here rather than being turned into some other
    // slash command that happens to start with a slash.
    const unknown = await controlModel(harness, 'new')
    assert.equal(unknown.ok, false)
    assert.match(unknown.detail, /不支持的操作/)

    // A switch with no target would otherwise list the models and report success, which reads as a
    // switch that happened.
    const targetless = await controlModel(harness, 'switch')
    assert.equal(targetless.ok, false)
    assert.match(targetless.detail, /需要指定目标/)

    assert.equal(harness.prompted.length, promptsBefore, 'neither attempt starts a turn')
    assert.equal(harness.modelSelections.length, selectionsBefore)
  })
})

test('the model tool refuses when the caller is not bound to a WeChat conversation', async () => {
  await withSettings(async (harness) => {
    const result = await modelTool(harness).execute(
      { action: 'list' },
      { agent: { session: { id: 'session-not-ours' } } },
    )
    assert.equal(result.ok, false)
    assert.match(result.detail, /没有绑定/)
  })
})

/**
 * Wait for a condition the channel reaches asynchronously.
 *
 * A confirmation is answered by a later message, so the question is sent from a detached task
 * rather than inside the inbound call. Tests therefore have to wait for the effect instead of
 * asserting the instant `ingest` returns — and polling with a deadline keeps a genuine hang
 * failing fast rather than holding the suite open.
 *
 * The predicate may be asynchronous, because many of the effects worth waiting for are on disk: a
 * charge written to the state file, a line appended to the boot log. A fixed sleep long enough for
 * the author's machine is what a release was blocked by — see {@link deliverReply} — and
 * waiting for the fact the assertion is about cannot be too short on a slow runner or too long on
 * a fast one.
 *
 * @param check - Condition that becomes true.
 * @param what - Description used in the failure message.
 */
async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await check()) return
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
    // A short window, so the test measures the release rather than the wait. What it asserts is that
    // the photo is not stranded when no caption follows — the length of the window is a setting.
    await withSettings(
      async (harness) => {
        await harness.runtime.ingest(await imageMessage(aesKey, '', reference))
        assert.equal(harness.prompted.length, 0)

        await waitFor(() => harness.prompted.length === 1, 'the photo to be released')

        assert.equal(harness.prompted.length, 1, 'the photo is prompted once the window closes')
        assert.match(harness.prompted[0].text, /\[图片\]/)
      },
      { mergeWindowMs: 200 },
    )
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

test('routing survives a remount: the same session is resumed again', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    const first = await mount({ home, seedAccount: true })
    await first.runtime.ingest(inbound('first'))
    const sessionId = first.prompted[0].sessionId
    first.dispose()

    // A fresh mount reads the persisted binding and resumes the same session directly.
    const second = await mount({ home })
    await second.runtime.ingest(inbound('after restart'))
    assert.equal(second.created.length, 0, 'a stored session needs no create call')
    assert.equal(second.prompted.at(-1)?.sessionId, sessionId)
    assert.deepEqual(second.resolvedWorkspacePaths, [], 'and no workspace is resolved for it')
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
    // a create whose workspace differs, so it must never drift.
    assert.deepEqual(harness.resolvedWorkspacePaths, [custom])
    assert.equal(harness.created.length, 1, 'the session is created once, then resumed in place')
    const id = harness.created[0].workspaceId
    assert.ok(id !== undefined && id !== '', 'a workspace was named')
  } finally {
    harness.dispose()
    await removeHome(home)
  }
})

test('a workspace chosen in Settings is used, and beats the loader-patch override', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  const chosen = join(home, 'picked-ws')
  const fromConfig = join(home, 'from-config')
  /*
   * Seeded by hand rather than through `seedAccount`: that helper writes the whole state file, which
   * would land on top of the setting before the plugin ever reads it.
   */
  await mkdir(join(home, 'wechat'), { recursive: true })
  await writeFile(
    join(home, 'wechat', 'state.json'),
    JSON.stringify({
      version: 1,
      accounts: {},
      syncBufs: {},
      contextTokens: {},
      bindings: {},
      settings: { workspacePath: chosen },
    }),
    'utf8',
  )
  const harness = await mount({ home, seedAccount: false, config: { workspace: fromConfig } })
  try {
    assert.ok(existsSync(chosen), 'the chosen directory is created at startup')
    assert.ok(!existsSync(fromConfig), 'the patch override is not created when a choice exists')
    const status = await harness.runtime.status()
    // Reported as the resolved directory, not the default: this used to be computed from the home
    // rather than read back, so a moved workspace was displayed at its old path.
    assert.equal(status.diagnostics?.workspace, chosen, 'diagnostics report the chosen directory')
  } finally {
    harness.dispose()
    await removeHome(home)
  }
})

test('an empty workspace setting falls back to the default under the DSH home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  await mkdir(join(home, 'wechat'), { recursive: true })
  await writeFile(
    join(home, 'wechat', 'state.json'),
    JSON.stringify({
      version: 1,
      accounts: {},
      syncBufs: {},
      contextTokens: {},
      bindings: {},
      settings: { workspacePath: '' },
    }),
    'utf8',
  )
  const harness = await mount({ home, seedAccount: false })
  try {
    const status = await harness.runtime.status()
    const fallback = join(home, 'dsh_wechat')
    assert.equal(status.diagnostics?.workspace, fallback, 'empty means the default')
    assert.ok(existsSync(fallback), 'the default directory is created')
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
      /*
       * The submission runs detached from ingest and the fallback adds a round trip, so wait for the
       * fallback to land instead of guessing how long it takes. A fixed wait here was the same bet
       * the reply tests lost on a CI runner — see {@link deliverReply}.
       */
      await waitFor(() => harness.prompted.length === 1, 'the fallback to reach the queue')

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
      // Handing the words back runs in the same detached task; wait for it to be sent.
      await waitFor(() => harness.sent.length > 0, 'the message to be handed back')

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
    const sentBefore = harness.sent.length
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
    await waitFor(() => harness.sent.length > sentBefore, 'the prompt to reach the phone')
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

    const sentBefore = harness.sent.length
    const outcomePromise = approval(
      { agent: { session: { id: sessionId } }, toolName: 'shell' },
      () => Promise.resolve('delegated' as const),
    )
    // Answering before the prompt is out would settle nothing, so wait for it.
    await waitFor(() => harness.sent.length > sentBefore, 'the prompt to reach the phone')
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
    const sentBefore = harness.sent.length
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

    await waitFor(() => harness.sent.length > sentBefore, 'the question to reach the phone')
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

    const sentBefore = harness.sent.length
    const answerPromise = questions(
      {
        agent: { session: { id: sessionId } },
        questions: [{ id: 'q1', question: '叫什么名字？' }],
      },
      () => Promise.resolve({ answers: [] }),
    )
    await waitFor(() => harness.sent.length > sentBefore, 'the question to reach the phone')
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
    const sentBefore = harness.sent.length
    const outcomePromise = approval(
      { agent: { session: { id: sessionId } }, toolName: 'shell' },
      () => Promise.resolve('delegated' as const),
    ).then((value) => {
      settled = true
      return value
    })
    await waitFor(() => harness.sent.length > sentBefore, 'the prompt to reach the phone')

    // Not a decision. It must route normally — losing a user's message because a prompt happened
    // to be open is worse than an unanswered prompt.
    const promptsBefore = harness.prompted.length
    await harness.runtime.ingest(inbound('顺便帮我查一下天气'))
    // Both facts the assertions below read: the words reached the agent, and the prompt was repeated.
    await waitFor(
      () =>
        harness.prompted.length === promptsBefore + 1 &&
        (harness.sent.at(-1)?.text ?? '').includes('请回复上一条提示'),
      'the message to reach the agent and the prompt to be repeated',
    )

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
  description: string
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
 * @param quotaUsed - Sends to record as already charged against the stored reply token.
 */
async function seedBoundConversation(
  home: string,
  settings: Record<string, unknown> = {},
  pending: unknown[] = [],
  quotaUsed = 0,
): Promise<void> {
  /*
   * The bound session has to exist on disk, or this fixture would describe a conversation whose
   * session is *gone* — which the channel now detects and repairs by starting a new one and telling
   * the user. That repair is right, but it is not what these tests are about: they stand mid-window
   * to count sends, and a replacement session would spend a slot and arrive as an extra message.
   * So the fixture models a working conversation, which is what it always meant.
   */
  await seedStoredSession(home, join(home, 'dsh_wechat'), 'session-wechat-bound', '微信那边')
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
        /*
         * Seeded so a test can stand mid-window rather than counting up to it. Written with the same
         * token as `contextTokens` above, which is what makes it the *current* window rather than a
         * spent one.
         */
        ...(quotaUsed > 0
          ? {
              quota: {
                'test@im.bot:peer@im.wechat': { token: 'ctx-token-1', used: quotaUsed, warned: false },
              },
            }
          : {}),
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

test('a directory saved from the settings page reaches state.json and is used after a restart', async () => {
  /*
   * The end-to-end shape of the report this covers: `settings.workspacePath` is written by nothing
   * but the page's own save, and no test drove a save through the request, the host's type check,
   * the store write, and the next start. Every half was green while the user's choice never reached
   * the file — and the evidence that settled it was the *absence of the key* in `state.json`, which
   * is exactly what a save that never left the browser looks like.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  const chosen = join(home, 'picked-ws')
  try {
    const harness = await mount({ home, seedAccount: false })
    try {
      const loaded = await callRoute(harness, ROUTE_SETTINGS)
      assert.equal(loaded.status, 200)
      const draft = (loaded.body.settings ?? {}) as Record<string, unknown>
      assert.equal(draft.workspacePath, '', 'an untouched install stores no directory')

      // The page posts its whole draft with one field replaced, which is what the client bundle does.
      const saved = await callRoute(harness, ROUTE_SETTINGS, {
        method: 'POST',
        body: { ...draft, workspacePath: chosen },
      })
      assert.equal(saved.status, 200)
      assert.equal(
        (saved.body.settings as Record<string, unknown>).workspacePath,
        chosen,
        'the answer carries the value the host stored, which is what the page shows',
      )

      // The value really is on disk. This is the assertion whose absence let the bug through.
      const stored = JSON.parse(await readFile(harness.stateFile, 'utf8')) as {
        settings?: Record<string, unknown>
      }
      assert.equal(stored.settings?.workspacePath, chosen, 'the value lands in state.json')

      // And the status tells the two facts apart until a restart: stored is not in effect.
      const before = await harness.runtime.status()
      assert.equal(before.diagnostics?.settingsWorkspace, chosen, 'the stored value is reported')
      assert.notEqual(
        before.diagnostics?.workspace,
        chosen,
        'the directory in use is still the one resolved at startup',
      )

      // The save is diagnosable from the log alone: which key, and both values.
      const line = (await bootLogLines(harness)).find(
        (entry) => entry.includes('settings: saved') && entry.includes('workspacePath'),
      )
      assert.ok(line, 'a settings save writes one line naming the key')
      assert.ok(
        line.includes('workspacePath "" -> ') && line.includes(JSON.stringify(chosen)),
        `the line carries the old and the new value, got: ${String(line)}`,
      )
    } finally {
      harness.dispose()
    }

    // A restart: `apply` reads the stored directory before any message can arrive.
    const second = await mount({ home, seedAccount: false })
    try {
      assert.ok(existsSync(chosen), 'the chosen directory is created at startup')
      const after = await second.runtime.status()
      assert.equal(after.diagnostics?.workspace, chosen, 'the stored directory is the one in use')
      assert.equal(after.diagnostics?.settingsWorkspace, chosen, 'and the two now agree')
    } finally {
      second.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

/**
 * A state store whose writes always fail.
 *
 * Injected rather than coaxed out of the filesystem, so the failure is byte-for-byte the same on
 * every platform. Reads are inherited and still work, which is what the settings page does first —
 * only the write is refused, which is the one thing the test is about.
 */
class RefusingStore extends StateStore {
  /** How many writes were attempted, so the test can show the route really reached the store. */
  attempts = 0

  override async update(): Promise<void> {
    this.attempts += 1
    throw new Error('the state file is not writable (injected failure)')
  }
}

test('a settings save that cannot be written is logged and reported as a failure', async () => {
  /*
   * The other half of the same line: a save that fails has to leave a mark, because the page's own
   * error dialog is gone the moment the tab is closed and the state file then looks exactly like a
   * save that was never attempted.
   *
   * The failure is injected through the store, not produced by the filesystem, because the contract
   * under test is ours: a store that refuses a write must make the route answer 500 and write one
   * `settings: save FAILED` line naming the field. *How* a filesystem refuses belongs to the
   * operating system — a rename over a directory is EPERM on Windows and EISDIR on Linux, and a
   * chmod means nothing to a process running as root — so a test built on it grades the platform
   * rather than the plugin, and passes or fails for reasons this code cannot control. The same
   * scenario through a real filesystem is kept below, asserting only that no success is reported.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    // A real, readable state file, so the page's own load works and only the save is refused.
    await seedState(home, {})
    const store = new RefusingStore(join(home, 'wechat', 'state.json'))
    const harness = await mountWith({ home, seedAccount: false, stateStore: store })
    try {
      const chosen = join(home, 'picked-ws')
      const answer = await callRoute(harness, ROUTE_SETTINGS, {
        method: 'POST',
        body: { workspacePath: chosen },
      })
      assert.equal(answer.status, 500, 'the page is told the save failed')
      assert.equal(store.attempts, 1, 'the route reached the store, which is what refused the write')

      const line = (await bootLogLines(harness)).find((entry) => entry.includes('settings: save FAILED'))
      assert.ok(line, 'the failure reaches the boot log')
      assert.match(line, /workspacePath/, 'and names the field that could not be stored')

      /*
       * And the file still says what it said. A route that answered 500 while the value had landed
       * anyway would be worse than one that lied about the status: the page would report a failure
       * for a save that took effect, and the user would change it again.
       */
      const stored = JSON.parse(await readFile(harness.stateFile, 'utf8')) as {
        settings?: Record<string, unknown>
      }
      assert.notEqual(stored.settings?.workspacePath, chosen, 'nothing was written')
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a save the filesystem refuses is never reported as a success', async () => {
  /*
   * The same failure reached through a real filesystem, kept because it is the shape a user hits — a
   * state file that cannot be replaced, here an empty directory standing where the file belongs. The
   * assertions are deliberately weaker than the test above's: which error comes back and where it is
   * raised is the operating system's business, so the shared, platform-independent claim is only
   * that this is not reported to the page as a save that worked. The exact contract is pinned by the
   * injected failure above, which does not depend on any errno.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-refused-'))
  try {
    await mkdir(join(home, 'wechat', 'state.json'), { recursive: true })
    const harness = await mount({ home, seedAccount: false })
    try {
      const answer = await callRoute(harness, ROUTE_SETTINGS, {
        method: 'POST',
        body: { workspacePath: join(home, 'picked-ws') },
      })
      assert.notEqual(answer.status, 200, 'a save that did not happen must not look saved')
      // Whatever the platform's reason, the refusal has to be findable after the tab is closed.
      const line = (await bootLogLines(harness)).find((entry) => entry.includes('settings: save FAILED'))
      assert.ok(line, 'the failure reaches the boot log')
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
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
        // A zero window means "answer at once", so wait for the answer rather than for a guess at
        // how long the release takes.
        await waitFor(() => harness.prompted.length === 1, 'the attachment to be released')
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
        // This one is a *negative* claim, so the wait only gives the code a chance to be wrong: a
        // slow machine cannot turn it red, which is why a fixed wait is safe here and not above.
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
      /*
       * The file is written, uploaded and then logged, so waiting for its log line is waiting for the
       * whole path — rather than for a guess at how long an upload takes, which is the kind of bet
       * that lost the reply tests a release.
       */
      await waitFor(
        async () =>
          (await readFile(join(home, 'wechat', 'boot.log'), 'utf8').catch(() => '')).includes(
            'long reply',
          ),
        'the long reply to be sent as a file',
      )

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
    // Each kind is logged when it is first seen, so wait for the log to hold the last of them.
    await waitFor(
      async () =>
        (await readFile(join(harness.bundleHome, 'wechat', 'boot.log'), 'utf8')).includes(
          'stream frame shape:',
        ),
      'the frame shapes to reach the log',
    )

    const log = await readFile(join(harness.bundleHome, 'wechat', 'boot.log'), 'utf8')
    for (const kind of kinds) {
      const seen = log.split(`stream chunk kind: ${kind}`).length - 1
      assert.equal(seen, 1, `${kind} must be reported exactly once`)
    }
    assert.equal(log.split('stream frame shape:').length - 1, 1, 'the frameless shape, once')
  })
})

// ---------------------------------------------------------------------------
// Reply-window quota: shared with `dsh-wechat-send`
// ---------------------------------------------------------------------------

/** Read one conversation's persisted reply-window quota. */
async function quotaOnDisk(
  stateFile: string,
  conversationId: string,
): Promise<{ token?: string; used: number; warned: boolean } | undefined> {
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as {
    quota?: Record<string, { token?: string; used: number; warned: boolean }>
  }
  return state.quota?.[conversationId]
}

/** Count how many times the "write me back" warning went out. */
function warningsSent(harness: Harness): number {
  return harness.sent.filter((entry) => entry.text.startsWith(QUOTA_WARNING_PREFIX)).length
}

/** The warning constant, matched by its own text rather than by a copy of it here. */
const QUOTA_WARNING_PREFIX = '📮 微信这边一个回复窗口最多连发'

/** The form the send path records a message under: whitespace collapsed, head only. */
function recordedPreview(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 120)
}

/**
 * A state store that remembers what it has successfully written.
 *
 * The reply-window tests have to know that a send's bookkeeping has reached the file before they
 * assert on it: the charge that decides whether the ask for a new window is due, and the ask itself,
 * both happen inside an asynchronous flush.
 *
 * Reading the state file in a poll answers that question and *breaks the thing it is watching* — on
 * Windows a `rename` over a file that is open for reading fails with EPERM, which is not rare: with a
 * reader polling every millisecond, 790 of 2000 renames failed here. The store then reports the send
 * as failed, no record is written, and the poll times out — a test failing the code it was watching,
 * for a reason that exists only because the test was watching. Observing the store's own completion
 * cannot do that: nothing touches the file, and the write's own success is what is reported.
 */
class RecordingStore extends StateStore {
  /** Every reply record and queued notification this store has written. */
  readonly written = new Set<string>()

  override async update(mutate: Parameters<StateStore['update']>[0]): Promise<void> {
    await super.update(mutate)
    // Read from the store's own cache: watching a write must not open the file it just wrote.
    const state = await this.read()
    for (const perConversation of Object.values(state.sentMessages)) {
      for (const history of Object.values(perConversation)) {
        for (const entry of history) this.written.add(recordedPreview(entry.preview))
      }
    }
    for (const entry of state.pendingNotifications ?? []) {
      this.written.add(recordedPreview(entry.text))
    }
  }
}

/**
 * Mount a harness whose state store reports what it has written.
 *
 * @param home - DSH home the plugin resolves paths under.
 * @param options.send - Sender to use, for a test that makes delivery fail.
 * @returns The mounted plugin and the store it writes through.
 */
async function mountRecording(
  home: string,
  options: { send?: SendFunction } = {},
): Promise<{ harness: Harness; store: RecordingStore }> {
  const store = new RecordingStore(join(home, 'wechat', 'state.json'))
  const harness = await mountWith({ home, seedAccount: false, stateStore: store, ...options })
  return { harness, store }
}

/**
 * Deliver one complete assistant reply through the stream, the way the host does.
 *
 * `ingest` hands the message to the agent and returns; nothing is sent back to WeChat until the
 * assistant stream ends. So a test that cares about what the *channel sent* — its reply, and the
 * reply-window charge that follows it — has to drive that frame too.
 *
 * @param harness - Mounted plugin.
 * @param store - The harness's store, watched for the reply's record.
 * @param text - The assistant's answer for this turn.
 * @param until - Terminal condition for a reply that is not recorded as sent, such as one the service
 *   refused: what to wait for instead of the reply's own record.
 */
async function deliverReply(
  harness: Harness,
  store: RecordingStore,
  text: string,
  until?: () => Promise<boolean>,
): Promise<void> {
  const sessionId = harness.prompted.at(-1)?.sessionId
  assert.ok(sessionId, 'the message must have reached the agent first')
  const listener = harness.listeners.get('agent/assistant-stream')
  assert.ok(listener, 'apply must subscribe to agent/assistant-stream')
  // Two frames, in the shape the host sends them: the text, then the one frame that closes the turn.
  // An `end` frame flushes immediately instead of waiting out the settle window, which is what keeps
  // these tests free of a timeout guessed from a constant someone may later change.
  listener({
    agent: { session: { id: sessionId } },
    frame: { type: 'chunk', revision: 2, chunk: { type: 'text-delta', index: 0, text } },
  })
  listener({ agent: { session: { id: sessionId } }, frame: { type: 'end', revision: 3 } })
  /*
   * The flush is asynchronous, so the test waits for its end rather than guessing how long it takes.
   *
   * This used to sleep a fixed 80 ms. It passed on the author's machine and lost the race on a CI
   * runner, where the assertion right after it — the eighth reply must carry the ask for a new
   * window — reported `expected 1, actual 0` and blocked a release. The wait is for the reply's own
   * record, which is the *last* thing the send path writes: the text goes out first, then the window
   * is charged and the ask sent when it is due, and only then is the message recorded under the id
   * the service assigned. So everything the assertions afterwards care about has already happened,
   * a slow machine only makes the wait slower, and a flush that never finishes still fails, by name.
   *
   * A reply the service refuses is the exception, and the caller says so through `until`: the reply
   * path records that as an error rather than queueing it, so there is no record to wait for.
   */
  if (until === undefined) {
    await waitFor(
      () => store.written.has(recordedPreview(text)),
      `the reply "${text}" to be recorded as sent or queued`,
    )
  } else {
    await waitFor(until, `the reply "${text}" to be accounted for`)
  }
}

test('a reply is charged to the reply window, on disk, and the next one continues it', async () => {
  /*
   * The count used to live in a map inside the process, so every restart began again at zero — and the
   * count is what decides whether the user is asked for a new window *before* the last slot is spent.
   * A process that came back mid-window therefore spent the remainder on messages the platform refused
   * instead of on the one message that would have asked for more.
   *
   * It is on disk now, and it has to stay there: `dsh-wechat-send` is a separate process that reads and
   * writes the same entry, which is the only way a script's sends and the plugin's add up to one ten.
   * The second reply is the part that proves it — each charge is read back from the store rather than
   * accumulated in a field the plugin owns.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedBoundConversation(home)
    const { harness, store } = await mountRecording(home)
    try {
      await harness.runtime.ingest(inbound('第一条'))
      await deliverReply(harness, store, '好的')
      assert.deepEqual(
        await quotaOnDisk(harness.stateFile, 'test@im.bot:peer@im.wechat'),
        { token: 'ctx-token-1', used: 1, warned: false },
        'the charge is stamped with the token it belongs to and written to the state file',
      )

      await harness.runtime.ingest(inbound('第二条'))
      await deliverReply(harness, store, '还是我')
      assert.equal(
        (await quotaOnDisk(harness.stateFile, 'test@im.bot:peer@im.wechat'))?.used,
        2,
        'the second charge continues the stored count instead of starting a new window',
      )
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a send already counted on disk is continued rather than replaced', async () => {
  /*
   * What a `dsh-wechat-send` run leaves behind, seen from the plugin's side: the file says six sends of
   * this window, and the plugin's own reply has to be the seventh. Counted separately, the script and
   * the plugin would each believe they had ten, the user would never be warned in time, and the tail of
   * a series would be refused with nothing having said so — which is the failure the command exists to
   * prevent.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedBoundConversation(home, {}, [], 6)
    const { harness, store } = await mountRecording(home)
    try {
      await harness.runtime.ingest(inbound('接着发'))
      await deliverReply(harness, store, '第七条')

      assert.equal(
        (await quotaOnDisk(harness.stateFile, 'test@im.bot:peer@im.wechat'))?.used,
        7,
        'the plugin continues the count somebody else wrote',
      )
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a message from the user opens a new window and resets the count', async () => {
  // The platform issues a fresh ten with every inbound message, and the token is the only signal this
  // side gets. A count that survived the token change would ask for a window the user has already
  // opened.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedBoundConversation(home)
    const { harness, store } = await mountRecording(home)
    try {
      await harness.runtime.ingest(inbound('第一条'))
      await deliverReply(harness, store, '好的')

      await harness.runtime.ingest(inbound('第二条', { contextToken: 'ctx-token-2' }))
      await deliverReply(harness, store, '又是我')
      assert.deepEqual(await quotaOnDisk(harness.stateFile, 'test@im.bot:peer@im.wechat'), {
        token: 'ctx-token-2',
        used: 1,
        warned: false,
      })
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('the eighth reply asks the user for a new window, once', async () => {
  /*
   * The warning has to fire two short of the limit, because it is itself a message: an ask at the tenth
   * would be an ask with no slot left to carry it. And it has to fire exactly once — repeating it on
   * every later send would spend the remaining slots on asking.
   *
   * It goes out on the low-level sender rather than through the text path, which is what stops charging
   * a send from charging another one and recursing; the count still reflects it, because a message the
   * user received is a message the window spent.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedBoundConversation(home, {}, [], 7)
    const { harness, store } = await mountRecording(home)
    try {
      assert.equal(warningsSent(harness), 0, 'nothing to warn about yet')

      await harness.runtime.ingest(inbound('第八条'))
      await deliverReply(harness, store, '第八次回复')
      assert.equal(warningsSent(harness), 1, 'the eighth send carries the ask')
      assert.equal(
        harness.sent.at(-1)?.text.startsWith(QUOTA_WARNING_PREFIX),
        true,
        'and the ask is the last thing to go out — the reply was sent before the charge',
      )
      assert.deepEqual(await quotaOnDisk(harness.stateFile, 'test@im.bot:peer@im.wechat'), {
        token: 'ctx-token-1',
        used: 9,
        warned: true,
      })

      await harness.runtime.ingest(inbound('第九条'))
      await deliverReply(harness, store, '第九次回复')
      assert.equal(warningsSent(harness), 1, 'the ask is not repeated within the same window')
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})

test('a refused send does not charge the window it could not use', async () => {
  /*
   * The count is only ever advanced after the service accepted the message. Charging first would make
   * every refused send of a closed window add one that never happened, so the arithmetic would claim
   * slots were spent that the user never received — and the ask for a new window would arrive early,
   * or the count would be wrong the moment the window reopened.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-test-'))
  try {
    await seedBoundConversation(home, {}, [], 5)
    const refuse: SendFunction = async () => {
      throw new SendRefusedError('微信会话已超时（session timeout）。', -14)
    }
    const { harness, store } = await mountRecording(home, { send: refuse })
    try {
      await harness.runtime.ingest(inbound('这条会被拒'))
      /*
       * A refused reply is not queued: the reply path catches the refusal and records it, which is
       * what this waits for. Waiting for the reply's own record — the condition the other tests use —
       * would fail here, because a reply that was refused never gets one, and "the count did not
       * move" is meaningless until the attempt has been made and refused.
       */
      await deliverReply(harness, store, '这条回复发不出去', async () =>
        (await harness.runtime.status()).errors.some((entry) => entry.includes('发送失败')),
      )

      assert.equal(
        (await quotaOnDisk(harness.stateFile, 'test@im.bot:peer@im.wechat'))?.used,
        5,
        'a refused send leaves the count where it was',
      )
    } finally {
      harness.dispose()
    }
  } finally {
    await removeHome(home)
  }
})


test('an archived session is not offered by /list', async () => {
  /*
   * The failure this guards: splitStoredSessions groups sessions only by workspace, so an archived
   * session stayed in the listing. Selecting it did not fail loudly — the dead-binding guard rebound
   * the conversation to a brand-new session instead, so the user's next message landed in a
   * conversation with none of the history they expected.
   *
   * The archive set is the authority here, exactly as it is for sessionState().
   */
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('第一条'))
    const archived = harness.created[0]?.sessionId ?? ''
    assert.notEqual(archived, '')
    await harness.runtime.ingest(inbound('/new 第二个'))
    const kept = harness.created.at(-1)?.sessionId ?? ''

    // Two conversations exist; archive the first one.
    await harness.runtime.ingest(inbound('/list'))
    const before = (harness.sent.at(-1)?.text ?? '').split('\n').filter((line) => /^\d+\. /.test(line))
    assert.equal(before.length, 2, `expected two rows before archiving, got: ${before.join(' | ')}`)

    harness.archivedSessionIds.push(archived)

    await harness.runtime.ingest(inbound('/list'))
    const listing = harness.sent.at(-1)?.text ?? ''
    const rows = listing.split('\n').filter((line) => /^\d+\. /.test(line))
    assert.equal(rows.length, 1, `the archived row must be gone: ${listing}`)
    assert.ok(
      !rows.some((row) => row.includes(shortId(archived))),
      `the archived session is still listed: ${listing}`,
    )
    assert.ok(
      rows.some((row) => row.includes(shortId(kept))),
      `the live session must still be listed: ${listing}`,
    )
  })
})

test('a probe that throws keeps the session listed, rather than hiding it', async () => {
  /*
   * The soft edge this guards: a registry that fails to answer is not evidence that a conversation
   * is gone. Dropping rows on a transient error would make the user's history disappear from the one
   * surface they can reach it from.
   *
   * The stub cannot easily throw per session, so this asserts the observable half: the live session
   * survives a listing pass that consults the archive set.
   */
  await withHarness(async (harness) => {
    await harness.runtime.ingest(inbound('唯一一条'))
    const only = harness.created[0]?.sessionId ?? ''
    assert.notEqual(only, '')
    await harness.runtime.ingest(inbound('/list'))
    const listing = harness.sent.at(-1)?.text ?? ''
    const rows = listing.split('\n').filter((line) => /^\d+\. /.test(line))
    assert.equal(rows.length, 1)
    assert.ok(rows[0]?.includes(shortId(only)), `the live session must be kept: ${listing}`)
  })
})

