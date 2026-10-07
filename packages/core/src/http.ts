/**
 * HTTP transport for the iLink Bot API.
 *
 * Two details matter and are easy to get wrong:
 *
 * 1. Request headers. Every call carries `iLink-App-Id`, `iLink-App-ClientVersion`
 *    and a random `X-WECHAT-UIN`; authenticated calls add `AuthorizationType:
 *    ilink_bot_token` plus the bearer token.
 * 2. Identifier precision. The protocol defines several identifiers as `uint64`.
 *    They arrive as bare JSON numbers, so a plain `JSON.parse` would silently
 *    round 19-digit message ids. {@link parseWireJson} quotes those fields before
 *    parsing, copying Tencent's own scanner.
 *
 * @module @dsh-wechat/core/http
 */

import { randomBytes, randomUUID } from 'node:crypto'

import { APP_CLIENT_VERSION, APP_ID, CHANNEL_VERSION, DEFAULT_BOT_AGENT, DEFAULT_API_TIMEOUT_MS, STALE_TOKEN_ERRCODE } from './constants.ts'
import type { BaseInfo, SendMessageResp } from './types.ts'

/**
 * Throw when the service refused a send.
 *
 * Every send endpoint answers HTTP 200 whether it accepted the message or not, and reports a refusal
 * as a non-zero `errcode` with no `message_id`. Reading only `message_id` therefore made every
 * failure indistinguishable from success: `notify_wechat` reported "已通过微信发送" while the phone
 * received nothing, which is the worst shape a bug can take — the user is told the opposite of what
 * happened, and there is nothing to investigate.
 *
 * `errcode ?? ret` because the send endpoints use `errcode` while the polling endpoint has been seen
 * with either; both are checked so a response shape change cannot reopen this hole.
 *
 * @param response - Parsed response from `ilink/bot/sendmessage`.
 * @throws When the service refused, with the reason it gave.
 */
export function assertSendAccepted(response: SendMessageResp): void {
  const errcode = response.errcode ?? response.ret
  if (errcode === undefined || errcode === 0) return

  if (errcode === STALE_TOKEN_ERRCODE) {
    // Specifically actionable, unlike a generic failure: the conversation has gone quiet long enough
    // that the reply context expired, and only an inbound message from the user can revive it. The
    // agent can say so instead of retrying into the same refusal.
    throw new Error(
      '微信会话已超时（session timeout）。需要用户先在微信里给机器人发一条消息，之后才能主动推送。',
    )
  }
  throw new Error(`发送被微信拒绝：errcode=${String(errcode)} errmsg=${response.errmsg ?? '(无)'}`)
}

/**
 * Identifiers the wire format declares as `uint64`.
 *
 * Timestamp and sequence fields are deliberately excluded: they stay numbers,
 * and only identifiers risk exceeding `Number.MAX_SAFE_INTEGER`.
 */
const LOSSLESS_ID_FIELDS = ['message_id', 'msg_id', 'svr_id'] as const

/**
 * Parse a wire response without losing `uint64` precision.
 *
 * Only object property values are rewritten, and only when they are long enough
 * to be at risk, so identifiers inside ordinary strings are left alone.
 *
 * @param raw - Response body.
 * @returns The parsed value.
 */
export function parseWireJson<T>(raw: string): T {
  const alternation = LOSSLESS_ID_FIELDS.join('|')
  const rewritten = raw.replace(
    new RegExp(`"(${alternation})"\\s*:\\s*(\\d{6,})`, 'g'),
    '"$1":"$2"',
  )
  return JSON.parse(rewritten) as T
}

/** Copy the inbound message ids out of a raw body as strings. Diagnostic helper. */
export function extractRawIds(raw: string): string[] {
  const out: string[] = []
  const re = new RegExp(`"(?:${LOSSLESS_ID_FIELDS.join('|')})"\\s*:\\s*(\\d{6,})`, 'g')
  for (const match of raw.matchAll(re)) out.push(match[1])
  return out
}

/** `X-WECHAT-UIN`: a random uint32 rendered as a decimal string, then base64. */
function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64')
}

export interface ApiRequest {
  /** API host. Trailing slash optional. */
  baseUrl: string
  /** Endpoint path relative to the host, query string already encoded. */
  endpoint: string
  method?: 'GET' | 'POST'
  /** JSON body, serialized verbatim. GET requests normally omit it. */
  body?: unknown
  /** Bot token. Omit only for QR-code requests. */
  token?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Identity hint reported in `base_info`. */
  botAgent?: string
}

/** Thrown when the service answers with a non-2xx status. */
export class ApiHttpError extends Error {
  readonly status: number
  readonly body: string
  readonly endpoint: string

  constructor(endpoint: string, status: number, body: string) {
    super(`${endpoint} HTTP ${status}: ${body.slice(0, 300)}`)
    this.name = 'ApiHttpError'
    this.status = status
    this.body = body
    this.endpoint = endpoint
  }
}

/** `base_info` attached to request bodies that accept it. */
export function baseInfo(botAgent = DEFAULT_BOT_AGENT): BaseInfo {
  return { channel_version: CHANNEL_VERSION, bot_agent: botAgent }
}

/**
 * Perform one API call and return the decoded JSON.
 *
 * @param request - Call description.
 * @returns The parsed response body.
 * @throws {ApiHttpError} On a non-2xx status.
 */
export async function apiCall<T>(request: ApiRequest): Promise<T> {
  const raw = await apiCallRaw(request)
  return parseWireJson<T>(raw)
}

/**
 * Perform one API call and return the raw body.
 *
 * Kept separate because the caller sometimes needs the untouched text — for
 * diagnostics, and because error replies are not always valid JSON.
 */
export async function apiCallRaw(request: ApiRequest): Promise<string> {
  const base = request.baseUrl.endsWith('/') ? request.baseUrl : `${request.baseUrl}/`
  const url = new URL(request.endpoint, base)
  const headers = buildHeaders({ token: request.token })

  const controller = request.timeoutMs === undefined ? undefined : new AbortController()
  const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), request.timeoutMs)
  const signal = combineSignals(controller?.signal, request.signal)

  try {
    const response = await fetch(url.toString(), {
      method: request.method ?? 'POST',
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await response.text()
    if (!response.ok) throw new ApiHttpError(request.endpoint, response.status, text)
    return text
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Headers shared by every call, authenticated or not.
 *
 * @param params.token - Bot token, when the call is authenticated.
 */
export function buildHeaders(params: { token?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': APP_CLIENT_VERSION,
    'X-WECHAT-UIN': randomWechatUin(),
  }
  const token = params.token?.trim()
  if (token) {
    headers.AuthorizationType = 'ilink_bot_token'
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

/** Unique id for one outbound message, echoed back by the server for correlation. */
export function newClientId(prefix = 'dsh-wechat'): string {
  return `${prefix}-${randomUUID()}`
}

/** Abort as soon as either signal fires. */
function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  if (a.aborted) return a
  if (b.aborted) return b
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return controller.signal
}

export { DEFAULT_API_TIMEOUT_MS }
