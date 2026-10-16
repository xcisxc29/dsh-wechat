/**
 * Host surface this plugin needs, declared locally.
 *
 * The shapes match the official controllers shipped inside DSH. They are declared
 * here rather than imported because an installable bundle must not depend on the
 * host's internal packages at build time — the same approach the official
 * `dsh-orb` bundle takes. Anything missing here simply keeps the plugin pending.
 *
 * @module dsh-wechat/services
 */

/** Session identifiers DSH mints look like `session-<uuid>`. */
export type SessionId = string

/** One entry from the host's session list. */
export interface SessionSummary {
  readonly sessionId: SessionId
  readonly title?: string
  readonly updatedAt: number
  readonly agentPreset?: string
}

/** One provider, model and reasoning effort — what a session runs on. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One reasoning effort a model accepts. */
export interface ModelReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One model a selector may offer. */
export interface ModelCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  /**
   * Present only on models that expose reasoning levels.
   *
   * `defaultEffort` is what the host itself selects with, so it is what this plugin passes back
   * rather than leaving the choice to a resolve step the user cannot see.
   */
  readonly reasoning?: {
    readonly efforts: readonly ModelReasoningEffort[]
    readonly defaultEffort?: string
  }
}

/** Models under one provider, which is how the desktop picker groups them. */
export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelCatalogModel[]
}

/** One provider whose models could not be listed, with the host's own reason. */
export interface ModelCatalogFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

/** Every model the deployment can currently route to. */
export interface ModelCatalog {
  readonly default: ModelSelection
  readonly routableProviders: readonly string[]
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly ModelCatalogFailure[]
}

/**
 * Which model, and which reasoning level, one session runs on.
 *
 * `next` is the selection the next request will use — the pending choice when one was just installed,
 * otherwise the one the last request header logged. `lastUsed` is that logged one on its own. Both are
 * `{provider, model, reasoningEffort?}`, and `null` until the session has a request of its own, which
 * is why the caller falls back to the catalog's default.
 */
export interface ModelSelectionProjection {
  readonly lastUsed: ModelSelection | null
  readonly next: ModelSelection | null
}

/** What one session's registered projections currently hold, as far as this plugin reads them. */
export interface SessionProjections {
  readonly modelSelection?: ModelSelectionProjection
}

/** The subset of the session controller this plugin drives. */
export interface SessionControllerService {
  /**
   * Create a session with this id, or adopt the existing one.
   *
   * Idempotent by contract, which is what makes the conversation-to-session
   * mapping durable across host restarts. `cwd` must be identical on every call:
   * the host rejects an adopt whose working directory differs from the stored one.
   */
  create(request: {
    readonly sessionId?: SessionId
    readonly cwd?: string
    readonly workspaceId?: string
    readonly agentPreset?: string
  }): Promise<{ readonly sessionId: SessionId; readonly agentPreset?: string }>

  /**
   * Submit a user message to a session.
   *
   * `mode` decides what happens when a turn is already running: `queue` appends the message
   * after it, `steer` interrupts it. When nothing is running the two are equivalent.
   */
  prompt(
    request: {
      readonly requestId: string
      readonly sessionId: SessionId
      readonly mode: 'queue' | 'steer'
      readonly content: readonly { readonly type: 'text'; readonly text: string }[]
      readonly clientTimeZone?: string
    },
    signal: AbortSignal,
  ): Promise<{ readonly accepted: true }>

  /** Recent sessions, newest first. */
  list(
    request: object,
    signal: AbortSignal,
  ): Promise<{ readonly items?: readonly SessionSummary[] } | readonly SessionSummary[]>

  /** Abort the session's current work. */
  cancel(request: { readonly sessionId: SessionId }): Promise<unknown>

  /**
   * Every model this deployment can route to.
   *
   * Read-only and host-owned: grouping, labels and the default all come from DSH, so a model the
   * host adds or withdraws appears to the user without a plugin change. It takes no session because
   * the catalog is deployment-wide; which entry a *session* is on is read through
   * {@link SessionControllerService.projections} instead.
   */
  modelCatalog(): Promise<ModelCatalog>

  /**
   * Every registered projection for one session, read without activating its Agent.
   *
   * This is the only way to learn which model and reasoning level a *particular* session runs on: the
   * catalog answers deployment-wide, and the picker's default is not the session's choice. It is
   * optional on purpose — the per-session projection is a host generation detail, and a composition
   * that cannot answer must leave `/model` marking the deployment default exactly as it did before,
   * never failing the command. Answers `null` for a session that does not exist.
   */
  projections?(
    request: { readonly sessionId: SessionId },
    signal?: AbortSignal,
  ): Promise<{ readonly values?: SessionProjections } | null>

