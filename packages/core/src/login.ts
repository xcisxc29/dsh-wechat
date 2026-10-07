/**
 * QR-code login for the WeChat ClawBot channel.
 *
 * The flow is a long-poll handshake, and two behaviours in it are load-bearing:
 *
 * - **`bot_type`** is sent on the QR request. Tencent's own client uses `3` and we
 *   keep it identical, because the server may branch on the declared client type.
 * - **`local_token_list`** tells the server which bot identities this deployment
 *   already holds. The server then answers `binded_redirect` instead of issuing a
 *   *new* identity, and it also reconciles the account's binding. Sending the list
 *   is therefore what lets us **adopt** an existing binding rather than silently
 *   take it over — see `reuseExisting` in {@link LoginOptions}.
 *
 * The generator shape keeps every interactive decision with the caller: rendering a
 * QR code, reading a verification code, and deciding what to do on a redirect.
 *
 * @module @dsh-wechat/core/login
 */

import {
  FIXED_BASE_URL,
  DEFAULT_BOT_TYPE,
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_QR_POLL_TIMEOUT_MS,
  MAX_QR_REFRESH,
} from './constants.ts'
import { apiCall } from './http.ts'
import type { QRCodeResponse, QRStatusResponse, WeixinAccount } from './types.ts'

/** How the caller wants an already-bound account handled. */
export type ReusePolicy =
  /** Keep the existing credentials and adopt them. The default, and the safe choice. */
  | 'adopt'
  /** Report the collision instead of pretending it succeeded. */
  | 'reject'

export interface LoginOptions {
  /**
   * Bot tokens this deployment already holds, newest first.
   *
   * Sent as `local_token_list`. Omitting it makes the server treat this as a brand
   * new client, which is what re-binds the account and unbinds whatever was bound
   * before — the exact behaviour a second client causes by scanning naively.
   */
  existingTokens?: readonly string[]
  /** `bot_type` query parameter. Defaults to the WeChat channel build. */
  botType?: string
  /** Overall login deadline. Defaults to five minutes. */
  timeoutMs?: number
  /** Base URL for QR requests. Only overridden by tests. */
  baseUrl?: string
  /** Behaviour when the server reports the bot as already bound. */
  reuseExisting?: ReusePolicy
  /** Called once per status poll with the raw status. Diagnostics only. */
  onStatus?: (status: QRStatusResponse) => void
}

/** One step of the login handshake, surfaced to the caller. */
export type LoginEvent =
  /** A QR code is ready for the user to scan. */
  | { kind: 'qr'; qrUrl: string; qrcode: string; refreshed: boolean }
  /** The user scanned and is being asked to confirm on the phone. */
  | { kind: 'scanned' }
  /** The server wants a pairing verification code. Answer with the generator's input. */
  | { kind: 'verifycode-required'; attempt: number }
  /** The polling host changed. Informational. */
  | { kind: 'redirected'; host: string }
  /** The QR code expired and a fresh one was requested. */
  | { kind: 'expired'; refreshCount: number; willRetry: boolean }
  /** Terminal success. */
  | { kind: 'confirmed'; account: WeixinAccount }
  /** The server considers this deployment already bound. */
  | { kind: 'already-bound' }
  /** Terminal failure. */
  | { kind: 'failed'; reason: string }

/** Outcome of a completed login attempt. */
export interface LoginResult {
  account?: WeixinAccount
  alreadyBound: boolean
  reason?: string
}

/**
 * Request a QR code.
 *
 * @param params.localTokenList - Tokens this deployment already holds, newest first.
 * @param params.botType - Declared client type.
 * @param params.baseUrl - API host.
 * @returns The QR session handle and its renderable payload.
 */
export async function fetchQRCode(params: {
  localTokenList?: readonly string[]
  botType?: string
  baseUrl?: string
}): Promise<QRCodeResponse> {
  const botType = params.botType ?? DEFAULT_BOT_TYPE
  return await apiCall<QRCodeResponse>({
    baseUrl: params.baseUrl ?? FIXED_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    method: 'POST',
    body: { local_token_list: [...(params.localTokenList ?? [])] },
    timeoutMs: 20_000,
  })
}

/**
 * Poll one QR status. The server holds the request, so a client-side timeout is a
 * normal `wait` rather than an error.
 *
 * @param params.qrcode - Session handle from {@link fetchQRCode}.
 * @param params.verifyCode - Pairing code, when the server demanded one.
 */
