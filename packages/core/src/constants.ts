/**
 * Wire constants for the Tencent iLink Bot API — the backend behind the official
 * WeChat ClawBot plugin.
 *
 * Every value here was read out of Tencent's own channel implementation,
 * `@tencent-weixin/openclaw-weixin@2.4.9` (MIT), and then confirmed live against
 * the service from a third-party client. Values that the server itself hands
 * back at login (`baseurl`, `redirect_host`, `longpolling_timeout_ms`) are never
 * hardcoded except as fallbacks.
 *
 * @module @dsh-wechat/core/constants
 */

/** Fixed entry point for QR-code requests. Login may redirect elsewhere afterwards. */
export const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** Tenant/application id. Sent as `iLink-App-Id`. Mirrors the official `ilink_appid`. */
export const APP_ID = 'bot'

/**
 * Client build number, sent as `iLink-App-ClientVersion`.
 * The official build derives it from its own package version; the server accepted
 * this literal value from an independent client.
 */
export const APP_CLIENT_VERSION = '204009'

/** Free-form channel version reported in `base_info.channel_version`. */
export const CHANNEL_VERSION = '2.4.9'

/**
 * Self-declared bot identity reported in `base_info.bot_agent`.
 * Documented by Tencent as observability-only: it does not authenticate or route.
 */
export const DEFAULT_BOT_AGENT = 'dsh-wechat/0.0.0'

/**
 * `bot_type` for the WeChat channel build.
 * Kept identical to the official value: the server may branch on it per client type.
 */
export const DEFAULT_BOT_TYPE = '3'

/** Server-suggested long-poll hold, used until the server sends its own value. */
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000

/** Client-side timeout for one QR-status long-poll. */
export const DEFAULT_QR_POLL_TIMEOUT_MS = 35_000

/** Timeout for ordinary (non-long-poll) calls such as `sendmessage`. */
export const DEFAULT_API_TIMEOUT_MS = 15_000

/** Local verification-code prompt must not hang a login forever. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000

/** How many times one login session may replace an expired QR code. */
export const MAX_QR_REFRESH = 3

/** Restart backoff cap for the long-poll loop. */
export const MAX_LONG_POLL_BACKOFF_MS = 10_000

/** Base retry delay after a recoverable API failure. */
export const RETRY_DELAY_MS = 2_000

/** Delay after several consecutive failures. */
export const BACKOFF_DELAY_MS = 30_000

/** Consecutive API failures before backing off. */
export const MAX_CONSECUTIVE_FAILURES = 3

/**
 * Server error code meaning the bot token is stale.
 *
 * Tencent's own client reacts by pausing every request for this account for one
 * hour before re-authentication, so a single expired token cannot storm the API.
 * We reproduce that cooldown rather than hot-looping.
 */
export const STALE_TOKEN_ERRCODE = -14

/** Tencent's cooldown after {@link STALE_TOKEN_ERRCODE}. */
export const SESSION_PAUSE_MS = 60 * 60 * 1000

/** CDN base for encrypted media. Media transfer arrives in phase 2. */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