  /**
   * Point one session at a model, and optionally at one reasoning level.
   *
   * Takes the session id as an argument instead of resolving the caller, because the person asking
   * is on a phone: the session that must change is the one the conversation is bound to, which is
   * not necessarily the session the agent runs in. Throws when the provider or model is unknown, and
   * when the model does not publish the requested level.
   */
  selectModel(request: {
    readonly sessionId: SessionId
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<{ readonly selected: ModelSelection }>
}

/** One registered Workspace, as far as this plugin needs it. */
export interface Workspace {
  readonly id: string
  /** Directory the Workspace owns. Sessions created with this workspace use it as `cwd`. */
  readonly path: string
  readonly title: string
  setTitle(title: string): Promise<void>
}

/**
 * The Workspace registry.
 *
 * Sessions are grouped on the desktop by Workspace: a session created with a bare
 * `cwd` and no workspace lands in the built-in "Ungrouped" bucket, which is not a
 * folder anyone can name. Passing a `workspaceId` is what puts sessions in a named
 * group — and `sessionController.create` accepts `workspaceId` or `cwd`, never both.
 */
export interface WorkspaceRegistryService {
  resolveByPath(path: string): Promise<Workspace | undefined>
  create(path: string): Promise<Workspace>
  get(id: string): Workspace | undefined
  list(): readonly Workspace[]
  /**
   * Sessions the user has archived, across every workspace.
   *
   * The archive set is one registry-global list rather than a per-workspace flag, and it is the only
   * place the fact is recorded — nothing in the session record on disk says so. Optional because a
   * composition without the Workspace feature has no archive concept either, in which case nothing
   * can be archived and there is nothing to report.
   */
  readonly archivedSessionIds?: readonly string[]
}

/** Live session registry, used to read a session's header. */
export interface SessionsService {  get(id: SessionId):
    | {
        readonly header?: { readonly cwd?: string; readonly agentPreset?: string }
      }
    | undefined
}

/** Host facts this plugin reads but can live without. */
export interface OptionalServices {
  /** Registered web routes; present in the browser surface. */
  webServer?: {
    readonly port: number
    register(route: {
      kind: 'prefix'
      path: string
      handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>
    }): () => void
  }
  /** Home path helper, when the host exposes one. */
  homePaths?: { home: string }
}

/** One handler registration's disposer. */
export type Disposer = () => void

/**
 * One tool as the registry accepts it.
 *
 * `parameters` is a plain JSON Schema object. The first-party packages build this with
 * `defineTool`, but that helper lives in `@deepseek-ai/dsh-tools`, which a
 * profile-installed plugin cannot resolve — so the schema is written out directly.
 * `defineTool` only converts a parameter spec into exactly this shape.
 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: 'object'
    readonly properties: Record<string, unknown>
    readonly required?: readonly string[]
    readonly additionalProperties?: boolean
  }
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (args: Record<string, unknown>, value: unknown) => readonly unknown[]
  }
  execute(
    args: Record<string, unknown>,
    exec: { readonly signal?: AbortSignal; readonly agent?: unknown },
  ): Promise<unknown>
}

/** The tool registry. */
export interface ToolsService {
  register(definition: ToolDefinition): Disposer
}

/**
 * The Cordis context as this plugin uses it.
 *
 * `effect` owns setup/teardown, `on` subscribes to host events, and `get` reaches
 * optional services without creating a hard dependency on them.
 */
export interface WechatContext {
  readonly sessionController: SessionControllerService
  readonly sessions: SessionsService
  /**
   * Optional: a composition without the Workspace feature still runs the channel,
   * it just leaves sessions in the built-in Ungrouped bucket.
   */
  readonly workspaceRegistry?: WorkspaceRegistryService
  /**
   * Optional: the tool registry. Present in every real composition, and the only way
   * the agent can send a file back to WeChat.
   */
  readonly tools?: ToolsService
  effect(execute: () => void | (() => void)): void
  get(name: string): unknown
  /**
   * Start a child plugin that waits for these services and then runs with them resolved.
   *
   * The way to reach a service that may not be active yet. `get` is strict — it answers only for a
   * service whose fiber is already active — so during this plugin's synchronous `apply` it misses
   * everything mounted after it, `systemPrompt` among them.
   */
  inject?(services: readonly string[], callback: (ctx: unknown) => void): unknown
  provide(name: string, value: unknown): void
  on(
    name: 'session/created',
    listener: (session: { readonly header?: { readonly cwd?: string; readonly agentPreset?: string } }) => void,
  ): (() => void) | void
  on(
    name: 'agent/assistant-stream',
    listener: (payload: AssistantStreamPayload) => void,
    options?: { readonly global?: boolean; readonly prepend?: boolean },
  ): (() => void) | void
  /**
   * One finished tool call.
   *
   * Optional to receive: the harness dispatches this against the calling agent's scope, so a
   * host-scope plugin may never be inside it. Used only to give tool cards their real status.
   */
  on(
    name: 'tools/result',
    listener: (exec: unknown, result: unknown) => void,
    options?: { readonly global?: boolean; readonly prepend?: boolean },
  ): (() => void) | void
  /**
   * One pending permission prompt, to be answered or delegated.
   *
   * A waterfall: returning an outcome claims the request, calling `next()` leaves it to another
   * answerer. This is what lets a phone-only user answer a prompt the desktop pane would
   * otherwise own, and what makes abstaining on desktop-bound sessions safe.
   */
  on<T>(
    name: 'approval/request',
    listener: (request: unknown, next: () => Promise<T>) => Promise<T>,
    options?: { readonly global?: boolean; readonly prepend?: boolean },
  ): (() => void) | void
  /** One pending structured question, answered or delegated. */
  on<T>(
    name: 'user-questions/request',
    listener: (request: unknown, next: () => Promise<T>) => Promise<T>,
    options?: { readonly global?: boolean; readonly prepend?: boolean },
  ): (() => void) | void
  on(name: string, listener: (...args: unknown[]) => void): (() => void) | void
}

/**
 * One assistant stream frame.
 *
 * DSH emits these while a session is generating; the channel turns them into
 * WeChat replies. The frame is `{ revision, type, attemptId, turn, step }` for
 * `start`, `{ revision, type: 'chunk', chunk }` for `chunk`, and a matching shape
 * for `end`. The text lives one level deeper, on the model chunk.
 *
 * @see `@deepseek-ai/dsh-llm` `AssistantStreamAccumulator` for the chunk variants.
 */
export interface AssistantStreamPayload {
  readonly agent?: { readonly session?: { readonly id?: unknown } }
  readonly frame?: unknown
}

/** What one frame means for the channel. */
export interface StreamFrame {
  /** Session the frame belongs to, when the payload names one. */
  sessionId?: string
  /**
   * User-visible text carried by this frame.
   *
   * Only model *output* text appears here. Reasoning deltas are deliberately
   * excluded: they are the model's private scratchpad, not a reply.
   */
  text?: string
  /** Set on a frame that ends the assistant's output, so the reply can be flushed. */
  completed?: boolean
  /**
   * Every chunk kind this reader has seen, e.g. `text-delta`.
   *
   * Chunk types are a closed set, so a caller can log each one once and learn the stream's
   * whole vocabulary from a single run. That is how a wrong assumption about which chunk
   * announces a tool call gets settled, instead of guessed at a second time.
   */
  chunkType?: string
  /**
   * The field set of a frame this reader could not interpret, e.g. `frame:type,revision;type=start`.
   *
   * Same purpose as {@link chunkType}, for frames that carry no chunk at all.
   */
  frameShape?: string
}

/**
 * Extract the session, visible text, and completion signal from a stream payload.
 *
 * The frame shape is host-owned, so this reads it defensively and tolerates
 * unknown variants rather than throwing. Getting this wrong fails silently — a
 * mismatched field name means the reply is dropped with no error anywhere — so it
 * is written against the documented chunk variants.
 *
 * @param payload - The `agent/assistant-stream` payload.
 */
export function readStreamFrame(payload: AssistantStreamPayload): StreamFrame {
  const rawId = payload.agent?.session?.id
  const sessionId = typeof rawId === 'string' ? rawId : undefined
  const withId: StreamFrame = sessionId === undefined ? {} : { sessionId }

  const frame = payload.frame
  if (typeof frame !== 'object' || frame === null) return withId
  const record = frame as Record<string, unknown>

  if (record.type === 'end') return { ...withId, completed: true }

  // The model chunk carries the content; `start` frames carry none.
  const chunk = record.chunk
  if (typeof chunk !== 'object' || chunk === null) {
    // A frame with no chunk is not a shape this reader understands. Reporting the frame kind
    // is the only way to learn what the harness actually sends: the tool-call chunks this
    // plugin keys on were never observed arriving, and an unobserved assumption cannot be
    // distinguished from a wrong one by reading the code.
    return {
      ...withId,
      frameShape: `frame:${Object.keys(record).join(',')};type=${String(record.type)}`,
    }
  }
  const item = chunk as Record<string, unknown>
  // Every chunk kind seen, reported once by the caller. Chunk types are a closed set, so this
  // is bounded and shows exactly which vocabulary the stream uses.
  const observed: StreamFrame = { ...withId, chunkType: String(item.type) }

  switch (item.type) {
    case 'text-delta':
      // The model's actual output.
      return typeof item.text === 'string' ? { ...withId, text: item.text, ...observed } : observed
    default:
      // `reasoning-delta`, `block-start`, `block-end`, `usage`, `finish`, and anything added
      // later: not user-visible text.
      //
      // `block-end` and `finish` are deliberately not completion signals, even though they
      // read like ones. `finish` fires once per model step, and a turn that calls tools has
      // several steps, so flushing on it splits one answer into several WeChat messages. Only
      // the `end` frame — handled above — closes the turn.
      return observed
  }
}