export async function pollQRStatus(params: {
  qrcode: string
  verifyCode?: string
  baseUrl?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<QRStatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`
  if (params.verifyCode) endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`
  try {
    return await apiCall<QRStatusResponse>({
      baseUrl: params.baseUrl ?? FIXED_BASE_URL,
      endpoint,
      method: 'GET',
      timeoutMs: params.timeoutMs ?? DEFAULT_QR_POLL_TIMEOUT_MS,
      signal: params.signal,
    })
  } catch (error) {
    // A held request that we stopped waiting on is indistinguishable from "nothing yet".
    if (isAbort(error)) return { status: 'wait' }
    throw error
  }
}

/**
 * Drive a complete login handshake.
 *
 * The caller consumes events and answers the interactive one by passing a string
 * back into the generator after `verifycode-required`. Aborting the signal cancels.
 *
 * @param options - Login policy, notably the existing-token list.
 * @param signal - Abort signal that cancels the handshake.
 * @returns Terminal outcome; a `confirmed` event also carries the account.
 */
export async function* login(
  options: LoginOptions = {},
  signal?: AbortSignal,
): AsyncGenerator<LoginEvent, LoginResult, string | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  // Mutable: `scaned_but_redirect` moves the whole handshake to another IDC host.
  let baseUrl = options.baseUrl ?? FIXED_BASE_URL
  const localTokenList = [...(options.existingTokens ?? [])]
  const reuseExisting = options.reuseExisting ?? 'adopt'

  let qr = await fetchQRCode({ localTokenList, botType: options.botType, baseUrl })
  yield { kind: 'qr', qrUrl: qr.qrcode_img_content, qrcode: qr.qrcode, refreshed: false }

  let verifyCode: string | undefined
  let scannedNotified = false
  let refreshCount = 0
  let verifyAttempt = 0

  while (Date.now() < deadline) {
    if (signal?.aborted) return { alreadyBound: false, reason: 'cancelled' }

    let status: QRStatusResponse
    try {
      status = await pollQRStatus({ qrcode: qr.qrcode, verifyCode, baseUrl, signal })
    } catch (error) {
      // Transient transport failures must not abort a login the user is mid-scan on.
      if (isAbort(error) && signal?.aborted) return { alreadyBound: false, reason: 'cancelled' }
      await sleep(1_500, signal)
      continue
    }
    options.onStatus?.(status)

    switch (status.status) {
      case 'wait':
        break

      case 'scaned':
        if (!scannedNotified) {
          scannedNotified = true
          yield { kind: 'scanned' }
        }
        // The verified code has served its purpose; do not resend it.
        verifyCode = undefined
        break

      case 'need_verifycode': {
        verifyAttempt += 1
        if (verifyAttempt > 3) {
          const reason = '验证码多次未通过'
          yield { kind: 'failed', reason }
          return { alreadyBound: false, reason }
        }
        verifyCode = yield { kind: 'verifycode-required', attempt: verifyAttempt }
        break
      }

      case 'verify_code_blocked': {
        const reason = '验证码被服务端锁定，请稍后重试'
        yield { kind: 'failed', reason }
        return { alreadyBound: false, reason }
      }

      case 'expired': {
        refreshCount += 1
        const willRetry = refreshCount <= MAX_QR_REFRESH
        yield { kind: 'expired', refreshCount, willRetry }
        if (!willRetry) {
          const reason = '二维码反复过期'
          yield { kind: 'failed', reason }
          return { alreadyBound: false, reason }
        }
        qr = await fetchQRCode({ localTokenList, botType: options.botType, baseUrl })
        yield { kind: 'qr', qrUrl: qr.qrcode_img_content, qrcode: qr.qrcode, refreshed: true }
        scannedNotified = false
        verifyCode = undefined
        break
      }

      case 'scaned_but_redirect': {
        if (status.redirect_host) {
          yield { kind: 'redirected', host: status.redirect_host }
          // One host change is expected; the handle stays valid there.
          baseUrl = `https://${status.redirect_host}`
        }
        break
      }

      case 'binded_redirect': {
        // The account already has a binding. Adopting it is the whole point of
        // sending `local_token_list`: the existing token keeps working, so we must
        // not overwrite it with a fresh identity.
        yield { kind: 'already-bound' }
        if (reuseExisting === 'adopt') return { alreadyBound: true }
        return { alreadyBound: true, reason: '服务端回复该账号已被绑定' }
      }

      case 'confirmed': {
        const account = accountFromStatus(status, baseUrl)
        if (account === undefined) {
          const reason = status.ilink_bot_id ? '服务端未返回 bot_token' : '服务端未返回 ilink_bot_id'
          yield { kind: 'failed', reason }
          return { alreadyBound: false, reason }
        }
        yield { kind: 'confirmed', account }
        return { account, alreadyBound: false }
      }

      default: {
        // Fail loudly on an unrecognised status rather than looping forever.
        const unknown = status as { status?: string }
        const reason = `未预期的状态: ${String(unknown.status)}`
        yield { kind: 'failed', reason }
        return { alreadyBound: false, reason }
      }
    }

    await sleep(1_000, signal)
  }

  const reason = '登录超时'
  yield { kind: 'failed', reason }
  return { alreadyBound: false, reason }
}

/** Build a persisted account from a confirmed login. */
function accountFromStatus(status: QRStatusResponse, fallbackBaseUrl: string): WeixinAccount | undefined {
  if (!status.ilink_bot_id) return undefined
  const token = status.bot_token?.trim()
  if (!token) return undefined
  const now = new Date().toISOString()
  return {
    accountId: status.ilink_bot_id,
    token,
    baseUrl: status.baseurl?.trim() || fallbackBaseUrl,
    ...(status.ilink_user_id === undefined ? {} : { userId: status.ilink_user_id }),
    savedAt: now,
    boundAt: now,
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
